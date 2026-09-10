-- Phase 2 — the Team module.
--
-- Phase 0 made a tenant an entity and gave it members. This gives a tenant admin a
-- way to add people to it, and — more importantly — makes it impossible to add
-- someone without their agreement.
--
-- Two rules are enforced here rather than in the screen that shows them, because a
-- rule that lives only in a form is a rule that can be skipped by anyone willing to
-- open a console:
--
--   * a membership becomes active only when the invited person themselves accepts,
--   * the last admin cannot be removed or demoted.
--
-- What this migration deliberately does NOT do: it does not touch `claim_initial_role`,
-- it never writes `profiles.role` on an account that already exists, and it changes
-- none of the existing venue/court/booking policies. Roles here are labels the UI
-- honours; the policies still ask only whether a `staff` row exists. Giving those
-- roles teeth is Phase 2.5.

-- ---------------------------------------------------------------------------
-- 1. Every invitation attempt, kept.
-- ---------------------------------------------------------------------------
-- One table serving two needs. As an audit it answers "who tried to add whom"; as a
-- rate limiter it is simply a count over the last hour. Attempts are recorded
-- whatever their outcome, because a refused attempt is the one worth seeing: this
-- endpoint unavoidably reveals whether an address is registered, and a burst of
-- refusals against unrelated addresses is what that being abused looks like.
CREATE TABLE IF NOT EXISTS public.tenant_invite_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL,
  email      text NOT NULL,
  outcome    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_invite_attempts_actor_time
  ON public.tenant_invite_attempts (actor_id, created_at DESC);

ALTER TABLE public.tenant_invite_attempts ENABLE ROW LEVEL SECURITY;

-- Readable by the admins of the tenant it belongs to; written only by the server,
-- which holds the service role and bypasses this. No client insert policy exists,
-- and that absence is what stops the log being forged from a browser.
DROP POLICY IF EXISTS "Admins read their invite attempts" ON public.tenant_invite_attempts;
CREATE POLICY "Admins read their invite attempts"
  ON public.tenant_invite_attempts FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.is_tenant_admin());

-- ---------------------------------------------------------------------------
-- 2. Whether an email may be invited at all.
-- ---------------------------------------------------------------------------
-- Three answers, of which the caller shows two: `is_player` and `has_tenant` are one
-- sentence on screen. Which of them it was is not the admin's business, and saying
-- would turn the invite form into a way to inspect other people's accounts.
--
-- A player account is never invitable and never converted. That separation is the
-- point: a tenant member can edit prices and bookings, and the same person holding
-- both roles is the conflict this system is built to avoid.
-- Returns the verdict and, only when that verdict is `invitable`, the id of the
-- account it applies to. Bundled rather than split into a second lookup so the
-- caller never has a reason to ask "which user is this email?" on its own: the id
-- comes back exactly when an invitation is about to be sent to it anyway, and is
-- null both for an address with no account and for every refusal.
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

  -- Case-insensitively: addresses are not case sensitive, and an admin typing
  -- "Sarah@" must not create a second account for someone who already has one.
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

  -- A tenant-side account that currently belongs to nobody: a member who left. It
  -- may be invited again, by any tenant, through the same acceptance the rest go
  -- through — never transferred silently.
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

-- ---------------------------------------------------------------------------
-- 3. Accepting an invitation.
-- ---------------------------------------------------------------------------
-- Takes no arguments, and that is the security property rather than a convenience.
-- There is no user id to pass, so there is no call an admin can make that accepts on
-- somebody else's behalf — not from the UI, not from the API, not with the service
-- role. The only way a membership becomes active is the invited person, signed in as
-- themselves, asking for it.
--
-- Three things are proven before anything changes:
--   * a session exists                    -> they authenticated,
--   * auth.uid() owns an invited row      -> as the account that was invited,
--   * their email is confirmed            -> having controlled the invited mailbox,
--                                            which is what following the emailed
--                                            link and setting a password shows.
--
-- The staff rows are written in the same statement, so access and activation cannot
-- come apart: there is no moment where a member is active and cannot see the venues,
-- or can see them without having accepted.
CREATE OR REPLACE FUNCTION public.tenant_accept_invitation()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _confirmed timestamptz;
  _tenant uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;

  SELECT u.email_confirmed_at INTO _confirmed FROM auth.users u WHERE u.id = _uid;
  IF _confirmed IS NULL THEN
    RAISE EXCEPTION 'Confirm your email address first.' USING ERRCODE = '42501';
  END IF;

  -- Only their own row, and only one still waiting. A membership that was removed
  -- cannot be revived this way; it takes a fresh invitation.
  UPDATE public.tenant_members
     SET status = 'active'
   WHERE user_id = _uid
     AND status = 'invited'
  RETURNING tenant_id INTO _tenant;

  IF _tenant IS NULL THEN
    RAISE EXCEPTION 'No invitation is waiting for this account.' USING ERRCODE = '22023';
  END IF;

  -- The access half. Existing policies ask `staff` and nothing else, so a member
  -- without these rows would be active and see an empty workspace.
  INSERT INTO public.staff (user_id, venue_id, role)
  SELECT _uid, v.id, 'staff'
    FROM public.venues v
   WHERE v.tenant_id = _tenant
     AND NOT EXISTS (
       SELECT 1 FROM public.staff s WHERE s.venue_id = v.id AND s.user_id = _uid
     );

  RETURN _tenant::text;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_accept_invitation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_accept_invitation() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. New venues reach the people already on the team.
-- ---------------------------------------------------------------------------
-- Without this a venue created tomorrow is invisible to every member who joined
-- today, because the policies read `staff` and only the creator gets a row from
-- `assign_venue_owner()`. That trigger is untouched and this runs beside it.
--
-- Active members only: an invitation that has not been accepted must not hand out
-- access, and a removed member must not quietly regain it.
CREATE OR REPLACE FUNCTION public.grant_team_access_to_new_venue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.staff (user_id, venue_id, role)
  SELECT tm.user_id, NEW.id, 'staff'
    FROM public.tenant_members tm
   WHERE tm.tenant_id = NEW.tenant_id
     AND tm.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.staff s WHERE s.venue_id = NEW.id AND s.user_id = tm.user_id
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_grant_team_access ON public.venues;
CREATE TRIGGER venues_grant_team_access
  AFTER INSERT ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.grant_team_access_to_new_venue();

-- ---------------------------------------------------------------------------
-- 5. Removing a member, and changing a role.
-- ---------------------------------------------------------------------------
-- The last-admin rule is stated here as well as in the Team screen, and this is the
-- copy that decides. It is written about the *last admin* rather than about
-- self-removal: a workspace nobody can administer is the same accident whether the
-- final admin removed themselves or was removed by a peer, and in both cases there
-- is no one left to undo it.
CREATE OR REPLACE FUNCTION public.tenant_remove_member(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tenant uuid := public.current_tenant_id();
  _role text;
  _status text;
  _other_admins int;
BEGIN
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only an admin can remove members.' USING ERRCODE = '42501';
  END IF;

  SELECT tm.role, tm.status INTO _role, _status
    FROM public.tenant_members tm
   WHERE tm.user_id = _user_id AND tm.tenant_id = _tenant;

  IF _role IS NULL THEN
    RAISE EXCEPTION 'That member is not part of this team.' USING ERRCODE = '22023';
  END IF;
  IF _status = 'inactive' THEN
    RAISE EXCEPTION 'That member has already been removed.' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO _other_admins
    FROM public.tenant_members tm
   WHERE tm.tenant_id = _tenant
     AND tm.role = 'admin'
     AND tm.status = 'active'
     AND tm.user_id <> _user_id;

  IF _role = 'admin' AND _status = 'active' AND _other_admins = 0 THEN
    RAISE EXCEPTION 'This is the only admin. Make someone else an admin first.'
      USING ERRCODE = '42501';
  END IF;

  -- Marked inactive rather than deleted. The account survives and belongs to nobody,
  -- so it can be invited again — by this tenant or another — through the same
  -- acceptance every other member goes through.
  UPDATE public.tenant_members
     SET status = 'inactive'
   WHERE user_id = _user_id AND tenant_id = _tenant;

  -- Access goes immediately. The row above is the record; these are the keys.
  DELETE FROM public.staff s
   USING public.venues v
   WHERE s.venue_id = v.id
     AND v.tenant_id = _tenant
     AND s.user_id = _user_id
     -- Never the owner row `assign_venue_owner()` wrote: that is what marks who
     -- created the venue, and removing it would orphan the venue's own history.
     AND s.role <> 'owner';
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_set_member_role(_user_id uuid, _role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tenant uuid := public.current_tenant_id();
  _current text;
  _status text;
  _other_admins int;
BEGIN
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only an admin can change roles.' USING ERRCODE = '42501';
  END IF;
  IF _role NOT IN ('admin', 'manager', 'staff') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = '22023';
  END IF;

  SELECT tm.role, tm.status INTO _current, _status
    FROM public.tenant_members tm
   WHERE tm.user_id = _user_id AND tm.tenant_id = _tenant;

  IF _current IS NULL THEN
    RAISE EXCEPTION 'That member is not part of this team.' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO _other_admins
    FROM public.tenant_members tm
   WHERE tm.tenant_id = _tenant
     AND tm.role = 'admin'
     AND tm.status = 'active'
     AND tm.user_id <> _user_id;

  -- Demoting the last admin locks the team out exactly as removing them would.
  IF _current = 'admin' AND _status = 'active' AND _role <> 'admin' AND _other_admins = 0 THEN
    RAISE EXCEPTION 'This is the only admin. Make someone else an admin first.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenant_members
     SET role = _role
   WHERE user_id = _user_id AND tenant_id = _tenant;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_remove_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tenant_set_member_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_remove_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_set_member_role(uuid, text) TO authenticated;
