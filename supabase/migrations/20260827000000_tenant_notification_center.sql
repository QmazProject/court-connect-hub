-- Tenant notification centre.
--
-- Extends the existing pipeline rather than adding a second one. Everything still
-- flows notify → public.notifications → fan_out_notification → notification_outbox →
-- the drain worker. What is new is (a) who gets notified, (b) a deduplication key so
-- the same business event cannot produce two rows, and (c) tenant-facing categories
-- in notification_preferences.
--
-- `notify_user()` is deliberately NOT modified. Adding a parameter to it would create
-- an overload and make every existing 8-argument call ambiguous, and every player
-- notification in the system goes through it. Tenant fan-out gets its own entry point.
--
-- DEDUPLICATION IS THE CORE OF THIS FILE. Bookings are stored one row per hour with no
-- session or checkout column, and the write paths differ:
--
--   * "settle at venue" inserts N confirmed rows in ONE statement
--   * online payment confirms N rows in ONE update inside finalize_paid_checkout()
--   * staff_cancel_bookings() updates row BY ROW inside a LOOP
--   * refunds update row by row from the server function
--
-- A trigger therefore fires anywhere between once and N times for one thing a human
-- would call a single event. Rather than special-casing each path, every tenant
-- notification carries a `dedupe_key` built from the session anchor, and a unique
-- index collapses the duplicates. The trigger may fire five times; exactly one row
-- survives. This also makes PayMongo webhook retries safe without touching payment
-- code: a retry performs no UPDATE (finalize_paid_checkout returns "Already
-- confirmed" early), so no trigger fires at all — and if one somehow did, the key
-- would absorb it.

-- ---------------------------------------------------------------------------
-- 1. Deduplication key
-- ---------------------------------------------------------------------------

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Partial, so the millions of player notifications that carry no key are unaffected
-- and keep costing nothing extra to insert.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_uidx
  ON public.notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Session anchor
-- ---------------------------------------------------------------------------

-- The lowest booking id in the same logical session, where "session" means exactly
-- what groupBookingSessions() in src/lib/booking-groups.ts means: a maximal run of
-- CONTIGUOUS hourly rows on one court for one player, each starting where the last
-- ended.
--
-- Contiguity, not calendar day. Grouping by (player, court, day) — which is what the
-- booking reminders do — is right for a reminder, because one nudge per court per day
-- is the goal. It is wrong here: a player who books 9–10am and then separately books
-- 7–8pm on the same court has made two bookings, and a venue must be told about both.
-- A day-based key would give them the same anchor and silently drop the second.
--
-- Every hourly row of a run resolves to the same anchor, which is what lets a per-row
-- trigger emit one notification for the whole session.
CREATE OR REPLACE FUNCTION public.booking_session_anchor(_booking_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE seed AS (
    SELECT b.id, b.user_id, b.court_id, b.start_time, b.status, b.payment_status
      FROM public.bookings b WHERE b.id = _booking_id
  ), walk AS (
    SELECT * FROM seed
    UNION ALL
    -- Backwards while the previous hour is the same player, same court, and in the
    -- SAME state. Status and payment_status are part of the match because that is
    -- what groupBookingSessions() buckets on: if only the middle hour of a booking
    -- is cancelled, that hour is its own session, and the notification about it must
    -- describe that hour rather than the whole original span.
    SELECT prev.id, prev.user_id, prev.court_id, prev.start_time,
           prev.status, prev.payment_status
      FROM walk w
      JOIN public.bookings prev
        ON prev.user_id        = w.user_id
       AND prev.court_id       = w.court_id
       AND prev.end_time       = w.start_time
       AND prev.status         = w.status
       AND prev.payment_status = w.payment_status
  )
  SELECT min(id) FROM walk;
$$;

-- Human-facing span of a session: earliest start, latest end, row count and total.
-- Walks forward from the anchor under the same rule.
CREATE OR REPLACE FUNCTION public.booking_session_span(_anchor bigint)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz, slots integer, total numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE walk AS (
    SELECT b.id, b.user_id, b.court_id, b.start_time, b.end_time,
           b.status, b.payment_status, b.unit_price, b.discount_amount
      FROM public.bookings b WHERE b.id = _anchor
    UNION ALL
    SELECT nxt.id, nxt.user_id, nxt.court_id, nxt.start_time, nxt.end_time,
           nxt.status, nxt.payment_status, nxt.unit_price, nxt.discount_amount
      FROM walk w
      JOIN public.bookings nxt
        ON nxt.user_id        = w.user_id
       AND nxt.court_id       = w.court_id
       AND nxt.start_time     = w.end_time
       AND nxt.status         = w.status
       AND nxt.payment_status = w.payment_status
  )
  SELECT min(start_time), max(end_time), count(*)::integer,
         COALESCE(sum(COALESCE(unit_price, 0) - COALESCE(discount_amount, 0)), 0)
    FROM walk;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tenant preference categories
-- ---------------------------------------------------------------------------

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS new_bookings_enabled    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS booking_changes_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cancellations_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS refunds_enabled         boolean NOT NULL DEFAULT true;

-- Seed a row for everyone who is already staff somewhere, with message email/push
-- OFF. Without this, deploying would start mailing every venue on every player
-- message — a busy venue would get hundreds on day one and switch the whole thing
-- off. Operational categories are on, because those are the ones worth interrupting
-- for. The in-app bell is unaffected either way: it records everything regardless of
-- these columns.
INSERT INTO public.notification_preferences (user_id, messages_enabled)
SELECT DISTINCT s.user_id, false
  FROM public.staff s
 WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id)
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Staff fan-out
-- ---------------------------------------------------------------------------

-- One notification per staff member of one venue.
--
-- Scoping rules, all enforced here rather than at the call sites:
--   * only staff of `_venue_id` — never another venue, never another tenant
--   * DISTINCT, because public.staff has no unique constraint on
--     (venue_id, user_id) and a duplicated row must not double-notify
--   * only users that still exist in auth.users, so a deleted account is skipped
--   * `_exclude_user` drops the actor, so staff who cancel a booking themselves are
--     not told about their own action
CREATE OR REPLACE FUNCTION public.notify_venue_staff(
  _venue_id       bigint,
  _type           text,
  _title          text,
  _body           text,
  _link           text,
  _booking_id     bigint    DEFAULT NULL,
  _conversation_id uuid     DEFAULT NULL,
  _dedupe_suffix  text      DEFAULT NULL,
  _exclude_user   uuid      DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid  uuid;
  _sent integer := 0;
BEGIN
  IF _venue_id IS NULL THEN RETURN 0; END IF;

  FOR _uid IN
    SELECT DISTINCT s.user_id
      FROM public.staff s
     WHERE s.venue_id = _venue_id
       AND (_exclude_user IS NULL OR s.user_id <> _exclude_user)
       AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id)
  LOOP
    INSERT INTO public.notifications
      (user_id, type, title, body, link, booking_id, venue_id, conversation_id, dedupe_key)
    VALUES
      (_uid, _type, _title, _body, _link, _booking_id, _venue_id, _conversation_id,
       CASE WHEN _dedupe_suffix IS NULL THEN NULL
            ELSE _type || ':' || _dedupe_suffix || ':' || _uid::text END)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

    IF FOUND THEN _sent := _sent + 1; END IF;
  END LOOP;

  RETURN _sent;
END; $$;

REVOKE EXECUTE ON FUNCTION public.notify_venue_staff(bigint, text, text, text, text, bigint, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Booking lifecycle → tenant notifications
-- ---------------------------------------------------------------------------

-- Formats one session into the title/body a venue actually reads, then fans out.
-- Row-level triggers call this for every hourly row; the dedupe key means only the
-- first one through produces notifications.
CREATE OR REPLACE FUNCTION public.notify_staff_booking_event(
  _booking_id bigint,
  _type       text,
  _actor      uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _anchor    bigint;
  _span      record;
  _b         record;
  _player    text;
  _title     text;
  _body      text;
  _when      text;
  _money     text;
BEGIN
  _anchor := public.booking_session_anchor(_booking_id);
  IF _anchor IS NULL THEN RETURN; END IF;

  SELECT b.id, b.user_id, c.name AS court_name, s.name AS sport_name,
         v.id AS venue_id, v.name AS venue_name, v.timezone AS tz
    INTO _b
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
    JOIN public.venues v ON v.id = c.venue_id
    LEFT JOIN public.sports s ON s.id = c.sport_id
   WHERE b.id = _anchor;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO _span FROM public.booking_session_span(_anchor);

  SELECT COALESCE(NULLIF(trim(p.full_name), ''), 'A player')
    INTO _player FROM public.profiles p WHERE p.id = _b.user_id;
  _player := COALESCE(_player, 'A player');

  -- The venue's own timezone, so "6:00 PM" means what the front desk thinks it means.
  _when := to_char(_span.starts_at AT TIME ZONE COALESCE(_b.tz, 'Asia/Manila'),
                   'Mon FMDD · FMHH12:MI AM')
        || '–'
        || to_char(_span.ends_at AT TIME ZONE COALESCE(_b.tz, 'Asia/Manila'), 'FMHH12:MI AM');
  _money := '₱' || to_char(_span.total, 'FM999,999,990.00');

  IF _type = 'venue_booking_new' THEN
    _title := 'New booking · ' || COALESCE(_b.court_name, 'Court');
    _body  := _player || ' booked ' || COALESCE(_b.sport_name, 'a court') || ' at '
              || _b.venue_name || E'\n' || _when || ' · ' || _money;
  ELSIF _type = 'venue_booking_cancelled' THEN
    _title := 'Booking cancelled · ' || COALESCE(_b.court_name, 'Court');
    _body  := _player || ' cancelled ' || COALESCE(_b.sport_name, 'a booking') || ' at '
              || _b.venue_name || E'\n' || _when;
  ELSIF _type = 'venue_payment_received' THEN
    _title := 'Payment received · ' || _money;
    _body  := _player || ' paid for ' || COALESCE(_b.court_name, 'a court') || ' at '
              || _b.venue_name || E'\n' || _when;
  ELSIF _type = 'venue_refund_processed' THEN
    _title := 'Refund processed · ' || _money;
    _body  := 'Refunded to ' || _player || ' for ' || COALESCE(_b.court_name, 'a court')
              || E'\n' || _when;
  ELSIF _type = 'venue_refund_failed' THEN
    _title := 'Refund needs attention';
    _body  := 'A refund for ' || _player || ' at ' || _b.venue_name
              || ' could not be completed.' || E'\n' || _when;
  ELSE
    RETURN;
  END IF;

  PERFORM public.notify_venue_staff(
    _b.venue_id, _type, _title, _body,
    '/dashboard?section=bookings&booking=' || _anchor::text,
    _anchor, NULL, _anchor::text, _actor
  );
END; $$;

REVOKE EXECUTE ON FUNCTION public.notify_staff_booking_event(bigint, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- A confirmed row appearing is a new booking. "Settle at venue" inserts straight to
-- confirmed; online checkout inserts `pending` and is handled by the update trigger.
CREATE OR REPLACE FUNCTION public.tg_booking_insert_notify_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    PERFORM public.notify_staff_booking_event(NEW.id, 'venue_booking_new', NULL);
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS bookings_notify_staff_insert ON public.bookings;
CREATE CONSTRAINT TRIGGER bookings_notify_staff_insert
AFTER INSERT ON public.bookings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.tg_booking_insert_notify_staff();

-- Transitions worth telling a venue about. Each is guarded on the value actually
-- changing, so an unrelated UPDATE touching the same row stays silent.
CREATE OR REPLACE FUNCTION public.tg_booking_update_notify_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- pending → confirmed. This is the online-payment path, and it is where a paid
  -- booking becomes real. finalize_paid_checkout() only reaches its UPDATE once, so
  -- a webhook retry never gets here.
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    PERFORM public.notify_staff_booking_event(NEW.id, 'venue_booking_new', NULL);
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    PERFORM public.notify_staff_booking_event(
      NEW.id, 'venue_booking_cancelled', NEW.cancelled_by);
  END IF;

  -- Only when payment lands on a booking that was ALREADY confirmed — a settle-at-
  -- venue booking later marked paid. finalize_paid_checkout() sets status and
  -- payment_status in the same UPDATE, so without this guard one online checkout
  -- would produce both "New booking" and "Payment received" for the same event; the
  -- new-booking notification already carries the amount.
  IF NEW.payment_status = 'paid'
     AND OLD.payment_status IS DISTINCT FROM 'paid'
     AND NOT (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed') THEN
    PERFORM public.notify_staff_booking_event(NEW.id, 'venue_payment_received', NULL);
  END IF;

  IF NEW.refund_status = 'refunded' AND OLD.refund_status IS DISTINCT FROM 'refunded' THEN
    PERFORM public.notify_staff_booking_event(NEW.id, 'venue_refund_processed', NULL);
  END IF;

  IF NEW.refund_status = 'failed' AND OLD.refund_status IS DISTINCT FROM 'failed' THEN
    PERFORM public.notify_staff_booking_event(NEW.id, 'venue_refund_failed', NULL);
  END IF;

  RETURN NULL;
END; $$;

-- Deferred for the same reason: it fires at COMMIT, by which time every row the
-- transaction cancelled/confirmed is visible to the session walk, so the first row
-- through computes the complete span rather than a one-hour fragment of it.
DROP TRIGGER IF EXISTS bookings_notify_staff_update ON public.bookings;
CREATE CONSTRAINT TRIGGER bookings_notify_staff_update
AFTER UPDATE ON public.bookings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.tg_booking_update_notify_staff();

-- ---------------------------------------------------------------------------
-- 6. Better message notifications, and a link that goes somewhere
-- ---------------------------------------------------------------------------

-- Replaces the version in 20260727034617. Two changes: staff notifications now deep
-- link to the booking's conversation instead of '/dashboard', and they carry the
-- court and venue so a venue with six courts knows which one is being asked about.
-- The player direction is unchanged apart from the same court context.
CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _c RECORD; _sender_name text; _venue_name text; _court_name text; _context text;
BEGIN
  SELECT * INTO _c FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(trim(full_name), ''), 'Someone') INTO _sender_name
    FROM public.profiles WHERE id = NEW.sender_id;
  SELECT name INTO _venue_name FROM public.venues WHERE id = _c.venue_id;

  SELECT c.name INTO _court_name
    FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
   WHERE b.id = _c.booking_id;

  _context := COALESCE(_court_name, 'Booking') || ' · Booking #' || _c.booking_id::text;

  IF NEW.sender_id = _c.player_id THEN
    -- Player → venue. No dedupe key: each message is its own event, and collapsing
    -- them would lose the message a venue most needs to see. External delivery is
    -- governed by messages_enabled, which is seeded OFF for existing staff.
    PERFORM public.notify_venue_staff(
      _c.venue_id, 'message',
      'New message from ' || COALESCE(_sender_name, 'a player'),
      left(NEW.body, 140) || E'\n' || _context,
      '/dashboard?section=bookings&booking=' || _c.booking_id::text || '&chat=1',
      _c.booking_id, _c.id, NULL, NULL
    );
  ELSE
    PERFORM public.notify_user(
      _c.player_id, 'message',
      COALESCE(_venue_name, 'The venue') || ' replied',
      left(NEW.body, 140) || E'\n' || _context,
      '/dashboard?booking=' || _c.booking_id::text,
      _c.booking_id, _c.venue_id, _c.id
    );
  END IF;

  RETURN NEW;
END; $$;

-- ---------------------------------------------------------------------------
-- 7. Route the new types through the existing preference fan-out
-- ---------------------------------------------------------------------------

-- Same function as 20260826000000, with the tenant categories added. Anything
-- unrecognised still falls through to bookings_enabled so a new type is delivered
-- rather than silently dropped.
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
  _new_bookings boolean;
  _changes   boolean;
  _cancels   boolean;
  _refunds   boolean;
  _category_ok boolean;
  _has_push  boolean;
BEGIN
  SELECT p.email_enabled, p.push_enabled, p.reminders_enabled,
         p.bookings_enabled, p.messages_enabled, p.payments_enabled,
         p.new_bookings_enabled, p.booking_changes_enabled,
         p.cancellations_enabled, p.refunds_enabled
    INTO _email, _push, _reminders, _bookings, _messages, _payments,
         _new_bookings, _changes, _cancels, _refunds
    FROM public.notification_preferences p
   WHERE p.user_id = NEW.user_id;

  IF NOT FOUND THEN
    _email        := true;
    _push         := false;
    _reminders    := true;
    _bookings     := true;
    _messages     := true;
    _payments     := true;
    _new_bookings := true;
    _changes      := true;
    _cancels      := true;
    _refunds      := true;
  END IF;

  _category_ok := CASE
    WHEN NEW.type LIKE 'booking_reminder%'        THEN _reminders
    WHEN NEW.type = 'message'                     THEN _messages
    WHEN NEW.type = 'refund'                      THEN _payments
    WHEN NEW.type = 'venue_booking_new'           THEN _new_bookings
    WHEN NEW.type = 'venue_booking_changed'       THEN _changes
    WHEN NEW.type = 'venue_booking_cancelled'     THEN _cancels
    WHEN NEW.type = 'venue_payment_received'      THEN _payments
    WHEN NEW.type LIKE 'venue_refund%'            THEN _refunds
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

REVOKE EXECUTE ON FUNCTION public.fan_out_notification() FROM PUBLIC, anon, authenticated;
