-- Rollback for 20260917000000_allow_staff_role_on_staff.sql
--
-- Outside supabase/migrations/ so `db push` never applies it. Run by hand only.
--
-- ⚠️ Unlike the other rollbacks in this folder, this one can FAIL — and failing is the
-- correct behaviour. Narrowing a CHECK is refused by Postgres while any row violates
-- it, so if a team member has accepted an invitation since the fix, their `staff` row
-- carries 'staff' and this statement will abort with:
--
--   ERROR: check constraint "staff_role_check" of relation "staff" is violated by some row
--
-- That is the database refusing to let a rollback quietly strand a working team. It
-- means the fix is load-bearing and reversing it would break acceptance again.
--
-- To see what would block it:
--
--   SELECT s.user_id, s.venue_id, v.name AS venue, p.full_name
--     FROM public.staff s
--     LEFT JOIN public.venues   v ON v.id = s.venue_id
--     LEFT JOIN public.profiles p ON p.id = s.user_id
--    WHERE s.role = 'staff'
--    ORDER BY v.name;
--
-- Deleting those rows revokes those members' access to their venues. Do it only
-- deliberately, and expect the Team module to stop working afterwards.

BEGIN;

ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_role_check;

-- The original, verbatim from 20260721022837.
ALTER TABLE public.staff ADD CONSTRAINT staff_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text]));

COMMIT;
