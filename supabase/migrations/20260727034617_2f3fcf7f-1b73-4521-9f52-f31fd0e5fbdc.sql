-- 1. Booking cancellation metadata
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS refund_mode text,
  ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none';

-- 2. Notifications
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  booking_id bigint,
  venue_id bigint,
  conversation_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications (user_id, created_at DESC);

GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own notifications" ON public.notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users mark own notifications read" ON public.notifications
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Block direct notification inserts" ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.notify_user(
  _user_id uuid, _type text, _title text, _body text DEFAULT NULL,
  _link text DEFAULT NULL, _booking_id bigint DEFAULT NULL,
  _venue_id bigint DEFAULT NULL, _conversation_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid;
BEGIN
  IF _user_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.notifications (user_id, type, title, body, link, booking_id, venue_id, conversation_id)
  VALUES (_user_id, _type, _title, _body, _link, _booking_id, _venue_id, _conversation_id)
  RETURNING id INTO _id;
  RETURN _id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text, bigint, bigint, uuid) FROM PUBLIC, anon, authenticated;

-- 3. Conversations (one thread per booking session)
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id bigint NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE CASCADE,
  venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  player_id uuid NOT NULL,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_venue_idx ON public.conversations (venue_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_player_idx ON public.conversations (player_id, last_message_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_conversation_participant(_conversation_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = _conversation_id
      AND (c.player_id = _uid
           OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = c.venue_id AND s.user_id = _uid))
  );
$$;

CREATE POLICY "Participants read conversations" ON public.conversations
  FOR SELECT TO authenticated USING (
    player_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = conversations.venue_id AND s.user_id = auth.uid())
  );
CREATE POLICY "Player opens own booking thread" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (
    (player_id = auth.uid() AND EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = booking_id AND b.user_id = auth.uid()))
    OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = conversations.venue_id AND s.user_id = auth.uid())
  );
CREATE POLICY "Participants touch conversations" ON public.conversations
  FOR UPDATE TO authenticated USING (
    player_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = conversations.venue_id AND s.user_id = auth.uid())
  ) WITH CHECK (
    player_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = conversations.venue_id AND s.user_id = auth.uid())
  );

CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Messages
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_body_len CHECK (char_length(body) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON public.messages (conversation_id, created_at);

GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants read messages" ON public.messages
  FOR SELECT TO authenticated USING (public.is_conversation_participant(conversation_id, auth.uid()));
CREATE POLICY "Participants send messages" ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid())
  );
CREATE POLICY "Participants mark messages read" ON public.messages
  FOR UPDATE TO authenticated USING (public.is_conversation_participant(conversation_id, auth.uid()))
  WITH CHECK (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c RECORD; _sender_name text; _venue_name text; _recipient uuid;
BEGIN
  SELECT * INTO _c FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE public.conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;

  SELECT full_name INTO _sender_name FROM public.profiles WHERE id = NEW.sender_id;
  SELECT name INTO _venue_name FROM public.venues WHERE id = _c.venue_id;

  IF NEW.sender_id = _c.player_id THEN
    FOR _recipient IN SELECT user_id FROM public.staff WHERE venue_id = _c.venue_id LOOP
      PERFORM public.notify_user(_recipient, 'message',
        COALESCE(NULLIF(_sender_name, ''), 'A player') || ' sent a message',
        left(NEW.body, 140), '/dashboard', _c.booking_id, _c.venue_id, _c.id);
    END LOOP;
  ELSE
    PERFORM public.notify_user(_c.player_id, 'message',
      COALESCE(NULLIF(_venue_name, ''), 'The venue') || ' replied',
      left(NEW.body, 140), '/dashboard', _c.booking_id, _c.venue_id, _c.id);
  END IF;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_message() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER messages_after_insert AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_message();

-- 5. Staff cancellation with refund choice
CREATE OR REPLACE FUNCTION public.staff_cancel_bookings(
  _booking_ids bigint[], _reason text, _refund_mode text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _n int := 0;
  _b RECORD;
  _players uuid[] := '{}';
  _p uuid;
  _venue_name text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _refund_mode NOT IN ('auto', 'manual', 'none') THEN
    RAISE EXCEPTION 'Invalid refund mode';
  END IF;

  FOR _b IN
    SELECT b.id, b.user_id, b.payment_status, c.venue_id
      FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids) AND b.status <> 'cancelled'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = _b.venue_id AND s.user_id = _uid) THEN
      RAISE EXCEPTION 'Not authorised for this venue';
    END IF;

    UPDATE public.bookings
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = _uid,
           cancel_reason = NULLIF(trim(COALESCE(_reason, '')), ''),
           refund_mode = CASE WHEN _b.payment_status = 'paid' THEN _refund_mode ELSE 'none' END,
           refund_status = CASE
             WHEN _b.payment_status <> 'paid' THEN 'none'
             WHEN _refund_mode = 'none' THEN 'none'
             ELSE 'pending' END
     WHERE id = _b.id;

    _n := _n + 1;
    IF NOT (_b.user_id = ANY(_players)) THEN
      _players := array_append(_players, _b.user_id);
      SELECT name INTO _venue_name FROM public.venues WHERE id = _b.venue_id;
      PERFORM public.notify_user(_b.user_id, 'booking_cancelled',
        'Booking cancelled by ' || COALESCE(_venue_name, 'the venue'),
        COALESCE(NULLIF(trim(COALESCE(_reason, '')), ''), 'Your reservation was cancelled.')
          || CASE WHEN _refund_mode = 'auto' THEN ' A refund has been requested to your original payment method.'
                  WHEN _refund_mode = 'manual' THEN ' The venue will settle your refund directly.'
                  ELSE '' END,
        '/dashboard', _b.id, _b.venue_id, NULL);
    END IF;
  END LOOP;

  RETURN _n;
END; $$;
REVOKE EXECUTE ON FUNCTION public.staff_cancel_bookings(bigint[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cancel_bookings(bigint[], text, text) TO authenticated;

-- 6. Mark a refund settled
CREATE OR REPLACE FUNCTION public.staff_mark_refund_settled(_booking_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _n int := 0; _b RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  FOR _b IN
    SELECT b.id, b.user_id, c.venue_id FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids) AND b.refund_status = 'pending'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = _b.venue_id AND s.user_id = _uid) THEN
      RAISE EXCEPTION 'Not authorised for this venue';
    END IF;
    UPDATE public.bookings SET refund_status = 'refunded', payment_status = 'refunded' WHERE id = _b.id;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END; $$;
REVOKE EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[]) TO authenticated;

-- 7. Realtime
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;