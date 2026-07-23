ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending','confirmed','cancelled','completed'));

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_payment_status_check CHECK (payment_status IN ('unpaid','paid','refunded','partial'));