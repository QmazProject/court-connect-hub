-- CourtHub admin identity, and the hole it exposed on the way in.
--
-- Two things land here, and the second is the reason the first could not simply be
-- a new value in profiles.role.
--
--   1. `profiles.role` is writable by its owner: the policy "Users can update own
--      profile" allows UPDATE with no column restriction, so any authenticated
--      player could PATCH themselves to 'tenant' and unlock "Tenants can insert
--      venues". The CHECK constraint stopped 'admin' but nothing stopped 'tenant'.
--      A column that a user can set is not a place to record authority, so admin
--      does not live there — and the escalation is closed below.
--
--   2. Admin authority lives in `user_roles`, a table the browser has no write
--      grant on at all. Even with a policy mistake, PostgREST cannot insert into
--      it: the GRANT is missing, which is a second wall behind RLS.
--
-- Nothing here is reachable by anon. Nothing here lets a caller raise its own
-- authority: every promotion path requires either an existing super admin or a
-- direct SQL session.

-- ---------------------------------------------------------------------------
-- 1. Where admin authority actually lives.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'super_admin')),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_active
  ON public.user_roles (user_id, role)
  WHERE revoked_at IS NULL;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Read-only for the browser, and only for admins. There is deliberately no
-- INSERT/UPDATE/DELETE grant: writes happen through the functions below, which run
-- as the definer and check authority themselves.
REVOKE ALL ON public.user_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The canonical predicates. Everything else asks these.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose: the predicate has to work for a caller who cannot
-- read user_roles, which is every non-admin. search_path is pinned so a caller
-- cannot shadow `user_roles` with something of their own.
CREATE OR REPLACE FUNCTION public.is_courthub_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles r
    WHERE r.user_id = auth.uid()
      AND r.role IN ('admin', 'super_admin')
      AND r.revoked_at IS NULL
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_courthub_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles r
    WHERE r.user_id = auth.uid()
      AND r.role = 'super_admin'
      AND r.revoked_at IS NULL
  );
$function$;

-- anon is never an admin, so it never needs to ask.
REVOKE EXECUTE ON FUNCTION public.is_courthub_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_courthub_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_courthub_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_courthub_super_admin() TO authenticated, service_role;

DROP POLICY IF EXISTS "Admins read role grants" ON public.user_roles;
CREATE POLICY "Admins read role grants"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.is_courthub_admin());

-- ---------------------------------------------------------------------------
-- 3. Audit. Every privileged mutation writes one row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  -- Safe descriptive detail only. Never a token, key, header or password: the
  -- writers below are the only callers, and none of them is handed a secret.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON public.admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON public.admin_audit_log (actor_id, created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_audit_log TO authenticated;
GRANT ALL ON public.admin_audit_log TO service_role;

DROP POLICY IF EXISTS "Admins read the audit log" ON public.admin_audit_log;
CREATE POLICY "Admins read the audit log"
  ON public.admin_audit_log FOR SELECT TO authenticated
  USING (public.is_courthub_admin());

-- Internal writer. Not granted to anyone: it is called only from the definer
-- functions below, which already run with the privileges it needs.
CREATE OR REPLACE FUNCTION public.write_admin_audit(
  _action text,
  _target_type text DEFAULT NULL,
  _target_id text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), _action, _target_type, _target_id, coalesce(_metadata, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.write_admin_audit(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Granting and revoking admin. Super admin only, and never to oneself.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.grant_courthub_admin(
  _user_id uuid,
  _role text DEFAULT 'admin',
  _note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.is_courthub_super_admin() THEN
    RAISE EXCEPTION 'Only a CourtHub super admin can grant admin roles.'
      USING ERRCODE = '42501';
  END IF;
  IF _role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Unknown role %', _role USING ERRCODE = '22023';
  END IF;
  IF _user_id = auth.uid() THEN
    -- Self-promotion is the shape every escalation takes; there is no legitimate
    -- reason for it here, because the caller already holds the higher role.
    RAISE EXCEPTION 'An admin cannot change their own roles.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.user_roles (user_id, role, granted_by, note)
  VALUES (_user_id, _role, auth.uid(), _note)
  ON CONFLICT (user_id, role) DO UPDATE
    SET revoked_at = NULL,
        revoked_by = NULL,
        granted_by = auth.uid(),
        granted_at = now(),
        note = COALESCE(EXCLUDED.note, public.user_roles.note);

  PERFORM public.write_admin_audit(
    'admin_role_granted', 'user', _user_id::text, jsonb_build_object('role', _role)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_courthub_admin(_user_id uuid, _role text DEFAULT 'admin')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.is_courthub_super_admin() THEN
    RAISE EXCEPTION 'Only a CourtHub super admin can revoke admin roles.'
      USING ERRCODE = '42501';
  END IF;
  IF _user_id = auth.uid() THEN
    RAISE EXCEPTION 'An admin cannot change their own roles.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_roles
     SET revoked_at = now(), revoked_by = auth.uid()
   WHERE user_id = _user_id AND role = _role AND revoked_at IS NULL;

  PERFORM public.write_admin_audit(
    'admin_role_revoked', 'user', _user_id::text, jsonb_build_object('role', _role)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.grant_courthub_admin(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_courthub_admin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_courthub_admin(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_courthub_admin(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The first super admin. SQL session only.
-- ---------------------------------------------------------------------------

-- Deliberately granted to nobody — not anon, not authenticated, not service_role.
-- PostgREST calls arrive as one of those roles, so this cannot be reached over
-- HTTP at all. It runs from the Supabase SQL Editor, which connects as an owner
-- and is not subject to the grant. It also refuses once any super admin exists,
-- so it is a bootstrap rather than a back door.
CREATE OR REPLACE FUNCTION public.bootstrap_courthub_super_admin(_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _uid uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'A CourtHub super admin already exists. Use grant_courthub_admin() instead.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id INTO _uid FROM auth.users WHERE lower(email) = lower(btrim(_email));
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'No Supabase Auth user with email %. Create the account first.', _email
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_roles (user_id, role, note)
  VALUES (_uid, 'super_admin', 'bootstrap')
  ON CONFLICT (user_id, role) DO UPDATE SET revoked_at = NULL, revoked_by = NULL;

  INSERT INTO public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  VALUES (_uid, 'super_admin_bootstrapped', 'user', _uid::text, jsonb_build_object('via', 'sql'));

  RETURN _uid;
END;
$function$;

REVOKE ALL ON FUNCTION public.bootstrap_courthub_super_admin(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Who the admins are. Super admin only, because it reads auth.users.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_courthub_admins()
RETURNS TABLE(
  user_id uuid,
  email text,
  full_name text,
  role text,
  granted_at timestamptz,
  revoked_at timestamptz,
  last_sign_in_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT r.user_id,
         u.email::text,
         p.full_name,
         r.role,
         r.granted_at,
         r.revoked_at,
         u.last_sign_in_at
  FROM public.user_roles r
  JOIN auth.users u ON u.id = r.user_id
  LEFT JOIN public.profiles p ON p.id = r.user_id
  -- The email of a colleague with admin rights is operational data a super admin
  -- needs. It is exposed for admins only, and for no one else.
  WHERE public.is_courthub_super_admin()
  ORDER BY r.granted_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.list_courthub_admins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_courthub_admins() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Closing the player-to-tenant escalation.
-- ---------------------------------------------------------------------------

-- The owner may still edit their own profile; they may no longer change what kind
-- of account it is. The only way past this is the transaction-local flag, which
-- only claim_initial_role() below sets.
CREATE OR REPLACE FUNCTION public.guard_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND coalesce(current_setting('courthub.role_claim', true), '') <> '1' THEN
    RAISE EXCEPTION 'The account type cannot be changed from here.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_guard_role ON public.profiles;
CREATE TRIGGER profiles_guard_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role();

-- Google's redirect flow cannot hand signUp() a role, so the role is applied after
-- the account exists. That is a legitimate need and this is the whole of it: it
-- works once, only while the profile is still on its default, and only in the few
-- minutes after sign-up. Anything later is the escalation this replaces.
CREATE OR REPLACE FUNCTION public.claim_initial_role(_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE _uid uuid := auth.uid(); _current text; _created timestamptz;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF _role NOT IN ('player', 'tenant') THEN
    RAISE EXCEPTION 'Unknown account type.' USING ERRCODE = '22023';
  END IF;

  SELECT role, created_at INTO _current, _created FROM public.profiles WHERE id = _uid;
  IF _current IS NULL THEN
    RAISE EXCEPTION 'No profile for this account yet.' USING ERRCODE = '22023';
  END IF;

  -- Already something other than the default: the choice has been made.
  IF _current <> 'player' THEN RETURN _current; END IF;
  IF _created < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'This account type can no longer be changed here.' USING ERRCODE = '42501';
  END IF;
  IF _role = 'player' THEN RETURN 'player'; END IF;

  PERFORM set_config('courthub.role_claim', '1', true);
  UPDATE public.profiles SET role = _role WHERE id = _uid;
  PERFORM set_config('courthub.role_claim', '', true);
  RETURN _role;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_initial_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_initial_role(text) TO authenticated, service_role;
