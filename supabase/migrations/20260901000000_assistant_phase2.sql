-- Phase 2 of the CourtHub Assistant: one canonical opening-hours rule, and
-- set-based operational aggregates for tenants.
--
-- Two things land here.
--
--   1. court_is_open() stops disagreeing with the rest of the system. It read its
--      window through parse_hours_window(), which returns [0,24] for anything it
--      cannot parse — including the literal 'closed'. A day a manager marked closed
--      was therefore treated as open around the clock, and the booking trigger that
--      is supposed to reject out-of-hours inserts let them through. It now reads
--      assistant_open_hours(), which is the same rule the booking grid and the
--      assistant already use, so there is one definition rather than three.
--
--   2. tenant_court_day() and tenant_activity() answer a manager's operational
--      questions across every venue they are staff on, in one round trip each. The
--      assistant previously walked the first six venues court by court.
--
-- Scope for both tenant functions is derived from auth.uid() against staff inside
-- the function. Nothing about it is passed in, so a caller cannot widen it.

-- ---------------------------------------------------------------------------
-- 1. One opening-hours rule.
-- ---------------------------------------------------------------------------

-- Behaviour change, deliberate and narrow: a weekday whose window is the literal
-- 'closed' is now closed. Every other input resolves exactly as before, including
-- an unparseable window (still open all day) and an overnight window such as
-- 18:00-02:00 (still open past midnight, via the previous day's tail).
--
-- The only caller is the bookings validation trigger, which already raises
-- 'Court not found' before reaching here, so the previous NULL-court branch that
-- returned true was unreachable.
CREATE OR REPLACE FUNCTION public.court_is_open(_court_id bigint, _ts timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.courts c
    JOIN public.venues v ON v.id = c.venue_id
    CROSS JOIN LATERAL (
      SELECT (_ts AT TIME ZONE coalesce(v.timezone, 'Asia/Manila')) AS local_ts
    ) l
    WHERE c.id = _court_id
      AND extract(hour FROM l.local_ts)::integer = ANY (
        public.assistant_open_hours(
          CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END,
          extract(dow FROM l.local_ts)::integer
        )
      )
  );
$function$;

-- ---------------------------------------------------------------------------
-- 2. Tenant: one row per court, for one venue-local date.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_court_day(
  _date date,
  _hours integer[] DEFAULT NULL,
  _now timestamptz DEFAULT now()
)
RETURNS TABLE(
  venue_id bigint,
  venue_name text,
  court_id bigint,
  court_name text,
  sport text,
  open_hours integer,
  booked_hours integer,
  held_hours integer,
  blocked_hours_count integer,
  past_hours integer,
  free_hours integer,
  free_hour_list integer[],
  booked_hour_list integer[],
  occupancy_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH scope AS (
    SELECT DISTINCT st.venue_id FROM public.staff st WHERE st.user_id = auth.uid()
  ),
  mine AS (
    SELECT c.id AS court_id,
           c.venue_id,
           v.name AS venue_name,
           c.name AS court_name,
           coalesce(s.name, '') AS sport,
           c.capacity,
           coalesce(v.timezone, 'Asia/Manila') AS tz,
           CASE WHEN c.inherit_venue_hours THEN v.operating_hours ELSE c.operating_hours END AS hrs,
           c.blocked_hours,
           c.blocked_dates
    FROM public.courts c
    JOIN public.venues v ON v.id = c.venue_id
    JOIN scope sc ON sc.venue_id = c.venue_id
    LEFT JOIN public.sports s ON s.id = c.sport_id
    WHERE c.is_active IS TRUE
      AND c.capacity IS NOT NULL
  ),
  avail AS (
    SELECT a.court_id, a.hour_start, a.remaining, a.blocked_by_other_sport, a.held_for_payment
    FROM public.courts_availability(
           (SELECT array_agg(DISTINCT court_id) FROM mine),
           ((_date - 1)::timestamp AT TIME ZONE 'Asia/Manila'),
           ((_date + 2)::timestamp AT TIME ZONE 'Asia/Manila')
         ) a
  ),
  grid AS (
    SELECT m.*,
           h.hour,
           ((_date::timestamp + make_interval(hours => h.hour)) AT TIME ZONE m.tz) AS ts,
           (h.hour = ANY (public.assistant_blocked_hours(m.blocked_hours, m.blocked_dates, _date,
                                                         extract(dow FROM _date)::integer))) AS is_blocked
    FROM mine m
    CROSS JOIN LATERAL unnest(
      public.assistant_open_hours(m.hrs, extract(dow FROM _date)::integer)
    ) AS h(hour)
    WHERE _hours IS NULL OR h.hour = ANY (_hours)
  ),
  classified AS (
    SELECT g.venue_id, g.venue_name, g.court_id, g.court_name, g.sport, g.hour,
           CASE
             WHEN g.is_blocked THEN 'blocked'
             WHEN g.ts < _now THEN 'past'
             WHEN coalesce(a.blocked_by_other_sport, false) THEN 'other_sport'
             WHEN coalesce(a.remaining, g.capacity) <= 0 THEN 'booked'
             WHEN coalesce(a.held_for_payment, false) THEN 'held'
             ELSE 'free'
           END AS state
    FROM grid g
    LEFT JOIN avail a ON a.court_id = g.court_id AND a.hour_start = g.ts
  )
  SELECT c.venue_id,
         c.venue_name,
         c.court_id,
         c.court_name,
         c.sport,
         count(*)::integer AS open_hours,
         count(*) FILTER (WHERE c.state IN ('booked', 'other_sport'))::integer AS booked_hours,
         count(*) FILTER (WHERE c.state = 'held')::integer AS held_hours,
         count(*) FILTER (WHERE c.state = 'blocked')::integer AS blocked_hours_count,
         count(*) FILTER (WHERE c.state = 'past')::integer AS past_hours,
         count(*) FILTER (WHERE c.state = 'free')::integer AS free_hours,
         coalesce(array_agg(c.hour ORDER BY c.hour) FILTER (WHERE c.state = 'free'), ARRAY[]::integer[]),
         coalesce(array_agg(c.hour ORDER BY c.hour) FILTER (WHERE c.state IN ('booked', 'other_sport')), ARRAY[]::integer[]),
         -- Occupancy counts only hours that were winnable: a past or manager-blocked
         -- hour is neither taken nor lost, and folding it in makes every evening
         -- look worse than it was.
         CASE
           WHEN count(*) FILTER (WHERE c.state NOT IN ('past', 'blocked')) = 0 THEN NULL
           ELSE round(
             100.0 * count(*) FILTER (WHERE c.state IN ('booked', 'other_sport', 'held'))
             / count(*) FILTER (WHERE c.state NOT IN ('past', 'blocked')), 0)
         END AS occupancy_pct
  FROM classified c
  GROUP BY c.venue_id, c.venue_name, c.court_id, c.court_name, c.sport
  ORDER BY c.venue_name, c.court_name;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Tenant: bookings, cancellations and money over a window.
-- ---------------------------------------------------------------------------

-- Money is reported as three separate, literal things. `paid_amount` is the sum of
-- transactions this venue actually collected through CourtHub in the window; it is
-- gross booking value, NOT net revenue — CourtHub does not know the venue's costs
-- or the payment provider's fees, so no column here may be presented as profit.
CREATE OR REPLACE FUNCTION public.tenant_activity(
  _from timestamptz,
  _to timestamptz
)
RETURNS TABLE(
  venue_id bigint,
  venue_name text,
  bookings_created integer,
  bookings_starting integer,
  cancelled_count integer,
  confirmed_count integer,
  pending_payment_count integer,
  unpaid_count integer,
  refund_pending_count integer,
  refund_settled_count integer,
  paid_amount numeric,
  pending_amount numeric,
  refunded_amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH scope AS (
    SELECT DISTINCT st.venue_id FROM public.staff st WHERE st.user_id = auth.uid()
  ),
  b AS (
    SELECT c.venue_id, bk.*
    FROM public.bookings bk
    JOIN public.courts c ON c.id = bk.court_id
    JOIN scope sc ON sc.venue_id = c.venue_id
    WHERE (bk.created_at >= _from AND bk.created_at < _to)
       OR (bk.start_time >= _from AND bk.start_time < _to)
       OR (bk.cancelled_at IS NOT NULL AND bk.cancelled_at >= _from AND bk.cancelled_at < _to)
  ),
  t AS (
    SELECT tx.venue_id, tx.status, tx.amount, tx.paid_at, tx.refunded_at, tx.created_at
    FROM public.transactions tx
    JOIN scope sc ON sc.venue_id = tx.venue_id
    WHERE (tx.paid_at >= _from AND tx.paid_at < _to)
       OR (tx.refunded_at >= _from AND tx.refunded_at < _to)
       OR (tx.created_at >= _from AND tx.created_at < _to)
  ),
  per_venue_bookings AS (
    SELECT b.venue_id,
           count(*) FILTER (WHERE b.created_at >= _from AND b.created_at < _to)::integer AS bookings_created,
           count(*) FILTER (WHERE b.start_time >= _from AND b.start_time < _to)::integer AS bookings_starting,
           count(*) FILTER (WHERE b.cancelled_at >= _from AND b.cancelled_at < _to)::integer AS cancelled_count,
           count(*) FILTER (WHERE b.status = 'confirmed')::integer AS confirmed_count,
           count(*) FILTER (WHERE b.payment_status = 'pending')::integer AS pending_payment_count,
           count(*) FILTER (WHERE b.payment_status = 'unpaid')::integer AS unpaid_count,
           count(*) FILTER (WHERE b.refund_status = 'pending')::integer AS refund_pending_count,
           count(*) FILTER (WHERE b.refund_status = 'settled')::integer AS refund_settled_count
    FROM b GROUP BY b.venue_id
  ),
  per_venue_money AS (
    SELECT t.venue_id,
           coalesce(sum(t.amount) FILTER (WHERE t.status = 'paid' AND t.paid_at >= _from AND t.paid_at < _to), 0) AS paid_amount,
           coalesce(sum(t.amount) FILTER (WHERE t.status = 'pending'), 0) AS pending_amount,
           coalesce(sum(t.amount) FILTER (WHERE t.status = 'refunded' AND t.refunded_at >= _from AND t.refunded_at < _to), 0) AS refunded_amount
    FROM t GROUP BY t.venue_id
  )
  SELECT sc.venue_id,
         v.name,
         coalesce(pb.bookings_created, 0),
         coalesce(pb.bookings_starting, 0),
         coalesce(pb.cancelled_count, 0),
         coalesce(pb.confirmed_count, 0),
         coalesce(pb.pending_payment_count, 0),
         coalesce(pb.unpaid_count, 0),
         coalesce(pb.refund_pending_count, 0),
         coalesce(pb.refund_settled_count, 0),
         coalesce(pm.paid_amount, 0),
         coalesce(pm.pending_amount, 0),
         coalesce(pm.refunded_amount, 0)
  FROM scope sc
  JOIN public.venues v ON v.id = sc.venue_id
  LEFT JOIN per_venue_bookings pb ON pb.venue_id = sc.venue_id
  LEFT JOIN per_venue_money pm ON pm.venue_id = sc.venue_id
  ORDER BY v.name;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the new aggregates.
-- ---------------------------------------------------------------------------

-- tenant_activity filters bookings on three timestamps within a staff-scoped set.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON public.bookings (created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_cancelled_at ON public.bookings (cancelled_at)
  WHERE cancelled_at IS NOT NULL;
-- Money is summed per venue over a window.
CREATE INDEX IF NOT EXISTS idx_transactions_venue_paid ON public.transactions (venue_id, paid_at);
-- A player's own booking history is read by start_time, newest first.
CREATE INDEX IF NOT EXISTS idx_bookings_user_start ON public.bookings (user_id, start_time DESC);

-- ---------------------------------------------------------------------------
-- 5. Grants.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.tenant_court_day(date, integer[], timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_court_day(date, integer[], timestamptz) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.tenant_activity(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_activity(timestamptz, timestamptz) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.court_is_open(bigint, timestamptz) FROM PUBLIC, anon;
