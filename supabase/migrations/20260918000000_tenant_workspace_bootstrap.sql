-- A workspace for every tenant account, not only the ones that existed on the day
-- Phase 0 ran.
--
-- `handle_new_user()` is where a tenant account is born, and it predates `tenants`
-- and `tenant_members`; Phase 0 created those tables and backfilled the accounts that
-- already existed, and nothing ever extended the birth path. So a tenant who signed up
-- after that has `profiles.role = 'tenant'` and no workspace: `current_tenant_id()`
-- returns NULL, the Team module has nothing to attach a member to, and the booking-
-- number panel has no tenant to group by.
--
-- The fix is deliberately not a change to `handle_new_user()`. Two reasons. That
-- trigger is also the player sign-up path, and the brief is that player sign-up does
-- not change. And an invited member is created through the very same trigger, by the
-- invite endpoint, a moment before that endpoint inserts their membership — so a
-- trigger that created a workspace for every tenant-role account would give each
-- invited member a business of their own and then fail the invite on UNIQUE(user_id).
--
-- Instead the workspace is created on demand, by the dashboard, through a function
-- that first asks whether the caller already belongs to anything. An invited member
-- does, and so does every tenant Phase 0 backfilled. Only a founder with no membership
-- at all gets a new one.

CREATE OR REPLACE FUNCTION public.ensure_tenant_workspace()
RETURNS TABLE (tenant_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- auth.uid() and nothing else. There is no argument that names a user or a tenant,
  -- so there is no call that sets up a workspace for anybody but the caller.
  _uid uuid := auth.uid();
  _role text;
  _existing uuid;
  _name text;
  _tenant uuid;
BEGIN
  IF _uid IS NULL THEN
    RETURN;
  END IF;

  -- Players never get one. Their sign-up is untouched by all of this, and a player
  -- calling this — which the dashboard does not do, but the API allows — is answered
  -- with nothing rather than a workspace.
  SELECT p.role INTO _role FROM public.profiles p WHERE p.id = _uid;
  IF _role IS DISTINCT FROM 'tenant' THEN
    RETURN;
  END IF;

  -- Any membership at all, whatever its status: an invitation not yet accepted still
  -- means this account belongs somewhere, and a removed member keeps their account
  -- but not a business of their own. Both are answered with what they already have.
  SELECT tm.tenant_id INTO _existing FROM public.tenant_members tm WHERE tm.user_id = _uid;
  IF _existing IS NOT NULL THEN
    RETURN QUERY SELECT _existing, false;
    RETURN;
  END IF;

  -- Two tabs opening the dashboard at once both reach this point having seen no
  -- membership. The lock is per user, so the second waits for the first to finish
  -- and then re-reads — and finds the workspace the first one made. UNIQUE(user_id)
  -- on tenant_members would refuse a duplicate regardless; the lock means that
  -- refusal is never what a second tab actually experiences.
  PERFORM pg_advisory_xact_lock(hashtext('ensure_tenant_workspace'), hashtext(_uid::text));

  SELECT tm.tenant_id INTO _existing FROM public.tenant_members tm WHERE tm.user_id = _uid;
  IF _existing IS NOT NULL THEN
    RETURN QUERY SELECT _existing, false;
    RETURN;
  END IF;

  -- The name typed on the venue-manager sign-up, if there was one. A Google founder
  -- has it only after the redirect lands and `updateUser` runs, which is before the
  -- dashboard mounts; anyone without it gets a placeholder slug and is asked.
  SELECT NULLIF(btrim(u.raw_user_meta_data->>'business_name'), '') INTO _name
    FROM auth.users u
   WHERE u.id = _uid;

  -- The slug passed here is only a fallback. `tenants_maintain_slug` runs BEFORE
  -- INSERT and, given a name, replaces it with one derived from that name.
  INSERT INTO public.tenants (name, slug)
  VALUES (_name, public.new_placeholder_tenant_slug())
  RETURNING id INTO _tenant;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, status)
  VALUES (_tenant, _uid, 'admin', 'active');

  RETURN QUERY SELECT _tenant, true;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_tenant_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_tenant_workspace() TO authenticated;
