-- Rollback for 20260920000000_venue_creation_admin_only.sql
--
-- Outside supabase/migrations/ so `db push` never applies it. Run by hand only.
--
-- Restores the INSERT policy exactly as it was read out of pg_policies before the
-- change: INSERT, roles {authenticated}, WITH CHECK (is_tenant(auth.uid())). Doing so
-- reopens what the migration closed — any account whose profile says 'tenant',
-- including every invited Staff and Manager, can create a venue again, into whichever
-- tenant_id it chooses to send.

BEGIN;

DROP POLICY IF EXISTS "Admins can insert venues in their tenant" ON public.venues;

CREATE POLICY "Tenants can insert venues"
  ON public.venues FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant(auth.uid()));

COMMIT;
