-- The two questions a tenant-specific login page has to ask.
--
-- /tenant/{slug}/login names a workspace before anyone has signed in, and then has to
-- prove that whoever did sign in belongs to that exact one. Neither question can be
-- answered by the policies as they stand: `tenants` is readable only by a member of
-- that tenant (`id = current_tenant_id()`), so an anonymous visitor sees nothing, and
-- a member of some *other* workspace cannot read the one they are attempting either.
--
-- Two functions rather than an anonymous SELECT policy on `tenants`. A policy would
-- expose whole rows — the id, the created_at, whatever the table grows next — to
-- anyone, and the id is the thing the browser must never hold, because an id in the
-- browser is an id that can be swapped. These return the name, and a yes or no, and
-- nothing else. No tenant id crosses the wire in either direction.
--
-- Nothing else changes: no policy is altered, no table is touched, and the one-tenant
-- rule, invitation acceptance and every Stage 1-5 permission are left exactly as they
-- are. These only read.

-- ---------------------------------------------------------------------------
-- 1. What to put at the top of the page.
-- ---------------------------------------------------------------------------
-- Callable before authentication, which is the point: the page is the sign-in page.
-- It returns the business name for an exact slug and nothing for anything else — no
-- id, no member list, no counts, no created_at, and no row at all for a slug that
-- does not exist.
--
-- This is the enumeration trade-off already accepted: someone who guesses a real slug
-- learns that business's name. What they cannot learn is anything more, and what they
-- cannot do is act on it — the name is a label, and the function below is the gate.
--
-- Matched case-insensitively on a trimmed slug so a link pasted with different casing
-- still finds its workspace; slugs are minted lowercase, so this only forgives input.
CREATE OR REPLACE FUNCTION public.tenant_login_page(_slug text)
RETURNS TABLE (name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.name
    FROM public.tenants t
   WHERE lower(t.slug) = lower(btrim(coalesce(_slug, '')))
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.tenant_login_page(text) FROM PUBLIC;
-- `anon` deliberately: the caller has not signed in yet and cannot have.
GRANT EXECUTE ON FUNCTION public.tenant_login_page(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Whether the person who just signed in belongs to that workspace.
-- ---------------------------------------------------------------------------
-- The whole authorisation of this page, and deliberately a boolean. It takes a slug,
-- never a tenant id: an id supplied by the browser is an id the browser chose, and the
-- comparison it would take part in would be the browser's rather than the database's.
-- The caller is `auth.uid()` and cannot be passed either.
--
-- `status = 'active'` is the same condition `venue_role()` applies. An invitation that
-- has not been accepted, and a membership that was removed, both carry a role on the
-- row and neither is a way in.
--
-- False for everything that is not an exact match: a player, a member of another
-- business, an unknown slug, no session at all. The caller cannot tell those apart
-- from the answer, which is the point.
CREATE OR REPLACE FUNCTION public.membership_matches_slug(_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.tenant_members tm
      JOIN public.tenants t ON t.id = tm.tenant_id
     WHERE tm.user_id = auth.uid()
       AND tm.status = 'active'
       AND lower(t.slug) = lower(btrim(coalesce(_slug, '')))
  );
$$;

REVOKE ALL ON FUNCTION public.membership_matches_slug(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.membership_matches_slug(text) TO authenticated;
