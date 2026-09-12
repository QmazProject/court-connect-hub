-- ===========================================================================
-- Rollback for 20260912000000_team_module.sql
--
-- Everything that migration created was new, so the previous state is absence
-- and nothing here is reconstructed by guesswork.
--
-- ⚠ THIS DESTROYS DATA. Dropping `tenant_invite_attempts` discards the
--   invitation audit trail and the rolling rate-limit window with it. The
--   memberships themselves live in `tenant_members` and are left alone, so a
--   member who has accepted stays accepted — but no further invitation can be
--   sent or accepted once the functions below are gone.
--
-- ⚠ ORDER. 20260922 redefines `tenant_member_eligibility()` and adds
--   `tenant_place_invitation()`, which this file does not know about. Roll
--   20260922 back first, or `tenant_place_invitation()` will be left behind
--   calling helpers that no longer exist.
-- ===========================================================================

DROP TRIGGER IF EXISTS venues_grant_team_access ON public.venues;
DROP FUNCTION IF EXISTS public.grant_team_access_to_new_venue();

DROP FUNCTION IF EXISTS public.tenant_set_member_role(uuid, text);
DROP FUNCTION IF EXISTS public.tenant_remove_member(uuid);
DROP FUNCTION IF EXISTS public.tenant_accept_invitation();
DROP FUNCTION IF EXISTS public.tenant_member_eligibility(text);

DROP POLICY IF EXISTS "Admins read their invite attempts" ON public.tenant_invite_attempts;
DROP INDEX IF EXISTS public.idx_tenant_invite_attempts_actor_time;
DROP TABLE IF EXISTS public.tenant_invite_attempts;
