-- Online payment reservations have a strict 15-minute lifetime. Booking state
-- and payment state are intentionally separate: a captured payment can exist
-- for an expired reservation and must be refunded rather than confirmed.

UPDATE public.bookings
SET payment_status = 'pending'
WHERE status = 'pending' AND payment_status = 'unpaid';

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'completed'));

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'cancelled', 'refunded', 'partial', 'partially_paid'));

CREATE OR REPLACE FUNCTION public.booking_is_active_hold(_status text, _created_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT _status = 'confirmed'
     OR (_status = 'pending' AND COALESCE(_created_at, now()) > now() - interval '15 minutes');
$function$;

CREATE OR REPLACE FUNCTION public.expire_pending_payment_holds()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _booking_ids bigint[];
BEGIN
  WITH expired AS (
    UPDATE public.bookings b
       SET status = 'expired',
           payment_status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = NULL,
           cancel_reason = 'Payment hold expired after 15 minutes',
           refund_mode = 'none',
           refund_status = 'none'
     WHERE b.status = 'pending'
       AND b.payment_status IN ('pending', 'unpaid', 'failed')
       AND b.created_at <= now() - interval '15 minutes'
     RETURNING b.id
  )
  SELECT coalesce(array_agg(id), '{}'::bigint[]) INTO _booking_ids FROM expired;

  IF coalesce(array_length(_booking_ids, 1), 0) = 0 THEN RETURN 0; END IF;

  UPDATE public.transactions
     SET status = 'cancelled'
   WHERE booking_id = ANY(_booking_ids)
     AND status = 'pending';

  RETURN array_length(_booking_ids, 1);
END;
$function$;

-- Preserve compatibility with any existing scheduled job using the old name.
CREATE OR REPLACE FUNCTION public.expire_stale_pending_bookings(
  _older_than interval DEFAULT interval '30 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN public.expire_pending_payment_holds();
END;
$function$;

-- Persist expired status without relying on a player visiting the venue page.
-- Availability still ignores an expired hold at the exact 15-minute boundary
-- even if pg_cron is not enabled for a deployment.
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-pending-payment-holds') THEN
      PERFORM cron.schedule(
        'expire-pending-payment-holds',
        '* * * * *',
        'SELECT public.expire_pending_payment_holds()'
      );
    END IF;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron scheduling was skipped (%); expire_pending_payment_holds must be scheduled externally.', SQLERRM;
END;
$block$;

CREATE OR REPLACE FUNCTION public.finalize_paid_checkout(
  _session_id text,
  _payment_id text,
  _method text
)
RETURNS TABLE(confirmed boolean, refund_required boolean, booking_ids bigint[], reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _ids bigint[];
  _count integer;
  _valid_count integer;
  _already_confirmed integer;
  _refund_queued integer;
  _pc bigint;
  _tx record;
BEGIN
  -- Lock all payment records for this checkout so duplicate webhooks are idempotent.
  FOR _tx IN
    SELECT id FROM public.transactions WHERE provider_ref = _session_id FOR UPDATE
  LOOP
    NULL;
  END LOOP;

  SELECT array_agg(DISTINCT booking_id ORDER BY booking_id), count(DISTINCT booking_id)
    INTO _ids, _count
  FROM public.transactions
  WHERE provider_ref = _session_id;

  IF _count IS NULL OR _count = 0 THEN
    RETURN QUERY SELECT false, false, '{}'::bigint[], 'Checkout transaction not found';
    RETURN;
  END IF;

  PERFORM public.expire_pending_payment_holds();

  SELECT count(*) INTO _already_confirmed
  FROM public.bookings
  WHERE id = ANY(_ids) AND status = 'confirmed' AND payment_status = 'paid';
  IF _already_confirmed = _count THEN
    RETURN QUERY SELECT true, false, _ids, 'Already confirmed';
    RETURN;
  END IF;

  -- A duplicate paid webhook must not initiate a second refund request.
  SELECT count(*) INTO _refund_queued
  FROM public.bookings
  WHERE id = ANY(_ids) AND refund_status IN ('pending', 'refunded');
  IF _refund_queued = _count THEN
    RETURN QUERY SELECT false, false, _ids, 'Refund already queued or completed';
    RETURN;
  END IF;

  -- Serialize finalization with every court on the checkout's shared surface.
  FOR _pc IN
    SELECT DISTINCT c.physical_court_id
    FROM public.courts c
    JOIN public.bookings b ON b.court_id = c.id
    WHERE b.id = ANY(_ids)
    ORDER BY c.physical_court_id
  LOOP
    PERFORM pg_advisory_xact_lock(_pc);
  END LOOP;

  SELECT count(*) INTO _valid_count
  FROM public.bookings
  WHERE id = ANY(_ids)
    AND status = 'pending'
    AND payment_status IN ('pending', 'unpaid', 'failed')
    AND created_at > now() - interval '15 minutes';

  IF _valid_count <> _count THEN
    -- Payment arrived too late or was cancelled. Never revive the reservation.
    UPDATE public.transactions
       SET status = 'paid', paid_at = now(), method = _method,
           raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('payment_id', _payment_id, 'finalization', 'reservation_unavailable')
     WHERE provider_ref = _session_id;

    UPDATE public.bookings
       SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
           payment_status = 'paid',
           refund_mode = 'auto',
           refund_status = 'pending',
           cancel_reason = coalesce(cancel_reason, 'Payment completed after reservation was no longer available')
     WHERE id = ANY(_ids);

    RETURN QUERY SELECT false, true, _ids, 'Reservation expired, cancelled, or no longer available';
    RETURN;
  END IF;

  -- Both updates are one transaction. The existing booking trigger performs
  -- the same capacity and directional court-block validation before confirm.
  UPDATE public.transactions
     SET status = 'paid', paid_at = now(), method = _method,
         raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('payment_id', _payment_id, 'finalization', 'confirmed')
   WHERE provider_ref = _session_id;

  UPDATE public.bookings
     SET status = 'confirmed', payment_status = 'paid'
   WHERE id = ANY(_ids)
     AND status = 'pending'
     AND payment_status IN ('pending', 'unpaid', 'failed')
     AND created_at > now() - interval '15 minutes';

  RETURN QUERY SELECT true, false, _ids, 'Confirmed';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.expire_pending_payment_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_payment_holds() TO service_role;
REVOKE EXECUTE ON FUNCTION public.finalize_paid_checkout(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_checkout(text, text, text) TO service_role;
