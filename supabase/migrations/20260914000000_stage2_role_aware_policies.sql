-- Phase 2.5, Stage 2 — the first policies that ask what a member is for.
--
-- Every policy so far has asked one question: does this person have a `staff` row for
-- this venue? Admin, Manager and Staff have been labels the Team screen honours and
-- the database has never read. This introduces the reading, on the tables where being
-- wrong is recoverable — discounts, revenue figures and change history — and leaves
-- venues, courts and bookings for Stage 3.
--
-- Two functions carry the whole rule so the twenty-odd remaining policies can adopt it
-- a line at a time, and so a future change to what a Manager may do is one edit rather
-- than twenty-four.
--
-- Untouched here: `venues`, `courts`, `bookings`, `conversations`, `physical_courts`,
-- `court_block_rules`, both refund RPCs, every player-facing policy, and Stage 1.

-- ---------------------------------------------------------------------------
-- 1. What a person is, at a venue.
-- ---------------------------------------------------------------------------
-- Resolves through `staff` (which venue) to `tenant_members` (what role), because
-- `staff.role` is not the answer: `tenant_accept_invitation` writes 'staff' into it for
-- everyone, and the meaningful role lives on the membership.
--
-- A `staff.role = 'owner'` row counts as admin whatever the membership says. That is
-- the anti-lockout guard: the person who created a venue can never be shut out of it
-- by a membership record that is missing, invited-but-not-accepted, or wrong.
--
-- SECURITY DEFINER so it reads `staff` and `tenant_members` outside row-level security.
-- Stage 1 narrowed the `staff` SELECT policy to a member's own rows; without definer
-- rights this would inherit that narrowing and answer for nobody but the caller — and
-- a policy helper that consults the policies it serves is how recursion starts.
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
         -- Only an accepted membership grants anything. An invitation that has not
         -- been answered must not open a door before the person walks through it.
         AND tm.status = 'active'
       WHERE s.venue_id = _venue_id
         AND s.user_id = auth.uid()
       LIMIT 1
    )
  END;
$$;

-- The predicate the policies actually call. Ranked rather than compared by name, so
-- "at least a manager" is one expression instead of a list that has to be extended
-- every time a role is added.
CREATE OR REPLACE FUNCTION public.venue_allows(_venue_id bigint, _min text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE public.venue_role(_venue_id)
           WHEN 'admin'   THEN 3
           WHEN 'manager' THEN 2
           WHEN 'staff'   THEN 1
           ELSE 0
         END
       >= CASE _min
           WHEN 'admin'   THEN 3
           WHEN 'manager' THEN 2
           ELSE 1
         END;
$$;

REVOKE ALL ON FUNCTION public.venue_role(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venue_allows(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venue_role(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venue_allows(bigint, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Vouchers — everyone sees them, managers change them.
-- ---------------------------------------------------------------------------
-- A voucher is money off. Front-desk staff need to know one exists to honour it; only
-- a manager decides one should.
DROP POLICY IF EXISTS "Staff can view venue vouchers" ON public.vouchers;
CREATE POLICY "Team can view venue vouchers"
  ON public.vouchers FOR SELECT TO authenticated
  USING (public.venue_allows(vouchers.venue_id, 'staff'));

DROP POLICY IF EXISTS "Staff can insert venue vouchers" ON public.vouchers;
CREATE POLICY "Managers can insert venue vouchers"
  ON public.vouchers FOR INSERT TO authenticated
  WITH CHECK (public.venue_allows(vouchers.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can update venue vouchers" ON public.vouchers;
CREATE POLICY "Managers can update venue vouchers"
  ON public.vouchers FOR UPDATE TO authenticated
  USING (public.venue_allows(vouchers.venue_id, 'manager'))
  WITH CHECK (public.venue_allows(vouchers.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can delete venue vouchers" ON public.vouchers;
CREATE POLICY "Managers can delete venue vouchers"
  ON public.vouchers FOR DELETE TO authenticated
  USING (public.venue_allows(vouchers.venue_id, 'manager'));

-- ---------------------------------------------------------------------------
-- 3. Redemptions and revenue — manager and above.
-- ---------------------------------------------------------------------------
-- Who used which discount, and what the venue took. Both are the financial picture of
-- the business rather than anything the front desk needs to serve a customer.
--
-- The players' own halves of these tables are separate policies and are not touched:
-- "Players see own redemptions" and "Players view own transactions" still stand
-- exactly as they were, so nothing about a player's view of their own history changes.
DROP POLICY IF EXISTS "Staff see venue redemptions" ON public.voucher_redemptions;
CREATE POLICY "Managers see venue redemptions"
  ON public.voucher_redemptions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.vouchers v
     WHERE v.id = voucher_redemptions.voucher_id
       AND public.venue_allows(v.venue_id, 'manager')
  ));

DROP POLICY IF EXISTS "Venue staff view venue transactions" ON public.transactions;
CREATE POLICY "Managers view venue transactions"
  ON public.transactions FOR SELECT TO authenticated
  USING (public.venue_allows(transactions.venue_id, 'manager'));

-- ---------------------------------------------------------------------------
-- 4. Change history — manager and above.
-- ---------------------------------------------------------------------------
-- Who changed what, and when. Useful when something looks wrong and not otherwise, so
-- it follows the same line as the financial views.
DROP POLICY IF EXISTS "Staff can view court audit" ON public.court_audit_log;
DROP POLICY IF EXISTS "Venue staff can view court audit" ON public.court_audit_log;
CREATE POLICY "Managers can view court audit"
  ON public.court_audit_log FOR SELECT TO authenticated
  USING (public.venue_allows(court_audit_log.venue_id, 'manager'));

-- Dropped rather than gated. Nothing writes this table from a browser — the only
-- writer is `log_court_change()`, a SECURITY DEFINER trigger that bypasses row-level
-- security entirely — so the policy has never been the thing permitting an audit row,
-- and keeping it would leave a client-side write path with nothing on the other end of
-- it. `venue_audit_log` already blocks direct inserts outright for the same reason.
DROP POLICY IF EXISTS "Venue staff can insert court audit" ON public.court_audit_log;

DROP POLICY IF EXISTS "Staff can view audit log for their venues" ON public.venue_audit_log;
CREATE POLICY "Managers can view venue audit log"
  ON public.venue_audit_log FOR SELECT TO authenticated
  USING (public.venue_allows(venue_audit_log.venue_id, 'manager'));
