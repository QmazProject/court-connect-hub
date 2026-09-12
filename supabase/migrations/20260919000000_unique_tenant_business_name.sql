-- One business name per business.
--
-- Two tenants called "QMAZ Holdings" — or "QMAZ Holdings" and "qmaz holdings" — would be
-- indistinguishable everywhere the name is shown: the header, the invitation email, the
-- acceptance panel, and eventually the login page of Phase 3. Uniqueness is enforced
-- here, in the database, because the Settings form is only one of the ways the column
-- can be written and a rule that lives in a form is skipped by a direct request.
--
-- "The same name" is decided after normalising, and the normalising is one IMMUTABLE
-- function so the index, the pre-check below and any later reader all agree exactly:
-- runs of whitespace collapse to one space, the ends are trimmed, and case is folded.
-- The stored name is NOT rewritten — a tenant who typed "ABC  Sports" keeps that
-- spelling; only the comparison is normalised.
--
-- Nothing about who may write the column changes. "Admins update their tenant"
-- (id = current_tenant_id() AND is_tenant_admin(), USING and WITH CHECK) stays exactly
-- as Phase 0 wrote it, and the slug trigger is untouched: a slug that has been minted
-- is frozen, so renaming the business never moves its address.

-- ---------------------------------------------------------------------------
-- 1. What "the same name" means.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_tenant_name(_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(btrim(regexp_replace(coalesce(_name, ''), '\s+', ' ', 'g')));
$$;

-- ---------------------------------------------------------------------------
-- 2. Refuse to proceed if the rule is already broken.
-- ---------------------------------------------------------------------------
-- The index below cannot be built while two tenants normalise to one name, and even
-- if it could, silently renaming or dropping one of them is a decision about two real
-- businesses that only a person should make. So the migration stops here and names
-- them. Because `db push` runs each migration in a transaction, a raise leaves nothing
-- applied — not even the function above.
DO $$
DECLARE
  _dupes text;
BEGIN
  SELECT string_agg(format('"%s" x%s', norm, n), ', ' ORDER BY norm)
    INTO _dupes
    FROM (
      SELECT public.normalize_tenant_name(t.name) AS norm, count(*) AS n
        FROM public.tenants t
       WHERE t.name IS NOT NULL AND btrim(t.name) <> ''
       GROUP BY 1
      HAVING count(*) > 1
    ) d;
  IF _dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce unique business names: existing tenants already share a name after normalising — %. Review and rename them deliberately, then re-run.',
      _dupes
      USING ERRCODE = '23505';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. A submitted name cannot be blank.
-- ---------------------------------------------------------------------------
-- NULL stays allowed: an unnamed tenant is a real state, the one Phase 0 backfilled
-- accounts into and the one a Google founder is in until the dashboard asks. What is
-- refused is a name that was *given* and is nothing — empty, or whitespace only.
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_name_not_blank;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_name_not_blank
  CHECK (name IS NULL OR btrim(name) <> '');

-- ---------------------------------------------------------------------------
-- 4. The rule itself.
-- ---------------------------------------------------------------------------
-- Partial, so the NULL and blank rows the constraint above tolerates never collide
-- with each other; expression-based, so the comparison is the normalised form and not
-- the stored spelling. A violation surfaces as SQLSTATE 23505 on this index name, which
-- is what the Settings form catches and turns into a sentence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_name_normalized
  ON public.tenants (public.normalize_tenant_name(name))
  WHERE name IS NOT NULL AND btrim(name) <> '';
