-- Player profile picture, notification preferences, and delivery beyond the bell.
--
-- Three things that arrive together because they are one feature from the player's
-- side: a Settings page that shows who they are and decides how they hear from us.
--
-- The delivery design is a fan-out on INSERT rather than a change to any of the
-- functions that notify. Every notification in this system — reminders, messages,
-- confirmations, refunds — is written by notify_user() into public.notifications, so
-- one AFTER INSERT trigger on that table is the only place that has to know email and
-- push exist. send_booking_reminders() is not touched, and a notification added later
-- gets the new channels for free.
--
-- The trigger writes an outbox row per enabled channel rather than sending inline.
-- Postgres cannot make an HTTPS request without pg_net, and even with it, a reminder
-- run that blocks on a slow provider — or fails halfway and rolls back the
-- notification the player has already seen in the bell — is a worse system than one
-- that queues. A worker drains the outbox; see src/routes/api/internal/*.

-- ---------------------------------------------------------------------------
-- 1. Profile picture
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;

-- A private bucket read through signed URLs, matching how venue images already work
-- in this project rather than introducing a second convention.
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;

-- Every policy is scoped to a folder named for the owner's uid, so one player can
-- never read or overwrite another's picture even though they share a bucket.
DROP POLICY IF EXISTS "Users manage own avatar upload" ON storage.objects;
CREATE POLICY "Users manage own avatar upload"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "Users manage own avatar update" ON storage.objects;
CREATE POLICY "Users manage own avatar update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "Users manage own avatar delete" ON storage.objects;
CREATE POLICY "Users manage own avatar delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "Users read own avatar" ON storage.objects;
CREATE POLICY "Users read own avatar"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ---------------------------------------------------------------------------
-- 2. Notification preferences
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Channels. In-app is not listed: the bell is the record of what happened and
  -- turning it off would mean losing history, not silence.
  email_enabled boolean NOT NULL DEFAULT true,
  push_enabled  boolean NOT NULL DEFAULT false,
  -- Categories, applied to both channels. Named for what a player recognises
  -- rather than for the notification `type` strings they map to.
  reminders_enabled boolean NOT NULL DEFAULT true,
  bookings_enabled  boolean NOT NULL DEFAULT true,
  messages_enabled  boolean NOT NULL DEFAULT true,
  payments_enabled  boolean NOT NULL DEFAULT true,
  -- Local time (venue-agnostic) during which push is held back. Both NULL = never.
  quiet_hours_start smallint,
  quiet_hours_end   smallint,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quiet_hours_valid CHECK (
    (quiet_hours_start IS NULL AND quiet_hours_end IS NULL)
    OR (quiet_hours_start BETWEEN 0 AND 23 AND quiet_hours_end BETWEEN 0 AND 23)
  )
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own notification prefs" ON public.notification_preferences;
CREATE POLICY "Users read own notification prefs"
ON public.notification_preferences FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users upsert own notification prefs" ON public.notification_preferences;
CREATE POLICY "Users upsert own notification prefs"
ON public.notification_preferences FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own notification prefs" ON public.notification_preferences;
CREATE POLICY "Users update own notification prefs"
ON public.notification_preferences FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Push subscriptions
-- ---------------------------------------------------------------------------

-- One row per browser/device. The endpoint is the identity: the same person on a
-- phone and a laptop is two rows, and re-subscribing in the same browser returns
-- the same endpoint, which is why it is the conflict target rather than a new row.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  endpoint    text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users read own push subscriptions"
ON public.push_subscriptions FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users insert own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users insert own push subscriptions"
ON public.push_subscriptions FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users delete own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users delete own push subscriptions"
ON public.push_subscriptions FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Delivery outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id          bigserial PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'push')),
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts    smallint NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  -- One attempt per notification per channel, however many times a trigger fires.
  CONSTRAINT notification_outbox_unique UNIQUE (notification_id, channel)
);

-- The drain query: oldest pending first, and it never scans delivered rows.
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON public.notification_outbox (created_at)
  WHERE status = 'pending';

-- No policies and RLS on: this table is the worker's, reached with the service role,
-- which bypasses RLS. Enabling it without policies denies every client outright,
-- which is the intent — a player has no reason to read the delivery log.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Fan-out
-- ---------------------------------------------------------------------------

-- Which preference governs which notification type. Types not listed fall through to
-- `bookings_enabled`, so a type added later is delivered rather than silently dropped
-- — an unexpected notification is a smaller failure than a missing one.
--
-- Scalars rather than a %ROWTYPE variable: the defaults below have to survive a
-- SELECT INTO that matches nothing, and `SELECT ... INTO` sets every target to NULL
-- when it finds no row, so the fallback is written out explicitly.
CREATE OR REPLACE FUNCTION public.fan_out_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _email     boolean;
  _push      boolean;
  _reminders boolean;
  _bookings  boolean;
  _messages  boolean;
  _payments  boolean;
  _category_ok boolean;
  _has_push  boolean;
BEGIN
  SELECT p.email_enabled, p.push_enabled, p.reminders_enabled,
         p.bookings_enabled, p.messages_enabled, p.payments_enabled
    INTO _email, _push, _reminders, _bookings, _messages, _payments
    FROM public.notification_preferences p
   WHERE p.user_id = NEW.user_id;

  -- No row means the player has never opened Settings. Mirror the column defaults
  -- rather than skipping delivery, so email works before they touch anything. These
  -- must stay in step with the DEFAULTs on notification_preferences above.
  IF NOT FOUND THEN
    _email     := true;
    _push      := false;
    _reminders := true;
    _bookings  := true;
    _messages  := true;
    _payments  := true;
  END IF;

  _category_ok := CASE
    WHEN NEW.type LIKE 'booking_reminder%' THEN _reminders
    WHEN NEW.type = 'message'              THEN _messages
    WHEN NEW.type = 'refund'               THEN _payments
    ELSE _bookings
  END;

  IF _category_ok IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF _email THEN
    INSERT INTO public.notification_outbox (notification_id, user_id, channel)
    VALUES (NEW.id, NEW.user_id, 'email')
    ON CONFLICT (notification_id, channel) DO NOTHING;
  END IF;

  -- Only queue push if there is somewhere to push to. Queuing for a player with no
  -- registered browser produces a row that can only ever fail.
  IF _push THEN
    SELECT EXISTS (
      SELECT 1 FROM public.push_subscriptions ps WHERE ps.user_id = NEW.user_id
    ) INTO _has_push;
    IF _has_push THEN
      INSERT INTO public.notification_outbox (notification_id, user_id, channel)
      VALUES (NEW.id, NEW.user_id, 'push')
      ON CONFLICT (notification_id, channel) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS notifications_fan_out ON public.notifications;
CREATE TRIGGER notifications_fan_out
AFTER INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.fan_out_notification();

-- ---------------------------------------------------------------------------
-- 6. Drain helper
-- ---------------------------------------------------------------------------

-- Claims a batch and marks it in-flight in one statement, so two overlapping worker
-- runs cannot both send the same email. SKIP LOCKED is what makes that safe without
-- serialising the whole table.
CREATE OR REPLACE FUNCTION public.claim_notification_outbox(_limit integer DEFAULT 50)
RETURNS TABLE (
  id bigint,
  notification_id uuid,
  user_id uuid,
  channel text,
  attempts smallint,
  type text,
  title text,
  body text,
  link text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    SELECT o.id
      FROM public.notification_outbox o
     WHERE o.status = 'pending'
       AND o.attempts < 5
     ORDER BY o.created_at
     LIMIT _limit
       FOR UPDATE SKIP LOCKED
  ), bumped AS (
    UPDATE public.notification_outbox o
       SET attempts = o.attempts + 1
      FROM claimed c
     WHERE o.id = c.id
    RETURNING o.id, o.notification_id, o.user_id, o.channel, o.attempts
  )
  SELECT b.id, b.notification_id, b.user_id, b.channel, b.attempts,
         n.type, n.title, n.body, n.link
    FROM bumped b
    JOIN public.notifications n ON n.id = b.notification_id
   ORDER BY b.id;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_notification_outbox(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fan_out_notification() FROM PUBLIC, anon, authenticated;
