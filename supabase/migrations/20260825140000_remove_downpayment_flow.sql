-- Remove the downpayment flow.
--
-- A venue could collect part of the price online and the rest on arrival. That mode
-- is being withdrawn: from here a venue either takes the full amount online
-- (`payment_mode = 'full'`) or takes nothing online and settles at the counter
-- (`'none'`). Nothing in between.
--
-- Order matters below. The trigger that stamps `partially_paid` is dropped first, so
-- moving venues off the mode cannot produce one last partial booking on the way out.
--
-- Bookings that are already `partially_paid` are deliberately left alone. That column
-- records what actually happened — a player really did pay part of the price — and
-- rewriting it to 'paid' would say money was collected that was not. They keep their
-- status and stay inside `bookings_payment_status_check`, which is not narrowed here
-- for exactly that reason. What goes away is every way to make a new one.

-- 1. Stop new partial bookings being created.
DROP TRIGGER IF EXISTS trg_mark_downpayment_booking_partial ON public.bookings;
DROP FUNCTION IF EXISTS public.mark_downpayment_booking_partial();

-- 2. The settlement RPC only ever accepted bookings that were `partially_paid` with a
--    verified online downpayment behind them, so it has nothing left to act on. It is
--    unrelated to `payment_mode = 'none'` venues, which never route money through it.
DROP FUNCTION IF EXISTS public.record_venue_settlement(bigint[], numeric, text, text);

-- 3. Any venue still on the mode collects the full amount online instead. Chosen over
--    'none' because these venues had already opted into taking money online; dropping
--    them to offline settlement would quietly change how they get paid.
UPDATE public.venues SET payment_mode = 'full' WHERE payment_mode = 'downpayment';

ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_payment_mode_check;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_payment_mode_check
  CHECK (payment_mode IN ('none', 'full'));

-- 4. The columns and their constraints.
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_downpayment_type_check;
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_downpayment_value_check;
ALTER TABLE public.venues
  DROP COLUMN IF EXISTS downpayment_type,
  DROP COLUMN IF EXISTS downpayment_value;

-- 5. Booking reminders appended "Remember to settle the balance at the venue" for a
--    partially paid booking. Replaced rather than edited in place, so the database
--    ends up correct whether or not the reminders migration has already run here.
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
    -- Which reminder, if any, is due for this session right now.
    IF _b.start_time <= now() + interval '3 hours' THEN
      _when  := 'booking_reminder_soon';
      _title := COALESCE(_b.sport_name, 'Booking') || ' starting soon';
      _body  := 'Your booking at ' || _b.venue_name || ' — ' || _b.court_name || ' starts at ' ||
                to_char(_b.start_time AT TIME ZONE COALESCE(_b.venue_tz, 'Asia/Manila'), 'FMHH12:MI AM') || '.';
    ELSIF _b.start_time >= now() + interval '6 hours' THEN
      _when  := 'booking_reminder_day';
      _title := COALESCE(_b.sport_name, 'Booking') || ' tomorrow';
      _body  := 'Your booking at ' || _b.venue_name || ' — ' || _b.court_name || ' starts tomorrow at ' ||
                to_char(_b.start_time AT TIME ZONE COALESCE(_b.venue_tz, 'Asia/Manila'), 'FMHH12:MI AM') || '.';
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
