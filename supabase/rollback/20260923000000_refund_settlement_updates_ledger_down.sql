-- ===========================================================================
-- Rollback for 20260923000000_refund_settlement_updates_ledger.sql
--
-- Both functions are restored to the text 20260916000000 last defined, taken
-- from that migration verbatim rather than retyped.
--
-- ⚠ WHAT THIS DOES NOT UNDO. Ledger rows that the new version already marked
--   `refunded` stay refunded. That is correct — the money really was returned,
--   and reverting the status would put the ledger back to claiming income the
--   business does not have. Only the rule changes back, not the record.
--
-- After rolling back, a refund settled by staff once again updates the booking
-- and leaves the transaction row saying `paid`, and every revenue figure that
-- reads the ledger overstates by that amount. The screens read the booking
-- alongside the row, so they stay correct either way.
-- ===========================================================================

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
    SELECT tx.venue_id, tx.status, tx.amount, tx.paid_at, tx.refunded_at, tx.created_at
    FROM public.transactions tx
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