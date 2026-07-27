ALTER TABLE public.courts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.courts c
   SET created_at = COALESCE(v.created_at, c.created_at)
  FROM public.venues v
 WHERE v.id = c.venue_id;

CREATE TABLE IF NOT EXISTS public.court_audit_log (
  id BIGSERIAL PRIMARY KEY,
  court_id BIGINT NOT NULL REFERENCES public.courts(id) ON DELETE CASCADE,
  venue_id BIGINT NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID,
  actor_name TEXT,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_court_audit_court ON public.court_audit_log(court_id, created_at DESC);

GRANT SELECT, INSERT ON public.court_audit_log TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.court_audit_log_id_seq TO authenticated;
GRANT ALL ON public.court_audit_log TO service_role;
GRANT ALL ON SEQUENCE public.court_audit_log_id_seq TO service_role;

ALTER TABLE public.court_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Venue staff can view court audit"
ON public.court_audit_log FOR SELECT
TO authenticated
USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = court_audit_log.venue_id AND s.user_id = auth.uid()));

CREATE POLICY "Venue staff can insert court audit"
ON public.court_audit_log FOR INSERT
TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = court_audit_log.venue_id AND s.user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.log_court_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid UUID := auth.uid();
  _name TEXT;
  _changes JSONB := '{}'::jsonb;
BEGIN
  SELECT full_name INTO _name FROM public.profiles WHERE id = _uid;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.court_audit_log (court_id, venue_id, action, actor_id, actor_name)
    VALUES (NEW.id, NEW.venue_id, 'created', _uid, _name);
    RETURN NEW;
  ELSE
    IF NEW.name IS DISTINCT FROM OLD.name THEN _changes := _changes || jsonb_build_object('name', jsonb_build_object('from', OLD.name, 'to', NEW.name)); END IF;
    IF NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate THEN _changes := _changes || jsonb_build_object('hourly_rate', jsonb_build_object('from', OLD.hourly_rate, 'to', NEW.hourly_rate)); END IF;
    IF NEW.sport_id IS DISTINCT FROM OLD.sport_id THEN _changes := _changes || jsonb_build_object('sport', 'changed'); END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN _changes := _changes || jsonb_build_object('status', jsonb_build_object('from', OLD.is_active, 'to', NEW.is_active)); END IF;
    IF NEW.is_indoor IS DISTINCT FROM OLD.is_indoor THEN _changes := _changes || jsonb_build_object('indoor', jsonb_build_object('from', OLD.is_indoor, 'to', NEW.is_indoor)); END IF;
    IF NEW.description IS DISTINCT FROM OLD.description THEN _changes := _changes || jsonb_build_object('description', 'changed'); END IF;
    IF NEW.amenities IS DISTINCT FROM OLD.amenities THEN _changes := _changes || jsonb_build_object('amenities', 'changed'); END IF;
    IF NEW.images IS DISTINCT FROM OLD.images THEN _changes := _changes || jsonb_build_object('images', 'changed'); END IF;
    IF NEW.operating_hours IS DISTINCT FROM OLD.operating_hours OR NEW.inherit_venue_hours IS DISTINCT FROM OLD.inherit_venue_hours THEN _changes := _changes || jsonb_build_object('operating_hours', 'changed'); END IF;
    IF NEW.rate_rules IS DISTINCT FROM OLD.rate_rules THEN _changes := _changes || jsonb_build_object('rate_rules', 'changed'); END IF;
    IF NEW.blocked_hours IS DISTINCT FROM OLD.blocked_hours OR NEW.blocked_dates IS DISTINCT FROM OLD.blocked_dates THEN _changes := _changes || jsonb_build_object('availability', 'changed'); END IF;
    IF NEW.voucher_enabled IS DISTINCT FROM OLD.voucher_enabled THEN _changes := _changes || jsonb_build_object('voucher_enabled', jsonb_build_object('from', OLD.voucher_enabled, 'to', NEW.voucher_enabled)); END IF;
    IF NEW.surface_type IS DISTINCT FROM OLD.surface_type THEN _changes := _changes || jsonb_build_object('surface_type', jsonb_build_object('from', OLD.surface_type, 'to', NEW.surface_type)); END IF;
    IF NEW.player_capacity IS DISTINCT FROM OLD.player_capacity THEN _changes := _changes || jsonb_build_object('player_capacity', jsonb_build_object('from', OLD.player_capacity, 'to', NEW.player_capacity)); END IF;
    IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN _changes := _changes || jsonb_build_object('capacity', jsonb_build_object('from', OLD.capacity, 'to', NEW.capacity)); END IF;
    IF NEW.map_emoji IS DISTINCT FROM OLD.map_emoji THEN _changes := _changes || jsonb_build_object('map_emoji', jsonb_build_object('from', OLD.map_emoji, 'to', NEW.map_emoji)); END IF;
    IF NEW.coming_soon IS DISTINCT FROM OLD.coming_soon THEN _changes := _changes || jsonb_build_object('coming_soon', jsonb_build_object('from', OLD.coming_soon, 'to', NEW.coming_soon)); END IF;

    IF _changes = '{}'::jsonb THEN RETURN NEW; END IF;

    INSERT INTO public.court_audit_log (court_id, venue_id, action, actor_id, actor_name, changes)
    VALUES (NEW.id, NEW.venue_id, 'updated', _uid, _name, _changes);
    RETURN NEW;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_court_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS courts_audit_ins ON public.courts;
DROP TRIGGER IF EXISTS courts_audit_upd ON public.courts;
CREATE TRIGGER courts_audit_ins AFTER INSERT ON public.courts FOR EACH ROW EXECUTE FUNCTION public.log_court_change();
CREATE TRIGGER courts_audit_upd AFTER UPDATE ON public.courts FOR EACH ROW EXECUTE FUNCTION public.log_court_change();

INSERT INTO public.court_audit_log (court_id, venue_id, action, actor_id, actor_name, created_at)
SELECT c.id, c.venue_id, 'created', s.user_id, p.full_name, c.created_at
  FROM public.courts c
  LEFT JOIN LATERAL (SELECT user_id FROM public.staff st WHERE st.venue_id = c.venue_id AND st.role = 'owner' LIMIT 1) s ON true
  LEFT JOIN public.profiles p ON p.id = s.user_id
 WHERE NOT EXISTS (SELECT 1 FROM public.court_audit_log l WHERE l.court_id = c.id);