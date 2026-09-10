-- Tenant-facing booking numbers, counted per venue.
--
-- The Transactions table showed `bookings.id` — a global surrogate key. It is
-- unique, but it is not the tenant's: it starts wherever the table happened to
-- be, jumps over every other tenant's rows, and means nothing to the person
-- reading it. This gives each venue its own run, starting at 1, and lets the
-- tenant choose the letters in front of it (BN1, INV1, or a bare 1).
--
-- The count is plain: 1, 2, 3 … 10, 11, 12. Nothing is zero-padded, which is why
-- the prefix below is letters only — see the CHECK, and the note in
-- src/lib/booking-numbers.ts that this constraint mirrors.

-- ---------------------------------------------------------------------------
-- 1. The tenant's chosen letters, per venue.
-- ---------------------------------------------------------------------------
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS booking_no_prefix text NOT NULL DEFAULT '';

-- Enforced in the database as well as in the form, because the form is not the
-- only way a row can be written. A prefix carrying digits would make the second
-- booking of a venue configured as `BN01` read `BN012`.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_booking_no_prefix_letters;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_booking_no_prefix_letters
  CHECK (booking_no_prefix ~ '^[A-Za-z]{0,6}$');

-- ---------------------------------------------------------------------------
-- 2. The number itself.
-- ---------------------------------------------------------------------------
-- Nullable on purpose: a booking whose court has no venue cannot be numbered,
-- and the UI prints nothing rather than inventing a number for it.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS booking_no integer;

-- Supports both the assigner's MAX() and the tenant reading their own run.
CREATE INDEX IF NOT EXISTS idx_bookings_court_booking_no
  ON public.bookings (court_id, booking_no);

-- ---------------------------------------------------------------------------
-- 3. Assigning the next number.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_booking_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  -- An explicit number wins, so a restore or a backfill can place a row without
  -- the trigger renumbering it.
  IF NEW.booking_no IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.venue_id INTO v_id FROM public.courts c WHERE c.id = NEW.court_id;
  IF v_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- One assigner at a time per venue. Without this, two bookings taken in the
  -- same instant both read the same MAX and are handed the same number; the lock
  -- is held to the end of the transaction, so a rollback releases it and burns
  -- no number. It is taken per venue, so a busy venue never blocks a quiet one.
  PERFORM pg_advisory_xact_lock(v_id);

  SELECT COALESCE(MAX(b.booking_no), 0) + 1
    INTO NEW.booking_no
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
   WHERE c.venue_id = v_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_assign_booking_no ON public.bookings;
CREATE TRIGGER bookings_assign_booking_no
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.assign_booking_no();

-- ---------------------------------------------------------------------------
-- 4. Backfill, oldest first.
-- ---------------------------------------------------------------------------
-- Ordered by id so the venue's first booking becomes 1 and the run reads in the
-- order it actually happened. Guarded by IS NULL so re-running this migration
-- cannot renumber rows that already carry a number.
WITH numbered AS (
  SELECT b.id,
         ROW_NUMBER() OVER (PARTITION BY c.venue_id ORDER BY b.id) AS n
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
   WHERE b.booking_no IS NULL
)
UPDATE public.bookings AS b
   SET booking_no = numbered.n
  FROM numbered
 WHERE b.id = numbered.id;
