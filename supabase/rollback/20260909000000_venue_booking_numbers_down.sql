-- ===========================================================================
-- Rollback for 20260909000000_venue_booking_numbers.sql
--
-- Every object that migration created was new, so the previous state is simply
-- their absence and this file is reconstructible without guessing.
--
-- ⚠ THIS DESTROYS DATA. Dropping `bookings.booking_no` discards every booking
--   number a tenant has issued, and dropping `venues.booking_no_prefix`
--   discards their configured prefixes. Nothing preserves either. Re-applying
--   the migration afterwards renumbers from 1 per court, so numbers a customer
--   has already been shown will not come back the same.
--
-- ⚠ ORDER. 20260910 widens the CHECK constraint this file restores, and both
--   20260910 and 20260911 redefine the prefix trigger. Roll those back first,
--   newest to oldest, or this file will drop objects a later migration still
--   depends on.
-- ===========================================================================

DROP TRIGGER IF EXISTS bookings_assign_booking_no ON public.bookings;
DROP FUNCTION IF EXISTS public.assign_booking_no();

DROP INDEX IF EXISTS public.idx_bookings_court_booking_no;

ALTER TABLE public.bookings
  DROP COLUMN IF EXISTS booking_no;

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_booking_no_prefix_letters;
ALTER TABLE public.venues
  DROP COLUMN IF EXISTS booking_no_prefix;
