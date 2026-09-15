-- ===========================================================================
-- Where a booking came from, and who collected the money for it.
--
-- Until now every booking in this system was the same kind of booking: a player
-- signed in, chose an hour, and paid Court Connect Hub through PayMongo. The
-- platform therefore held the cash for every row in the table, and "gross sales"
-- and "what we owe this tenant" were the same number read twice.
--
-- A walk-in breaks that equality. Someone arrives at the venue, hands ₱600 to
-- the person behind the desk, and plays. The court is occupied exactly as if it
-- had been booked online — so it must occupy the same calendar — but the
-- platform never touched the money and owes the tenant nothing for it. Summing
-- bookings to decide a payout would now overstate the liability by the whole of
-- the walk-in trade.
--
-- Two columns carry that distinction, and they are deliberately separate:
--
--   booking_source            where the booking came from
--   payment_collection_source who ended up holding the cash
--
-- They are separate because they are not the same question and will not stay in
-- step. An admin-created booking might be settled online; a walk-in might be
-- left unpaid until the player finishes. Collapsing them into one column would
-- force a guess the moment a third case appears.
--
-- What this migration does NOT do: it does not add a ledger, a balance, a payout
-- or a fee. It records the fact those things will later be computed from. The
-- accounting rule this exists to protect is one sentence — money the tenant
-- collected itself is never money the platform owes the tenant — and it is
-- enforced here only as far as recording the fact honestly.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The two source columns.
-- ---------------------------------------------------------------------------
-- Both are NOT NULL with a default, which is what backfills the existing table:
-- Postgres fills every historical row with the default as part of this
-- statement. 'online'/'platform' is the correct classification for all of them
-- and not merely the convenient one — until this migration ships there was no
-- way to create a booking except as a signed-in player paying through the
-- platform's PayMongo account, so no historical row can be anything else. No
-- row's money is reinterpreted by this backfill; it is named, not moved.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS booking_source text NOT NULL DEFAULT 'online';

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_collection_source text NOT NULL DEFAULT 'platform';

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_booking_source_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_booking_source_check
  CHECK (booking_source IN ('online', 'walk_in', 'admin_manual'));

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_collection_source_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_collection_source_check
  CHECK (payment_collection_source IN ('platform', 'tenant', 'unpaid'));


-- ---------------------------------------------------------------------------
-- 2. The walk-in customer, recorded on the booking itself.
-- ---------------------------------------------------------------------------
-- A walk-in customer need not have an account — requiring one would defeat the
-- point of the feature — so their details are stored on the booking rather than
-- resolved through a join to a user that may not exist. This is also a snapshot
-- on purpose: a receipt reprinted next year must show the name and number taken
-- at the desk that evening, not whatever a linked profile has been edited to
-- since. The rate charged is snapshotted the same way, in the existing
-- `unit_price` column, so re-pricing a court later cannot rewrite history.

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_customer_name  text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_customer_phone text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_customer_email text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_player_count   integer;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_notes          text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_reference      text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS walkin_payment_method text;

-- Who took the booking. Always a real staff member for a walk-in, and null for
-- anything a player did themselves. ON DELETE SET NULL because losing the
-- employee must never delete the sale.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- 3. The rules that keep the two columns honest.
-- ---------------------------------------------------------------------------
-- An online booking is by definition one the platform collected for, and a
-- walk-in is by definition one it did not. Writing that down as a constraint is
-- what stops a later screen, migration or well-meaning fix from producing a row
-- that claims the platform holds cash a venue actually took at the desk — the
-- single error this whole feature exists to prevent. 'unpaid' is allowed on a
-- walk-in because a venue may seat someone who pays afterwards; it is not
-- allowed on an online booking, which cannot exist unpaid.

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_source_collection_agree;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_source_collection_agree CHECK (
    (booking_source = 'online'       AND payment_collection_source = 'platform')
    OR (booking_source = 'walk_in'   AND payment_collection_source IN ('tenant', 'unpaid'))
    OR (booking_source = 'admin_manual')
  );

-- A walk-in without a customer name is an unidentifiable sale, and one without a
-- recorded actor is an unauditable one.
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_walkin_requires_customer;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_walkin_requires_customer CHECK (
    booking_source <> 'walk_in'
    OR (
      walkin_customer_name IS NOT NULL
      AND length(btrim(walkin_customer_name)) > 0
      AND recorded_by IS NOT NULL
    )
  );

-- A receipt number identifies one sale or it identifies nothing.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_walkin_reference_unique
  ON public.bookings (walkin_reference)
  WHERE walkin_reference IS NOT NULL;

-- Every tenant report this feature feeds splits on booking_source.
CREATE INDEX IF NOT EXISTS idx_bookings_source
  ON public.bookings (booking_source, payment_collection_source);


-- ---------------------------------------------------------------------------
-- 4. A walk-in must not appear in the recorder's own player bookings.
-- ---------------------------------------------------------------------------
-- `bookings.user_id` is NOT NULL, and making it nullable breaks nine call sites
-- in the tenant workspace, so an unlinked walk-in has to borrow a uid. It
-- borrows the recording staff member's. That is a storage detail and must not
-- become a visible one: without this change the employee who took the booking
-- would find a stranger's game sitting in their own "My bookings" list, and
-- every per-player figure computed from `user_id` would count it as theirs.
--
-- The staff clause is reproduced exactly as Stage 4 left it. The player clause
-- gains one test. An unlinked walk-in is precisely the row whose `user_id` is
-- its own `recorded_by`; a walk-in deliberately linked to a real player has that
-- player in `user_id` and the employee in `recorded_by`, so it stays visible to
-- the player it belongs to. Historical rows are all 'online' with a null
-- `recorded_by`, so the added test is false for every one of them and their
-- visibility is bit-for-bit unchanged.
--
-- This narrows what a player may read and widens nothing. Staff visibility is
-- untouched: the second clause still returns every walk-in at the venue.

DROP POLICY IF EXISTS "Users can select own bookings" ON public.bookings;
CREATE POLICY "Users can select own bookings"
  ON public.bookings FOR SELECT
  USING (
    (
      user_id = auth.uid()
      AND NOT (
        booking_source = 'walk_in'
        AND user_id IS NOT DISTINCT FROM recorded_by
      )
    )
    OR (EXISTS ( SELECT 1
                   FROM public.courts c
                  WHERE c.id = bookings.court_id
                    AND public.venue_allows(c.venue_id, 'staff')))
  );


-- ---------------------------------------------------------------------------
-- 5. Creating a walk-in.
-- ---------------------------------------------------------------------------
-- The important thing about this function is how little it does.
--
-- It does NOT check whether the slot is free. `public.validate_booking()` is
-- already a BEFORE INSERT/UPDATE trigger on this table: it takes
-- `pg_advisory_xact_lock(physical_court_id)`, then re-checks operating hours
-- through `court_is_open`, directional blocking through `court_block_rules`, and
-- capacity against every active hold. Every row that enters `bookings` passes
-- through it, whoever inserted it and by whatever route. So a walk-in is
-- protected by exactly the mechanism an online checkout is protected by, and the
-- two cannot both win the same hour: the lock serialises them and the loser gets
-- an exception. Adding a second availability check here would not make that
-- safer — it would create a second answer that can disagree with the first.
--
-- It does NOT accept a price from the caller. The amount comes from
-- `court_price_for_hours` over the same hour series the player-side checkout
-- prices, so a member of staff cannot quietly discount a court by posting a
-- different number, and the tenant's own rate rules remain the only source of
-- truth for what an hour costs.
--
-- SECURITY DEFINER with the search_path pinned, because it must insert a row
-- whose `user_id` is not the caller, which no RLS policy on this table permits.
-- The authorisation it therefore has to make explicit is the first thing it
-- does, before anything is read or written.

CREATE OR REPLACE FUNCTION public.tenant_create_walkin_booking(
  _court_id       bigint,
  _start          timestamptz,
  _end            timestamptz,
  _customer_name  text,
  _customer_phone text DEFAULT NULL,
  _customer_email text DEFAULT NULL,
  _player_count   integer DEFAULT NULL,
  _notes          text DEFAULT NULL,
  _payment_method text DEFAULT 'cash',
  _paid           boolean DEFAULT true,
  _link_user_id   uuid DEFAULT NULL
) RETURNS TABLE (
  booking_id  bigint,
  booking_no  bigint,
  reference   text,
  total       numeric,
  starts_at   timestamptz,
  ends_at     timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid       uuid := auth.uid();
  _venue_id  bigint;
  _hours     timestamptz[];
  _total     numeric;
  _owner     uuid;
  _new_id    bigint;
  _new_no    bigint;
  _ref       text;
  _name      text := btrim(coalesce(_customer_name, ''));
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT c.venue_id INTO _venue_id FROM public.courts c WHERE c.id = _court_id;
  IF _venue_id IS NULL THEN
    RAISE EXCEPTION 'Court not found';
  END IF;

  -- Taking a booking on behalf of a customer is front-desk work with a price on
  -- it, so it sits at 'manager' alongside the other money-touching controls.
  IF NOT public.venue_allows(_venue_id, 'manager') THEN
    RAISE EXCEPTION 'Not authorised for this venue';
  END IF;

  IF _name = '' THEN
    RAISE EXCEPTION 'A customer name is required for a walk-in booking';
  END IF;

  IF _end <= _start THEN
    RAISE EXCEPTION 'The booking must end after it starts';
  END IF;

  -- Whole hours, matching how this system prices and blocks every other booking.
  IF date_part('minute', _start) <> 0 OR date_part('second', _start) <> 0
     OR date_part('minute', _end) <> 0 OR date_part('second', _end) <> 0 THEN
    RAISE EXCEPTION 'Walk-in bookings are taken in whole hours';
  END IF;

  SELECT array_agg(h ORDER BY h) INTO _hours
    FROM generate_series(_start, _end - interval '1 hour', interval '1 hour') AS h;

  IF _hours IS NULL OR array_length(_hours, 1) IS NULL THEN
    RAISE EXCEPTION 'The booking must cover at least one hour';
  END IF;

  -- The tenant's own rate rules decide the price. Never the caller.
  _total := public.court_price_for_hours(_court_id, _hours);

  -- A walk-in linked to a real account belongs to that player and will show in
  -- their bookings. An unlinked one borrows the recorder's uid to satisfy the
  -- NOT NULL column and is hidden from their player view by the policy above.
  _owner := coalesce(_link_user_id, _uid);

  INSERT INTO public.bookings (
    court_id, user_id, start_time, end_time,
    status, payment_status, unit_price,
    booking_source, payment_collection_source,
    walkin_customer_name, walkin_customer_phone, walkin_customer_email,
    walkin_player_count, walkin_notes, walkin_payment_method, recorded_by
  ) VALUES (
    _court_id, _owner, _start, _end,
    'confirmed',
    CASE WHEN _paid THEN 'paid' ELSE 'unpaid' END,
    _total,
    'walk_in',
    CASE WHEN _paid THEN 'tenant' ELSE 'unpaid' END,
    _name, nullif(btrim(coalesce(_customer_phone, '')), ''),
    nullif(btrim(coalesce(_customer_email, '')), ''),
    _player_count, nullif(btrim(coalesce(_notes, '')), ''),
    CASE WHEN _paid THEN coalesce(nullif(btrim(_payment_method), ''), 'cash') ELSE NULL END,
    _uid
  )
  RETURNING id, bookings.booking_no INTO _new_id, _new_no;

  -- The receipt number reuses the per-venue sequence `assign_booking_no()` has
  -- already allocated inside this same transaction rather than starting a second
  -- counter that could drift away from it. The date is the venue's calendar day,
  -- not the server's.
  _ref := 'CCH-WI-'
       || to_char(_start AT TIME ZONE 'Asia/Manila', 'YYYYMMDD')
       || '-' || lpad(coalesce(_new_no, _new_id)::text, 4, '0');

  UPDATE public.bookings SET walkin_reference = _ref WHERE id = _new_id;

  INSERT INTO public.court_audit_log (court_id, venue_id, action, actor_id, changes)
  VALUES (
    _court_id, _venue_id, 'walkin.created', _uid,
    jsonb_build_object(
      'booking_id', _new_id,
      'reference', _ref,
      'customer', _name,
      'total', _total,
      'payment_method', _payment_method,
      'collection', CASE WHEN _paid THEN 'tenant' ELSE 'unpaid' END,
      'linked_user', _link_user_id
    )
  );

  RETURN QUERY SELECT _new_id, _new_no, _ref, _total, _start, _end;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_create_walkin_booking(
  bigint, timestamptz, timestamptz, text, text, text, integer, text, text, boolean, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_create_walkin_booking(
  bigint, timestamptz, timestamptz, text, text, text, integer, text, text, boolean, uuid
) TO authenticated, service_role;
