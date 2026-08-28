-- Server-side discovery for the CourtHub Assistant.
--
-- Before this, a broad question ("what is available tonight") walked venues in the
-- browser and called get_court_availability once per court, so it was capped at six
-- venues to stay responsive. That cap is a correctness problem, not a speed one: the
-- only free court in the city could sit at venue seven and never be found.
--
-- Three things land here:
--   1. courts_availability(...) — the existing per-court rules, expressed once, for
--      many courts at a time. get_court_availability now delegates to it, so the
--      booking grid and the assistant cannot drift apart.
--   2. assistant_open_hours / assistant_blocked_hours — the operating-hours and
--      manager-closure rules as the *TypeScript* reads them. Deliberately not
--      parse_hours_window: that helper treats an unparseable window as open all day,
--      including the literal 'closed', which would advertise a shut court as free.
--   3. search_available_courts(...) — one call that filters, prices, ranks and pages
--      the whole eligible catalogue.

-- ---------------------------------------------------------------------------
-- 1. Operating hours, matching src/lib/operating-hours.ts exactly.
-- ---------------------------------------------------------------------------

-- Mirrors parseWindow(): NULL only for the literal 'closed'; anything unparseable is
-- open all day, which is what the UI already shows.
CREATE OR REPLACE FUNCTION public.assistant_window(_raw text)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE _t text; m text[]; s integer; e integer;
BEGIN
  IF _raw IS NULL THEN RETURN ARRAY[0, 24]; END IF;
  _t := btrim(_raw);
  IF _t = '' THEN RETURN ARRAY[0, 24]; END IF;
  IF _t = 'closed' THEN RETURN NULL; END IF;
  m := regexp_match(_t, '^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$');
  IF m IS NULL THEN RETURN ARRAY[0, 24]; END IF;
  s := GREATEST(0, LEAST(24, m[1]::integer));
  e := GREATEST(0, LEAST(24, m[3]::integer));
  IF s = e THEN RETURN ARRAY[0, 24]; END IF;
  RETURN ARRAY[s, e];
END;
$function$;

-- Local hours 0-23 a court is open on one weekday, including yesterday's overnight
-- tail. Mirrors openHoursForDay().
CREATE OR REPLACE FUNCTION public.assistant_open_hours(_hours jsonb, _dow integer)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE
  _keys text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  _w integer[]; _wp integer[]; _out integer[] := ARRAY[]::integer[]; h integer;
BEGIN
  IF _hours IS NULL OR jsonb_typeof(_hours) <> 'object' THEN
    RETURN ARRAY(SELECT generate_series(0, 23));
  END IF;

  _w  := public.assistant_window(_hours ->> _keys[_dow + 1]);
  _wp := public.assistant_window(_hours ->> _keys[((_dow + 6) % 7) + 1]);

  IF _w IS NOT NULL THEN
    IF _w[2] > _w[1] THEN
      FOR h IN _w[1].._w[2] - 1 LOOP _out := _out || h; END LOOP;
    ELSE
      FOR h IN _w[1]..23 LOOP _out := _out || h; END LOOP;
    END IF;
  END IF;

  IF _wp IS NOT NULL AND _wp[2] < _wp[1] THEN
    FOR h IN 0.._wp[2] - 1 LOOP
      IF NOT (h = ANY(_out)) THEN _out := _out || h; END IF;
    END LOOP;
  END IF;

  RETURN _out;
END;
$function$;

-- Manager closures: an exact-date override wins over the weekday pattern, which is
-- the precedence CourtBookingPanel applies.
CREATE OR REPLACE FUNCTION public.assistant_blocked_hours(
  _blocked_hours jsonb, _blocked_dates jsonb, _date date, _dow integer
)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE
  _keys text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  _node jsonb;
BEGIN
  IF _blocked_dates IS NOT NULL AND jsonb_typeof(_blocked_dates) = 'object' THEN
    _node := _blocked_dates -> to_char(_date, 'YYYY-MM-DD');
  END IF;
  IF _node IS NULL AND _blocked_hours IS NOT NULL AND jsonb_typeof(_blocked_hours) = 'object' THEN
    _node := _blocked_hours -> _keys[_dow + 1];
  END IF;
  IF _node IS NULL OR jsonb_typeof(_node) <> 'array' THEN RETURN ARRAY[]::integer[]; END IF;
  RETURN ARRAY(SELECT (jsonb_array_elements_text(_node))::integer);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Availability for many courts at once — the single definition.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.courts_availability(
  _court_ids bigint[], _from timestamptz, _to timestamptz
)
RETURNS TABLE(
  court_id bigint,
  hour_start timestamptz,
  remaining integer,
  blocked_by_other_sport boolean,
  held_for_payment boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH target AS (
    SELECT c.id, c.capacity
    FROM public.courts c
    WHERE c.id = ANY(_court_ids)
      AND c.capacity IS NOT NULL
  ),
  hours AS (
    SELECT gs AS hour_start
    FROM generate_series(date_trunc('hour', _from), _to - interval '1 hour', interval '1 hour') AS gs
  ),
  grid AS (
    SELECT t.id AS court_id, t.capacity, h.hour_start
    FROM target t CROSS JOIN hours h
  ),
  same_court AS (
    SELECT g.court_id, g.hour_start,
           count(*) FILTER (WHERE b.status = 'confirmed')::integer AS confirmed_count,
           count(*) FILTER (WHERE b.status = 'pending')::integer AS pending_count
    FROM grid g
    JOIN public.bookings b
      ON b.court_id = g.court_id
     AND public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < g.hour_start + interval '1 hour'
     AND b.end_time > g.hour_start
    GROUP BY g.court_id, g.hour_start
  ),
  blocking AS (
    SELECT g.court_id, g.hour_start,
           count(*) FILTER (WHERE b.status = 'confirmed')::integer AS confirmed_count,
           count(*) FILTER (WHERE b.status = 'pending')::integer AS pending_count
    FROM grid g
    JOIN public.court_block_rules r
      ON r.blocked_court_id = g.court_id
    JOIN public.bookings b
      ON b.court_id = r.court_id
     AND public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < g.hour_start + interval '1 hour'
     AND b.end_time > g.hour_start
    GROUP BY g.court_id, g.hour_start
  )
  SELECT g.court_id,
         g.hour_start,
         CASE WHEN coalesce(bl.confirmed_count, 0) + coalesce(bl.pending_count, 0) > 0 THEN 0
              ELSE greatest(g.capacity - coalesce(sc.confirmed_count, 0) - coalesce(sc.pending_count, 0), 0) END,
         coalesce(bl.confirmed_count, 0) + coalesce(bl.pending_count, 0) > 0,
         (
           coalesce(bl.confirmed_count, 0) = 0
           AND coalesce(sc.confirmed_count, 0) = 0
           AND (
             coalesce(bl.pending_count, 0) > 0
             OR coalesce(sc.pending_count, 0) >= g.capacity
           )
         )
  FROM grid g
  LEFT JOIN same_court sc ON sc.court_id = g.court_id AND sc.hour_start = g.hour_start
  LEFT JOIN blocking  bl ON bl.court_id = g.court_id AND bl.hour_start = g.hour_start
  ORDER BY g.court_id, g.hour_start;
$function$;

-- The booking grid's entry point, now a thin wrapper. Same signature, same columns,
-- same rules — there is only one implementation of them left.
CREATE OR REPLACE FUNCTION public.get_court_availability(
  _court_id bigint, _from timestamptz, _to timestamptz
)
RETURNS TABLE(
  hour_start timestamptz,
  remaining integer,
  blocked_by_other_sport boolean,
  held_for_payment boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT a.hour_start, a.remaining, a.blocked_by_other_sport, a.held_for_payment
  FROM public.courts_availability(ARRAY[_court_id], _from, _to) a
  ORDER BY a.hour_start;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Broad discovery.
-- ---------------------------------------------------------------------------

-- Returns one row per court that can actually be played on, already filtered,
-- priced at the real rate for the hours in question, ordered and paged.
--
-- Security: _venue_ids only ever narrows. Tenant scope is derived from auth.uid()
-- against the staff table inside the function, never from an argument, so a caller
-- cannot widen their own reach by passing someone else's venue ids.
CREATE OR REPLACE FUNCTION public.search_available_courts(
  _date date,
  _hours integer[] DEFAULT NULL,
  _min_duration integer DEFAULT 1,
  _sport_slug text DEFAULT NULL,
  _venue_ids bigint[] DEFAULT NULL,
  _tenant_scope boolean DEFAULT false,
  _lat double precision DEFAULT NULL,
  _lng double precision DEFAULT NULL,
  _max_km double precision DEFAULT NULL,
  _min_price numeric DEFAULT NULL,
  _max_price numeric DEFAULT NULL,
  _payment text DEFAULT NULL,
  _amenities text[] DEFAULT NULL,
  _order text DEFAULT 'relevance',
  _now timestamptz DEFAULT now(),
  _limit integer DEFAULT 5,
  _offset integer DEFAULT 0
)
RETURNS TABLE(
  court_id bigint,
  venue_id bigint,
  free_hours integer[],
  free_hour_count integer,
  run_start integer,
  run_length integer,
  period_total numeric,
  period_rate numeric,
  distance_km double precision,
  total_matches bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH params AS (
    SELECT greatest(coalesce(_min_duration, 1), 1) AS dur,
           extract(dow FROM _date)::integer AS dow,
           coalesce(array_length(_hours, 1), 0) AS want_n
  ),
  candidates AS (
    SELECT c.id AS court_id,
           c.venue_id,
           c.capacity,
           coalesce(v.timezone, 'Asia/Manila') AS tz,
           CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END AS hrs,
           c.blocked_hours,
           c.blocked_dates,
           CASE
             WHEN _lat IS NULL OR _lng IS NULL OR v.latitude IS NULL OR v.longitude IS NULL THEN NULL
             ELSE 2 * 6371 * asin(sqrt(
                    power(sin(radians(v.latitude::double precision - _lat) / 2), 2)
                    + cos(radians(_lat)) * cos(radians(v.latitude::double precision))
                      * power(sin(radians(v.longitude::double precision - _lng) / 2), 2)))
           END AS distance_km
    FROM public.courts c
    JOIN public.venues v ON v.id = c.venue_id
    LEFT JOIN public.sports s ON s.id = c.sport_id
    WHERE c.is_active IS TRUE
      AND v.is_active IS TRUE
      AND coalesce(c.coming_soon, false) IS FALSE
      AND c.capacity IS NOT NULL
      AND (_sport_slug IS NULL OR s.slug = _sport_slug)
      AND (_venue_ids IS NULL OR c.venue_id = ANY(_venue_ids))
      AND (
        _tenant_scope IS NOT TRUE
        OR c.venue_id IN (SELECT st.venue_id FROM public.staff st WHERE st.user_id = auth.uid())
      )
      AND (
        _payment IS NULL
        OR (_payment = 'online' AND coalesce(v.payment_mode, 'none') <> 'none')
        OR (_payment = 'venue'  AND coalesce(v.payment_mode, 'none') = 'none')
      )
      AND (
        _amenities IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(_amenities) AS want(term)
          WHERE NOT EXISTS (
            SELECT 1
            FROM unnest(coalesce(v.amenities, ARRAY[]::text[])
                        || coalesce(v.facility_services, ARRAY[]::text[])
                        || coalesce(v.food_beverages, ARRAY[]::text[])
                        || coalesce(c.amenities, ARRAY[]::text[])) AS have(label)
            WHERE have.label ILIKE '%' || want.term || '%'
          )
        )
      )
  ),
  in_range AS (
    SELECT * FROM candidates
    WHERE _max_km IS NULL OR distance_km IS NULL OR distance_km <= _max_km
  ),
  avail AS (
    SELECT a.court_id, a.hour_start, a.remaining, a.blocked_by_other_sport, a.held_for_payment
    FROM public.courts_availability(
           (SELECT array_agg(DISTINCT court_id) FROM in_range),
           ((_date - 1)::timestamp AT TIME ZONE 'Asia/Manila'),
           ((_date + 2)::timestamp AT TIME ZONE 'Asia/Manila')
         ) a
  ),
  slotted AS (
    SELECT r.court_id,
           r.venue_id,
           r.capacity,
           r.distance_km,
           h.hour,
           ((_date::timestamp + make_interval(hours => h.hour)) AT TIME ZONE r.tz) AS ts
    FROM in_range r
    CROSS JOIN params p
    CROSS JOIN LATERAL unnest(public.assistant_open_hours(r.hrs, p.dow)) AS h(hour)
    WHERE NOT (h.hour = ANY(public.assistant_blocked_hours(r.blocked_hours, r.blocked_dates, _date, p.dow)))
  ),
  free AS (
    SELECT s.court_id,
           s.venue_id,
           s.distance_km,
           s.hour,
           public.court_rate_for_hour(s.court_id, s.ts) AS rate
    FROM slotted s
    LEFT JOIN avail a ON a.court_id = s.court_id AND a.hour_start = s.ts
    WHERE s.ts >= _now
      AND coalesce(a.remaining, s.capacity) > 0
      AND coalesce(a.blocked_by_other_sport, false) IS FALSE
      AND coalesce(a.held_for_payment, false) IS FALSE
  ),
  per_court AS (
    SELECT f.court_id,
           f.venue_id,
           f.distance_km,
           array_agg(f.hour ORDER BY f.hour) AS free_hours,
           count(*)::integer AS free_hour_count
    FROM free f
    GROUP BY f.court_id, f.venue_id, f.distance_km
  ),
  -- Every hour the question named must be free, or the court does not qualify.
  required AS (
    SELECT f.court_id, sum(f.rate) AS total, count(*)::integer AS n, min(f.hour) AS start_hour
    FROM free f, params p
    WHERE p.want_n > 0 AND f.hour = ANY(_hours)
    GROUP BY f.court_id
    HAVING count(*) = (SELECT want_n FROM params)
  ),
  -- No hours named: the cheapest contiguous block of the requested length. The
  -- count check is what enforces contiguity — free rows are one per open hour.
  windows AS (
    SELECT f1.court_id,
           f1.hour AS start_hour,
           sum(f2.rate) AS win_total
    FROM free f1
    JOIN params p ON true
    JOIN free f2
      ON f2.court_id = f1.court_id
     AND f2.hour >= f1.hour
     AND f2.hour <= f1.hour + p.dur - 1
    WHERE (SELECT want_n FROM params) = 0
    GROUP BY f1.court_id, f1.hour, p.dur
    HAVING count(*) = (SELECT dur FROM params)
  ),
  matched AS (
    SELECT pc.court_id,
           pc.venue_id,
           pc.free_hours,
           pc.free_hour_count,
           coalesce(rq.start_hour, w.start_hour) AS run_start,
           CASE WHEN (SELECT want_n FROM params) > 0
                THEN (SELECT want_n FROM params)
                ELSE (SELECT dur FROM params) END AS run_length,
           coalesce(rq.total, w.win_total) AS period_total,
           pc.distance_km
    FROM per_court pc
    LEFT JOIN required rq ON rq.court_id = pc.court_id
    LEFT JOIN LATERAL (
      SELECT wi.start_hour, wi.win_total
      FROM windows wi
      WHERE wi.court_id = pc.court_id
      ORDER BY wi.win_total ASC, wi.start_hour ASC
      LIMIT 1
    ) w ON true
    WHERE ((SELECT want_n FROM params) > 0 AND rq.court_id IS NOT NULL)
       OR ((SELECT want_n FROM params) = 0 AND w.start_hour IS NOT NULL)
  ),
  priced AS (
    SELECT m.*, (m.period_total / nullif(m.run_length, 0)) AS period_rate
    FROM matched m
  ),
  filtered AS (
    SELECT * FROM priced
    WHERE (_max_price IS NULL OR period_rate <= _max_price)
      AND (_min_price IS NULL OR period_rate >= _min_price)
  )
  SELECT f.court_id,
         f.venue_id,
         f.free_hours,
         f.free_hour_count,
         f.run_start,
         f.run_length,
         f.period_total,
         f.period_rate,
         f.distance_km,
         count(*) OVER () AS total_matches
  FROM filtered f
  ORDER BY
    CASE WHEN _order = 'price'    THEN f.period_rate::double precision END ASC NULLS LAST,
    CASE WHEN _order = 'distance' THEN f.distance_km END ASC NULLS LAST,
    CASE WHEN _order = 'time'     THEN f.run_start::double precision END ASC NULLS LAST,
    f.distance_km ASC NULLS LAST,
    f.period_rate ASC NULLS LAST,
    f.run_start ASC,
    f.court_id ASC
  LIMIT greatest(coalesce(_limit, 5), 1)
  OFFSET greatest(coalesce(_offset, 0), 0);
$function$;

-- ---------------------------------------------------------------------------
-- 4. Indexes the above actually needs.
-- ---------------------------------------------------------------------------

-- Availability joins bookings by court and time window on every call; there was no
-- index covering it, so each lookup was a scan of the whole booking table.
CREATE INDEX IF NOT EXISTS idx_bookings_court_time
  ON public.bookings (court_id, start_time, end_time);

-- Tenant scoping resolves staff rows by the signed-in user on every scoped search.
CREATE INDEX IF NOT EXISTS idx_staff_user_venue
  ON public.staff (user_id, venue_id);

-- Candidate selection filters courts by venue and active state, then by sport.
CREATE INDEX IF NOT EXISTS idx_courts_venue_active
  ON public.courts (venue_id, is_active);
CREATE INDEX IF NOT EXISTS idx_courts_sport
  ON public.courts (sport_id);

-- ---------------------------------------------------------------------------
-- 5. Grants. Availability stays as anonymous as it already was.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.assistant_window(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assistant_open_hours(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assistant_blocked_hours(jsonb, jsonb, date, integer) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.courts_availability(bigint[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.courts_availability(bigint[], timestamptz, timestamptz) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.search_available_courts(
  date, integer[], integer, text, bigint[], boolean, double precision, double precision,
  double precision, numeric, numeric, text, text[], text, timestamptz, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_available_courts(
  date, integer[], integer, text, bigint[], boolean, double precision, double precision,
  double precision, numeric, numeric, text, text[], text, timestamptz, integer, integer
) TO anon, authenticated, service_role;
