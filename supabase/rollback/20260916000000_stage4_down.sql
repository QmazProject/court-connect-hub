-- Rollback for 20260916000000_stage4_booking_chat_refund_roles.sql
--
-- Outside supabase/migrations/ on purpose: `db push` applies that folder in filename
-- order, so a rollback kept there would undo its own migration on the next push. Run
-- this by hand, only if Stage 4 has to be reversed.
--
-- The four policies are transcribed from the pg_policies dump taken before Stage 4.
-- The five functions are the previous definitions reproduced in full, extracted from
-- the migrations that created them rather than retyped — including the per-row
-- authorisation inside the two loops, which Stage 4 hoists. A rollback that kept the
-- improvement would not be a rollback.
--
-- Restoring these returns every one of these surfaces to asking only whether a `staff`
-- row exists: any team member could cancel bookings, settle refunds, and read the
-- venue's revenue through `tenant_activity`.
--
-- `venue_role()` and `venue_allows()` stay in place — Stages 2 and 3 still call them.

BEGIN;

-- ---- bookings ----------------------------------------------------------------
DROP POLICY IF EXISTS "Users can select own bookings" ON public.bookings;

-- Original: SELECT, roles {public}, no WITH CHECK.
CREATE POLICY "Users can select own bookings"
  ON public.bookings FOR SELECT
  USING (
    ((user_id = auth.uid()) OR (EXISTS ( SELECT 1
       FROM public.staff
      WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id IN ( SELECT c.venue_id
              FROM public.courts c
             WHERE (c.id = bookings.court_id)))))))
  );

-- ---- conversations -----------------------------------------------------------
DROP POLICY IF EXISTS "Participants read conversations"  ON public.conversations;
DROP POLICY IF EXISTS "Participants touch conversations" ON public.conversations;
DROP POLICY IF EXISTS "Player opens own booking thread"  ON public.conversations;

CREATE POLICY "Participants read conversations"
  ON public.conversations FOR SELECT TO authenticated
  USING (
    ((player_id = auth.uid()) OR (EXISTS ( SELECT 1
       FROM public.staff s
      WHERE ((s.venue_id = conversations.venue_id) AND (s.user_id = auth.uid())))))
  );

-- The original carried the same expression in USING and WITH CHECK.
CREATE POLICY "Participants touch conversations"
  ON public.conversations FOR UPDATE TO authenticated
  USING (
    ((player_id = auth.uid()) OR (EXISTS ( SELECT 1
       FROM public.staff s
      WHERE ((s.venue_id = conversations.venue_id) AND (s.user_id = auth.uid())))))
  )
  WITH CHECK (
    ((player_id = auth.uid()) OR (EXISTS ( SELECT 1
       FROM public.staff s
      WHERE ((s.venue_id = conversations.venue_id) AND (s.user_id = auth.uid())))))
  );

CREATE POLICY "Player opens own booking thread"
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (
    (((player_id = auth.uid()) AND (EXISTS ( SELECT 1
        FROM public.bookings b
       WHERE ((b.id = conversations.booking_id) AND (b.user_id = auth.uid())))))
     OR (EXISTS ( SELECT 1
        FROM public.staff s
       WHERE ((s.venue_id = conversations.venue_id) AND (s.user_id = auth.uid())))))
  );

-- ---- functions, previous definitions in full ---------------------------------

CREATE OR REPLACE FUNCTION public.is_conversation_participant(_conversation_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = _conversation_id
      AND (c.player_id = _uid
           OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = c.venue_id AND s.user_id = _uid))
  );
$$;


CREATE OR REPLACE FUNCTION public.staff_cancel_bookings(
  _booking_ids bigint[], _reason text, _refund_mode text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _n int := 0;
  _b RECORD;
  _players uuid[] := '{}';
  _p uuid;
  _venue_name text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _refund_mode NOT IN ('auto', 'manual', 'none') THEN
    RAISE EXCEPTION 'Invalid refund mode';
  END IF;

  FOR _b IN
    SELECT b.id, b.user_id, b.payment_status, c.venue_id
      FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids) AND b.status <> 'cancelled'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = _b.venue_id AND s.user_id = _uid) THEN
      RAISE EXCEPTION 'Not authorised for this venue';
    END IF;

    UPDATE public.bookings
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = _uid,
           cancel_reason = NULLIF(trim(COALESCE(_reason, '')), ''),
           refund_mode = CASE WHEN _b.payment_status = 'paid' THEN _refund_mode ELSE 'none' END,
           refund_status = CASE
             WHEN _b.payment_status <> 'paid' THEN 'none'
             WHEN _refund_mode = 'none' THEN 'none'
             ELSE 'pending' END
     WHERE id = _b.id;

    _n := _n + 1;
    IF NOT (_b.user_id = ANY(_players)) THEN
      _players := array_append(_players, _b.user_id);
      SELECT name INTO _venue_name FROM public.venues WHERE id = _b.venue_id;
      PERFORM public.notify_user(_b.user_id, 'booking_cancelled',
        'Booking cancelled by ' || COALESCE(_venue_name, 'the venue'),
        COALESCE(NULLIF(trim(COALESCE(_reason, '')), ''), 'Your reservation was cancelled.')
          || CASE WHEN _refund_mode = 'auto' THEN ' A refund has been requested to your original payment method.'
                  WHEN _refund_mode = 'manual' THEN ' The venue will settle your refund directly.'
                  ELSE '' END,
        '/dashboard', _b.id, _b.venue_id, NULL);
    END IF;
  END LOOP;

  RETURN _n;
END; $$;


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


COMMIT;
