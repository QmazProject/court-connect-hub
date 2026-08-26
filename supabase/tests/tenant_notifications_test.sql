-- Tenant notification tests.
--
-- Run against a BRANCH or STAGING database, never production:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenant_notifications_test.sql
--
-- The whole file runs inside one transaction that is ROLLED BACK at the end, so it
-- leaves nothing behind. Every check RAISEs on failure, so a non-zero exit means a
-- real failure — with ON_ERROR_STOP=1, psql exits 3.
--
-- Deferred constraint triggers are what these exercise: notifications are produced at
-- COMMIT, so each scenario uses a SAVEPOINT + `SET CONSTRAINTS ALL IMMEDIATE` to force
-- them to fire at a point the test can observe.

BEGIN;

\echo '=== setting up fixtures ==='

CREATE TEMP TABLE t_ids (k text PRIMARY KEY, v text);

DO $$
DECLARE
  _owner_a uuid; _owner_b uuid; _player uuid;
  _venue_a bigint; _venue_b bigint; _court_a bigint; _court_b bigint;
  _sport bigint; _pc_a bigint; _pc_b bigint;
BEGIN
  -- Two tenants and a player. auth.users rows are created directly because these
  -- tests do not go through the auth API.
  INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (gen_random_uuid(), 'owner-a@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  RETURNING id INTO _owner_a;
  INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (gen_random_uuid(), 'owner-b@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  RETURNING id INTO _owner_b;
  INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (gen_random_uuid(), 'player@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  RETURNING id INTO _player;

  INSERT INTO public.profiles (id, full_name, role) VALUES (_owner_a, 'Owner A', 'tenant')
    ON CONFLICT (id) DO UPDATE SET full_name = 'Owner A', role = 'tenant';
  INSERT INTO public.profiles (id, full_name, role) VALUES (_owner_b, 'Owner B', 'tenant')
    ON CONFLICT (id) DO UPDATE SET full_name = 'Owner B', role = 'tenant';
  INSERT INTO public.profiles (id, full_name, role) VALUES (_player, 'John Player', 'player')
    ON CONFLICT (id) DO UPDATE SET full_name = 'John Player', role = 'player';

  SELECT id INTO _sport FROM public.sports LIMIT 1;

  INSERT INTO public.venues (name, address, timezone)
  VALUES ('Venue A', '1 Test St', 'Asia/Manila') RETURNING id INTO _venue_a;
  INSERT INTO public.venues (name, address, timezone)
  VALUES ('Venue B', '2 Test St', 'Asia/Manila') RETURNING id INTO _venue_b;

  INSERT INTO public.physical_courts (venue_id, name) VALUES (_venue_a, 'Surface A')
    RETURNING id INTO _pc_a;
  INSERT INTO public.physical_courts (venue_id, name) VALUES (_venue_b, 'Surface B')
    RETURNING id INTO _pc_b;

  INSERT INTO public.courts (venue_id, physical_court_id, sport_id, name, hourly_rate, is_indoor, capacity)
  VALUES (_venue_a, _pc_a, _sport, 'Badminton Court 2', 400, true, 1) RETURNING id INTO _court_a;
  INSERT INTO public.courts (venue_id, physical_court_id, sport_id, name, hourly_rate, is_indoor, capacity)
  VALUES (_venue_b, _pc_b, _sport, 'Court B1', 400, true, 1) RETURNING id INTO _court_b;

  -- Owner A staffs Venue A TWICE, to prove a duplicated staff row does not
  -- double-notify. Owner B staffs only Venue B.
  INSERT INTO public.staff (venue_id, user_id, role) VALUES (_venue_a, _owner_a, 'owner');
  INSERT INTO public.staff (venue_id, user_id, role) VALUES (_venue_a, _owner_a, 'manager');
  INSERT INTO public.staff (venue_id, user_id, role) VALUES (_venue_b, _owner_b, 'owner');

  INSERT INTO t_ids VALUES
    ('owner_a', _owner_a::text), ('owner_b', _owner_b::text), ('player', _player::text),
    ('venue_a', _venue_a::text), ('venue_b', _venue_b::text),
    ('court_a', _court_a::text), ('court_b', _court_b::text);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.id(_k text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT v FROM t_ids WHERE k = _k $$;

CREATE OR REPLACE FUNCTION pg_temp.check(_label text, _got bigint, _want bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _got IS DISTINCT FROM _want THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', _label, _want, _got;
  END IF;
  RAISE NOTICE 'ok  %  (%)', _label, _got;
END $$;

-- ---------------------------------------------------------------------------
\echo '=== 1. one multi-row session produces exactly ONE tenant notification ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s1;
DO $$
DECLARE _n bigint;
BEGIN
  -- Three contiguous hours, one INSERT — the "settle at venue" path.
  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  SELECT pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
         (date_trunc('hour', now()) + make_interval(hours => h)),
         (date_trunc('hour', now()) + make_interval(hours => h + 1)),
         'confirmed', 'pending', 400
    FROM generate_series(30, 32) AS h;

  SET CONSTRAINTS ALL IMMEDIATE;   -- force the deferred trigger to fire now

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_new';
  PERFORM pg_temp.check('3 hourly rows -> 1 new-booking notification', _n, 1);

  -- ...and the duplicated staff row did not produce a second copy.
  SELECT count(DISTINCT dedupe_key) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_new';
  PERFORM pg_temp.check('duplicate staff row -> still 1', _n, 1);
END $$;
ROLLBACK TO SAVEPOINT s1;

-- ---------------------------------------------------------------------------
\echo '=== 2. two NON-contiguous bookings on the same court/day -> TWO notifications ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s2;
DO $$
DECLARE _n bigint;
BEGIN
  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  VALUES
    (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
     date_trunc('hour', now()) + interval '30 hours', date_trunc('hour', now()) + interval '31 hours',
     'confirmed', 'pending', 400),
    (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
     date_trunc('hour', now()) + interval '40 hours', date_trunc('hour', now()) + interval '41 hours',
     'confirmed', 'pending', 400);

  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_new';
  PERFORM pg_temp.check('two separate bookings -> 2 notifications', _n, 2);
END $$;
ROLLBACK TO SAVEPOINT s2;

-- ---------------------------------------------------------------------------
\echo '=== 3. cross-tenant isolation ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s3;
DO $$
DECLARE _n bigint;
BEGIN
  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours', date_trunc('hour', now()) + interval '31 hours',
          'confirmed', 'pending', 400);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications WHERE user_id = pg_temp.id('owner_b')::uuid;
  PERFORM pg_temp.check('Venue B staff receive NOTHING about Venue A', _n, 0);
END $$;
ROLLBACK TO SAVEPOINT s3;

-- ---------------------------------------------------------------------------
\echo '=== 4. cancellation -> one notification for the cancelled session ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s4;
DO $$
DECLARE _n bigint; _ids bigint[];
BEGIN
  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  SELECT pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
         date_trunc('hour', now()) + make_interval(hours => h),
         date_trunc('hour', now()) + make_interval(hours => h + 1),
         'confirmed', 'pending', 400
    FROM generate_series(30, 32) AS h;

  SELECT array_agg(id) INTO _ids FROM public.bookings
   WHERE user_id = pg_temp.id('player')::uuid;
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM public.notifications;      -- ignore the new-booking notifications

  UPDATE public.bookings SET status = 'cancelled', cancelled_at = now()
   WHERE id = ANY(_ids);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_cancelled';
  PERFORM pg_temp.check('3 cancelled rows -> 1 cancellation notification', _n, 1);
END $$;
ROLLBACK TO SAVEPOINT s4;

-- ---------------------------------------------------------------------------
\echo '=== 5. preferences govern EXTERNAL delivery only ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s5;
DO $$
DECLARE _notifs bigint; _email bigint; _push bigint;
BEGIN
  INSERT INTO public.notification_preferences (user_id, email_enabled, push_enabled, new_bookings_enabled)
  VALUES (pg_temp.id('owner_a')::uuid, false, false, true)
  ON CONFLICT (user_id) DO UPDATE
    SET email_enabled = false, push_enabled = false, new_bookings_enabled = true;

  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours', date_trunc('hour', now()) + interval '31 hours',
          'confirmed', 'pending', 400);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _notifs FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_new';
  SELECT count(*) INTO _email FROM public.notification_outbox o
    JOIN public.notifications n ON n.id = o.notification_id
   WHERE n.user_id = pg_temp.id('owner_a')::uuid AND o.channel = 'email';
  SELECT count(*) INTO _push FROM public.notification_outbox o
    JOIN public.notifications n ON n.id = o.notification_id
   WHERE n.user_id = pg_temp.id('owner_a')::uuid AND o.channel = 'push';

  PERFORM pg_temp.check('bell still records it', _notifs, 1);
  PERFORM pg_temp.check('email disabled -> no email outbox row', _email, 0);
  PERFORM pg_temp.check('push disabled -> no push outbox row', _push, 0);
END $$;
ROLLBACK TO SAVEPOINT s5;

-- ---------------------------------------------------------------------------
\echo '=== 6. email/push enabled -> outbox rows created ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s6;
DO $$
DECLARE _email bigint; _push bigint;
BEGIN
  INSERT INTO public.notification_preferences (user_id, email_enabled, push_enabled, new_bookings_enabled)
  VALUES (pg_temp.id('owner_a')::uuid, true, true, true)
  ON CONFLICT (user_id) DO UPDATE
    SET email_enabled = true, push_enabled = true, new_bookings_enabled = true;

  INSERT INTO public.push_subscriptions (endpoint, user_id, p256dh, auth)
  VALUES ('https://push.test/endpoint-1', pg_temp.id('owner_a')::uuid, 'fake-p256dh', 'fake-auth');

  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours', date_trunc('hour', now()) + interval '31 hours',
          'confirmed', 'pending', 400);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _email FROM public.notification_outbox o
    JOIN public.notifications n ON n.id = o.notification_id
   WHERE n.user_id = pg_temp.id('owner_a')::uuid AND o.channel = 'email';
  SELECT count(*) INTO _push FROM public.notification_outbox o
    JOIN public.notifications n ON n.id = o.notification_id
   WHERE n.user_id = pg_temp.id('owner_a')::uuid AND o.channel = 'push';

  PERFORM pg_temp.check('email enabled -> 1 email outbox row', _email, 1);
  PERFORM pg_temp.check('push enabled + subscription -> 1 push outbox row', _push, 1);
END $$;
ROLLBACK TO SAVEPOINT s6;

-- ---------------------------------------------------------------------------
\echo '=== 7. dedupe key makes a repeated event idempotent ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s7;
DO $$
DECLARE _n bigint; _bid bigint;
BEGIN
  INSERT INTO public.bookings (court_id, user_id, start_time, end_time, status, payment_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours', date_trunc('hour', now()) + interval '31 hours',
          'confirmed', 'pending', 400)
  RETURNING id INTO _bid;
  SET CONSTRAINTS ALL IMMEDIATE;

  -- Simulate a retry of the same business event, the way a webhook redelivery would.
  PERFORM public.notify_staff_booking_event(_bid, 'venue_booking_new', NULL);
  PERFORM public.notify_staff_booking_event(_bid, 'venue_booking_new', NULL);

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_booking_new';
  PERFORM pg_temp.check('replayed event -> still 1 notification', _n, 1);
END $$;
ROLLBACK TO SAVEPOINT s7;

-- ---------------------------------------------------------------------------
\echo '=== 8. full multi-row refund -> ONE notification, whole span and total ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s8;
DO $$
DECLARE _n bigint; _ids bigint[]; _body text;
BEGIN
  INSERT INTO public.bookings
    (court_id, user_id, start_time, end_time, status, payment_status, refund_status, unit_price)
  SELECT pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
         date_trunc('hour', now()) + make_interval(hours => h),
         date_trunc('hour', now()) + make_interval(hours => h + 1),
         'cancelled', 'paid', 'none', 500
    FROM generate_series(30, 32) AS h;
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM public.notifications;

  SELECT array_agg(id) INTO _ids FROM public.bookings WHERE user_id = pg_temp.id('player')::uuid;

  -- The batched update the fixed refund loop performs: every refunded row in ONE
  -- statement, so the session walk sees the whole set.
  UPDATE public.bookings SET payment_status = 'refunded', refund_status = 'refunded'
   WHERE id = ANY(_ids);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_processed';
  PERFORM pg_temp.check('3 refunded rows -> 1 refund notification', _n, 1);

  SELECT body INTO _body FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_processed';
  IF _body NOT LIKE '%1,500.00%' THEN
    RAISE EXCEPTION 'FAIL: refund total — expected 1,500.00 in body, got: %', _body;
  END IF;
  RAISE NOTICE 'ok  refund total is the full session amount';
END $$;
ROLLBACK TO SAVEPOINT s8;

-- ---------------------------------------------------------------------------
\echo '=== 9. partial refund -> only the refunded portion ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s9;
DO $$
DECLARE _n bigint; _body text; _ids bigint[];
BEGIN
  INSERT INTO public.bookings
    (court_id, user_id, start_time, end_time, status, payment_status, refund_status, unit_price)
  SELECT pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
         date_trunc('hour', now()) + make_interval(hours => h),
         date_trunc('hour', now()) + make_interval(hours => h + 1),
         'cancelled', 'paid', 'none', 500
    FROM generate_series(30, 32) AS h;
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM public.notifications;

  -- Refund only the last two hours.
  SELECT array_agg(id) INTO _ids FROM (
    SELECT id FROM public.bookings WHERE user_id = pg_temp.id('player')::uuid
     ORDER BY start_time OFFSET 1
  ) q;
  UPDATE public.bookings SET payment_status = 'refunded', refund_status = 'refunded'
   WHERE id = ANY(_ids);
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_processed';
  PERFORM pg_temp.check('partial refund -> 1 notification', _n, 1);

  SELECT body INTO _body FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_processed';
  IF _body LIKE '%1,500.00%' THEN
    RAISE EXCEPTION 'FAIL: partial refund claimed the FULL amount: %', _body;
  END IF;
  IF _body NOT LIKE '%1,000.00%' THEN
    RAISE EXCEPTION 'FAIL: partial refund total — expected 1,000.00, got: %', _body;
  END IF;
  RAISE NOTICE 'ok  partial refund reports only the refunded portion';
END $$;
ROLLBACK TO SAVEPOINT s9;

-- ---------------------------------------------------------------------------
\echo '=== 10. failed refund -> one human-readable alert, no provider detail ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s10;
DO $$
DECLARE _n bigint; _body text; _id bigint;
BEGIN
  INSERT INTO public.bookings
    (court_id, user_id, start_time, end_time, status, payment_status, refund_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours',
          date_trunc('hour', now()) + interval '31 hours',
          'cancelled', 'paid', 'none', 500)
  RETURNING id INTO _id;
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM public.notifications;

  UPDATE public.bookings SET refund_status = 'failed' WHERE id = _id;
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_failed';
  PERFORM pg_temp.check('failed refund -> 1 alert', _n, 1);

  SELECT body INTO _body FROM public.notifications
   WHERE user_id = pg_temp.id('owner_a')::uuid AND type = 'venue_refund_failed';
  IF _body ~* '(paymongo|http|api_key|secret|stack|Error:)' THEN
    RAISE EXCEPTION 'FAIL: provider/internal detail leaked to the venue: %', _body;
  END IF;
  RAISE NOTICE 'ok  failure alert is human-readable and leaks nothing';
END $$;
ROLLBACK TO SAVEPOINT s10;

-- ---------------------------------------------------------------------------
\echo '=== 11. refund isolation: Tenant B hears nothing about Tenant A ==='
-- ---------------------------------------------------------------------------
SAVEPOINT s11;
DO $$
DECLARE _n bigint; _id bigint;
BEGIN
  INSERT INTO public.bookings
    (court_id, user_id, start_time, end_time, status, payment_status, refund_status, unit_price)
  VALUES (pg_temp.id('court_a')::bigint, pg_temp.id('player')::uuid,
          date_trunc('hour', now()) + interval '30 hours',
          date_trunc('hour', now()) + interval '31 hours',
          'cancelled', 'paid', 'none', 500)
  RETURNING id INTO _id;
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM public.notifications;

  UPDATE public.bookings SET payment_status = 'refunded', refund_status = 'refunded' WHERE id = _id;
  SET CONSTRAINTS ALL IMMEDIATE;

  SELECT count(*) INTO _n FROM public.notifications WHERE user_id = pg_temp.id('owner_b')::uuid;
  PERFORM pg_temp.check('Venue B staff receive nothing', _n, 0);
END $$;
ROLLBACK TO SAVEPOINT s11;

-- ---------------------------------------------------------------------------
\echo '=== 12. avatar storage policies are user-scoped and role-agnostic ==='
-- ---------------------------------------------------------------------------
DO $$
DECLARE _n bigint;
BEGIN
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE '%avatar%';
  PERFORM pg_temp.check('four avatar policies exist', _n, 4);

  -- Every one must pin the first path segment to auth.uid(); none may test a role.
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE '%avatar%'
     AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%auth.uid()%';
  PERFORM pg_temp.check('every avatar policy is scoped to auth.uid()', _n, 4);

  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE '%avatar%'
     AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%foldername%';
  PERFORM pg_temp.check('every avatar policy checks the folder name', _n, 4);
END $$;

-- ---------------------------------------------------------------------------
\echo '=== 13. SECURITY DEFINER functions all pin search_path ==='
-- ---------------------------------------------------------------------------
DO $$
DECLARE _bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO _bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'
     );
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: SECURITY DEFINER without search_path: %', _bad;
  END IF;
  RAISE NOTICE 'ok  every SECURITY DEFINER function pins search_path';
END $$;

\echo '=== all tenant notification + refund + avatar checks passed ==='
ROLLBACK;
