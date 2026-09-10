-- Rollback for 20260915000000_stage3_structural_policies.sql
--
-- Outside supabase/migrations/ on purpose: `db push` applies that folder in filename
-- order, so a rollback kept there would undo its own migration on the next push. Run
-- this by hand, only if Stage 3 has to be reversed.
--
-- Transcribed from the pg_policies dump taken before Stage 3 — including the details
-- that were probably accidents. The `venues` and `courts` policies were `{public}`
-- rather than `{authenticated}`, and their UPDATE policies carried a USING clause with
-- no WITH CHECK. Both are reproduced. A rollback that tidied them would not return the
-- database to the state it is meant to return it to.
--
-- Restoring these gives any staff row the ability to edit and delete venues and courts
-- again. That was the state before Stage 3.
--
-- `venue_role()` and `venue_allows()` are left in place: Stage 2's policies still call
-- them, and dropping them here would break that. Remove them only if Stage 2 is being
-- reversed as well, and after this file has run.

BEGIN;

-- ---- venues -----------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can update venues" ON public.venues;
DROP POLICY IF EXISTS "Admins can delete venues"   ON public.venues;

-- Original: UPDATE, roles {public}, USING only.
CREATE POLICY "Staff can update venues"
  ON public.venues FOR UPDATE
  USING (EXISTS ( SELECT 1 FROM public.staff
                   WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id = venues.id))));

-- Original: DELETE, roles {public}.
CREATE POLICY "Staff can delete venues"
  ON public.venues FOR DELETE
  USING (EXISTS ( SELECT 1 FROM public.staff
                   WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id = venues.id))));

-- ---- courts -----------------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert courts" ON public.courts;
DROP POLICY IF EXISTS "Managers can update courts" ON public.courts;
DROP POLICY IF EXISTS "Admins can delete courts"   ON public.courts;

-- Original: INSERT, roles {public}.
CREATE POLICY "Staff can insert courts"
  ON public.courts FOR INSERT
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff
                        WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id = courts.venue_id))));

-- Original: UPDATE, roles {public}, USING only.
CREATE POLICY "Staff can update courts"
  ON public.courts FOR UPDATE
  USING (EXISTS ( SELECT 1 FROM public.staff
                   WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id = courts.venue_id))));

-- Original: DELETE, roles {public}.
CREATE POLICY "Staff can delete courts"
  ON public.courts FOR DELETE
  USING (EXISTS ( SELECT 1 FROM public.staff
                   WHERE ((staff.user_id = auth.uid()) AND (staff.venue_id = courts.venue_id))));

-- ---- physical_courts ---------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert physical courts" ON public.physical_courts;
DROP POLICY IF EXISTS "Managers can update physical courts" ON public.physical_courts;
DROP POLICY IF EXISTS "Managers can delete physical courts" ON public.physical_courts;

CREATE POLICY "Staff can insert physical courts"
  ON public.physical_courts FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = physical_courts.venue_id))));

-- Original carried both USING and WITH CHECK.
CREATE POLICY "Staff can update physical courts"
  ON public.physical_courts FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = physical_courts.venue_id))))
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = physical_courts.venue_id))));

CREATE POLICY "Staff can delete physical courts"
  ON public.physical_courts FOR DELETE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = physical_courts.venue_id))));

-- ---- court_block_rules -------------------------------------------------------
DROP POLICY IF EXISTS "Managers can insert court block rules" ON public.court_block_rules;
DROP POLICY IF EXISTS "Managers can update court block rules" ON public.court_block_rules;
DROP POLICY IF EXISTS "Managers can delete court block rules" ON public.court_block_rules;

CREATE POLICY "Staff can insert court block rules"
  ON public.court_block_rules FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = court_block_rules.venue_id))));

-- Original carried both USING and WITH CHECK.
CREATE POLICY "Staff can update court block rules"
  ON public.court_block_rules FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = court_block_rules.venue_id))))
  WITH CHECK (EXISTS ( SELECT 1 FROM public.staff s
                        WHERE ((s.user_id = auth.uid()) AND (s.venue_id = court_block_rules.venue_id))));

CREATE POLICY "Staff can delete court block rules"
  ON public.court_block_rules FOR DELETE TO authenticated
  USING (EXISTS ( SELECT 1 FROM public.staff s
                   WHERE ((s.user_id = auth.uid()) AND (s.venue_id = court_block_rules.venue_id))));

COMMIT;
