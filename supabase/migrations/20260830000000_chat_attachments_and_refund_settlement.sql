-- Booking chat attachments and replies, unread counts, and refund settlement records.
--
-- These arrive together because they are one workflow. When a venue cancels a paid
-- booking it can either push the money back through PayMongo — which always returns it
-- to the card or e-wallet the player originally paid with, and cannot be redirected —
-- or settle it by hand. Settling by hand means agreeing a destination with the player,
-- which happens in the booking chat, which is why the chat needs to carry a screenshot
-- and a reply, and why a settled refund needs to record HOW it was settled.

-- ---------------------------------------------------------------------------
-- 1. Chat attachments and replies
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_url  text,
  ADD COLUMN IF NOT EXISTS attachment_type text,
  ADD COLUMN IF NOT EXISTS attachment_name text,
  -- Self-reference: quoting one earlier message. ON DELETE SET NULL so removing a
  -- message never cascades away the replies to it.
  ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES public.messages(id) ON DELETE SET NULL;

-- `body` stays NOT NULL, but an image-only message is legitimate, so the real rule is
-- "a message must carry something". Existing rows all have a body, so this validates.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_have_content;
ALTER TABLE public.messages ADD CONSTRAINT messages_have_content
  CHECK (length(trim(body)) > 0 OR attachment_url IS NOT NULL);

CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON public.messages (reply_to) WHERE reply_to IS NOT NULL;

-- Private bucket. Read is through signed URLs, and both write and read are limited to
-- the two sides of that one conversation.
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Path is `<conversation_id>/<file>`, so the first segment is the authorisation
-- subject — the same shape the avatars bucket uses, but keyed on the conversation
-- rather than the uploader, because both participants must be able to read it.
DROP POLICY IF EXISTS "Participants upload chat attachments" ON storage.objects;
CREATE POLICY "Participants upload chat attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND public.is_conversation_participant(
        ((storage.foldername(name))[1])::uuid, auth.uid())
);

DROP POLICY IF EXISTS "Participants read chat attachments" ON storage.objects;
CREATE POLICY "Participants read chat attachments"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'chat-attachments'
  AND public.is_conversation_participant(
        ((storage.foldername(name))[1])::uuid, auth.uid())
);

-- ---------------------------------------------------------------------------
-- 2. Unread message counts
-- ---------------------------------------------------------------------------

-- Per participant, not per message. `messages.read_at` is a single column, which
-- cannot express "the player has read this but the receptionist has not" — and a venue
-- has many staff. A high-water mark per (conversation, user) answers that correctly and
-- costs one row per person per thread.
CREATE TABLE IF NOT EXISTS public.conversation_reads (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own conversation reads" ON public.conversation_reads;
CREATE POLICY "Users read own conversation reads"
ON public.conversation_reads FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users upsert own conversation reads" ON public.conversation_reads;
CREATE POLICY "Users upsert own conversation reads"
ON public.conversation_reads FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.is_conversation_participant(conversation_id, auth.uid()));

DROP POLICY IF EXISTS "Users update own conversation reads" ON public.conversation_reads;
CREATE POLICY "Users update own conversation reads"
ON public.conversation_reads FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- How many messages the caller has not seen, per booking. One round trip for a whole
-- table of bookings, so the badge does not cost a query per row.
--
-- SECURITY DEFINER because it reads messages across a venue's conversations, but it
-- answers only for auth.uid() and only for conversations that caller participates in —
-- a booking the caller has no part in simply returns nothing.
CREATE OR REPLACE FUNCTION public.unread_counts_for_bookings(_booking_ids bigint[])
RETURNS TABLE (booking_id bigint, unread integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.booking_id,
         count(m.id)::integer
    FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    LEFT JOIN public.conversation_reads r
      ON r.conversation_id = c.id AND r.user_id = auth.uid()
   WHERE c.booking_id = ANY(_booking_ids)
     AND public.is_conversation_participant(c.id, auth.uid())
     -- Never count your own messages as unread to yourself.
     AND m.sender_id <> auth.uid()
     AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
   GROUP BY c.booking_id;
$$;

-- Move the caller's high-water mark to now for one conversation.
CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_conversation_participant(_conversation_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a participant of this conversation';
  END IF;
  INSERT INTO public.conversation_reads (conversation_id, user_id, last_read_at)
  VALUES (_conversation_id, auth.uid(), now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now();
END; $$;

-- ---------------------------------------------------------------------------
-- 3. Refund settlement record
-- ---------------------------------------------------------------------------

-- How a refund was actually returned, and the reference that proves it. Without this a
-- settled refund is indistinguishable from an automatic one, and a venue that paid a
-- player by GCash has nothing on the booking to show for it.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS refund_method    text,
  ADD COLUMN IF NOT EXISTS refund_reference text,
  ADD COLUMN IF NOT EXISTS refund_settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_settled_by uuid;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_refund_method_valid;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_refund_method_valid
  CHECK (refund_method IS NULL OR refund_method IN ('paymongo', 'manual'));

-- Replaces the (bigint[]) version. Safe to drop: nothing in the application called it —
-- which is precisely why a booking settled by hand sat on "Awaiting refund" forever.
DROP FUNCTION IF EXISTS public.staff_mark_refund_settled(bigint[]);

CREATE OR REPLACE FUNCTION public.staff_mark_refund_settled(
  _booking_ids bigint[],
  _method      text DEFAULT 'manual',
  _reference   text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _uid uuid := auth.uid(); _n int := 0; _b RECORD; _venue text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _method NOT IN ('paymongo', 'manual') THEN
    RAISE EXCEPTION 'Unknown refund method %', _method;
  END IF;

  FOR _b IN
    SELECT b.id, b.user_id, c.venue_id
      FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids) AND b.refund_status = 'pending'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.staff s WHERE s.venue_id = _b.venue_id AND s.user_id = _uid
    ) THEN
      RAISE EXCEPTION 'Not authorised for this venue';
    END IF;

    UPDATE public.bookings
       SET refund_status    = 'refunded',
           payment_status   = 'refunded',
           refund_method    = _method,
           refund_reference = _reference,
           refund_settled_at = now(),
           refund_settled_by = _uid
     WHERE id = _b.id;
    _n := _n + 1;

    -- The player is the one waiting for this money; tell them it arrived. Idempotent
    -- per booking, so re-running the action cannot double-notify.
    SELECT v.name INTO _venue
      FROM public.courts c JOIN public.venues v ON v.id = c.venue_id
     WHERE c.id = (SELECT court_id FROM public.bookings WHERE id = _b.id);

    PERFORM public.notify_user(
      _b.user_id, 'refund',
      'Refund settled',
      CASE WHEN _method = 'manual'
           THEN COALESCE(_venue, 'The venue') || ' has sent your refund'
                || CASE WHEN _reference IS NOT NULL AND trim(_reference) <> ''
                        THEN ' (ref: ' || _reference || ')' ELSE '' END || '.'
           ELSE 'Your refund has been returned to your original payment method.'
      END,
      '/dashboard?booking=' || _b.id::text,
      _b.id, _b.venue_id, NULL
    );
  END LOOP;

  RETURN _n;
END; $$;

REVOKE EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[], text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[], text, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.unread_counts_for_bookings(bigint[]) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_conversation_read(uuid) TO authenticated;
