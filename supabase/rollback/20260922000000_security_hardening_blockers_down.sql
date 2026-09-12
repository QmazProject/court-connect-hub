-- ===========================================================================
-- Rollback for 20260922000000_security_hardening_blockers.sql
--
-- Restores every object to the exact text it had before that migration, taken
-- from the migration that last defined it:
--
--   1. venue-images policies   -> 20260721090308
--   2. session helper grants   -> no grant statement existed; EXECUTE was on
--                                 PUBLIC by default, so PUBLIC is granted back
--   3. venue_role()            -> 20260914000000
--   4. current_tenant_id()     -> 20260911000000
--   5. profiles policy         -> 20260721013823
--      is_tenant()             -> 20260721014612
--   6. tenant_member_eligibility() -> 20260912000000
--
-- Sections run in reverse order. Nothing here deletes a row: the membership
-- rows section 6 may have reinstated keep whatever status they now hold, and a
-- reinstated member stays reinstated. Rolling back restores the old *rules*,
-- not an old state of the data.
-- ===========================================================================


-- --- 6. Invitation placement -------------------------------------------------

DROP FUNCTION IF EXISTS public.tenant_place_invitation(uuid, text);

CREATE OR REPLACE FUNCTION public.tenant_member_eligibility(_email text)
RETURNS TABLE (outcome text, user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid;
  _role text;
  _has_tenant boolean;
BEGIN
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only an admin can add members.' USING ERRCODE = '42501';
  END IF;

  SELECT u.id INTO _uid FROM auth.users u WHERE lower(u.email) = lower(btrim(_email));
  IF _uid IS NULL THEN
    RETURN QUERY SELECT 'invitable'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT p.role INTO _role FROM public.profiles p WHERE p.id = _uid;
  IF coalesce(_role, 'player') <> 'tenant' THEN
    RETURN QUERY SELECT 'is_player'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenant_members tm
     WHERE tm.user_id = _uid AND tm.status <> 'inactive'
  ) INTO _has_tenant;

  IF _has_tenant THEN
    RETURN QUERY SELECT 'has_tenant'::text, NULL::uuid;
  ELSE
    RETURN QUERY SELECT 'invitable'::text, _uid;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_member_eligibility(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_member_eligibility(text) TO authenticated;


-- --- 5b. is_tenant() back to SECURITY INVOKER --------------------------------

CREATE OR REPLACE FUNCTION public.is_tenant(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND role = 'tenant');
$function$;


-- --- 5. profiles -------------------------------------------------------------

DROP POLICY IF EXISTS "Users read their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Venue team read their customers" ON public.profiles;
DROP POLICY IF EXISTS "Team read each other" ON public.profiles;
DROP POLICY IF EXISTS "Conversation partners read each other" ON public.profiles;

CREATE POLICY "Profiles are viewable by authenticated"
  ON public.profiles FOR SELECT TO authenticated USING (true);


-- --- 4. current_tenant_id() --------------------------------------------------

DROP POLICY IF EXISTS "Members read their own membership" ON public.tenant_members;
DROP POLICY IF EXISTS "Invited members read the inviting tenant" ON public.tenants;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.tenant_id FROM public.tenant_members tm WHERE tm.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;


-- --- 3. venue_role() ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.venue_role(_venue_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.venue_id = _venue_id
         AND s.user_id = auth.uid()
         AND s.role = 'owner'
    ) THEN 'admin'
    ELSE (
      SELECT tm.role
        FROM public.staff s
        JOIN public.tenant_members tm
          ON tm.user_id = s.user_id
         AND tm.status = 'active'
       WHERE s.venue_id = _venue_id
         AND s.user_id = auth.uid()
       LIMIT 1
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.venue_role(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venue_role(bigint) TO authenticated, service_role;


-- --- 2. Booking session helpers ----------------------------------------------
-- These had no GRANT or REVOKE of their own before the migration, so EXECUTE sat
-- on PUBLIC by Postgres default. Restoring that default is what "exactly as it
-- was" means here, unappealing as it reads.

GRANT EXECUTE ON FUNCTION public.booking_session_anchor(bigint) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_session_span(bigint)   TO PUBLIC;


-- --- 1. venue-images storage policies ----------------------------------------

DROP POLICY IF EXISTS "Venue managers upload venue images" ON storage.objects;
DROP POLICY IF EXISTS "Venue managers update venue images" ON storage.objects;
DROP POLICY IF EXISTS "Venue managers delete venue images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can read venue images" ON storage.objects;

CREATE POLICY "Authenticated can upload venue images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can update venue images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'venue-images')
WITH CHECK (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can delete venue images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can read venue images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'venue-images');

DROP FUNCTION IF EXISTS public.venue_image_write_allowed(text);
