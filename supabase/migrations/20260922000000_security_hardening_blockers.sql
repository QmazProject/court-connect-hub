-- ===========================================================================
-- Security hardening: the six blockers from the pre-UAT audit.
--
-- Six independent fixes, each in its own numbered section so they can be read
-- and reviewed one at a time. Nothing here changes what an *active* Admin,
-- Manager or Staff member can do; every section either closes a hole that was
-- open to people outside the business, or restores something that was supposed
-- to work and did not.
--
--   1. venue-images storage: scope writes to the venue the image belongs to.
--   2. booking_session_span/anchor: stop anonymous execution.
--   3. venue_role(): an 'owner' row no longer outranks a removed membership.
--   4. current_tenant_id(): only an active membership resolves a tenant.
--   5. profiles: end the platform-wide read.
--   6. tenant_members: let a removed member be invited again.
--
-- No data is deleted or rewritten anywhere in this migration.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Venue images — writes scoped to the venue, reads left alone.
-- ---------------------------------------------------------------------------
-- The four policies written in 20260721090308 ask one question: is this the
-- venue-images bucket. Any authenticated account — a player, an invited member
-- who never accepted, a member of another business — could therefore overwrite
-- or delete every venue photo on the platform.
--
-- The fix reads the object's own path, because the application has always
-- encoded the owning venue in it. `src/components/ImageUploader.tsx` writes
-- `<prefix>/<timestamp>-<random>.<ext>`, and the four prefixes it is ever given
-- are:
--
--     venues/<venue id>                     editing an existing venue
--     venues/new-<timestamp>-<random>       the create-venue form, no id yet
--     courts/<court id>                     editing an existing court
--     courts/venue-<venue id>/new-<ts>      adding a court to a known venue
--
-- Three of those name a venue that exists, so they are checked against it at
-- `manager`, which is exactly the level `venue_allows` already requires to edit
-- a venue or a court. Staff cannot edit a venue and so cannot touch its images.
-- The fourth is the staging folder for a venue that does not exist yet; there is
-- no venue to check, so it takes the same active-admin test that creating a
-- venue itself takes.
--
-- SELECT is deliberately left as it was. These images are published to players
-- as ten-year signed URLs stored on the venue row, so reading them is already
-- public in every sense that matters, and narrowing the policy would break the
-- `createSignedUrl` call the uploader makes immediately after each upload.

CREATE OR REPLACE FUNCTION public.venue_image_write_allowed(_path text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parts text[];
  _kind  text;
  _ref   text;
  _venue bigint;
BEGIN
  IF auth.uid() IS NULL OR _path IS NULL THEN
    RETURN false;
  END IF;

  -- Folder segments only; the filename is not part of this decision.
  _parts := storage.foldername(_path);
  IF _parts IS NULL OR array_length(_parts, 1) < 2 THEN
    RETURN false;
  END IF;
  _kind := _parts[1];
  _ref  := _parts[2];

  IF _kind = 'venues' THEN
    IF _ref ~ '^[0-9]+$' THEN
      RETURN public.venue_allows(_ref::bigint, 'manager');
    END IF;
    -- The create-venue form uploads before the venue exists. Nothing to check it
    -- against, so it takes the same test as creating the venue would.
    IF _ref ~ '^new-' THEN
      RETURN public.is_tenant_admin();
    END IF;
    RETURN false;
  END IF;

  IF _kind = 'courts' THEN
    IF _ref ~ '^[0-9]+$' THEN
      -- The court editor is used for both court tables, so both are consulted
      -- rather than guessing which id this is. A path matching neither is refused.
      SELECT c.venue_id INTO _venue FROM public.courts c WHERE c.id = _ref::bigint;
      IF _venue IS NULL THEN
        SELECT pc.venue_id INTO _venue FROM public.physical_courts pc WHERE pc.id = _ref::bigint;
      END IF;
      IF _venue IS NULL THEN
        RETURN false;
      END IF;
      RETURN public.venue_allows(_venue, 'manager');
    END IF;
    IF _ref ~ '^venue-[0-9]+$' THEN
      RETURN public.venue_allows(substring(_ref from 7)::bigint, 'manager');
    END IF;
    RETURN false;
  END IF;

  -- An unrecognised shape is refused rather than allowed. A new upload location
  -- must be added here deliberately.
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.venue_image_write_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venue_image_write_allowed(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated can upload venue images" ON storage.objects;
CREATE POLICY "Venue managers upload venue images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'venue-images'
  AND public.venue_image_write_allowed(name)
);

DROP POLICY IF EXISTS "Authenticated can update venue images" ON storage.objects;
CREATE POLICY "Venue managers update venue images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'venue-images'
  AND public.venue_image_write_allowed(name)
)
WITH CHECK (
  bucket_id = 'venue-images'
  AND public.venue_image_write_allowed(name)
);

DROP POLICY IF EXISTS "Authenticated can delete venue images" ON storage.objects;
CREATE POLICY "Venue managers delete venue images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'venue-images'
  AND public.venue_image_write_allowed(name)
);

-- The read policy is re-created byte-for-byte under its original name, so this
-- section leaves reads exactly where it found them.
DROP POLICY IF EXISTS "Authenticated can read venue images" ON storage.objects;
CREATE POLICY "Authenticated can read venue images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'venue-images');


-- ---------------------------------------------------------------------------
-- 2. The two booking-session helpers — no longer callable by anyone outside.
-- ---------------------------------------------------------------------------
-- `booking_session_span(bigint)` returns the slot count and the peso total of a
-- session; `booking_session_anchor(bigint)` finds its first hour. Both are
-- SECURITY DEFINER and neither was ever revoked, so Postgres left EXECUTE on
-- PUBLIC — an anonymous caller could read the value of any booking by guessing
-- its id. Every sibling function in the same migration was revoked; these two
-- were missed.
--
-- Nothing outside the database calls them. The only callers are
-- `notify_staff_booking_event()` and the refund notification function, both
-- SECURITY DEFINER, both of which execute as the owner and so keep working
-- after this. The application references them only in two test files that
-- re-implement the walk in TypeScript.
--
-- Revoking is therefore the whole fix: with no client caller there is no
-- authorization to add inside them, and adding an `auth.uid()` test would break
-- the notification path, which legitimately runs with no session at all.

REVOKE ALL ON FUNCTION public.booking_session_anchor(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_session_span(bigint)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_session_anchor(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_session_span(bigint)   TO service_role;


-- ---------------------------------------------------------------------------
-- 3. venue_role() — an owner row is history, not authority.
-- ---------------------------------------------------------------------------
-- `assign_venue_owner()` writes a `staff` row with role 'owner' for whoever
-- created a venue, and `tenant_remove_member()` deliberately keeps that row so
-- the record of who created the venue survives. But venue_role() read the owner
-- row *instead of* the membership: it returned 'admin' without looking at
-- tenant_members at all. A founder set to inactive therefore kept manager and
-- admin rights on every venue they had created — venue edit and delete,
-- vouchers, transactions, audit logs, booking cancellation and refund
-- settlement — despite having been removed from the business.
--
-- The owner row still counts, and still outranks whatever the membership says,
-- so nothing changes for a founder who is still on the team. It now counts only
-- while there is an active membership in that venue's own tenant behind it.
-- Removal takes the rights away and leaves the history in place.

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
    )
    -- The owner row on its own is a record of who created the venue. It grants
    -- nothing unless the person is still on the team of the tenant that owns it.
    AND EXISTS (
      SELECT 1
        FROM public.venues v
        JOIN public.tenant_members tm
          ON tm.tenant_id = v.tenant_id
         AND tm.user_id = auth.uid()
         AND tm.status = 'active'
       WHERE v.id = _venue_id
         AND v.tenant_id IS NOT NULL
    ) THEN 'admin'
    ELSE (
      SELECT tm.role
        FROM public.staff s
        JOIN public.tenant_members tm
          ON tm.user_id = s.user_id
         -- Only an accepted membership grants anything. An invitation that has not
         -- been answered must not open a door before the person walks through it.
         AND tm.status = 'active'
       WHERE s.venue_id = _venue_id
         AND s.user_id = auth.uid()
       LIMIT 1
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.venue_role(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venue_role(bigint) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. current_tenant_id() — an active membership, or nothing.
-- ---------------------------------------------------------------------------
-- The function resolved a tenant from any membership row, whatever its status.
-- Three policies are gated on it and nothing else, so an invited member who
-- never accepted, and a member who had been removed, could still read the
-- business's own row, the entire team roster, and every staff row for the
-- tenant's venues. Writes were never reachable — those all run through
-- venue_allows() or is_tenant_admin(), which check status — so this was a
-- read-only leak, but it was a leak straight across the boundary.
--
-- The invitation flow was checked before changing this. `tenant_accept_invitation()`
-- and `ensure_tenant_workspace()` are both SECURITY DEFINER and read
-- tenant_members directly, so neither goes through this function and neither
-- changes behaviour. What *did* depend on it is the acceptance screen: it has to
-- read the invited member's own row and the name of the business inviting them.
-- Two narrow policies below restore exactly that and nothing else.

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tm.tenant_id
    FROM public.tenant_members tm
   WHERE tm.user_id = auth.uid()
     -- Added deliberately. An invitation that has not been accepted, and a
     -- membership that has been removed, resolve to no tenant at all.
     AND tm.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;

-- Your own membership row, whatever its status. This is what the pending-invitation
-- panel reads to discover that an invitation exists, and it is one row: the
-- caller's own. It cannot show anyone else's.
DROP POLICY IF EXISTS "Members read their own membership" ON public.tenant_members;
CREATE POLICY "Members read their own membership"
  ON public.tenant_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- The name and address of a business you have a membership row with, accepted or
-- not. The acceptance screen has to name the business doing the inviting, and the
-- same two columns are already readable by anyone who knows the slug, through
-- `tenant_login_page()`. The roster stays behind the active-only policy above.
DROP POLICY IF EXISTS "Invited members read the inviting tenant" ON public.tenants;
CREATE POLICY "Invited members read the inviting tenant"
  ON public.tenants FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_members tm
       WHERE tm.tenant_id = tenants.id
         AND tm.user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- 6. Inviting someone again after they have been removed.
-- ---------------------------------------------------------------------------
-- (Section 5 follows this one; the numbering matches the audit, not the file.)
--
-- `tenant_member_eligibility()` answers 'invitable' for a removed member — its
-- own comment promises they may be invited again — but the endpoint then ran a
-- plain INSERT against a table with UNIQUE(user_id). The insert always failed
-- and the admin was told the address was "already registered". A removed member
-- could never be re-invited, by their old business or any other, and the reason
-- given was wrong.
--
-- Two changes. The eligibility function gains a 'resend' verdict so an admin can
-- send the invitation email again to someone in their own business who never
-- received it. And the row is placed by a function that decides between insert,
-- reinstate and resend, instead of an insert that assumes no row exists.
--
-- What does not change: acceptance is still explicit and still the only way to
-- become active, one account still belongs to at most one business, and a player
-- account is still refused rather than converted.

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
  _status text;
  _tenant uuid;
  _mine uuid := public.current_tenant_id();
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

  SELECT tm.status, tm.tenant_id INTO _status, _tenant
    FROM public.tenant_members tm
   WHERE tm.user_id = _uid;

  -- No row, or a row that belongs to nobody: a member who left. It may be
  -- invited again, by any tenant, through the same acceptance the rest go
  -- through — never transferred silently.
  IF _status IS NULL OR _status = 'inactive' THEN
    RETURN QUERY SELECT 'invitable'::text, _uid;
    RETURN;
  END IF;

  -- Invited to *this* business already and still waiting. The admin is looking at
  -- this person on their own team screen, so there is nothing to conceal: say it
  -- can be sent again rather than refusing as though the address belonged to a
  -- stranger.
  IF _status = 'invited' AND _mine IS NOT NULL AND _tenant = _mine THEN
    RETURN QUERY SELECT 'resend'::text, _uid;
    RETURN;
  END IF;

  -- Active here, or attached to another business either way. Refused, and the
  -- refusal says no more than that.
  RETURN QUERY SELECT 'has_tenant'::text, NULL::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_member_eligibility(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_member_eligibility(text) TO authenticated;


-- Places the membership row for an invitation: inserts a new one, reinstates a
-- removed one, or re-arms an outstanding one. Never two rows for one account.
--
-- The caller supplies a user id, which it got from `tenant_member_eligibility()`
-- for the address it typed. That id is not trusted: every rule is re-checked
-- here under the caller's own identity — admin of an active membership, target
-- is a tenant-side account, target is not active anywhere, target is not invited
-- by anyone else.
CREATE OR REPLACE FUNCTION public.tenant_place_invitation(_user_id uuid, _role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tenant uuid := public.current_tenant_id();
  _target_role text;
  _status text;
  _their_tenant uuid;
BEGIN
  IF NOT public.is_tenant_admin() OR _tenant IS NULL THEN
    RAISE EXCEPTION 'Only an admin can add members.' USING ERRCODE = '42501';
  END IF;
  IF _role NOT IN ('admin', 'manager', 'staff') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = '22023';
  END IF;
  IF _user_id IS NULL OR _user_id = auth.uid() THEN
    RAISE EXCEPTION 'That account cannot be invited.' USING ERRCODE = '22023';
  END IF;

  -- Player and tenant accounts stay separate. A player is never converted by
  -- being invited, here or anywhere else.
  SELECT p.role INTO _target_role FROM public.profiles p WHERE p.id = _user_id;
  IF coalesce(_target_role, 'player') <> 'tenant' THEN
    RAISE EXCEPTION 'That account cannot be invited.' USING ERRCODE = '22023';
  END IF;

  -- Locked while the decision is made, so two admins inviting the same person at
  -- the same moment cannot both decide there is no row.
  SELECT tm.status, tm.tenant_id INTO _status, _their_tenant
    FROM public.tenant_members tm
   WHERE tm.user_id = _user_id
     FOR UPDATE;

  IF _status IS NULL THEN
    INSERT INTO public.tenant_members (tenant_id, user_id, role, status)
    VALUES (_tenant, _user_id, _role, 'invited');
    RETURN 'invited';
  END IF;

  IF _status = 'inactive' THEN
    -- Reinstated as an *invitation*, not as a member: the row is reused because
    -- one account may hold only one, and it goes back to the same starting line
    -- everyone else stands on. The new invitation's role replaces the old one.
    UPDATE public.tenant_members
       SET tenant_id = _tenant, role = _role, status = 'invited'
     WHERE user_id = _user_id;
    RETURN 'reinvited';
  END IF;

  IF _status = 'invited' AND _their_tenant = _tenant THEN
    -- Still waiting, same business: the email is being sent again. The role is
    -- updated in case the admin picked a different one this time. Status is
    -- already 'invited' and is written unchanged rather than assumed.
    UPDATE public.tenant_members
       SET role = _role, status = 'invited'
     WHERE user_id = _user_id;
    RETURN 'resent';
  END IF;

  -- Active anywhere, or invited by someone else. An existing membership is never
  -- taken over by another business.
  RAISE EXCEPTION 'That email is already registered.' USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_place_invitation(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_place_invitation(uuid, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. profiles — four reasons to read a row, instead of no reason at all.
-- ---------------------------------------------------------------------------
-- `USING (true)` since the first migration: every signed-in account could read
-- every name, phone number and avatar on the platform. It also made the invite
-- endpoint's careful refusals pointless, since anyone could query the table
-- directly to learn whether an address was registered.
--
-- Every read of `profiles` in the application was inventoried before writing
-- this. There are thirteen, and they fall into four patterns. Each policy below
-- is one pattern; together they permit every existing read and nothing else.
--
-- Nothing anonymous reads this table, so these stay `TO authenticated`. The
-- eleven SECURITY DEFINER functions that read profiles internally — the audit
-- log actors, the chat and booking notifications, `claim_initial_role`,
-- `tenant_member_eligibility`, `ensure_tenant_workspace`, `list_courthub_admins`
-- — bypass row-level security and are unaffected by any of this.
--
-- One caveat worth stating plainly: row-level security cannot hide a column. A
-- venue that may read its customer's row may read that row's phone number, which
-- is what the bookings and customers screens already display. What changes is
-- *whose* rows are readable, not which columns.

DROP POLICY IF EXISTS "Profiles are viewable by authenticated" ON public.profiles;

-- P1. Your own row. Every sign-in reads it to decide whether this is a player or
-- a venue manager, and the header reads it for a name and an avatar.
DROP POLICY IF EXISTS "Users read their own profile" ON public.profiles;
CREATE POLICY "Users read their own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- P2. A customer of one of your venues. The bookings table, the customers list,
-- the calendar, today's schedule and the operating-hours conflict warning all
-- name the person who booked. Scoped exactly like the bookings policy itself, at
-- `staff`, so it follows venue access rather than inventing a second rule.
DROP POLICY IF EXISTS "Venue team read their customers" ON public.profiles;
CREATE POLICY "Venue team read their customers"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.bookings b
        JOIN public.courts c ON c.id = b.court_id
       WHERE b.user_id = profiles.id
         AND public.venue_allows(c.venue_id, 'staff')
    )
  );

-- P3. A teammate. The Team screen lists the roster and needs a name against each
-- member. `current_tenant_id()` is active-only as of section 4, so an invited or
-- removed member reads no colleague's row through this.
DROP POLICY IF EXISTS "Team read each other" ON public.profiles;
CREATE POLICY "Team read each other"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_members tm
       WHERE tm.user_id = profiles.id
         AND tm.tenant_id = public.current_tenant_id()
    )
  );

-- P4. Someone who has written to you. Chat shows the author's name beside each
-- message, and both sides read it. Keyed on having actually sent a message in a
-- conversation the reader is part of, which is narrower than "staff of that
-- venue" and matches what the screen does today.
DROP POLICY IF EXISTS "Conversation partners read each other" ON public.profiles;
CREATE POLICY "Conversation partners read each other"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
       WHERE m.sender_id = profiles.id
         AND public.is_conversation_participant(m.conversation_id, auth.uid())
    )
  );


-- ---------------------------------------------------------------------------
-- 5b. is_tenant() — a reader of profiles that section 5 would have changed.
-- ---------------------------------------------------------------------------
-- `is_tenant(_user_id)` was created SECURITY DEFINER and redefined SECURITY
-- INVOKER a day later, so it reads `profiles` under the caller's own row-level
-- security. While that policy was `USING (true)` the difference never showed.
-- With section 5 in place it would quietly start answering `false` for anybody
-- but the caller.
--
-- Its last policy consumer — the old "Tenants can insert venues" — was replaced
-- in 20260920, and nothing in the application calls it, so this changes no
-- behaviour today. It is restored to SECURITY DEFINER rather than dropped
-- because a function that silently returns the wrong answer is worse than either
-- keeping it correct or removing it, and removing it is not this migration's job.
CREATE OR REPLACE FUNCTION public.is_tenant(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = _user_id AND role = 'tenant'
  );
$$;

REVOKE ALL ON FUNCTION public.is_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_tenant(uuid) TO authenticated, service_role;
