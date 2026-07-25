DROP TRIGGER IF EXISTS bookings_apply_voucher ON public.bookings;

CREATE OR REPLACE FUNCTION public.apply_booking_voucher()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _v RECORD;
  _court RECORD;
  _uses INT;
  _user_uses INT;
  _exists INT;
BEGIN
  IF NEW.voucher_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM 'confirmed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN RETURN NEW; END IF;

  -- Skip if redemption already recorded for this booking
  SELECT COUNT(*) INTO _exists FROM public.voucher_redemptions WHERE booking_id = NEW.id;
  IF _exists > 0 THEN RETURN NEW; END IF;

  SELECT id, venue_id, voucher_enabled INTO _court FROM public.courts WHERE id = NEW.court_id;
  IF NOT FOUND OR NOT _court.voucher_enabled THEN
    RAISE EXCEPTION 'This court does not accept vouchers';
  END IF;

  SELECT * INTO _v FROM public.vouchers WHERE id = NEW.voucher_id AND venue_id = _court.venue_id;
  IF NOT FOUND OR NOT _v.is_active THEN
    RAISE EXCEPTION 'Voucher is not available';
  END IF;

  IF _v.expires_at IS NOT NULL AND _v.expires_at < now() THEN
    RAISE EXCEPTION 'Voucher has expired';
  END IF;

  IF _v.max_uses IS NOT NULL THEN
    SELECT COUNT(*) INTO _uses FROM public.voucher_redemptions WHERE voucher_id = _v.id;
    IF _uses >= _v.max_uses THEN RAISE EXCEPTION 'Voucher usage limit reached'; END IF;
  END IF;

  IF _v.one_per_user THEN
    SELECT COUNT(*) INTO _user_uses FROM public.voucher_redemptions
     WHERE voucher_id = _v.id AND user_id = NEW.user_id;
    IF _user_uses > 0 THEN RAISE EXCEPTION 'You have already used this voucher'; END IF;
  END IF;

  INSERT INTO public.voucher_redemptions (voucher_id, user_id, booking_id, amount_discounted)
  VALUES (_v.id, NEW.user_id, NEW.id, COALESCE(NEW.discount_amount, 0));

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_booking_voucher() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER bookings_apply_voucher
  AFTER INSERT OR UPDATE OF status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.apply_booking_voucher();