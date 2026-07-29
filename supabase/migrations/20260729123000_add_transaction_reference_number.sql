-- Store the merchant reference sent to PayMongo separately from PayMongo's
-- checkout-session ID. One checkout may cover several hourly booking rows.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reference_number text;

COMMENT ON COLUMN public.transactions.reference_number IS
  'Merchant checkout reference passed to PayMongo as reference_number.';

CREATE INDEX IF NOT EXISTS transactions_reference_number_idx
  ON public.transactions (reference_number)
  WHERE reference_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_booking_unique
  ON public.transactions (reference_number, booking_id)
  WHERE reference_number IS NOT NULL;
