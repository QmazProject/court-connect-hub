-- Booking a court failed for players with:
--   permission denied for function assistant_open_hours
--
-- Chain:
--   1. A player inserts into bookings.
--   2. The validate_booking() trigger fires. It is plpgsql and SECURITY INVOKER,
--      so its body runs as the player.
--   3. It calls public.court_is_open(), which 20260901000000_assistant_phase2.sql
--      rewrote to delegate its opening-hours rule to public.assistant_open_hours().
--   4. 20260831000000_assistant_search.sql had revoked EXECUTE on that helper from
--      PUBLIC, anon and authenticated the day before — it is an internal helper,
--      not a callable API, and that revoke is correct.
--   5. court_is_open() is revoked only from PUBLIC and anon, so the player gets
--      into it and fails one call deeper. That is why the error names the helper
--      and not court_is_open.
--
-- The other two callers of the helper — search_available_courts() and
-- tenant_court_day() — are already SECURITY DEFINER, which is why neither of them
-- broke. court_is_open() is the only one reachable from an ordinary user's
-- trigger, and it was the one that did not get the same treatment.
--
-- Fix: run it as its owner, like its siblings. ALTER rather than a rewrite so the
-- body cannot drift from the definition phase2 installed.
--
-- Safe as DEFINER: it takes a court id and an instant and returns a boolean about
-- opening hours, reading only courts and venues by primary key. The same fact is
-- already public through get_court_availability(), which is DEFINER and granted to
-- anon. It also already carries `SET search_path = public`, which is the guard a
-- SECURITY DEFINER function needs.
ALTER FUNCTION public.court_is_open(bigint, timestamptz) SECURITY DEFINER;

-- Unchanged, restated so this migration is self-describing: reachable by signed-in
-- users (the booking trigger needs it), never by anonymous ones.
REVOKE EXECUTE ON FUNCTION public.court_is_open(bigint, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.court_is_open(bigint, timestamptz) TO authenticated, service_role;
