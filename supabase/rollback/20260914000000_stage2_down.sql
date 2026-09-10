-- Rollback for 20260914000000_stage2_role_aware_policies.sql
--
-- Outside supabase/migrations/ on purpose: `db push` applies that folder in filename
-- order, and a rollback living there would undo the change it rolls back the moment it
-- was committed. Run this by hand, only if Stage 2 has to be reversed.
--
-- Every expression below is transcribed from the pg_policies dump taken before Stage 2,
-- not rewritten from memory. Restoring them returns the tables to asking only whether a
-- `staff` row exists — which means a Staff member regains the ability to create and
-- delete vouchers and to read every transaction. That is what the state before Stage 2
-- was, and a rollback that quietly improved on it would not be a rollback.
--
-- The two functions are left in place: nothing else references them once the policies
-- below are restored, and dropping them would break Stage 3 if it has already shipped.
-- Drop them by hand only if Stage 2 is being abandoned entirely.

BEGIN;

-- ---- vouchers ---------------------------------------------------------------
DROP POLICY IF EXISTS "Team can view venue vouchers"      ON public.vouchers;
DROP POLICY IF EXISTS "Managers can insert venue vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Managers can update venue vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Managers can delete venue vouchers" ON public.vouchers;

CREATE POLICY "Staff can view venue vouchers"
  ON public.vouchers FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = vouchers.venue_id))));

CREATE POLICY "Staff can insert venue vouchers"
  ON public.vouchers FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = vouchers.venue_id))));

-- The original carried both USING and WITH CHECK.
CREATE POLICY "Staff can update venue vouchers"
  ON public.vouchers FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = vouchers.venue_id))))
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = vouchers.venue_id))));

CREATE POLICY "Staff can delete venue vouchers"
  ON public.vouchers FOR DELETE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = vouchers.venue_id))));

-- ---- voucher_redemptions ----------------------------------------------------
DROP POLICY IF EXISTS "Managers see venue redemptions" ON public.voucher_redemptions;

CREATE POLICY "Staff see venue redemptions"
  ON public.voucher_redemptions FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
                    FROM (public.vouchers v
                      JOIN public.staff s ON ((s.venue_id = v.venue_id)))
                   WHERE ((v.id = voucher_redemptions.voucher_id) AND (s.user_id = auth.uid()))));

-- ---- transactions -----------------------------------------------------------
DROP POLICY IF EXISTS "Managers view venue transactions" ON public.transactions;

CREATE POLICY "Venue staff view venue transactions"
  ON public.transactions FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.venue_id = transactions.venue_id) AND (s.user_id = auth.uid()))));

-- ---- court_audit_log --------------------------------------------------------
DROP POLICY IF EXISTS "Managers can view court audit" ON public.court_audit_log;

CREATE POLICY "Venue staff can view court audit"
  ON public.court_audit_log FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.venue_id = court_audit_log.venue_id) AND (s.user_id = auth.uid()))));

-- Restored for fidelity even though nothing uses it: the writer is a SECURITY DEFINER
-- trigger that never needed a policy. It was there before Stage 2, so it is here.
CREATE POLICY "Venue staff can insert court audit"
  ON public.court_audit_log FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.venue_id = court_audit_log.venue_id) AND (s.user_id = auth.uid()))));

-- ---- venue_audit_log --------------------------------------------------------
DROP POLICY IF EXISTS "Managers can view venue audit log" ON public.venue_audit_log;

CREATE POLICY "Staff can view audit log for their venues"
  ON public.venue_audit_log FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.venue_id = venue_audit_log.venue_id) AND (s.user_id = auth.uid()))));

COMMIT;
