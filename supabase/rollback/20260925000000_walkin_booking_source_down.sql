-- ===========================================================================
-- Down: 20260925000000_walkin_booking_source
--
-- Reverses the booking-source model. Note what this costs: dropping the columns
-- destroys every walk-in booking's customer, receipt number and recorded actor,
-- and the rows themselves survive as ordinary bookings indistinguishable from
-- online ones. Any walk-in taken while the migration was live becomes, after
-- this runs, a booking the platform appears to have collected money for.
--
-- So this is a rollback for a deployment that failed early, not a way to undo
-- the feature once a venue has used it. If walk-ins exist, export them first.
-- ===========================================================================

-- 1. The policy, restored to the Stage 4 text exactly as it stood before.
DROP POLICY IF EXISTS "Users can select own bookings" ON public.bookings;
CREATE POLICY "Users can select own bookings"
  ON public.bookings FOR SELECT
  USING (
    (user_id = auth.uid())
    OR (EXISTS ( SELECT 1
                   FROM public.courts c
                  WHERE c.id = bookings.court_id
                    AND public.venue_allows(c.venue_id, 'staff')))
  );

-- 2. The function.
DROP FUNCTION IF EXISTS public.tenant_create_walkin_booking(
  bigint, timestamptz, timestamptz, text, text, text, integer, text, text, boolean, uuid
);

-- 3. Indexes and constraints, before the columns they depend on.
DROP INDEX IF EXISTS public.bookings_walkin_reference_unique;
DROP INDEX IF EXISTS public.idx_bookings_source;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_walkin_requires_customer;
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_source_collection_agree;
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_payment_collection_source_check;
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_booking_source_check;

-- 4. The columns.
ALTER TABLE public.bookings DROP COLUMN IF EXISTS recorded_by;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_payment_method;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_reference;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_notes;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_player_count;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_customer_email;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_customer_phone;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS walkin_customer_name;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS payment_collection_source;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS booking_source;
