-- Assistant Insights: what people asked that CourtHub could not answer, and the
-- trusted vocabulary an admin adds in response.
--
-- The loop this closes is deliberately not a learning loop. An unknown term is
-- recorded as a *signal*, never as a meaning. Nothing a user types can change what
-- the assistant understands; only a row an admin wrote in assistant_term_mappings
-- can, and that table is unreachable from the browser except through the two narrow
-- functions at the bottom.
--
-- Privacy: no user id, no email, no name, no coordinates. What is stored is the
-- shape of the question — its category, its normalised text, the sport or place it
-- mentioned — because that is all an admin needs to act on it.

-- ---------------------------------------------------------------------------
-- 1. The feedback signal.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.assistant_query_feedback (
  id bigserial PRIMARY KEY,
  category text NOT NULL CHECK (category IN (
    'unknown_intent',
    'unsupported_question',
    -- Understood perfectly; nothing matched. Two different facts, kept apart:
    'zero_inventory',      -- no venue offers this at all
    'no_available_slots',  -- it exists, but every slot is taken
    'zero_results',        -- matched nothing once filters were applied
    'unknown_sport_term',
    'unknown_amenity_term',
    'ambiguous_venue',
    'ambiguous_court',
    'location_not_found',
    'missing_venue_data',
    'missing_policy_data',
    'missing_payment_data'
  )),
  -- The aggregation key. Two questions collapse into one row only when every
  -- dimension an admin would act on is identical.
  dedupe_key text NOT NULL,
  normalized_query text NOT NULL,
  display_query text,
  role text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'tenant')),
  resolved_intent text,
  sport_term text,
  amenity_term text,
  location_term text,
  result_count integer,
  occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewed', 'ignored', 'product_gap', 'resolved')),
  resolution_type text,
  resolution_id bigint,
  admin_notes text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  -- Set when the raw text was longer than the cap and was cut.
  truncated boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assistant_feedback_key
  ON public.assistant_query_feedback (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_browse
  ON public.assistant_query_feedback (status, category, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_count
  ON public.assistant_query_feedback (occurrence_count DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_feedback_demand
  ON public.assistant_query_feedback (location_term, sport_term)
  WHERE category IN ('zero_inventory', 'zero_results', 'no_available_slots');

ALTER TABLE public.assistant_query_feedback ENABLE ROW LEVEL SECURITY;

-- No client writes at all, and reads for admins only. Ordinary users contribute
-- through record_assistant_feedback() below, which runs as the definer.
REVOKE ALL ON public.assistant_query_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_query_feedback TO authenticated;
GRANT ALL ON public.assistant_query_feedback TO service_role;

DROP POLICY IF EXISTS "Admins read assistant feedback" ON public.assistant_query_feedback;
CREATE POLICY "Admins read assistant feedback"
  ON public.assistant_query_feedback FOR SELECT TO authenticated
  USING (public.is_courthub_admin());

-- ---------------------------------------------------------------------------
-- 2. The trusted vocabulary.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.assistant_term_mappings (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('sport_alias', 'amenity_alias')),
  term text NOT NULL,
  normalized_term text NOT NULL,
  -- The literal value in CourtHub's own data: a sport name, or an amenity string.
  -- Matching is literal and normalised; this is never compiled, evaluated, or used
  -- as a pattern.
  target_value text NOT NULL,
  target_id bigint,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live meaning per term per kind. "football -> Basketball" and
-- "football -> Football" cannot both be active, because the lookup could not choose.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assistant_mapping_active
  ON public.assistant_term_mappings (kind, normalized_term)
  WHERE active;

ALTER TABLE public.assistant_term_mappings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.assistant_term_mappings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_term_mappings TO authenticated;
GRANT ALL ON public.assistant_term_mappings TO service_role;

-- Admins see the whole row, including who wrote it. Everyone else reads the
-- vocabulary through get_active_assistant_mappings(), which returns no authorship.
DROP POLICY IF EXISTS "Admins read assistant mappings" ON public.assistant_term_mappings;
CREATE POLICY "Admins read assistant mappings"
  ON public.assistant_term_mappings FOR SELECT TO authenticated
  USING (public.is_courthub_admin());

-- ---------------------------------------------------------------------------
-- 3. Normalisation and sanitisation.
-- ---------------------------------------------------------------------------

/* Longest text kept for analytics. Answers may be longer; the record need not be. */
CREATE OR REPLACE FUNCTION public.assistant_max_query_len() RETURNS integer
LANGUAGE sql IMMUTABLE AS $function$ SELECT 160 $function$;

-- Best-effort redaction. This is not a secret detector and does not claim to be:
-- it removes the shapes that show up when someone pastes the wrong thing into a
-- chat box, so those shapes are not the thing we persist.
CREATE OR REPLACE FUNCTION public.assistant_sanitize(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(coalesce(_raw, ''),
                   '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email]', 'g'),
                 '\m(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\M', '[key]', 'g'),
               '\mbearer\s+[A-Za-z0-9._-]{8,}\M', '[token]', 'gi'),
             '\m[0-9]{13,19}\M', '[number]', 'g'),
           '\m(\+?63|0)9[0-9]{9}\M', '[phone]', 'g');
$function$;

CREATE OR REPLACE FUNCTION public.assistant_normalize(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT btrim(regexp_replace(lower(unaccent_safe), '[^a-z0-9 ]+', ' ', 'g'))
  FROM (SELECT translate(coalesce(_raw, ''), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc') AS unaccent_safe) t;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The narrow write path.
-- ---------------------------------------------------------------------------

-- Everything an ordinary user may contribute. The caller cannot supply a count, a
-- status, a reviewer, a note or a resolution — those are the admin's, and they are
-- not parameters. The role is read from the caller's own profile rather than
-- accepted as an argument.
CREATE OR REPLACE FUNCTION public.record_assistant_feedback(
  _category text,
  _query text,
  _sport_term text DEFAULT NULL,
  _amenity_term text DEFAULT NULL,
  _location_term text DEFAULT NULL,
  _resolved_intent text DEFAULT NULL,
  _result_count integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _role text;
  _clean text;
  _norm text;
  _cut boolean := false;
  _key text;
  _max integer := public.assistant_max_query_len();
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  /* An unknown category is dropped rather than stored: the CHECK would reject it
     anyway, and analytics is never worth raising an error into a chat answer. */
  IF _category IS NULL OR _category NOT IN (
    'unknown_intent','unsupported_question','zero_inventory','no_available_slots',
    'zero_results','unknown_sport_term','unknown_amenity_term','ambiguous_venue',
    'ambiguous_court','location_not_found','missing_venue_data','missing_policy_data',
    'missing_payment_data'
  ) THEN
    RETURN;
  END IF;

  _clean := public.assistant_sanitize(_query);
  IF length(_clean) > _max THEN
    _clean := left(_clean, _max);
    _cut := true;
  END IF;
  _norm := public.assistant_normalize(_clean);
  IF length(_norm) < 2 THEN RETURN; END IF;

  SELECT p.role INTO _role FROM public.profiles p WHERE p.id = auth.uid();
  _role := CASE WHEN _role = 'tenant' THEN 'tenant' ELSE 'player' END;

  /* The aggregation key. "sauna" asked twice is one row; the same sport in a
     different town is two, because an admin would act on them differently. */
  _key := _category || '|' || _role || '|' || _norm
       || '|' || coalesce(public.assistant_normalize(_sport_term), '')
       || '|' || coalesce(public.assistant_normalize(_amenity_term), '')
       || '|' || coalesce(public.assistant_normalize(_location_term), '');

  INSERT INTO public.assistant_query_feedback AS f (
    category, dedupe_key, normalized_query, display_query, role, resolved_intent,
    sport_term, amenity_term, location_term, result_count, truncated
  )
  VALUES (
    _category, _key, _norm, _clean, _role, _resolved_intent,
    nullif(btrim(coalesce(_sport_term, '')), ''),
    nullif(btrim(coalesce(_amenity_term, '')), ''),
    nullif(btrim(coalesce(_location_term, '')), ''),
    _result_count, _cut
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET occurrence_count = f.occurrence_count + 1,
        last_seen_at = now(),
        result_count = COALESCE(EXCLUDED.result_count, f.result_count),
        -- A recurrence of something already dismissed does not silently reopen it;
        -- the count still rises, so it resurfaces by weight if it matters.
        status = f.status;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_assistant_feedback(text, text, text, text, text, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_assistant_feedback(text, text, text, text, text, text, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The vocabulary the assistant is allowed to read.
-- ---------------------------------------------------------------------------

-- Three columns and nothing else: no author, no timestamps, no inactive rows.
CREATE OR REPLACE FUNCTION public.get_active_assistant_mappings()
RETURNS TABLE(kind text, normalized_term text, target_value text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT m.kind, m.normalized_term, m.target_value
  FROM public.assistant_term_mappings m
  WHERE m.active
  ORDER BY m.kind, m.normalized_term;
$function$;

REVOKE ALL ON FUNCTION public.get_active_assistant_mappings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_assistant_mappings() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Admin workflows. Every one writes an audit row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_review_assistant_feedback(
  _id bigint,
  _status text,
  _notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _before text;
BEGIN
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Admin access required.' USING ERRCODE = '42501';
  END IF;
  IF _status NOT IN ('open', 'reviewed', 'ignored', 'product_gap', 'resolved') THEN
    RAISE EXCEPTION 'Unknown status %', _status USING ERRCODE = '22023';
  END IF;

  SELECT status INTO _before FROM public.assistant_query_feedback WHERE id = _id;
  IF _before IS NULL THEN
    RAISE EXCEPTION 'No such feedback item.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.assistant_query_feedback
     SET status = _status,
         admin_notes = COALESCE(_notes, admin_notes),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = _id;

  PERFORM public.write_admin_audit(
    'assistant_feedback_reviewed', 'assistant_feedback', _id::text,
    jsonb_build_object('from', _before, 'to', _status)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_assistant_mapping(
  _kind text,
  _term text,
  _target_value text,
  _feedback_id bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _norm text; _id bigint; _exists boolean;
BEGIN
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Admin access required.' USING ERRCODE = '42501';
  END IF;
  IF _kind NOT IN ('sport_alias', 'amenity_alias') THEN
    RAISE EXCEPTION 'Unknown mapping kind %', _kind USING ERRCODE = '22023';
  END IF;

  _norm := public.assistant_normalize(_term);
  IF length(_norm) < 2 THEN
    RAISE EXCEPTION 'The term is too short to map.' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(_target_value, '')) = '' THEN
    RAISE EXCEPTION 'A mapping needs a target.' USING ERRCODE = '22023';
  END IF;

  /* The target must be something CourtHub actually has, or the mapping would point
     the assistant at nothing. */
  IF _kind = 'sport_alias' THEN
    SELECT EXISTS (SELECT 1 FROM public.sports s WHERE lower(s.name) = lower(btrim(_target_value)))
      INTO _exists;
    IF NOT _exists THEN
      RAISE EXCEPTION 'No CourtHub sport named %', _target_value USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.venues v
      WHERE EXISTS (
        SELECT 1 FROM unnest(
          coalesce(v.amenities, ARRAY[]::text[])
          || coalesce(v.facility_services, ARRAY[]::text[])
          || coalesce(v.food_beverages, ARRAY[]::text[])
        ) AS a(label)
        WHERE lower(a.label) = lower(btrim(_target_value))
      )
    ) INTO _exists;
    IF NOT _exists THEN
      RAISE EXCEPTION 'No venue lists an amenity called %', _target_value USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.assistant_term_mappings (kind, term, normalized_term, target_value, created_by, updated_by)
  VALUES (_kind, btrim(_term), _norm, btrim(_target_value), auth.uid(), auth.uid())
  ON CONFLICT (kind, normalized_term) WHERE active DO UPDATE
    SET target_value = EXCLUDED.target_value,
        term = EXCLUDED.term,
        updated_by = auth.uid(),
        updated_at = now()
  RETURNING id INTO _id;

  IF _feedback_id IS NOT NULL THEN
    UPDATE public.assistant_query_feedback
       SET status = 'resolved', resolution_type = _kind, resolution_id = _id,
           reviewed_by = auth.uid(), reviewed_at = now()
     WHERE id = _feedback_id;
  END IF;

  PERFORM public.write_admin_audit(
    'assistant_mapping_saved', 'assistant_mapping', _id::text,
    jsonb_build_object('kind', _kind, 'term', _norm, 'target', btrim(_target_value))
  );
  RETURN _id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_assistant_mapping_active(_id bigint, _active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Admin access required.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.assistant_term_mappings
     SET active = _active, updated_by = auth.uid(), updated_at = now()
   WHERE id = _id;

  PERFORM public.write_admin_audit(
    CASE WHEN _active THEN 'assistant_mapping_reactivated' ELSE 'assistant_mapping_deactivated' END,
    'assistant_mapping', _id::text, '{}'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_review_assistant_feedback(bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_upsert_assistant_mapping(text, text, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_assistant_mapping_active(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_assistant_feedback(bigint, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_assistant_mapping(text, text, text, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_assistant_mapping_active(bigint, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. What the Insights page counts.
-- ---------------------------------------------------------------------------

-- Counts of rows that exist, over a window. Deliberately no "resolution rate":
-- only misses are recorded, so the denominator — every answer the assistant gave —
-- is not known, and a rate computed from what is here would be fiction.
CREATE OR REPLACE FUNCTION public.admin_assistant_insight_stats(_since timestamptz DEFAULT NULL)
RETURNS TABLE(
  category text,
  status text,
  signals bigint,
  occurrences bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT f.category, f.status, count(*)::bigint, sum(f.occurrence_count)::bigint
  FROM public.assistant_query_feedback f
  WHERE public.is_courthub_admin()
    AND (_since IS NULL OR f.last_seen_at >= _since)
  GROUP BY f.category, f.status;
$function$;

REVOKE ALL ON FUNCTION public.admin_assistant_insight_stats(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assistant_insight_stats(timestamptz) TO authenticated, service_role;

-- Locations and sports people searched for and found nothing. Behavioural signal,
-- not proven demand — the caller names it accordingly.
CREATE OR REPLACE FUNCTION public.admin_assistant_demand(
  _since timestamptz DEFAULT NULL,
  _limit integer DEFAULT 20
)
RETURNS TABLE(
  location_term text,
  sport_term text,
  searches bigint,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT f.location_term, f.sport_term, sum(f.occurrence_count)::bigint, max(f.last_seen_at)
  FROM public.assistant_query_feedback f
  WHERE public.is_courthub_admin()
    AND f.category IN ('zero_inventory', 'zero_results', 'no_available_slots')
    AND (f.location_term IS NOT NULL OR f.sport_term IS NOT NULL)
    AND (_since IS NULL OR f.last_seen_at >= _since)
  GROUP BY f.location_term, f.sport_term
  ORDER BY sum(f.occurrence_count) DESC
  LIMIT greatest(coalesce(_limit, 20), 1);
$function$;

REVOKE ALL ON FUNCTION public.admin_assistant_demand(timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assistant_demand(timestamptz, integer) TO authenticated, service_role;
