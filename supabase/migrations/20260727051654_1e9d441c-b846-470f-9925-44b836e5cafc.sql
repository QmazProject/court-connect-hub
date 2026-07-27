ALTER TABLE public.courts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.block_court_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cnt integer;
BEGIN
  IF OLD.is_active = true AND NEW.is_active = false THEN
    SELECT count(*) INTO cnt
    FROM public.bookings b
    WHERE b.court_id = NEW.id
      AND b.status = 'confirmed'
      AND b.end_time > now();
    IF cnt > 0 THEN
      RAISE EXCEPTION 'Cannot deactivate this court: % upcoming booking(s) are still scheduled. Cancel or let them finish first.', cnt;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.block_court_deactivation() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_block_court_deactivation ON public.courts;
CREATE TRIGGER trg_block_court_deactivation
BEFORE UPDATE OF is_active ON public.courts
FOR EACH ROW EXECUTE FUNCTION public.block_court_deactivation();