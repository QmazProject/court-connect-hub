-- A physical court identifies related layouts only. Whether one layout blocks
-- another is defined exclusively by the directional court_block_rules rows.
-- Pending online-payment bookings remain a short-lived hold, matching the UI.

UPDATE public.venues
SET timezone = 'Asia/Manila'
WHERE timezone IS DISTINCT FROM 'Asia/Manila';

ALTER TABLE public.venues
  ALTER COLUMN timezone SET DEFAULT 'Asia/Manila';

CREATE OR REPLACE FUNCTION public.court_is_open(_court_id bigint, _ts timestamptz)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
DECLARE
  _hours jsonb; _local timestamp; _dow integer; _h integer;
  _keys text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  _w integer[]; _wp integer[];
BEGIN
  SELECT CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END
    INTO _hours
  FROM public.courts c
  JOIN public.venues v ON v.id = c.venue_id
  WHERE c.id = _court_id;
  IF _hours IS NULL THEN RETURN true; END IF;

  _local := _ts AT TIME ZONE 'Asia/Manila';
  _dow := EXTRACT(DOW FROM _local)::integer;
  _h := EXTRACT(HOUR FROM _local)::integer;
  _w := public.parse_hours_window(_hours ->> _keys[_dow + 1]);
  _wp := public.parse_hours_window(_hours ->> _keys[((_dow + 6) % 7) + 1]);

  IF _w[2] > _w[1] AND _h >= _w[1] AND _h < _w[2] THEN RETURN true; END IF;
  IF _w[2] < _w[1] AND _h >= _w[1] THEN RETURN true; END IF;
  IF _wp[2] < _wp[1] AND _h < _wp[2] THEN RETURN true; END IF;
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_court_availability(
  _court_id bigint, _from timestamptz, _to timestamptz
)
RETURNS TABLE(hour_start timestamptz, remaining integer, blocked_by_other_sport boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _capacity integer;
BEGIN
  SELECT capacity INTO _capacity FROM public.courts WHERE id = _court_id;
  IF _capacity IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH hours AS (
    SELECT gs AS hour_start
    FROM generate_series(date_trunc('hour', _from), _to - interval '1 hour', interval '1 hour') AS gs
  ),
  same_court AS (
    SELECT h.hour_start, count(*)::integer AS n
    FROM hours h
    JOIN public.bookings b
      ON b.court_id = _court_id
     AND public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < h.hour_start + interval '1 hour'
     AND b.end_time > h.hour_start
    GROUP BY h.hour_start
  ),
  blocked AS (
    SELECT h.hour_start, count(*)::integer AS n
    FROM hours h
    JOIN public.bookings b
      ON public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < h.hour_start + interval '1 hour'
     AND b.end_time > h.hour_start
    JOIN public.court_block_rules r
      ON r.court_id = b.court_id
     AND r.blocked_court_id = _court_id
    GROUP BY h.hour_start
  )
  SELECT h.hour_start,
         CASE WHEN coalesce(blocked.n, 0) > 0 THEN 0
              ELSE greatest(_capacity - coalesce(same_court.n, 0), 0) END,
         coalesce(blocked.n, 0) > 0
  FROM hours h
  LEFT JOIN same_court USING (hour_start)
  LEFT JOIN blocked USING (hour_start)
  ORDER BY h.hour_start;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_booking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE _physical_court_id bigint; _capacity integer; _same integer; _blocked integer; _t timestamptz;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed') THEN RETURN NEW; END IF;

  SELECT physical_court_id, capacity INTO _physical_court_id, _capacity
  FROM public.courts WHERE id = NEW.court_id;
  IF _physical_court_id IS NULL THEN RAISE EXCEPTION 'Court not found'; END IF;

  -- Serialize changes for related layouts so concurrent inserts cannot both
  -- pass the directional-rule lookup before either one becomes visible.
  PERFORM pg_advisory_xact_lock(_physical_court_id);

  _t := NEW.start_time;
  WHILE _t < NEW.end_time LOOP
    IF NOT public.court_is_open(NEW.court_id, _t) THEN
      RAISE EXCEPTION 'That time is outside this court''s operating hours.' USING ERRCODE = '23514';
    END IF;
    _t := _t + interval '1 hour';
  END LOOP;

  SELECT count(*) INTO _blocked
  FROM public.bookings b
  JOIN public.court_block_rules r
    ON r.court_id = b.court_id
   AND r.blocked_court_id = NEW.court_id
  WHERE public.booking_is_active_hold(b.status, b.created_at)
    AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
    AND b.start_time < NEW.end_time
    AND b.end_time > NEW.start_time;
  IF _blocked > 0 THEN
    RAISE EXCEPTION 'Another court configured to block this court is already booked at that time.' USING ERRCODE = '23P01';
  END IF;

  SELECT count(*) INTO _same
  FROM public.bookings b
  WHERE b.court_id = NEW.court_id
    AND public.booking_is_active_hold(b.status, b.created_at)
    AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
    AND b.start_time < NEW.end_time
    AND b.end_time > NEW.start_time;
  IF _same >= _capacity THEN
    RAISE EXCEPTION 'All % slots for this court at that time are already booked.', _capacity USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO service_role;
