-- Player message notifications open the conversation, not just the booking.
--
-- The tenant direction already deep links to the chat (`&chat=1`); the player
-- direction stopped at the booking, so a player tapping "Open conversation" landed on
-- their workspace and then had to find the booking and press Message themselves — the
-- exact hop the deep link exists to remove.
--
-- Only the player branch's link changes. The staff branch, the bodies, the recipients
-- and the fan-out are identical to 20260827000000.

CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _c RECORD; _sender_name text; _venue_name text; _court_name text; _context text;
BEGIN
  SELECT * INTO _c FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(trim(full_name), ''), 'Someone') INTO _sender_name
    FROM public.profiles WHERE id = NEW.sender_id;
  SELECT name INTO _venue_name FROM public.venues WHERE id = _c.venue_id;

  SELECT c.name INTO _court_name
    FROM public.bookings b JOIN public.courts c ON c.id = b.court_id
   WHERE b.id = _c.booking_id;

  _context := COALESCE(_court_name, 'Booking') || ' · Booking #' || _c.booking_id::text;

  IF NEW.sender_id = _c.player_id THEN
    PERFORM public.notify_venue_staff(
      _c.venue_id, 'message',
      'New message from ' || COALESCE(_sender_name, 'a player'),
      left(NEW.body, 140) || E'\n' || _context,
      '/dashboard?section=bookings&booking=' || _c.booking_id::text || '&chat=1',
      _c.booking_id, _c.id, NULL, NULL
    );
  ELSE
    PERFORM public.notify_user(
      _c.player_id, 'message',
      COALESCE(_venue_name, 'The venue') || ' replied',
      left(NEW.body, 140) || E'\n' || _context,
      -- `&chat=1` is the fix: the workspace opens the booking's conversation on
      -- arrival instead of only scrolling to the card.
      '/dashboard?booking=' || _c.booking_id::text || '&chat=1',
      _c.booking_id, _c.venue_id, _c.id
    );
  END IF;

  RETURN NEW;
END; $$;
