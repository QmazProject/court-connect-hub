-- Rollback for 20260913000000_stage1_close_staff_writes.sql
--
-- Deliberately NOT in supabase/migrations/: `supabase db push` applies everything it
-- finds there in filename order, and a rollback that reapplies itself the moment it is
-- committed is worse than none. Run this by hand, in the SQL editor, only if Stage 1
-- has to be undone.
--
-- The four statements below restore the policies exactly as they were read out of
-- pg_policies before the change. They are transcribed from that dump rather than
-- rewritten from memory, because the point of a rollback is to return to the state
-- that was actually there — including the parts that made it a hole.
--
-- Restoring these reopens it: any account with one staff row regains the ability to
-- grant that venue to any user it chooses, to delete the owner's row, and every
-- signed-in account on the platform regains the ability to read the whole staff
-- table. Undo Stage 1 only long enough to find out what broke.

BEGIN;

DROP POLICY IF EXISTS "Members read staff for their own tenant" ON public.staff;

-- Original: SELECT, roles {public}, USING (auth.role() = 'authenticated'::text)
CREATE POLICY "Authenticated users can select staff"
  ON public.staff FOR SELECT
  USING (auth.role() = 'authenticated'::text);

-- Original: INSERT, roles {public}
CREATE POLICY "Staff can insert staff"
  ON public.staff FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.user_id = auth.uid() AND s.venue_id = staff.venue_id
  ));

-- Original: UPDATE, roles {public}, USING only — no WITH CHECK in the original
CREATE POLICY "Staff can update staff"
  ON public.staff FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.user_id = auth.uid() AND s.venue_id = staff.venue_id
  ));

-- Original: DELETE, roles {public}
CREATE POLICY "Staff can delete staff"
  ON public.staff FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.user_id = auth.uid() AND s.venue_id = staff.venue_id
  ));

COMMIT;

-- Verify the restore matches the original four rows:
--   SELECT policyname, cmd, roles,
--          pg_get_expr(pol.polqual, pol.polrelid)      AS using_expr,
--          pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
--     FROM pg_policies p
--     JOIN pg_policy pol ON pol.polname = p.policyname
--     JOIN pg_class  c   ON c.oid = pol.polrelid AND c.relname = p.tablename
--    WHERE p.schemaname = 'public' AND p.tablename = 'staff'
--    ORDER BY policyname;
