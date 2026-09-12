-- ===========================================================================
-- Rollback for 20260911000000_tenants_and_members.sql
--
-- Reconstructible, but read the warnings before running it. Every definition
-- restored below is proven: the tables, helper functions and policies were new
-- in that migration, and `set_venue_booking_prefix()` is restored to 20260910's
-- text verbatim, which is the version this migration replaced.
--
-- ⚠ THIS DESTROYS THE WORKSPACES. Dropping `tenants` and `tenant_members`
--   discards every business name, slug, membership and role. Nothing anywhere
--   preserves them; they cannot be reconstructed from `staff`, because `staff`
--   never carried a role beyond venue access. Take a backup of both tables
--   first if there is any chance of wanting them again.
--
-- ⚠ ORDER. Everything from 20260912 onward depends on these two tables —
--   the team module, the workspace bootstrap, the business-name index, the
--   venue-creation policy, the workspace login functions and the security
--   hardening in 20260922. Roll all of those back first, newest to oldest.
--   The DROPs below are deliberately not CASCADE, so a forgotten dependency
--   stops this file rather than being swept away with it.
--
-- The venue link is handled honestly: `tenant_id` values are put back to the
-- owner user ids they held before, from the `tenant_id_legacy_user` copy the
-- migration took for exactly this purpose. Venues created after the migration
-- have no copy, so their owner is read from `staff` using the same query
-- 20260910 used to fill the column in the first place.
-- ===========================================================================

-- 1. The foreign key, so the column can hold user ids again.
--    The migration's own `DROP CONSTRAINT IF EXISTS` before adding it shows
--    there was no such constraint beforehand, so none is recreated.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_tenant_id_fkey;

-- 2. Put the pre-migration values back.
UPDATE public.venues v
   SET tenant_id = v.tenant_id_legacy_user
 WHERE v.tenant_id_legacy_user IS NOT NULL;

-- Venues created after the migration never had a legacy copy. The owner in
-- `staff` is what 20260910 would have put there, so that is what goes back.
UPDATE public.venues v
   SET tenant_id = s.user_id
  FROM public.staff s
 WHERE s.venue_id = v.id
   AND s.role = 'owner'
   AND v.tenant_id_legacy_user IS NULL;

ALTER TABLE public.venues
  DROP COLUMN IF EXISTS tenant_id_legacy_user;

-- 3. The prefix trigger, restored to 20260910's version verbatim — the one that
--    fills `tenant_id` with `auth.uid()`, correct while the column holds a user id.
CREATE OR REPLACE FUNCTION public.set_venue_booking_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate text;
BEGIN
  -- A venue created now belongs to whoever is creating it. `assign_venue_owner()`
  -- records the same person in `staff` a moment later; this is the copy the
  -- uniqueness index can actually read.
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := auth.uid();
  END IF;

  IF coalesce(NEW.booking_no_prefix, '') <> '' THEN
    RETURN NEW;
  END IF;

  candidate := public.derive_venue_prefix(NEW.name);
  IF candidate = '' THEN
    RETURN NEW;
  END IF;

  -- Two venues of one tenant whose names reduce to the same word: the second is
  -- left empty for the tenant to name, never given a numeric suffix. "LABANGON2"
  -- followed by booking 1 reads "LABANGON21" — the same fusing of label and count
  -- that "BN01" was rejected for.
  IF EXISTS (
    SELECT 1 FROM public.venues o
     WHERE o.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
       AND upper(o.booking_no_prefix) = candidate
       AND o.id IS DISTINCT FROM NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  NEW.booking_no_prefix := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_set_booking_prefix ON public.venues;
CREATE TRIGGER venues_set_booking_prefix
  BEFORE INSERT OR UPDATE OF name, booking_no_prefix, tenant_id ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.set_venue_booking_prefix();

-- 4. The membership helpers and their policies.
DROP POLICY IF EXISTS "Members read their team" ON public.tenant_members;
DROP POLICY IF EXISTS "Admins update their tenant" ON public.tenants;
DROP POLICY IF EXISTS "Members read their tenant" ON public.tenants;

DROP FUNCTION IF EXISTS public.is_tenant_admin();
DROP FUNCTION IF EXISTS public.current_tenant_id();

-- 5. The slug machinery and the tables themselves.
DROP TRIGGER IF EXISTS tenants_maintain_slug ON public.tenants;
DROP FUNCTION IF EXISTS public.tenants_maintain_slug();
DROP FUNCTION IF EXISTS public.is_placeholder_tenant_slug(text);
DROP FUNCTION IF EXISTS public.slugify_tenant_name(text);
DROP FUNCTION IF EXISTS public.new_placeholder_tenant_slug();

DROP INDEX IF EXISTS public.idx_tenant_members_tenant;
DROP TABLE IF EXISTS public.tenant_members;
DROP TABLE IF EXISTS public.tenants;
