-- Expose only anonymous hold state to players. A pending payment is labelled
-- as a hold only when it is the reason this specific slot cannot be selected.

DROP FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.get_court_availability(
  _court_id bigint, _from timestamptz, _to timestamptz
)
RETURNS TABLE(
  hour_start timestamptz,
  remaining integer,
  blocked_by_other_sport boolean,
  held_for_payment boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _capacity integer;
BEGIN
  SELECT capacity INTO _capacity FROM public.courts WHERE id = _court_id;
  IF _capacity IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH hours AS (
    SELECT gs AS hour_start
    FROM generate_series(date_trunc('hour', _from), _to - interval '1 hour', interval '1 hour') AS gs
  ),
  same_court AS (
    SELECT h.hour_start,
           count(*) FILTER (WHERE b.status = 'confirmed')::integer AS confirmed_count,
           count(*) FILTER (WHERE b.status = 'pending')::integer AS pending_count
    FROM hours h
    JOIN public.bookings b
      ON b.court_id = _court_id
     AND public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < h.hour_start + interval '1 hour'
     AND b.end_time > h.hour_start
    GROUP BY h.hour_start
  ),
  blocking AS (
    SELECT h.hour_start,
           count(*) FILTER (WHERE b.status = 'confirmed')::integer AS confirmed_count,
           count(*) FILTER (WHERE b.status = 'pending')::integer AS pending_count
    FROM hours h
    JOIN public.bookings b
      ON public.booking_is_active_hold(b.status, b.created_at)
     AND b.start_time < h.hour_start + interval '1 hour'
     AND b.end_time > h.hour_start
    JOIN public.court_block_rules r
      ON r.court_id = b.court_id
     AND r.blocked_court_id = _court_id
    GROUP BY h.hour_start
  )
  SELECT h.hour_start,
         CASE WHEN coalesce(blocking.confirmed_count, 0) + coalesce(blocking.pending_count, 0) > 0 THEN 0
              ELSE greatest(_capacity - coalesce(same_court.confirmed_count, 0) - coalesce(same_court.pending_count, 0), 0) END,
         coalesce(blocking.confirmed_count, 0) + coalesce(blocking.pending_count, 0) > 0,
         (
           coalesce(blocking.confirmed_count, 0) = 0
           AND coalesce(same_court.confirmed_count, 0) = 0
           AND (
             coalesce(blocking.pending_count, 0) > 0
             OR coalesce(same_court.pending_count, 0) >= _capacity
           )
         )
  FROM hours h
  LEFT JOIN same_court USING (hour_start)
  LEFT JOIN blocking USING (hour_start)
  ORDER BY h.hour_start;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_court_availability(bigint, timestamptz, timestamptz) TO service_role;
