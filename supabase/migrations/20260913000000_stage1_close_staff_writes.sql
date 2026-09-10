-- Phase 2.5, Stage 1 — closing the client's write access to `staff`.
--
-- `staff` is the table every venue, court, booking and voucher policy consults. It
-- decides who may act on a venue. Until now the client could write to it:
--
--   "Staff can insert staff"  WITH CHECK (EXISTS (SELECT 1 FROM staff s
--                              WHERE s.user_id = auth.uid()
--                                AND s.venue_id = staff.venue_id))
--
-- The check asks only that the writer already works at the venue. It says nothing
-- about *whose* id is being written, so anybody with a single staff row could grant
-- that venue to any account they chose, and delete anyone else's row — including the
-- owner's. The Team module's invitations, its one-tenant rule and its acceptance step
-- were all optional: the same access could be handed out directly from a browser, and
-- a member about to leave could add a spare account that survives their removal.
--
-- Nothing legitimate is lost by removing these. Every writer of `staff` is a
-- SECURITY DEFINER function and bypasses row-level security entirely:
-- `assign_venue_owner`, `tenant_accept_invitation`, `grant_team_access_to_new_venue`
-- and `tenant_remove_member`. The application only ever reads the table, and only
-- ever its own rows — all three call sites are `.eq("user_id", <self>)`.
--
-- Stage 1 only. Roles are not introduced here: the remaining 24 policies still ask
-- whether a staff row exists and not what it is for, and every table other than
-- `staff` is left exactly as it was.
-- Rollback: supabase/rollback/20260913000000_stage1_down.sql

-- ---------------------------------------------------------------------------
-- 1. Who worked here that the Team module cannot account for.
-- ---------------------------------------------------------------------------
-- Reported rather than deleted. A row here is either an owner from before Phase 0,
-- which is expected, or one written through the hole above, which is not — and only
-- someone who knows the business can tell those apart. Printed at migration time so
-- the answer arrives with the change rather than waiting to be asked for.
DO $$
DECLARE
  _unbacked int;
  _owners int;
BEGIN
  SELECT count(*) INTO _unbacked
    FROM public.staff s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = s.user_id AND tm.status <> 'inactive'
   );

  SELECT count(*) INTO _owners
    FROM public.staff s
   WHERE s.role = 'owner'
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_members tm
        WHERE tm.user_id = s.user_id AND tm.status <> 'inactive'
     );

  RAISE NOTICE 'Stage 1 audit: % staff row(s) have no active tenant_members record (% of them are owner rows).', _unbacked, _owners;
  IF _unbacked > _owners THEN
    RAISE NOTICE 'Stage 1 audit: % non-owner row(s) unaccounted for. Review them with the query in this migration before assuming they are legitimate.', _unbacked - _owners;
  END IF;
END;
$$;

-- The same question, to run whenever you want the detail rather than the count:
--
--   SELECT s.user_id, s.venue_id, s.role, v.name AS venue, p.full_name
--     FROM public.staff s
--     LEFT JOIN public.venues   v ON v.id = s.venue_id
--     LEFT JOIN public.profiles p ON p.id = s.user_id
--    WHERE NOT EXISTS (
--      SELECT 1 FROM public.tenant_members tm
--       WHERE tm.user_id = s.user_id AND tm.status <> 'inactive')
--    ORDER BY v.name, p.full_name;

-- ---------------------------------------------------------------------------
-- 2. The three write policies, removed.
-- ---------------------------------------------------------------------------
-- Removal rather than tightening. There is no correct client-side write to this
-- table: membership is granted by accepting an invitation and revoked by an admin,
-- and both already run as definer functions. A policy allowing some narrower write
-- would only be a second way in to keep correct forever.
DROP POLICY IF EXISTS "Staff can insert staff" ON public.staff;
DROP POLICY IF EXISTS "Staff can update staff" ON public.staff;
DROP POLICY IF EXISTS "Staff can delete staff" ON public.staff;

-- ---------------------------------------------------------------------------
-- 3. Reading `staff` narrowed to the reader's own workspace.
-- ---------------------------------------------------------------------------
-- The old policy was `auth.role() = 'authenticated'`: every signed-in account on the
-- platform, players included, could read the whole table and learn who works at every
-- venue of every business.
--
-- `user_id = auth.uid()` leads deliberately. It is what all three application reads
-- ask for, and it means nobody can lose sight of their own rows however their tenant
-- record ends up — the guard against this change locking someone out of the workspace
-- list, which is built from exactly this query.
DROP POLICY IF EXISTS "Authenticated users can select staff" ON public.staff;
CREATE POLICY "Members read staff for their own tenant"
  ON public.staff FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.venues v
       WHERE v.id = staff.venue_id
         AND v.tenant_id IS NOT NULL
         AND v.tenant_id = public.current_tenant_id()
    )
  );
