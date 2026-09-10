-- Fix: invitation acceptance fails on `staff_role_check`.
--
-- `staff.role` has allowed only 'owner', 'admin' and 'manager' since 20260721022837,
-- written when a venue's staff table held the people who ran it and 'staff' was the
-- name of the table rather than a value in it.
--
-- The Team module then began writing 'staff' into that column, in two places:
--
--   tenant_accept_invitation()        — every acceptance raised
--                                       'new row for relation "staff" violates check
--                                        constraint "staff_role_check"'
--   grant_team_access_to_new_venue()  — not yet seen, because `assign_venue_owner`
--                                       runs first alphabetically and gives the owner
--                                       their row, so the NOT EXISTS guard skips the
--                                       only member who currently exists. It would
--                                       have failed on the first venue created after a
--                                       second member became active.
--
-- Nothing is corrupt. In `tenant_accept_invitation` the membership UPDATE precedes the
-- failing INSERT inside one function, so Postgres rolled both back: the membership is
-- still 'invited', and no row carrying 'staff' exists to clean up.
--
-- Widening only. Every value that satisfies the constraint today still satisfies it,
-- so no existing owner, admin or manager row is affected and no data is rewritten.
--
-- No authorization changes. Every reader of this column in the codebase tests
-- `= 'owner'` or `<> 'owner'` and nothing enumerates the set — `venue_role()` uses the
-- owner row as its anti-lockout guard and takes every other role from
-- `tenant_members`. A fourth value is invisible to all of them.

ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE public.staff ADD CONSTRAINT staff_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'staff'::text]));
