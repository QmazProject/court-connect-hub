
CREATE OR REPLACE FUNCTION public.get_court_bookings(_court_id bigint, _from timestamptz, _to timestamptz)
RETURNS TABLE(start_time timestamptz, end_time timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT start_time, end_time
  FROM public.bookings
  WHERE court_id = _court_id
    AND status = 'confirmed'
    AND start_time < _to
    AND end_time > _from;
$$;

REVOKE EXECUTE ON FUNCTION public.get_court_bookings(bigint, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_court_bookings(bigint, timestamptz, timestamptz) TO anon, authenticated;
