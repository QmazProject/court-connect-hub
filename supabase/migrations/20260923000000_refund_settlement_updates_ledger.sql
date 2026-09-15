-- ===========================================================================
-- A settled refund writes to the ledger, not only to the booking.
--
-- `staff_mark_refund_settled()` marked the booking refunded and left the
-- matching `transactions` row saying `paid`. Everything downstream that reads
-- the ledger then reported money the business had already given back: the
-- Detailed transactions list showed Paid, its Refunded filter missed the row
-- entirely, and every revenue figure — sales tiles, dashboard revenue, the
-- venue and court breakdowns, customer spend — counted it as retained.
--
-- The screens have been taught to read the booking alongside the payment row,
-- which fixes the display for rows already in this state. This migration fixes
-- the cause, so the two tables stop disagreeing in the first place.
--
-- Two functions change, and nothing else:
--   1. staff_mark_refund_settled() — also marks that booking's paid ledger row.
--   2. tenant_activity()           — its money columns read the booking too, so
--                                    the assistant's figures match the screens'.
--
-- No data is rewritten. Rows already settled the old way keep their `paid`
-- status; a backfill for those is a separate decision and is not made here.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Settling a refund now closes the ledger row as well.
-- ---------------------------------------------------------------------------
-- Identical to the Stage 4 version except for the one UPDATE marked below.
-- Admin-only, unchanged: the authorisation check still runs before anything
-- moves, and still asks `venue_allows(..., 'admin')`.
--
-- The new write is scoped to the booking being settled, never to the checkout.
-- A one-hour refund inside a three-hour checkout must leave its two siblings
-- paid, and `booking_id = _b.id` is what guarantees that. It touches only rows
-- currently `paid`, so a pending, failed or cancelled attempt is left alone,
-- and `raw`, `provider_ref` and `reference_number` are not written at all.

CREATE OR REPLACE FUNCTION public.staff_mark_refund_settled(
  _booking_ids bigint[],
  _method      text DEFAULT 'manual',
  _reference   text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _uid uuid := auth.uid(); _n int := 0; _b RECORD; _venue text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _method NOT IN ('paymongo', 'manual') THEN
    RAISE EXCEPTION 'Unknown refund method %', _method;
  END IF;

  -- Admin only, and checked before anything moves. Marking a refund settled is the
  -- statement that money left the business; it is the one action in this system that
  -- cannot be corrected from inside the application, so it sits with the person who
  -- answers for the account rather than with anyone holding a venue key.
  IF EXISTS (
    SELECT 1
      FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids)
       AND b.refund_status = 'pending'
       AND NOT public.venue_allows(c.venue_id, 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised for this venue';
  END IF;

  FOR _b IN
    SELECT b.id, b.user_id, c.venue_id
      FROM public.bookings b
      JOIN public.courts c ON c.id = b.court_id
     WHERE b.id = ANY(_booking_ids) AND b.refund_status = 'pending'
  LOOP

    UPDATE public.bookings
       SET refund_status    = 'refunded',
           payment_status   = 'refunded',
           refund_method    = _method,
           refund_reference = _reference,
           refund_settled_at = now(),
           refund_settled_by = _uid
     WHERE id = _b.id;

    -- The ledger half, and the whole point of this migration. Scoped to this one
    -- booking so the other hours of the same checkout keep their own state, and
    -- limited to rows that are actually `paid` so nothing pending or failed is
    -- quietly promoted into a refund. `refunded_at` is only set if it is empty,
    -- and no provider or payment metadata is touched.
    UPDATE public.transactions
       SET status      = 'refunded',
           refunded_at = coalesce(refunded_at, now())
     WHERE booking_id = _b.id
       AND status = 'paid';

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

REVOKE EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[], text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.staff_mark_refund_settled(bigint[], text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The assistant's money columns read the booking too.
-- ---------------------------------------------------------------------------
-- `tenant_activity()` totalled `status = 'paid'` straight off the ledger, so it
-- had the same blind spot as the screens did: a refund settled by staff stayed
-- in `paid_amount` and never reached `refunded_amount`.
--
-- Section 1 stops that happening from now on, but this function would still
-- misreport any refund settled before this migration. Reading the booking makes
-- it right for those too, and — more importantly — makes it agree with what the
-- Transactions screen shows, which is the whole point of having one rule.
--
-- Everything else is the Stage 4 text unchanged, including the manager-and-above
-- gate on the money CTE that keeps revenue away from front-desk staff.

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
SET search_path = public, pg_temp
AS $function$
  WITH scope AS (
    SELECT DISTINCT st.venue_id FROM public.staff st
     WHERE st.user_id = auth.uid()
       AND public.venue_allows(st.venue_id, 'staff')
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
    SELECT tx.venue_id,
           tx.amount, tx.paid_at, tx.refunded_at, tx.created_at,
           -- The effective state, matching what the Transactions screen shows: a
           -- booking marked refunded outranks a ledger row still saying `paid`,
           -- because two refund paths write the booking and not the row. Only a
           -- finalised refund counts — `refund_status = 'pending'` is a request.
           CASE
             WHEN tx.status = 'refunded'
               OR bk.refund_status = 'refunded'
               OR bk.payment_status = 'refunded' THEN 'refunded'
             WHEN tx.status = 'paid' OR bk.payment_status = 'paid' THEN 'paid'
             ELSE tx.status
           END AS status
    FROM public.transactions tx
    LEFT JOIN public.bookings bk ON bk.id = tx.booking_id
    JOIN scope sc ON sc.venue_id = tx.venue_id
    -- Money is manager-and-above, matching the policy on `transactions` itself. This
    -- function is SECURITY DEFINER and so reads that table with row-level security
    -- switched off; without this line it would hand a front-desk member the revenue
    -- figures that Stage 2 was written to keep from them. The booking counts above are
    -- unaffected, and a staff caller simply sees zero in the three money columns.
    WHERE public.venue_allows(tx.venue_id, 'manager')
      AND ((tx.paid_at >= _from AND tx.paid_at < _to)
       OR (tx.refunded_at >= _from AND tx.refunded_at < _to)
       OR (tx.created_at >= _from AND tx.created_at < _to))
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
           -- A refund settled by staff never sets `refunded_at` on the ledger row,
           -- so the window falls back to when the money was taken. Without this a
           -- manually settled refund would count in neither column.
           coalesce(sum(t.amount) FILTER (
             WHERE t.status = 'refunded'
               AND coalesce(t.refunded_at, t.paid_at, t.created_at) >= _from
               AND coalesce(t.refunded_at, t.paid_at, t.created_at) < _to
           ), 0) AS refunded_amount
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
