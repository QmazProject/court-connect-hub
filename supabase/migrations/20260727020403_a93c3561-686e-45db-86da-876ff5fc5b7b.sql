-- 1. Venue-level structured operating hours (source of truth)
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS operating_hours jsonb NOT NULL
  DEFAULT '{"mon":"00:00-24:00","tue":"00:00-24:00","wed":"00:00-24:00","thu":"00:00-24:00","fri":"00:00-24:00","sat":"00:00-24:00","sun":"00:00-24:00"}'::jsonb;

-- 2. Courts inherit venue hours by default; courts.operating_hours is only used when this is false
ALTER TABLE public.courts
  ADD COLUMN IF NOT EXISTS inherit_venue_hours boolean NOT NULL DEFAULT true;

-- 3. Parse "HH:MM-HH:MM" into [start_hour, end_hour]. end <= start means the window runs past midnight.
CREATE OR REPLACE FUNCTION public.parse_hours_window(_raw text)
RETURNS int[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE m text[]; s int; e int;
BEGIN
  IF _raw IS NULL THEN RETURN ARRAY[0,24]; END IF;
  m := regexp_match(btrim(_raw), '^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$');
  IF m IS NULL THEN RETURN ARRAY[0,24]; END IF;
  s := GREATEST(0, LEAST(24, m[1]::int));
  e := GREATEST(0, LEAST(24, m[3]::int));
  IF s = e THEN RETURN ARRAY[0,24]; END IF;
  RETURN ARRAY[s,e];
END;
$$;

-- 4. Effective hours map for a court: its own when overridden, otherwise the venue's.
CREATE OR REPLACE FUNCTION public.court_effective_hours(_court_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END
  FROM public.courts c
  JOIN public.venues v ON v.id = c.venue_id
  WHERE c.id = _court_id;
$$;

-- 5. Is the court open at a given instant (evaluated in the venue's timezone)?
CREATE OR REPLACE FUNCTION public.court_is_open(_court_id bigint, _ts timestamptz)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _tz text; _hours jsonb; _local timestamp; _dow int; _h int;
  _keys text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  _w int[]; _wp int[];
BEGIN
  SELECT v.timezone, CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END
    INTO _tz, _hours
  FROM public.courts c JOIN public.venues v ON v.id = c.venue_id
  WHERE c.id = _court_id;
  IF _hours IS NULL THEN RETURN true; END IF;

  _local := _ts AT TIME ZONE COALESCE(NULLIF(_tz,''), 'UTC');
  _dow := EXTRACT(DOW FROM _local)::int;
  _h := EXTRACT(HOUR FROM _local)::int;

  _w  := public.parse_hours_window(_hours ->> _keys[_dow + 1]);
  _wp := public.parse_hours_window(_hours ->> _keys[((_dow + 6) % 7) + 1]);

  -- same-day window
  IF _w[2] > _w[1] AND _h >= _w[1] AND _h < _w[2] THEN RETURN true; END IF;
  -- window that started today and runs past midnight
  IF _w[2] < _w[1] AND _h >= _w[1] THEN RETURN true; END IF;
  -- spillover from yesterday's overnight window
  IF _wp[2] < _wp[1] AND _h < _wp[2] THEN RETURN true; END IF;

  RETURN false;
END;
$$;

-- 6. Enforce operating hours on every confirmed booking, hour by hour.
CREATE OR REPLACE FUNCTION public.validate_booking()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE _pc_id BIGINT; _sport_id BIGINT; _capacity INT; _same INT; _other INT; _t timestamptz;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
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
   WHERE b.status = 'confirmed'
     AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
     AND c.physical_court_id = _pc_id AND c.sport_id <> _sport_id
     AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time;
  IF _other > 0 THEN
    RAISE EXCEPTION 'This surface is already booked for a different sport at that time.' USING ERRCODE = '23P01';
  END IF;

  SELECT COUNT(*) INTO _same
    FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
   WHERE b.status = 'confirmed'
     AND (TG_OP = 'INSERT' OR b.id <> NEW.id)
     AND c.physical_court_id = _pc_id AND c.sport_id = _sport_id
     AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time;
  IF _same >= _capacity THEN
    RAISE EXCEPTION 'All % slots for this sport at that time are already booked.', _capacity USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END; $$;

REVOKE EXECUTE ON FUNCTION public.validate_booking() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.parse_hours_window(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.court_is_open(bigint, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.court_effective_hours(bigint) TO anon, authenticated;