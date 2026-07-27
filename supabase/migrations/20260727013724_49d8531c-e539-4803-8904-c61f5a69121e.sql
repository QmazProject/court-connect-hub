ALTER TABLE public.courts
  ADD COLUMN IF NOT EXISTS rate_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS unit_price numeric;

-- Resolve the rate for a single timestamp on a court.
-- Rules: [{ "days": ["mon",...], "start_hour": 6, "end_hour": 12, "rate": 250 }]
-- Later matching rule wins. No match -> courts.hourly_rate.
CREATE OR REPLACE FUNCTION public.court_rate_for_hour(_court_id bigint, _ts timestamptz)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _base numeric;
  _rules jsonb;
  _tz text;
  _local timestamp;
  _dow text;
  _hour int;
  _rule jsonb;
  _rate numeric;
BEGIN
  SELECT c.hourly_rate, c.rate_rules, COALESCE(v.timezone, 'UTC')
    INTO _base, _rules, _tz
    FROM public.courts c
    JOIN public.venues v ON v.id = c.venue_id
   WHERE c.id = _court_id;

  IF _base IS NULL THEN RETURN NULL; END IF;

  BEGIN
    _local := _ts AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    _local := _ts AT TIME ZONE 'UTC';
  END;

  _dow := lower(to_char(_local, 'dy'));
  _hour := EXTRACT(HOUR FROM _local)::int;
  _rate := _base;

  IF _rules IS NULL OR jsonb_typeof(_rules) <> 'array' THEN RETURN _rate; END IF;

  FOR _rule IN SELECT * FROM jsonb_array_elements(_rules) LOOP
    IF jsonb_typeof(_rule->'days') = 'array'
       AND (_rule->'days') ? _dow
       AND _hour >= COALESCE((_rule->>'start_hour')::int, 0)
       AND _hour <  COALESCE((_rule->>'end_hour')::int, 24)
       AND COALESCE((_rule->>'rate')::numeric, 0) > 0
    THEN
      _rate := (_rule->>'rate')::numeric;
    END IF;
  END LOOP;

  RETURN _rate;
END;
$$;

-- Sum of rates for a list of hour-start timestamps.
CREATE OR REPLACE FUNCTION public.court_price_for_hours(_court_id bigint, _hours timestamptz[])
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(SUM(public.court_rate_for_hour(_court_id, h)), 0)::numeric
  FROM unnest(_hours) AS h;
$$;

REVOKE EXECUTE ON FUNCTION public.court_rate_for_hour(bigint, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.court_price_for_hours(bigint, timestamptz[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.court_rate_for_hour(bigint, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.court_price_for_hours(bigint, timestamptz[]) TO authenticated, service_role;