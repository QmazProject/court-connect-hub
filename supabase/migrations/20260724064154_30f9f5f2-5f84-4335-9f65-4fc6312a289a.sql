
-- Venue audit log
CREATE TABLE public.venue_audit_log (
  id BIGSERIAL PRIMARY KEY,
  venue_id BIGINT NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created','updated')),
  actor_id UUID,
  actor_name TEXT,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_venue_audit_venue ON public.venue_audit_log(venue_id, created_at DESC);

GRANT SELECT, INSERT ON public.venue_audit_log TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.venue_audit_log_id_seq TO authenticated;
GRANT ALL ON public.venue_audit_log TO service_role;
GRANT ALL ON SEQUENCE public.venue_audit_log_id_seq TO service_role;

ALTER TABLE public.venue_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view audit log for their venues"
ON public.venue_audit_log FOR SELECT
TO authenticated
USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = venue_audit_log.venue_id AND s.user_id = auth.uid()));

-- No direct insert policy needed — triggers run as table owner via SECURITY DEFINER
CREATE POLICY "Block direct inserts"
ON public.venue_audit_log FOR INSERT
TO authenticated
WITH CHECK (false);

-- Trigger function
CREATE OR REPLACE FUNCTION public.log_venue_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _name TEXT;
  _changes JSONB := '{}'::jsonb;
BEGIN
  SELECT full_name INTO _name FROM public.profiles WHERE id = _uid;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.venue_audit_log (venue_id, action, actor_id, actor_name)
    VALUES (NEW.id, 'created', _uid, _name);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.name IS DISTINCT FROM OLD.name THEN _changes := _changes || jsonb_build_object('name', jsonb_build_object('from', OLD.name, 'to', NEW.name)); END IF;
    IF NEW.address IS DISTINCT FROM OLD.address THEN _changes := _changes || jsonb_build_object('address', jsonb_build_object('from', OLD.address, 'to', NEW.address)); END IF;
    IF NEW.description IS DISTINCT FROM OLD.description THEN _changes := _changes || jsonb_build_object('description', 'changed'); END IF;
    IF NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude THEN _changes := _changes || jsonb_build_object('location', 'changed'); END IF;
    IF NEW.timezone IS DISTINCT FROM OLD.timezone THEN _changes := _changes || jsonb_build_object('timezone', jsonb_build_object('from', OLD.timezone, 'to', NEW.timezone)); END IF;
    IF NEW.map_emoji IS DISTINCT FROM OLD.map_emoji THEN _changes := _changes || jsonb_build_object('map_emoji', jsonb_build_object('from', OLD.map_emoji, 'to', NEW.map_emoji)); END IF;
    IF NEW.images IS DISTINCT FROM OLD.images THEN _changes := _changes || jsonb_build_object('images', 'changed'); END IF;
    IF NEW.payment_mode IS DISTINCT FROM OLD.payment_mode THEN _changes := _changes || jsonb_build_object('payment_mode', jsonb_build_object('from', OLD.payment_mode, 'to', NEW.payment_mode)); END IF;
    IF NEW.refund_cutoff_hours IS DISTINCT FROM OLD.refund_cutoff_hours THEN _changes := _changes || jsonb_build_object('refund_cutoff_hours', jsonb_build_object('from', OLD.refund_cutoff_hours, 'to', NEW.refund_cutoff_hours)); END IF;

    IF _changes <> '{}'::jsonb THEN
      INSERT INTO public.venue_audit_log (venue_id, action, actor_id, actor_name, changes)
      VALUES (NEW.id, 'updated', _uid, _name, _changes);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venues_audit_ins AFTER INSERT ON public.venues FOR EACH ROW EXECUTE FUNCTION public.log_venue_change();
CREATE TRIGGER venues_audit_upd AFTER UPDATE ON public.venues FOR EACH ROW EXECUTE FUNCTION public.log_venue_change();

-- Backfill 'created' entries for existing venues (unknown actor)
INSERT INTO public.venue_audit_log (venue_id, action, actor_id, actor_name, created_at)
SELECT v.id, 'created', s.user_id, p.full_name, COALESCE(v.created_at, now())
FROM public.venues v
LEFT JOIN LATERAL (SELECT user_id FROM public.staff WHERE venue_id = v.id AND role = 'owner' LIMIT 1) s ON true
LEFT JOIN public.profiles p ON p.id = s.user_id;
