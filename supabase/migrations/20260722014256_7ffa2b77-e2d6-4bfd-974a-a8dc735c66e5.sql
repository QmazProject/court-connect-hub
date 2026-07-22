REVOKE EXECUTE ON FUNCTION public.get_court_bookings(bigint, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_court_bookings(bigint, timestamp with time zone, timestamp with time zone) TO authenticated;
ALTER FUNCTION public.get_court_bookings(bigint, timestamp with time zone, timestamp with time zone) SECURITY INVOKER;