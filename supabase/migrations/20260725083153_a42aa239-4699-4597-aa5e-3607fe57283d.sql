
-- 1. Courts: voucher_enabled flag
ALTER TABLE public.courts
  ADD COLUMN IF NOT EXISTS voucher_enabled BOOLEAN NOT NULL DEFAULT false;

-- 2. Vouchers table
CREATE TABLE public.vouchers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  venue_id BIGINT NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
  expires_at TIMESTAMPTZ,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  one_per_user BOOLEAN NOT NULL DEFAULT true,
  min_booking_amount NUMERIC CHECK (min_booking_amount IS NULL OR min_booking_amount >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vouchers_venue_code_uniq
  ON public.vouchers (venue_id, upper(code));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vouchers TO authenticated;
GRANT ALL ON public.vouchers TO service_role;

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view venue vouchers" ON public.vouchers
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = auth.uid() AND s.venue_id = vouchers.venue_id));

CREATE POLICY "Staff can insert venue vouchers" ON public.vouchers
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = auth.uid() AND s.venue_id = vouchers.venue_id));

CREATE POLICY "Staff can update venue vouchers" ON public.vouchers
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = auth.uid() AND s.venue_id = vouchers.venue_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = auth.uid() AND s.venue_id = vouchers.venue_id));

CREATE POLICY "Staff can delete venue vouchers" ON public.vouchers
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = auth.uid() AND s.venue_id = vouchers.venue_id));

CREATE TRIGGER vouchers_set_updated_at
  BEFORE UPDATE ON public.vouchers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Redemptions table
CREATE TABLE public.voucher_redemptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  voucher_id UUID NOT NULL REFERENCES public.vouchers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  booking_id BIGINT NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  amount_discounted NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id)
);

CREATE INDEX voucher_redemptions_voucher_idx ON public.voucher_redemptions(voucher_id);
CREATE INDEX voucher_redemptions_user_idx ON public.voucher_redemptions(user_id);

GRANT SELECT ON public.voucher_redemptions TO authenticated;
GRANT ALL ON public.voucher_redemptions TO service_role;

ALTER TABLE public.voucher_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Players see own redemptions" ON public.voucher_redemptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Staff see venue redemptions" ON public.voucher_redemptions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.vouchers v
    JOIN public.staff s ON s.venue_id = v.venue_id
    WHERE v.id = voucher_redemptions.voucher_id AND s.user_id = auth.uid()
  ));

-- Direct writes blocked (only booking trigger inserts)
CREATE POLICY "Block direct redemption writes" ON public.voucher_redemptions
  FOR INSERT TO authenticated WITH CHECK (false);

-- 4. Booking fields
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS voucher_id UUID REFERENCES public.vouchers(id),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;

-- 5. Preview / validate voucher (security definer so players can validate without seeing other codes)
CREATE OR REPLACE FUNCTION public.preview_voucher(
  _code TEXT,
  _court_id BIGINT,
  _amount NUMERIC
) RETURNS TABLE(
  ok BOOLEAN,
  reason TEXT,
  voucher_id UUID,
  discount NUMERIC,
  discount_type TEXT,
  discount_value NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _v RECORD;
  _court RECORD;
  _uses INT;
  _user_uses INT;
  _disc NUMERIC;
  _uid UUID := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in required', NULL::uuid, 0::numeric, NULL::text, 0::numeric;
    RETURN;
  END IF;

  SELECT id, venue_id, voucher_enabled INTO _court FROM public.courts WHERE id = _court_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Court not found', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
  END IF;
  IF NOT _court.voucher_enabled THEN
    RETURN QUERY SELECT false, 'This court does not accept vouchers', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
  END IF;

  SELECT * INTO _v FROM public.vouchers
   WHERE venue_id = _court.venue_id AND upper(code) = upper(trim(_code)) AND is_active = true
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Invalid voucher code', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
  END IF;

  IF _v.expires_at IS NOT NULL AND _v.expires_at < now() THEN
    RETURN QUERY SELECT false, 'Voucher has expired', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
  END IF;

  IF _v.min_booking_amount IS NOT NULL AND _amount < _v.min_booking_amount THEN
    RETURN QUERY SELECT false,
      'Minimum booking amount is ₱' || _v.min_booking_amount::text,
      NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
  END IF;

  IF _v.max_uses IS NOT NULL THEN
    SELECT COUNT(*) INTO _uses FROM public.voucher_redemptions WHERE voucher_id = _v.id;
    IF _uses >= _v.max_uses THEN
      RETURN QUERY SELECT false, 'Voucher usage limit reached', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
    END IF;
  END IF;

  IF _v.one_per_user THEN
    SELECT COUNT(*) INTO _user_uses FROM public.voucher_redemptions
     WHERE voucher_id = _v.id AND user_id = _uid;
    IF _user_uses > 0 THEN
      RETURN QUERY SELECT false, 'You have already used this voucher', NULL::uuid, 0::numeric, NULL::text, 0::numeric; RETURN;
    END IF;
  END IF;

  IF _v.discount_type = 'percent' THEN
    _disc := ROUND((_amount * _v.discount_value / 100.0)::numeric, 2);
  ELSE
    _disc := _v.discount_value;
  END IF;

  IF _disc > _amount THEN _disc := _amount; END IF;

  RETURN QUERY SELECT true, 'OK'::text, _v.id, _disc, _v.discount_type, _v.discount_value;
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_voucher(TEXT, BIGINT, NUMERIC) TO authenticated;

-- 6. Booking trigger: validate voucher & record redemption
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
BEGIN
  IF NEW.voucher_id IS NULL THEN RETURN NEW; END IF;

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

CREATE TRIGGER bookings_apply_voucher
  AFTER INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.apply_booking_voucher();
