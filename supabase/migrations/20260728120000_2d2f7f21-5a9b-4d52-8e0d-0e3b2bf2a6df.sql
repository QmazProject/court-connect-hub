-- Treat pending bookings as a temporary hold for 15 minutes.
CREATE OR REPLACE FUNCTION public.booking_is_active_hold(
  _status text,
  _created_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT _status = 'confirmed'
     OR (
       _status = 'pending'
       AND COALESCE(_created_at, now()) > now() - interval '15 minutes'
     );
$function$;

GRANT EXECUTE ON FUNCTION public.booking_is_active_hold(text, timestamptz) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_court_bookings(_court_id bigint, _from timestamptz, _to timestamptz)
RETURNS TABLE(start_time timestamptz, end_time timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT start_time, end_time
  FROM public.bookings
  WHERE court_id = _court_id
    AND public.booking_is_active_hold(status, created_at)
    AND start_time < _to
    AND end_time > _from;
$function$;

CREATE OR REPLACE FUNCTION public.get_court_availability(
  _court_id bigint, _from timestamptz, _to timestamptz
)
RETURNS TABLE(hour_start timestamptz, remaining integer, blocked_by_other_sport boolean)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE _pc_id BIGINT; _sport_id BIGINT; _capacity INT;
BEGIN
  SELECT physical_court_id, sport_id, capacity INTO _pc_id, _sport_id, _capacity
    FROM public.courts WHERE id = _court_id;
  IF _pc_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH hours AS (
    SELECT gs AS hour_start
      FROM generate_series(date_trunc('hour', _from), _to - interval '1 hour', interval '1 hour') AS gs
  ),
  same_sport AS (
    SELECT h.hour_start, COUNT(*)::INT AS n
      FROM hours h
      JOIN public.bookings b
        ON public.booking_is_active_hold(b.status, b.created_at)
      JOIN public.courts sib ON sib.id = b.court_id
     WHERE sib.physical_court_id = _pc_id AND sib.sport_id = _sport_id
       AND b.start_time < h.hour_start + interval '1 hour' AND b.end_time > h.hour_start
     GROUP BY h.hour_start
  ),
  other_sport AS (
    SELECT h.hour_start, COUNT(*)::INT AS n
      FROM hours h
      JOIN public.bookings b
        ON public.booking_is_active_hold(b.status, b.created_at)
      JOIN public.courts sib ON sib.id = b.court_id
     WHERE sib.physical_court_id = _pc_id AND sib.sport_id <> _sport_id
       AND b.start_time < h.hour_start + interval '1 hour' AND b.end_time > h.hour_start
     GROUP BY h.hour_start
  )
  SELECT h.hour_start,
         CASE WHEN COALESCE(o.n, 0) > 0 THEN 0
              ELSE GREATEST(_capacity - COALESCE(s.n, 0), 0) END,
         COALESCE(o.n, 0) > 0
    FROM hours h
    LEFT JOIN same_sport s USING (hour_start)
    LEFT JOIN other_sport o USING (hour_start)
    ORDER BY h.hour_start;
END; $function$;

CREATE OR REPLACE FUNCTION public.validate_booking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE _pc_id BIGINT; _sport_id BIGINT; _capacity INT; _same INT; _other INT; _t timestamptz;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed') THEN RETURN NEW; END IF;
  SELECT physical_court_id, sport_id, capacity INTO _pc_id, _sport_id, _capacity
    FROM public.courts WHERE id = NEW.court_id;
  IF _pc_id IS NULL THEN RAISE EXCEPTION 'Court not found'; END IF;

  _t := NEW.start_time;
  WHILE _t < NEW.end_time LOOP
    IF NOT public.court_is_open(NEW.court_id, _t) THEN
      RAISE EXCEPTION 'That time is outside this court''s operating hours.' USING ERRCODE = '23514';
    END IF;
    _t := _t + interval '1 hour';
  END LOOP;

  SELECT COUNT(*) INTO _other
    FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
   WHERE public.booking_is_active_hold(b.status, b.created_at)
     AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
     AND c.physical_court_id = _pc_id AND c.sport_id <> _sport_id
     AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time;
  IF _other > 0 THEN
    RAISE EXCEPTION 'This surface is already booked for a different sport at that time.' USING ERRCODE = '23P01';
  END IF;

  SELECT COUNT(*) INTO _same
    FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
   WHERE public.booking_is_active_hold(b.status, b.created_at)
     AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
     AND c.physical_court_id = _pc_id AND c.sport_id = _sport_id
     AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time;
  IF _same >= _capacity THEN
    RAISE EXCEPTION 'All % slots for this sport at that time are already booked.', _capacity USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.expire_stale_pending_bookings(
  _older_than interval DEFAULT interval '30 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _booking_ids bigint[];
BEGIN
  WITH expired AS (
    UPDATE public.bookings b
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = NULL,
           cancel_reason = 'Pending booking expired after 30 minutes',
           refund_mode = 'none',
           refund_status = 'none'
     WHERE b.status = 'pending'
       AND b.payment_status = 'unpaid'
       AND b.created_at < now() - _older_than
     RETURNING b.id
  )
  SELECT COALESCE(array_agg(id), '{}'::bigint[])
    INTO _booking_ids
    FROM expired;

  IF COALESCE(array_length(_booking_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.transactions t
     SET status = 'cancelled'
   WHERE t.booking_id = ANY(_booking_ids)
     AND t.status = 'pending';

  RETURN COALESCE(array_length(_booking_ids, 1), 0);
END; $function$;

REVOKE EXECUTE ON FUNCTION public.expire_stale_pending_bookings(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_pending_bookings(interval) TO service_role;
