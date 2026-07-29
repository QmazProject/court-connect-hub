REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) TO service_role;