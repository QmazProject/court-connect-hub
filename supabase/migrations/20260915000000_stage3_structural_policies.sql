-- Phase 2.5, Stage 3 — the structure of a venue.
--
-- Stage 2 put roles behind money and history. This puts them behind the shape of the
-- business: the venue record, its courts, the physical courts beneath them, and the
-- rules that close a court for maintenance. A front-desk member can still do their
-- job — take bookings, talk to customers, read the venue — and can no longer alter
-- what they are working inside.
--
-- Deletion is separated from editing. A manager runs the venue; only an admin can
-- remove one, or remove a court, because an accidental delete here is not recoverable
-- from the application and takes a venue's bookings, rates and history with it.
--
-- Every public read path is left exactly as found. "Anyone can select venues",
-- "Anyone can select courts", "Anyone can view physical courts" and "Anyone can view
-- court block rules" are `USING (true)` for everyone and are not touched by this
-- migration — players browsing courts must be unaffected, and the surest way to keep
-- them unaffected is not to write their policies at all.
--
-- Untouched: bookings, conversations, refund RPCs, team management, booking numbers,
-- Stage 1, Stage 2, and `venues` INSERT (see the note at the foot of this file).

-- ---------------------------------------------------------------------------
-- 1. The venue record.
-- ---------------------------------------------------------------------------
-- `TO authenticated` on every new policy below. The originals were a mix of `{public}`
-- and `{authenticated}`, but `venue_allows` is REVOKEd from `anon`, so leaving a policy
-- open to anonymous callers would have them hit a permission error while evaluating it
-- rather than a clean refusal. Anonymous writes are refused either way — now by the
-- absence of a policy that admits them, which is the quieter answer.
DROP POLICY IF EXISTS "Staff can update venues" ON public.venues;
CREATE POLICY "Managers can update venues"
  ON public.venues FOR UPDATE TO authenticated
  USING (public.venue_allows(venues.id, 'manager'))
  /* Stated rather than left implicit. Postgres falls back to USING when WITH CHECK is
     omitted, which is what the original relied on; writing it out means the row being
     written is visibly checked too, and a manager cannot move a venue to another
     tenant by editing `tenant_id` into it. */
  WITH CHECK (public.venue_allows(venues.id, 'manager'));

DROP POLICY IF EXISTS "Staff can delete venues" ON public.venues;
CREATE POLICY "Admins can delete venues"
  ON public.venues FOR DELETE TO authenticated
  USING (public.venue_allows(venues.id, 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Courts.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Staff can insert courts" ON public.courts;
CREATE POLICY "Managers can insert courts"
  ON public.courts FOR INSERT TO authenticated
  WITH CHECK (public.venue_allows(courts.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can update courts" ON public.courts;
CREATE POLICY "Managers can update courts"
  ON public.courts FOR UPDATE TO authenticated
  USING (public.venue_allows(courts.venue_id, 'manager'))
  /* Also stops a court being moved between venues by editing `venue_id`: the new row
     has to pass the same test as the old one. */
  WITH CHECK (public.venue_allows(courts.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can delete courts" ON public.courts;
CREATE POLICY "Admins can delete courts"
  ON public.courts FOR DELETE TO authenticated
  USING (public.venue_allows(courts.venue_id, 'admin'));

-- ---------------------------------------------------------------------------
-- 3. Physical courts.
-- ---------------------------------------------------------------------------
-- Manager throughout, including delete. That follows the brief literally — a manager
-- was given physical courts to manage, and only venue and court deletion were named as
-- admin-only — but it does leave a manager able to delete the physical court sitting
-- under a `courts` row they are not allowed to delete. Worth a second look; one word
-- changes it.
DROP POLICY IF EXISTS "Staff can insert physical courts" ON public.physical_courts;
CREATE POLICY "Managers can insert physical courts"
  ON public.physical_courts FOR INSERT TO authenticated
  WITH CHECK (public.venue_allows(physical_courts.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can update physical courts" ON public.physical_courts;
CREATE POLICY "Managers can update physical courts"
  ON public.physical_courts FOR UPDATE TO authenticated
  USING (public.venue_allows(physical_courts.venue_id, 'manager'))
  WITH CHECK (public.venue_allows(physical_courts.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can delete physical courts" ON public.physical_courts;
CREATE POLICY "Managers can delete physical courts"
  ON public.physical_courts FOR DELETE TO authenticated
  USING (public.venue_allows(physical_courts.venue_id, 'manager'));

-- ---------------------------------------------------------------------------
-- 4. Court block rules.
-- ---------------------------------------------------------------------------
-- Closing a court for maintenance is configuration here rather than a daily task, per
-- the brief. It is the one change in this migration a front desk may feel: a Staff
-- member who finds a flooded court can no longer block it themselves and has to ask a
-- manager. Reading them is unchanged and still public.
DROP POLICY IF EXISTS "Staff can insert court block rules" ON public.court_block_rules;
CREATE POLICY "Managers can insert court block rules"
  ON public.court_block_rules FOR INSERT TO authenticated
  WITH CHECK (public.venue_allows(court_block_rules.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can update court block rules" ON public.court_block_rules;
CREATE POLICY "Managers can update court block rules"
  ON public.court_block_rules FOR UPDATE TO authenticated
  USING (public.venue_allows(court_block_rules.venue_id, 'manager'))
  WITH CHECK (public.venue_allows(court_block_rules.venue_id, 'manager'));

DROP POLICY IF EXISTS "Staff can delete court block rules" ON public.court_block_rules;
CREATE POLICY "Managers can delete court block rules"
  ON public.court_block_rules FOR DELETE TO authenticated
  USING (public.venue_allows(court_block_rules.venue_id, 'manager'));

-- ---------------------------------------------------------------------------
-- 5. Why `venues` INSERT is not in this migration.
-- ---------------------------------------------------------------------------
-- "Tenants can insert venues" WITH CHECK (is_tenant(auth.uid())) is left exactly as it
-- is, and that is a decision rather than an oversight.
--
-- Gating it on a tenant role would read the caller's `tenant_members` row — and a
-- tenant who signed up today has none. The only INSERT INTO public.tenants anywhere is
-- Phase 0's backfill of accounts that already existed; nothing creates a tenant record
-- for a new sign-up. So a membership-gated INSERT would refuse every new tenant their
-- first venue, which is a worse failure than the one it fixes.
--
-- What it leaves open: `is_tenant()` reads `profiles.role`, and invited members are
-- created with role='tenant', so a Staff member can still create a *new* venue — they
-- simply cannot change one that exists. Closing that needs the sign-up gap fixed first.
