-- Booking-number prefixes: a per-tenant default, and per-tenant uniqueness.
--
-- 20260909000000 gave every venue its own count and let a tenant type letters in
-- front of it. Two things were missing. A venue with nothing typed showed a bare
-- "1", which says nothing about which venue it belongs to. And nothing stopped
-- one tenant giving "BN" to two venues, which makes BN1 mean two different
-- bookings.
--
-- Both are fixed here, and both need the same missing fact: which tenant a venue
-- belongs to. That was only ever recorded in `staff`, which a uniqueness rule
-- cannot read — a rule can only see columns of the row it is checking. So the
-- boundary is written onto the venue itself.

-- ---------------------------------------------------------------------------
-- 1. The ownership boundary, on the venue.
-- ---------------------------------------------------------------------------
-- Deliberately no foreign key. The column exists to group a tenant's own venues
-- for the index below; a constraint against another table would add a way for
-- this migration to fail on live data without making the grouping any truer.
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

COMMENT ON COLUMN public.venues.tenant_id IS
  'The workspace a venue belongs to. Filled today from the venue''s owner in staff, because one tenant is one signup account. When a Team module introduces real tenant accounts, only how this is filled changes — everything reading it keeps working.';

-- Backfilled from the owner row `assign_venue_owner()` writes at creation. The
-- query that confirmed this is safe found no venue with anything other than
-- exactly one owner, so there is nothing arbitrary being chosen here.
UPDATE public.venues v
   SET tenant_id = s.user_id
  FROM public.staff s
 WHERE s.venue_id = v.id
   AND s.role = 'owner'
   AND v.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_venues_tenant_id ON public.venues (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. Room for a name-shaped prefix.
-- ---------------------------------------------------------------------------
-- Six letters held "BN" and "INV" but not "LAPULAPU". Widening only ever accepts
-- more than before, so nothing a tenant has already saved can stop being valid.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_booking_no_prefix_letters;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_booking_no_prefix_letters
  CHECK (booking_no_prefix ~ '^[A-Za-z]{0,16}$');

-- ---------------------------------------------------------------------------
-- 3. Turning a venue name into a prefix.
-- ---------------------------------------------------------------------------
-- Lives in SQL and only in SQL. All three paths that need it — the backfill
-- below, a newly created venue, and a tenant clearing the field — are writes,
-- so putting the rule anywhere else would mean two copies drifting apart.
--
-- Every distinctive word is joined, not just the first letter: "L" would serve
-- Lapulapu and Labangon equally and identify neither.
CREATE OR REPLACE FUNCTION public.derive_venue_prefix(_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parts text[];
  word text;
  joined text := '';
BEGIN
  -- Anything that is not a letter becomes a word break, so "Lapu-Lapu" and
  -- "Lapu Lapu" land on the same answer.
  parts := regexp_split_to_array(
             btrim(regexp_replace(lower(coalesce(_name, '')), '[^a-z]+', ' ', 'g')),
             '\s+');

  FOREACH word IN ARRAY coalesce(parts, ARRAY[]::text[]) LOOP
    CONTINUE WHEN word = '';
    -- Words shared by half the venues in a city identify none of them.
    CONTINUE WHEN word = ANY (ARRAY[
      'venue','venues','sports','sport','complex','court','courts','center',
      'centre','arena','club','hub','park','ground','grounds','field','fields',
      'gym','gymnasium','the','and','of','inc','co','company','corp','ltd',
      'road','street','st','rd','ave','avenue','brgy','barangay','city',
      -- What is left of "7th" and "2nd" once the digits are stripped. Without
      -- these, "7th Street Courts" reduces to "TH", which names nothing.
      'th','nd'
    ]);

    -- Whole words only. Appending as much as fits would cut mid-word and put
    -- "TALAMBANBASKETBA" in front of every booking; stopping at the last word
    -- that fits gives "TALAMBAN", which a tenant recognises. A first word longer
    -- than the cap is the one case with nothing to fall back to, so it is cut.
    IF joined = '' THEN
      joined := left(word, 16);
    ELSIF length(joined) + length(word) <= 16 THEN
      joined := joined || word;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  joined := upper(joined);

  -- A single letter is the collision this exists to avoid, and an empty result
  -- means the name carried no distinctive word at all. Both hand the choice back
  -- to the tenant rather than guessing.
  IF length(joined) < 2 THEN
    RETURN '';
  END IF;
  RETURN joined;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Filling the default, and keeping it filled.
-- ---------------------------------------------------------------------------
-- Runs on insert, and again whenever the prefix is left empty — which is how a
-- tenant clearing the field gets the derived default back rather than a bare "1".
-- A prefix the tenant has actually typed is never touched, so renaming a venue
-- does not quietly relabel its bookings.
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

-- ---------------------------------------------------------------------------
-- 5. Backfill the venues that already exist.
-- ---------------------------------------------------------------------------
-- Only rows with nothing set are touched, so a prefix a tenant already chose is
-- left exactly as it is. Where two of a tenant's venues derive the same word the
-- lowest id takes it and the rest stay empty, which is the same answer the
-- trigger above gives and leaves the choice with the tenant.
WITH derived AS (
  SELECT v.id,
         v.tenant_id,
         public.derive_venue_prefix(v.name) AS prefix
    FROM public.venues v
   WHERE coalesce(v.booking_no_prefix, '') = ''
),
claimed AS (
  SELECT id, tenant_id, prefix,
         ROW_NUMBER() OVER (PARTITION BY tenant_id, prefix ORDER BY id) AS rank_in_group
    FROM derived
   WHERE prefix <> ''
)
UPDATE public.venues v
   SET booking_no_prefix = claimed.prefix
  FROM claimed
 WHERE v.id = claimed.id
   AND claimed.rank_in_group = 1
   AND NOT EXISTS (
     SELECT 1 FROM public.venues held
      WHERE held.tenant_id IS NOT DISTINCT FROM claimed.tenant_id
        AND upper(held.booking_no_prefix) = claimed.prefix
        AND held.id <> claimed.id
   );

-- ---------------------------------------------------------------------------
-- 6. Uniqueness, enforced where it cannot be raced.
-- ---------------------------------------------------------------------------
-- Any duplicate a tenant managed to save before this rule existed is cleared on
-- the later venue, keeping the earliest. Without this the index below cannot be
-- built at all; the venues emptied here fall back to the derived default or ask
-- the tenant, and none of them loses a booking number — only the letters.
UPDATE public.venues v
   SET booking_no_prefix = ''
 WHERE coalesce(v.booking_no_prefix, '') <> ''
   AND EXISTS (
     SELECT 1 FROM public.venues earlier
      WHERE earlier.tenant_id IS NOT DISTINCT FROM v.tenant_id
        AND upper(earlier.booking_no_prefix) = upper(v.booking_no_prefix)
        AND earlier.id < v.id
   );

-- Partial, so the many venues with no prefix never collide with each other, and
-- case-folded, so "bn" cannot slip past a stored "BN".
CREATE UNIQUE INDEX IF NOT EXISTS uq_venues_tenant_booking_prefix
  ON public.venues (tenant_id, upper(booking_no_prefix))
  WHERE booking_no_prefix <> '';
