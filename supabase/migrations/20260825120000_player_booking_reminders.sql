-- Player booking reminders.
--
-- Notifications cannot be written by a client: `Block direct notification inserts`
-- denies INSERT to authenticated, and notify_user() is REVOKEd from them. Reminders
-- therefore have to be produced server-side on a schedule, which is what this is.
--
-- Anti-spam is the whole design constraint. Two rules:
--   1. One reminder per booking *session*, not per hourly row. A five-hour Saturday
--      booking is five rows in `bookings`; sending five identical notifications is
--      how a player turns the bell off for good. Rows are collapsed to the earliest
--      row per (user, court, local date) and only that row gets the reminder.
--   2. Idempotent by (booking_id, type). Re-running the job — or running it every
--      fifteen minutes, as scheduled below — never produces a second copy.
--
-- Windows are relative rather than calendar-based so no venue timezone maths is
-- needed: the day reminder lands the first time a booking is inside 24 hours, and
-- the 6-hour floor keeps it from colliding with the "starting soon" reminder.
--
-- Only `confirmed` bookings are reminded about. A `pending` row is an unpaid hold and
-- expire_pending_payment_holds() kills it after fifteen minutes, so a pending booking
-- a day out cannot exist — reminding about one would be dead code that also consumed
-- the booking's notification slot and suppressed the reminder that matters.

CREATE OR REPLACE FUNCTION public.send_booking_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sent integer := 0;
  _b RECORD;
  _when text;
  _title text;
  _body text;
  _tail text;
BEGIN
  FOR _b IN
    WITH session_head AS (
      -- The earliest row of each (player, court, local day) group stands in for the
      -- whole session. DISTINCT ON gives us exactly that row, with its own id so the
      -- notification can deep-link to the booking.
      SELECT DISTINCT ON (b.user_id, b.court_id, (b.start_time AT TIME ZONE COALESCE(v.timezone, 'Asia/Manila'))::date)
             b.id,
             b.user_id,
             b.start_time,
             b.status,
             b.payment_status,
             c.name  AS court_name,
             s.name  AS sport_name,
             v.id    AS venue_id,
             v.name  AS venue_name,
             v.timezone AS venue_tz
        FROM public.bookings b
        JOIN public.courts  c ON c.id = b.court_id
        JOIN public.venues  v ON v.id = c.venue_id
        LEFT JOIN public.sports s ON s.id = c.sport_id
       WHERE b.status = 'confirmed'
         AND b.start_time > now()
         AND b.start_time <= now() + interval '24 hours'
       ORDER BY b.user_id,
                b.court_id,
                (b.start_time AT TIME ZONE COALESCE(v.timezone, 'Asia/Manila'))::date,
                b.start_time
    )
    SELECT * FROM session_head
  LOOP
    -- A downpayment leaves a balance to settle on arrival; worth saying in the
    -- reminder, since that is exactly when the player needs to know.
    _tail := CASE WHEN _b.payment_status = 'partially_paid'
                  THEN ' Remember to settle the balance at the venue.'
                  ELSE '' END;

    -- Which reminder, if any, is due for this session right now.
    IF _b.start_time <= now() + interval '3 hours' THEN
      _when  := 'booking_reminder_soon';
      _title := COALESCE(_b.sport_name, 'Booking') || ' starting soon';
      _body  := 'Your booking at ' || _b.venue_name || ' — ' || _b.court_name || ' starts at ' ||
                to_char(_b.start_time AT TIME ZONE COALESCE(_b.venue_tz, 'Asia/Manila'), 'FMHH12:MI AM') || '.' || _tail;
    ELSIF _b.start_time >= now() + interval '6 hours' THEN
      _when  := 'booking_reminder_day';
      _title := COALESCE(_b.sport_name, 'Booking') || ' tomorrow';
      _body  := 'Your booking at ' || _b.venue_name || ' — ' || _b.court_name || ' starts tomorrow at ' ||
                to_char(_b.start_time AT TIME ZONE COALESCE(_b.venue_tz, 'Asia/Manila'), 'FMHH12:MI AM') || '.' || _tail;
    ELSE
      -- Between three and six hours out: the day reminder has already gone and the
      -- "starting soon" one is not due. Deliberately silent.
      CONTINUE;
    END IF;

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.booking_id = _b.id AND n.type = _when
    );

    PERFORM public.notify_user(
      _b.user_id, _when, _title, _body,
      '/dashboard?booking=' || _b.id,   -- deep link: the workspace scrolls to this booking
      _b.id, _b.venue_id, NULL
    );
    _sent := _sent + 1;
  END LOOP;

  RETURN _sent;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.send_booking_reminders() FROM PUBLIC, anon, authenticated;

-- Reminder lookups are all "has this booking already had this type?", so index that.
CREATE INDEX IF NOT EXISTS notifications_booking_type_idx
  ON public.notifications (booking_id, type)
  WHERE booking_id IS NOT NULL;

-- Same guarded pattern as expire-pending-payment-holds: schedule when pg_cron is
-- available, and degrade to "call it externally" when it is not, rather than failing
-- the migration on a deployment without the extension.
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-booking-reminders') THEN
      PERFORM cron.schedule(
        'send-booking-reminders',
        '*/15 * * * *',
        'SELECT public.send_booking_reminders()'
      );
    END IF;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron scheduling was skipped (%); send_booking_reminders must be scheduled externally.', SQLERRM;
END;
$block$;
