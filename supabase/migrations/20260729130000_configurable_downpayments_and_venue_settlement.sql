-- Configurable online payment collection per venue. Legacy downpayment_50
-- venues remain valid and are normalized to a percentage downpayment.
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS downpayment_type text NOT NULL DEFAULT 'percent',
  ADD COLUMN IF NOT EXISTS downpayment_value numeric(12,2) NOT NULL DEFAULT 50;

ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_payment_mode_check;
UPDATE public.venues
SET payment_mode = 'downpayment', downpayment_type = 'percent', downpayment_value = 50
WHERE payment_mode = 'downpayment_50';
ALTER TABLE public.venues
  ADD CONSTRAINT venues_payment_mode_check
  CHECK (payment_mode IN ('none', 'full', 'downpayment'));
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_downpayment_type_check;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_downpayment_type_check
  CHECK (downpayment_type IN ('percent', 'fixed'));
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_downpayment_value_check;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_downpayment_value_check
  CHECK (downpayment_value > 0 AND (downpayment_type <> 'percent' OR downpayment_value <= 100));

-- A successful online downpayment confirms the reservation but does not mark
-- its total price as fully paid. The checkout stores payment_kind in raw.
CREATE OR REPLACE FUNCTION public.mark_downpayment_booking_partial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF OLD.status <> 'confirmed'
     AND NEW.status = 'confirmed'
     AND NEW.payment_status = 'paid'
     AND EXISTS (
       SELECT 1 FROM public.transactions t
       WHERE t.booking_id = NEW.id
         AND t.status = 'paid'
         AND t.provider = 'paymongo'
         AND t.raw ->> 'payment_kind' = 'downpayment'
     ) THEN
    UPDATE public.bookings SET payment_status = 'partially_paid' WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mark_downpayment_booking_partial ON public.bookings;
CREATE TRIGGER trg_mark_downpayment_booking_partial
  AFTER UPDATE OF status, payment_status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.mark_downpayment_booking_partial();

-- Staff can record cash, card, or e-wallet balance payments collected at the
-- venue. Each amount is allocated to the supplied booking rows without ever
-- exceeding the verified balance.
CREATE OR REPLACE FUNCTION public.record_venue_settlement(
  _booking_ids bigint[],
  _amount numeric,
  _method text,
  _note text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _venue_id bigint;
  _remaining numeric(12,2) := round(_amount, 2);
  _outstanding numeric(12,2) := 0;
  _expected numeric(12,2);
  _already_paid numeric(12,2);
  _allocation numeric(12,2);
  _booking_count integer;
  _eligible_count integer;
  _booking record;
BEGIN
  IF coalesce(array_length(_booking_ids, 1), 0) = 0 OR _remaining <= 0 THEN
    RAISE EXCEPTION 'A positive settlement amount and at least one booking are required';
  END IF;
  IF length(trim(coalesce(_method, ''))) = 0 THEN RAISE EXCEPTION 'Payment method is required'; END IF;

  SELECT c.venue_id INTO _venue_id
  FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
  WHERE b.id = _booking_ids[1];
  IF _venue_id IS NULL THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = _venue_id AND s.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only venue staff can record a settlement';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
    WHERE b.id = ANY(_booking_ids) AND c.venue_id <> _venue_id
  ) THEN RAISE EXCEPTION 'Bookings must belong to one venue'; END IF;

  SELECT count(*) INTO _booking_count
  FROM public.bookings
  WHERE id = ANY(_booking_ids);
  IF _booking_count <> cardinality(ARRAY(SELECT DISTINCT unnest(_booking_ids))) THEN
    RAISE EXCEPTION 'One or more bookings could not be found';
  END IF;

  -- A venue settlement is only the remaining balance of a verified online
  -- downpayment. This prevents staff from adding offline payments to unrelated bookings.
  SELECT count(*) INTO _eligible_count
  FROM public.bookings b
  WHERE b.id = ANY(_booking_ids)
    AND b.status IN ('confirmed', 'completed')
    AND b.payment_status = 'partially_paid'
    AND EXISTS (
      SELECT 1 FROM public.transactions t
      WHERE t.booking_id = b.id
        AND t.status = 'paid'
        AND t.provider = 'paymongo'
        AND t.raw ->> 'payment_kind' = 'downpayment'
    );
  IF _eligible_count <> _booking_count THEN
    RAISE EXCEPTION 'Only confirmed bookings with an online downpayment can be settled';
  END IF;

  FOR _booking IN
    SELECT b.id, b.user_id, coalesce(b.unit_price, 0) - coalesce(b.discount_amount, 0) AS expected
    FROM public.bookings b WHERE b.id = ANY(_booking_ids)
  LOOP
    SELECT coalesce(sum(t.amount), 0) INTO _already_paid
    FROM public.transactions t WHERE t.booking_id = _booking.id AND t.status = 'paid';
    _outstanding := _outstanding + greatest(round(_booking.expected - _already_paid, 2), 0);
  END LOOP;
  IF _outstanding < _remaining THEN RAISE EXCEPTION 'Amount exceeds the outstanding balance of %', _outstanding; END IF;

  FOR _booking IN
    SELECT b.id, b.user_id, coalesce(b.unit_price, 0) - coalesce(b.discount_amount, 0) AS expected
    FROM public.bookings b WHERE b.id = ANY(_booking_ids) ORDER BY b.id
  LOOP
    SELECT coalesce(sum(t.amount), 0) INTO _already_paid
    FROM public.transactions t WHERE t.booking_id = _booking.id AND t.status = 'paid';
    _allocation := least(_remaining, greatest(round(_booking.expected - _already_paid, 2), 0));
    IF _allocation > 0 THEN
      INSERT INTO public.transactions (booking_id, venue_id, user_id, amount, currency, method, provider, status, mode, paid_at, raw)
      VALUES (_booking.id, _venue_id, _booking.user_id, _allocation, 'PHP', trim(_method), 'venue', 'paid', 'live', now(), jsonb_build_object('payment_kind', 'venue_settlement', 'note', nullif(trim(_note), '')));
      _remaining := round(_remaining - _allocation, 2);
      UPDATE public.bookings
      SET payment_status = CASE WHEN round(_booking.expected - _already_paid - _allocation, 2) <= 0.01 THEN 'paid' ELSE 'partially_paid' END
      WHERE id = _booking.id;
    END IF;
  END LOOP;
  RETURN round(_amount - _remaining, 2);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.record_venue_settlement(bigint[], numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_venue_settlement(bigint[], numeric, text, text) TO authenticated;
