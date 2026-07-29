ALTER FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_venue_day_bookings(_venue_id bigint, _from timestamptz, _to timestamptz)
RETURNS TABLE(court_id bigint, start_time timestamptz, end_time timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT b.court_id, b.start_time, b.end_time
    FROM public.bookings b
    JOIN public.courts c ON c.id = b.court_id
   WHERE c.venue_id = _venue_id
     AND public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < _to
     AND b.end_time > _from;
$$;
REVOKE EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_venue_day_bookings(bigint, timestamptz, timestamptz) TO anon, authenticated, service_role;

ALTER TABLE public.bookings REPLICA IDENTITY FULL;

-- The table may already have been added through the Supabase dashboard or a
-- prior manual deployment. Keep this migration safe to retry in either case.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;
