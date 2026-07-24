
-- Add is_active flag to venues
ALTER TABLE public.venues ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_venues_is_active ON public.venues(is_active);

-- Helper: check if a venue has upcoming or in-progress confirmed bookings
CREATE OR REPLACE FUNCTION public.venue_has_active_bookings(_venue_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
    WHERE c.venue_id = _venue_id
      AND b.status = 'confirmed'
      AND b.end_time > now()
  );
$$;

-- Helper: check if a venue has any confirmed booking (past or future) — blocks delete
CREATE OR REPLACE FUNCTION public.venue_has_any_confirmed_booking(_venue_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
    WHERE c.venue_id = _venue_id
      AND b.status = 'confirmed'
  );
$$;

-- Trigger: prevent inactivating a venue with active bookings; auto-cancel pending bookings when inactivating
CREATE OR REPLACE FUNCTION public.handle_venue_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
    -- Block if any confirmed booking is still upcoming or in-progress
    IF public.venue_has_active_bookings(NEW.id) THEN
      RAISE EXCEPTION 'Cannot set venue inactive while it has upcoming or in-progress confirmed bookings. Wait until those bookings finish.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Auto-cancel any pending bookings under this venue's courts
    UPDATE public.bookings b
       SET status = 'cancelled'
      FROM public.courts c
     WHERE b.court_id = c.id
       AND c.venue_id = NEW.id
       AND b.status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venue_status_change ON public.venues;
CREATE TRIGGER trg_venue_status_change
BEFORE UPDATE OF is_active ON public.venues
FOR EACH ROW
EXECUTE FUNCTION public.handle_venue_status_change();
