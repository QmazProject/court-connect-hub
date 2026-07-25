-- Restrict EXECUTE on SECURITY DEFINER functions to only what's necessary.
-- Trigger functions must not be directly callable by clients.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_venue_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_venue_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_booking_voucher() FROM PUBLIC, anon, authenticated;

-- preview_voucher is intentionally callable by signed-in players.
REVOKE ALL ON FUNCTION public.preview_voucher(text, bigint, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_voucher(text, bigint, numeric) TO authenticated;