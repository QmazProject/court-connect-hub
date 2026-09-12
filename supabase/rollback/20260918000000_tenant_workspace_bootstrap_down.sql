-- Rollback for 20260918000000_tenant_workspace_bootstrap.sql
--
-- Outside supabase/migrations/ so `db push` never applies it. Run by hand only.
--
-- This migration added one function and changed nothing else — no table, no column,
-- no policy, no trigger. Dropping the function is the whole reversal.
--
-- What it does NOT undo: any workspace the function created while it existed. Those
-- are ordinary `tenants` and `tenant_members` rows and are left exactly as they are,
-- because removing them would strip a real tenant of a real workspace. If one has to
-- go, that is a deliberate deletion of that tenant's data, not a rollback.

BEGIN;

DROP FUNCTION IF EXISTS public.ensure_tenant_workspace();

COMMIT;
