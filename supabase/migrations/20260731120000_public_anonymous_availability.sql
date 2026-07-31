-- Availability is deliberately anonymous: these RPCs return only court IDs,
-- timestamps and capacity state. Players need them before checkout, so do not
-- require the server-only service-role key merely to browse available slots.
REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) TO anon, authenticated, service_role;
