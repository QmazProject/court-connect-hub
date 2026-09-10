-- Phase 0 — the tenant entity.
--
-- Until now "a tenant" was an account: a profile with role='tenant', owning venues
-- through `staff`. That was enough while one business meant one login. It is not
-- enough for a team, where several people work inside one business and the
-- business itself has a name, a slug and a workspace of its own.
--
-- This migration introduces that entity and moves `venues.tenant_id` from meaning
-- "the owner's user id" (which 20260910 gave it) to meaning "the tenant". Nothing
-- about access changes: `staff` still decides who may read and write what, and
-- every existing policy is left exactly as it is. Team membership and the
-- tenant-specific login are later phases and are deliberately absent here.
--
-- Written to be correct whether or not 20260910 has been applied.

-- ---------------------------------------------------------------------------
-- 1. The tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable, and left null for the accounts that predate this table. A business
  -- name is something only the business can tell us; deriving one from a venue or
  -- a person's name would put a guess on screen that reads like a fact.
  name       text,
  -- Never null, because the tenant login URL in a later phase is addressed by it.
  -- Where there is no name yet this is a placeholder — see the trigger below.
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.tenants.slug IS
  'URL-safe identity. Starts as an opaque placeholder (t-xxxxxxxx) when the business has no name yet, is generated from the name the first time one is given, and is frozen from then on so a login URL never breaks.';

-- ---------------------------------------------------------------------------
-- 2. Membership — one tenant per user, enforced by the shape of the table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_members (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- The whole "one account, one business" rule. Not (tenant_id, user_id): a
  -- unique pair would allow a second membership elsewhere, which is exactly what
  -- must be impossible. Stated here so no application code can forget it and no
  -- two concurrent writes can race past it.
  user_id    uuid NOT NULL UNIQUE,
  role       text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'manager', 'staff')),
  -- `invited` until the person accepts. An admin can never attach an account
  -- silently; Phase 2 owns that flow, this only makes room for it.
  status     text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON public.tenant_members (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Slugs.
-- ---------------------------------------------------------------------------
-- Opaque and collision-checked. Random rather than sequential so a slug says
-- nothing about how many businesses exist or when this one joined.
CREATE OR REPLACE FUNCTION public.new_placeholder_tenant_slug()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE candidate text;
BEGIN
  LOOP
    candidate := 't-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

-- A name turned into a URL segment: "ABC Sports" -> "abc-sports". Returns empty
-- when the name carries nothing usable, so the caller keeps the placeholder
-- rather than minting something meaningless.
CREATE OR REPLACE FUNCTION public.slugify_tenant_name(_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
           regexp_replace(
             regexp_replace(lower(coalesce(_name, '')), '[^a-z0-9]+', '-', 'g'),
             '-{2,}', '-', 'g'),
           '-');
$$;

-- True for a slug this system minted as a placeholder, and only for those: the
-- freeze below turns on the first time a real name arrives, so it has to be able
-- to tell "never named" from "named once already".
CREATE OR REPLACE FUNCTION public.is_placeholder_tenant_slug(_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(_slug, '') ~ '^t-[0-9a-f]{8}$';
$$;

-- The slug's whole lifecycle, in one place so it cannot be worked around from the
-- client: minted on insert, generated once when the business is first named, and
-- frozen from then on. Freezing matters because Phase 3 addresses a workspace by
-- its slug — a slug that moved would silently break every bookmarked login URL.
CREATE OR REPLACE FUNCTION public.tenants_maintain_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base text;
  candidate text;
  suffix int := 2;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT public.is_placeholder_tenant_slug(OLD.slug) THEN
    -- Already named once. The slug is the workspace's address now, so whatever
    -- was submitted is discarded rather than trusted.
    NEW.slug := OLD.slug;
    RETURN NEW;
  END IF;

  base := public.slugify_tenant_name(NEW.name);

  IF base = '' THEN
    -- Still nameless: keep the placeholder, or mint one on insert.
    IF coalesce(NEW.slug, '') = '' THEN
      NEW.slug := public.new_placeholder_tenant_slug();
    END IF;
    RETURN NEW;
  END IF;

  -- Two businesses may share a name; their slugs may not.
  candidate := base;
  WHILE EXISTS (
    SELECT 1 FROM public.tenants t
     WHERE t.slug = candidate
       AND t.id IS DISTINCT FROM NEW.id
  ) LOOP
    candidate := base || '-' || suffix;
    suffix := suffix + 1;
  END LOOP;

  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_maintain_slug ON public.tenants;
CREATE TRIGGER tenants_maintain_slug
  BEFORE INSERT OR UPDATE OF name, slug ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tenants_maintain_slug();

-- ---------------------------------------------------------------------------
-- 4. Backfill: one tenant per existing tenant account.
-- ---------------------------------------------------------------------------
-- Sourced from `profiles`, not from venues: an account that has signed up as a
-- venue manager is a tenant whether or not it has created anything yet.
-- `name` is deliberately left null — see the note on the column.
INSERT INTO public.tenants (name, slug)
SELECT NULL, public.new_placeholder_tenant_slug()
  FROM public.profiles p
 WHERE p.role = 'tenant'
   AND NOT EXISTS (
     SELECT 1 FROM public.tenant_members tm WHERE tm.user_id = p.id
   );

-- The owner of each of those tenants is the account it was created for. Matched
-- by ordering both sides the same way, since the insert above created exactly one
-- row per unclaimed tenant account and nothing else writes here yet.
WITH unclaimed AS (
  SELECT p.id AS user_id, row_number() OVER (ORDER BY p.created_at, p.id) AS rn
    FROM public.profiles p
   WHERE p.role = 'tenant'
     AND NOT EXISTS (SELECT 1 FROM public.tenant_members tm WHERE tm.user_id = p.id)
),
fresh AS (
  SELECT t.id AS tenant_id, row_number() OVER (ORDER BY t.created_at, t.id) AS rn
    FROM public.tenants t
   WHERE t.name IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.tenant_members tm WHERE tm.tenant_id = t.id)
)
INSERT INTO public.tenant_members (tenant_id, user_id, role, status)
SELECT fresh.tenant_id, unclaimed.user_id, 'admin', 'active'
  FROM unclaimed
  JOIN fresh ON fresh.rn = unclaimed.rn;

-- ---------------------------------------------------------------------------
-- 5. Repointing venues.tenant_id.
-- ---------------------------------------------------------------------------
-- 20260910 gave this column the owner's *user* id. From here it holds the
-- *tenant* id. The two are both uuids, so nothing about the column's type or the
-- uniqueness index over it changes — only what the value means. `db push` applies
-- migrations in filename order, so 20260910 has always run by the time this does.
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- The old value, kept for one release. This migration overwrites live data in a
-- way no `IF NOT EXISTS` can undo, and eight rows of backup cost nothing next to
-- being unable to answer "what was it before?".
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS tenant_id_legacy_user uuid;

COMMENT ON COLUMN public.venues.tenant_id_legacy_user IS
  'Migration safety copy of the pre-Phase-0 tenant_id (an owner user id). Droppable once Phase 0 is confirmed good in production.';

UPDATE public.venues
   SET tenant_id_legacy_user = tenant_id
 WHERE tenant_id IS NOT NULL
   AND tenant_id_legacy_user IS NULL;

-- Venue -> its owner in `staff` -> that owner's tenant. `staff` is read, never
-- written: it remains the access mechanism and this migration does not touch it.
UPDATE public.venues v
   SET tenant_id = tm.tenant_id
  FROM public.staff s
  JOIN public.tenant_members tm ON tm.user_id = s.user_id
 WHERE s.venue_id = v.id
   AND s.role = 'owner';

-- A venue whose owner maps to no tenant cannot carry a tenant id, and must not
-- keep a stale user id in a column that now means something else. Nulled so the
-- key below can be trusted; the legacy column above still says what was there.
UPDATE public.venues v
   SET tenant_id = NULL
 WHERE v.tenant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v.tenant_id);

ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_tenant_id_fkey;
-- RESTRICT, not CASCADE: deleting a tenant that still owns venues should be
-- refused and looked at, never quietly take the venues with it.
ALTER TABLE public.venues
  ADD CONSTRAINT venues_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 6. The booking-prefix trigger, corrected for the new meaning.
-- ---------------------------------------------------------------------------
-- Identical to 20260910's version except for the three lines that fill in
-- tenant_id. That version assigned `auth.uid()` — correct while the column held a
-- user id, and silently wrong now: every new venue would receive a well-formed
-- uuid that matches no tenant, so its prefix would be checked for uniqueness
-- against nothing and the venue would be invisible to its own workspace.
CREATE OR REPLACE FUNCTION public.set_venue_booking_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate text;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    -- The tenant of whoever is creating this venue. One row at most, because
    -- tenant_members.user_id is unique.
    SELECT tm.tenant_id INTO NEW.tenant_id
      FROM public.tenant_members tm
     WHERE tm.user_id = auth.uid();
  END IF;

  IF coalesce(NEW.booking_no_prefix, '') <> '' THEN
    RETURN NEW;
  END IF;

  candidate := public.derive_venue_prefix(NEW.name);
  IF candidate = '' THEN
    RETURN NEW;
  END IF;

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

-- ---------------------------------------------------------------------------
-- 7. Row-level security, on the two new tables only.
-- ---------------------------------------------------------------------------
-- `staff` and every existing policy are untouched. Access to venues, courts and
-- bookings still works exactly as it did before this migration.

-- A policy on tenant_members that itself queries tenant_members would recurse.
-- Reading the membership through a definer function is the way out: it answers
-- from outside RLS, and because user_id is unique it returns at most one row.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_members tm
     WHERE tm.user_id = auth.uid()
       AND tm.role = 'admin'
       AND tm.status = 'active'
  );
$$;

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_tenant_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin() TO authenticated, service_role;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

-- A member sees their own workspace and no other. There is deliberately no
-- anonymous read: the tenant-specific login page of Phase 3 will need one, and it
-- should be added there, narrowed to what that page actually shows.
DROP POLICY IF EXISTS "Members read their tenant" ON public.tenants;
CREATE POLICY "Members read their tenant"
  ON public.tenants FOR SELECT TO authenticated
  USING (id = public.current_tenant_id());

-- Naming the business. Only an admin, only their own tenant, and the slug is not
-- theirs to set — the trigger above decides it and freezes it.
DROP POLICY IF EXISTS "Admins update their tenant" ON public.tenants;
CREATE POLICY "Admins update their tenant"
  ON public.tenants FOR UPDATE TO authenticated
  USING (id = public.current_tenant_id() AND public.is_tenant_admin())
  WITH CHECK (id = public.current_tenant_id() AND public.is_tenant_admin());

-- Seeing the team. Writing to it belongs to Phase 2, which will add its own
-- admin-gated function; until then nothing may be inserted or updated from a
-- browser, and the absence of those policies is what enforces it.
DROP POLICY IF EXISTS "Members read their team" ON public.tenant_members;
CREATE POLICY "Members read their team"
  ON public.tenant_members FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());
