-- Rollback for 20260921000000_tenant_login_page.sql
--
-- Outside supabase/migrations/ so `db push` never applies it. Run by hand only.
--
-- The migration added two read-only functions and changed nothing else — no table, no
-- column, no policy, no trigger, no data. Dropping them is the whole reversal.
--
-- Afterwards /tenant/{slug}/login can neither name a workspace nor verify membership,
-- so the route stops working. Remove the route file too, or it will show its generic
-- failure to everyone.

BEGIN;

DROP FUNCTION IF EXISTS public.tenant_login_page(text);
DROP FUNCTION IF EXISTS public.membership_matches_slug(text);

COMMIT;
