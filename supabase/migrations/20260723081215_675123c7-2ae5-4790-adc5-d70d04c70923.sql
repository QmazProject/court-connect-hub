
-- Payment settings per venue
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'none'
    CHECK (payment_mode IN ('none','full','downpayment_50')),
  ADD COLUMN IF NOT EXISTS refund_cutoff_hours integer NOT NULL DEFAULT 24
    CHECK (refund_cutoff_hours >= 0);

-- Allow pending_payment status on bookings
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','paid','partially_paid','refunded','failed'));

-- Transactions
CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id bigint NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'PHP',
  method text NOT NULL,                    -- gcash | paymaya | grab_pay | qrph
  provider text NOT NULL DEFAULT 'paymongo',
  provider_ref text,                       -- PayMongo source/payment id
  status text NOT NULL DEFAULT 'pending'   -- pending | paid | failed | refunded
    CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  mode text NOT NULL DEFAULT 'test'        -- test | live
    CHECK (mode IN ('test','live')),
  raw jsonb,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_venue_idx ON public.transactions(venue_id);
CREATE INDEX IF NOT EXISTS transactions_booking_idx ON public.transactions(booking_id);
CREATE INDEX IF NOT EXISTS transactions_user_idx ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS transactions_provider_ref_idx ON public.transactions(provider_ref);

CREATE TRIGGER trg_transactions_updated
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT SELECT ON public.transactions TO authenticated;
GRANT ALL ON public.transactions TO service_role;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Players see their own
CREATE POLICY "Players view own transactions"
  ON public.transactions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Tenant staff see transactions for their venues
CREATE POLICY "Venue staff view venue transactions"
  ON public.transactions FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.venue_id = transactions.venue_id
      AND s.user_id = auth.uid()
  ));
