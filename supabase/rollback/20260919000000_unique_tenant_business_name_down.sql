-- Rollback for 20260919000000_unique_tenant_business_name.sql
--
-- Outside supabase/migrations/ so `db push` never applies it. Run by hand only.
--
-- Reverses the three objects the migration added and nothing else. Stored names are
-- never rewritten by the forward migration, so there is nothing to restore in the data.
-- After this runs, two tenants may again share a business name.

BEGIN;

DROP INDEX IF EXISTS public.uq_tenants_name_normalized;
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_name_not_blank;
DROP FUNCTION IF EXISTS public.normalize_tenant_name(text);

COMMIT;
