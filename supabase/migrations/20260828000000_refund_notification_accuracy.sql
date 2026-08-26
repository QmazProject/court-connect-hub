-- Refund notification accuracy.
--
-- Background. Tenant notifications are deduplicated by a key built from the session
-- anchor, so the first hourly row of a session to commit creates the notification and
-- every later row is suppressed. That is correct when a whole session is written in
-- one statement, which is how bookings are created, confirmed and cancelled.
--
-- Refunds were the exception: cancelBookingsWithRefund() updated `bookings` one row at
-- a time, each its own transaction, so a three-hour refund produced a notification
-- built from the first row alone — "₱500, 6–7 PM" for a ₱1,500, 6–9 PM refund.
--
-- The primary fix is in the application: that loop now batches its `bookings` update,
-- matching what the webhook refund path already did. This migration is the second
-- layer. Rather than assuming every writer will always batch, a tenant notification
-- whose key already exists now REFINES the existing row instead of being dropped. If
-- rows ever do land separately again, each one corrects the notification, and the
-- final state is accurate.
--
-- This also fixes external delivery for free: notification_outbox stores a reference,
-- not a copy, and claim_notification_outbox() reads title and body from
-- public.notifications at drain time. A notification corrected before the drain runs
-- — seconds, against a two-minute schedule — is emailed and pushed in its corrected
-- form.

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
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE
      -- Refine, do not duplicate. Only the wording changes; `read_at` is deliberately
      -- left alone so a correction does not silently mark a read alert unread again,
      -- and `created_at` stays put so the bell does not reorder under the reader.
      SET title = EXCLUDED.title,
          body  = EXCLUDED.body,
          link  = EXCLUDED.link
      -- Skip the write entirely when nothing actually changed, so a replayed webhook
      -- is a no-op rather than a pointless UPDATE.
      WHERE public.notifications.title IS DISTINCT FROM EXCLUDED.title
         OR public.notifications.body  IS DISTINCT FROM EXCLUDED.body
         OR public.notifications.link  IS DISTINCT FROM EXCLUDED.link;

    IF FOUND THEN _sent := _sent + 1; END IF;
  END LOOP;

  RETURN _sent;
END; $$;

REVOKE EXECUTE ON FUNCTION public.notify_venue_staff(bigint, text, text, text, text, bigint, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- The refund-failure body is written for a venue manager, not an engineer: the
-- provider's message never reaches it. PayMongo's text is logged by the server
-- function, and any delivery error is recorded in notification_outbox.last_error.
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
    _body  := _money || ' refunded to ' || _player || ' for '
              || COALESCE(_b.court_name, 'a court') || ' · Booking #' || _anchor::text
              || E'\n' || _when;
  ELSIF _type = 'venue_refund_failed' THEN
    _title := 'Refund needs attention';
    _body  := 'The refund for ' || _player || ' at ' || _b.venue_name
              || ' could not be completed and is still owed.' || E'\n'
              || COALESCE(_b.court_name, 'Court') || ' · Booking #' || _anchor::text
              || ' · ' || _when || E'\n'
              || 'Settle it manually, or retry from the booking.';
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
