-- ===========================================================================
-- Platform-admin tenant visibility, and outbound payout providers.
--
-- Two problems, one slice of the marketplace finance flow.
--
-- 1. THE EMPTY TENANTS PAGE. `tenant_balances` is a security_invoker view built
--    `FROM public.tenants`. Every financial table already lets a platform admin
--    read (`OR public.is_courthub_admin()`), but `public.tenants` itself never
--    did: its only SELECT policies are "a member reads their own tenant" and "an
--    invitee reads the inviting tenant". A CourtHub admin is a member of no
--    tenant, so the view's FROM clause yields nothing and the admin sees an
--    empty list over a database full of businesses. One policy fixes it, and it
--    is scoped to `is_courthub_admin()` so an ordinary authenticated user still
--    cannot enumerate tenants.
--
-- 2. WHO ACTUALLY SENDS THE MONEY. Until now a payout was marked paid by hand
--    after a transfer made in a banking app. This adds a provider seam:
--
--      manual    — the transfer happens outside; the admin records reference,
--                  method, amount and a proof image, and the payout is paid.
--      paymongo  — the transfer is submitted to PayMongo Money Movement
--                  (POST /v2/batch_transfers). Accepting the request is NOT
--                  payment: the payout stays `processing` with a pending attempt
--                  until PayMongo's `transfer.outward.successful` or
--                  `transfer.outward.failed` webhook settles it.
--
--    Every submission is an ATTEMPT row. A retry after a failure is another
--    attempt; the failed one keeps its error. `provider_transfer_id` is unique,
--    one open attempt per payout is unique, and the ledger's `payout:paid:<id>`
--    idempotency key is single-use — three independent reasons a payout cannot
--    be paid twice.
--
-- ACCOUNTING RULE FOR RETRIES. `ledger_append` drops a duplicate idempotency
-- key silently (ON CONFLICT DO NOTHING). The original design keyed every
-- release as `payout:released:<id>`, which accidentally made a second release
-- a no-op — and also meant a retried payout (failed → processing → paid) was
-- paid without ever being re-reserved, driving the tenant's reserved column
-- negative. This migration keys retry reservations and releases by attempt
-- number, and decides whether a reservation is currently HELD by summing the
-- ledger for that payout rather than trusting the status column. A release
-- releases exactly what is held; a payment requires exactly the amount to be
-- held; a retry re-reserves only when nothing is held.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Platform admins may read every tenant.
-- ---------------------------------------------------------------------------
-- The minimum policy: SELECT only, admins only. No UPDATE, no INSERT, no
-- widening of the member policies that already exist beside it.
DROP POLICY IF EXISTS "Platform admins read all tenants" ON public.tenants;
CREATE POLICY "Platform admins read all tenants"
  ON public.tenants FOR SELECT TO authenticated
  USING (public.is_courthub_admin());


-- ---------------------------------------------------------------------------
-- 2. Provider columns on the payout, and a sticky BIC on the account.
-- ---------------------------------------------------------------------------
-- These are denormalised copies of the current attempt's state, so the tenant's
-- Finance screen and the admin queue can read one row. The attempts table below
-- is the history; these columns are the headline.
ALTER TABLE public.tenant_payouts
  ADD COLUMN IF NOT EXISTS request_type           text NOT NULL DEFAULT 'request',
  ADD COLUMN IF NOT EXISTS provider               text,
  ADD COLUMN IF NOT EXISTS provider_transfer_id   text,
  ADD COLUMN IF NOT EXISTS provider_status        text,
  ADD COLUMN IF NOT EXISTS provider_error_code    text,
  ADD COLUMN IF NOT EXISTS provider_error_message text,
  ADD COLUMN IF NOT EXISTS provider_submitted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS paid_amount_centavos   bigint;

ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_request_type_check;
ALTER TABLE public.tenant_payouts
  ADD CONSTRAINT tenant_payouts_request_type_check
  CHECK (request_type IN ('request', 'recurring'));

ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_provider_check;
ALTER TABLE public.tenant_payouts
  ADD CONSTRAINT tenant_payouts_provider_check
  CHECK (provider IS NULL OR provider IN ('manual', 'paymongo'));

-- A PayMongo transfer id belongs to exactly one payout, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_provider_transfer_id
  ON public.tenant_payouts (provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;

-- Which PayMongo receiving institution this destination maps to. Set by a
-- platform admin from the official receiving-institutions list, never typed
-- freehand, and remembered so the next payout to the same account needs no
-- mapping step. NULL means "not yet mapped; PayMongo processing is blocked".
ALTER TABLE public.tenant_payout_accounts
  ADD COLUMN IF NOT EXISTS paymongo_bic text,
  ADD COLUMN IF NOT EXISTS paymongo_institution_name text;


-- ---------------------------------------------------------------------------
-- 3. Attempts: one row per time money was actually asked to move.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_payout_attempts (
  id                        bigserial PRIMARY KEY,
  payout_id                 bigint NOT NULL REFERENCES public.tenant_payouts(id) ON DELETE CASCADE,
  tenant_id                 uuid   NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  attempt_no                integer NOT NULL,
  provider                  text NOT NULL,
  status                    text NOT NULL DEFAULT 'created',
  amount_centavos           bigint NOT NULL CHECK (amount_centavos > 0),
  currency                  text NOT NULL DEFAULT 'PHP',
  -- Copied from the payout at attempt time. The payout's snapshot is immutable,
  -- so these are always equal; the copy exists so an attempt row reads alone.
  destination_snapshot      jsonb NOT NULL,
  idempotency_key           text NOT NULL,
  provider_transfer_id      text,
  provider_batch_id         text,
  provider_reference_number text,
  provider_status           text,
  provider_rail             text,
  destination_bic           text,
  livemode                  boolean,
  error_code                text,
  error_message             text,
  -- Safe descriptive detail only: fee, rail, institution name. Never a key.
  provider_metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  submitted_at              timestamptz,
  completed_at              timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, attempt_no),
  UNIQUE (idempotency_key)
);

ALTER TABLE public.tenant_payout_attempts
  DROP CONSTRAINT IF EXISTS tenant_payout_attempts_status_check;
ALTER TABLE public.tenant_payout_attempts
  ADD CONSTRAINT tenant_payout_attempts_status_check CHECK (status IN (
    -- created:    row exists, nothing sent (manual attempts wait here)
    -- submitting: the API call is in flight; if it never comes back this is
    --             the state that says "check PayMongo before trying again"
    -- pending:    the provider accepted it and has not yet settled it
    -- succeeded / failed: settled
    'created', 'submitting', 'pending', 'succeeded', 'failed'
  ));

ALTER TABLE public.tenant_payout_attempts
  DROP CONSTRAINT IF EXISTS tenant_payout_attempts_provider_check;
ALTER TABLE public.tenant_payout_attempts
  ADD CONSTRAINT tenant_payout_attempts_provider_check
  CHECK (provider IN ('manual', 'paymongo'));

-- The concurrency guarantee in one index: a payout has at most one attempt
-- that is not yet settled. Two admins, two tabs, a double-click — the second
-- INSERT fails here whatever the application code did.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_attempts_one_open
  ON public.tenant_payout_attempts (payout_id)
  WHERE status IN ('created', 'submitting', 'pending');

CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_attempts_provider_transfer_id
  ON public.tenant_payout_attempts (provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payout_attempts_tenant
  ON public.tenant_payout_attempts (tenant_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_payout_attempts_updated_at ON public.tenant_payout_attempts;
CREATE TRIGGER trg_payout_attempts_updated_at
  BEFORE UPDATE ON public.tenant_payout_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 4. Provider events: every webhook delivery, exactly once.
-- ---------------------------------------------------------------------------
-- The unique (provider, event_id) is what makes a retried or duplicated webhook
-- harmless: the second delivery cannot insert, so it cannot settle. `outcome`
-- records what the settlement function decided, including "ignored" cases, so
-- an operator can see a stale failure arrive after a success and know it was
-- refused rather than lost.
CREATE TABLE IF NOT EXISTS public.payout_provider_events (
  id                        bigserial PRIMARY KEY,
  provider                  text NOT NULL,
  event_id                  text NOT NULL,
  event_type                text NOT NULL,
  provider_transfer_id      text,
  provider_reference_number text,
  attempt_id                bigint REFERENCES public.tenant_payout_attempts(id) ON DELETE SET NULL,
  payout_id                 bigint REFERENCES public.tenant_payouts(id) ON DELETE SET NULL,
  outcome                   text NOT NULL DEFAULT 'received',
  livemode                  boolean,
  payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payout_provider_events_transfer
  ON public.payout_provider_events (provider_transfer_id);


-- ---------------------------------------------------------------------------
-- 5. Reservation held by a payout, read from the ledger.
-- ---------------------------------------------------------------------------
-- The authority for "is this payout's money still reserved" is the sum of the
-- ledger's reserved column for that payout, not its status. Reserve +N, release
-- -N, pay -N: whatever sequence of attempts happened, this is what is held now.
CREATE OR REPLACE FUNCTION public.payout_reserved_held(_payout_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(SUM(reserved_centavos), 0)::bigint
    FROM public.tenant_ledger_entries
   WHERE payout_id = _payout_id;
$$;

REVOKE ALL ON FUNCTION public.payout_reserved_held(bigint) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Creating a reservation: shared by tenant requests and admin-initiated
--    recurring payouts.
-- ---------------------------------------------------------------------------
-- This is the body of the original `tenant_request_payout`, lifted out so the
-- recurring path cannot drift from it. The advisory lock, the account checks,
-- the balance check under that lock, the frozen destination snapshot and the
-- reservation entry are all here and nowhere else. Callers decide WHO may call
-- and whom to notify; this decides WHAT a reservation is.
CREATE OR REPLACE FUNCTION public.payout_reserve_internal(
  _tid          uuid,
  _amount       bigint,
  _actor        uuid,
  _request_type text
) RETURNS TABLE (payout_id bigint, reserved_centavos bigint, remaining_available_centavos bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _acct RECORD;
  _available bigint;
  _new_id bigint;
  _snapshot jsonb;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount above zero';
  END IF;

  -- One requester at a time per tenant. Held to commit.
  PERFORM pg_advisory_xact_lock(hashtextextended(_tid::text, 0));

  SELECT * INTO _acct FROM public.tenant_payout_accounts
   WHERE tenant_id = _tid AND is_active;
  IF _acct.id IS NULL THEN
    RAISE EXCEPTION 'Add a payout account before requesting a payout';
  END IF;
  IF _acct.status = 'rejected' OR _acct.status = 'disabled' THEN
    RAISE EXCEPTION 'This payout account cannot receive funds; update it first';
  END IF;

  SELECT available_centavos INTO _available
    FROM public.tenant_balances WHERE tenant_id = _tid;
  _available := coalesce(_available, 0);

  IF _amount > _available THEN
    RAISE EXCEPTION 'Requested % exceeds the available balance of %',
      _amount, _available USING ERRCODE = '23514';
  END IF;

  -- Frozen here, deliberately. See the tenant_payouts table comment.
  _snapshot := jsonb_build_object(
    'account_id', _acct.id,
    'account_type', _acct.account_type,
    'account_name', _acct.account_name,
    'account_number_masked', public.mask_account_number(_acct.account_number),
    'bank_name', _acct.bank_name,
    'captured_at', now()
  );

  INSERT INTO public.tenant_payouts (
    tenant_id, amount_centavos, status, account_id, destination_snapshot,
    available_at_request_centavos, requested_by, request_type
  ) VALUES (
    _tid, _amount, 'requested', _acct.id, _snapshot, _available, _actor, _request_type
  ) RETURNING id INTO _new_id;

  PERFORM public.ledger_append(
    _tenant_id => _tid,
    _entry_type => 'payout_reserved',
    _idempotency_key => 'payout:reserved:' || _new_id::text,
    _payout_id => _new_id,
    _reserved => _amount,
    _actor_id => _actor,
    _source => 'payout',
    _metadata => jsonb_build_object('available_at_request', _available, 'request_type', _request_type)
  );

  INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, to_status, actor_id, metadata)
  VALUES (_new_id, _tid, 'payout.requested', 'requested', _actor,
          jsonb_build_object('amount_centavos', _amount, 'request_type', _request_type));

  RETURN QUERY SELECT _new_id, _amount, (_available - _amount);
END;
$$;

REVOKE ALL ON FUNCTION public.payout_reserve_internal(uuid, bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- Same signature, same checks, same return shape as before; the body moved.
CREATE OR REPLACE FUNCTION public.tenant_request_payout(_amount_centavos bigint)
RETURNS TABLE (payout_id bigint, reserved_centavos bigint, remaining_available_centavos bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _tid uuid := public.current_tenant_id();
  _r RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _tid IS NULL THEN RAISE EXCEPTION 'No tenant workspace for this account'; END IF;
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin may request a payout';
  END IF;

  SELECT * INTO _r FROM public.payout_reserve_internal(_tid, _amount_centavos, _uid, 'request');

  -- Platform admins need to know there is something to process.
  PERFORM public.notify_user(ur.user_id, 'payout_requested',
            'New payout request',
            'A tenant has requested a payout of PHP ' || (_amount_centavos / 100.0)::text,
            '/admin/disbursements')
    FROM public.user_roles ur
   WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;

  RETURN QUERY SELECT _r.payout_id, _r.reserved_centavos, _r.remaining_available_centavos;
END;
$$;

-- A recurring payout the admin chose to process. Nothing creates one of these
-- on a timer: the admin ticks a tenant the queue says is due, and only then is
-- the balance reserved, through exactly the reservation logic a tenant's own
-- request uses.
CREATE OR REPLACE FUNCTION public.admin_request_recurring_payout(
  _tenant_id       uuid,
  _amount_centavos bigint
) RETURNS TABLE (payout_id bigint, reserved_centavos bigint, remaining_available_centavos bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _r RECORD;
  _owner uuid;
  _open int;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may start a recurring payout';
  END IF;

  -- A tenant with a request already open is not "due": the open request holds
  -- the money. Refusing here keeps one reservation per tenant at a time.
  SELECT count(*) INTO _open FROM public.tenant_payouts
   WHERE tenant_id = _tenant_id
     AND status IN ('requested', 'under_review', 'approved', 'processing');
  IF _open > 0 THEN
    RAISE EXCEPTION 'This tenant already has a payout in progress' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO _r FROM public.payout_reserve_internal(_tenant_id, _amount_centavos, _uid, 'recurring');

  PERFORM public.write_admin_audit('payout.recurring_created', 'payout', _r.payout_id::text,
    jsonb_build_object('tenant_id', _tenant_id, 'amount_centavos', _amount_centavos));

  FOR _owner IN
    SELECT tm.user_id FROM public.tenant_members tm
     WHERE tm.tenant_id = _tenant_id AND tm.role = 'admin' AND tm.status = 'active'
  LOOP
    PERFORM public.notify_user(_owner, 'payout_processing',
      'Scheduled payout started',
      'PHP ' || (_amount_centavos / 100.0)::text || ' is being sent to your payout account.',
      '/dashboard?section=finance');
  END LOOP;

  RETURN QUERY SELECT _r.payout_id, _r.reserved_centavos, _r.remaining_available_centavos;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7. Internal settlement: paid, and failed.
-- ---------------------------------------------------------------------------
-- Not granted to anyone. Callers hold the payout row lock and have decided the
-- transition is legal; these write the consequences in one place so the manual
-- path, the webhook path and the reconciliation path cannot disagree about
-- what "paid" means.
CREATE OR REPLACE FUNCTION public.payout_apply_paid(
  _payout_id  bigint,
  _attempt_id bigint,
  _reference  text,
  _method     text,
  _proof_path text,
  _actor      uuid,
  _notes      text,
  _metadata   jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _p RECORD;
  _held bigint;
  _entry bigint;
  _owner uuid;
BEGIN
  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;
  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already %', _p.id, _p.status USING ERRCODE = '23514';
  END IF;
  IF _reference IS NULL OR length(btrim(_reference)) = 0 THEN
    RAISE EXCEPTION 'A transfer reference is required to mark a payout paid';
  END IF;

  -- Exactly the amount must be held. Less means the reservation was released
  -- (a failure that was never retried through the attempt path) and paying now
  -- would take money the tenant may already have re-requested.
  _held := public.payout_reserved_held(_payout_id);
  IF _held <> _p.amount_centavos THEN
    RAISE EXCEPTION 'Payout % holds % of its % reservation; re-reserve it by retrying before paying',
      _p.id, _held, _p.amount_centavos USING ERRCODE = '23514';
  END IF;

  UPDATE public.tenant_payouts
     SET status = 'paid',
         transfer_reference = btrim(_reference),
         transfer_method = coalesce(_method, transfer_method),
         proof_path = coalesce(_proof_path, proof_path),
         admin_notes = coalesce(_notes, admin_notes),
         paid_amount_centavos = amount_centavos,
         provider_status = 'succeeded',
         provider_error_code = NULL,
         provider_error_message = NULL,
         completed_by = _actor,
         completed_at = now()
   WHERE id = _payout_id;

  IF _attempt_id IS NOT NULL THEN
    UPDATE public.tenant_payout_attempts
       SET status = 'succeeded',
           provider_status = coalesce(provider_status, 'succeeded'),
           completed_at = now(),
           provider_metadata = provider_metadata || coalesce(_metadata, '{}'::jsonb)
     WHERE id = _attempt_id;
  END IF;

  -- Reserved becomes paid out. The amount is read from the row, never supplied.
  -- The key is single-use, so if it already exists the ledger refuses the
  -- second payment by returning NULL — and that is an error here, not a no-op.
  _entry := public.ledger_append(
    _tenant_id => _p.tenant_id,
    _entry_type => 'payout_paid',
    _idempotency_key => 'payout:paid:' || _p.id::text,
    _payout_id => _p.id,
    _reserved => -_p.amount_centavos,
    _paid_out => _p.amount_centavos,
    _actor_id => _actor,
    _source => 'payout',
    _reference => btrim(_reference),
    _metadata => coalesce(_metadata, '{}'::jsonb)
  );
  IF _entry IS NULL THEN
    RAISE EXCEPTION 'Payout % has already been paid out in the ledger', _p.id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.tenant_payout_events (
    payout_id, tenant_id, action, from_status, to_status, actor_id, metadata
  ) VALUES (
    _p.id, _p.tenant_id, 'payout.paid', _p.status, 'paid', _actor,
    jsonb_build_object('reference', btrim(_reference), 'method', _method,
                       'attempt_id', _attempt_id, 'proof_path', _proof_path) || coalesce(_metadata, '{}'::jsonb)
  );

  FOR _owner IN
    SELECT tm.user_id FROM public.tenant_members tm
     WHERE tm.tenant_id = _p.tenant_id AND tm.role = 'admin' AND tm.status = 'active'
  LOOP
    PERFORM public.notify_user(_owner, 'payout_paid', 'Payout sent',
      'PHP ' || (_p.amount_centavos / 100.0)::text || ' has been sent. Reference ' || btrim(_reference),
      '/dashboard?section=finance');
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.payout_apply_paid(bigint, bigint, text, text, text, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.payout_apply_failed(
  _payout_id  bigint,
  _attempt_id bigint,
  _code       text,
  _message    text,
  _actor      uuid,
  _metadata   jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _p RECORD;
  _a RECORD;
  _held bigint;
  _owner uuid;
  _key text;
  _seq bigint;
BEGIN
  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;
  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already %', _p.id, _p.status USING ERRCODE = '23514';
  END IF;

  IF _attempt_id IS NOT NULL THEN
    SELECT * INTO _a FROM public.tenant_payout_attempts WHERE id = _attempt_id;
    UPDATE public.tenant_payout_attempts
       SET status = 'failed',
           provider_status = coalesce(_metadata->>'provider_status', provider_status, 'failed'),
           error_code = _code,
           error_message = _message,
           completed_at = now(),
           provider_metadata = provider_metadata || coalesce(_metadata, '{}'::jsonb)
     WHERE id = _attempt_id;
    _key := 'payout:released:' || _p.id::text || ':a' || _a.attempt_no::text;
  ELSE
    -- No attempt row (the legacy transition path). Number the release so a
    -- second failure after a retry can never collide with the first one's key
    -- and be dropped by ON CONFLICT DO NOTHING. The held-amount check below
    -- is what stops a double release; this only stops a lost one.
    SELECT count(*) + 1 INTO _seq FROM public.tenant_ledger_entries
     WHERE payout_id = _p.id AND entry_type = 'payout_released';
    _key := 'payout:released:' || _p.id::text || ':r' || _seq::text;
  END IF;

  UPDATE public.tenant_payouts
     SET status = 'failed',
         provider_status = 'failed',
         provider_error_code = _code,
         provider_error_message = _message,
         reviewed_by = coalesce(_actor, reviewed_by),
         reviewed_at = now()
   WHERE id = _payout_id;

  -- The reservation goes back to available — but only what is actually held.
  -- A payout that already released (an earlier failure) releases nothing more.
  _held := public.payout_reserved_held(_payout_id);
  IF _held > 0 THEN
    PERFORM public.ledger_append(
      _tenant_id => _p.tenant_id,
      _entry_type => 'payout_released',
      _idempotency_key => _key,
      _payout_id => _p.id,
      _reserved => -_held,
      _actor_id => _actor,
      _source => 'payout',
      _metadata => jsonb_build_object('status', 'failed', 'error_code', _code, 'attempt_id', _attempt_id)
    );
  END IF;

  INSERT INTO public.tenant_payout_events (
    payout_id, tenant_id, action, from_status, to_status, actor_id, metadata
  ) VALUES (
    _p.id, _p.tenant_id, 'payout.failed', _p.status, 'failed', _actor,
    jsonb_build_object('error_code', _code, 'error_message', _message, 'attempt_id', _attempt_id,
                       'released_centavos', _held) || coalesce(_metadata, '{}'::jsonb)
  );

  FOR _owner IN
    SELECT tm.user_id FROM public.tenant_members tm
     WHERE tm.tenant_id = _p.tenant_id AND tm.role = 'admin' AND tm.status = 'active'
  LOOP
    PERFORM public.notify_user(_owner, 'payout_failed', 'Payout failed',
      'PHP ' || (_p.amount_centavos / 100.0)::text || ' was not sent and is available again.' ||
      CASE WHEN _message IS NOT NULL THEN ' ' || _message ELSE '' END,
      '/dashboard?section=finance');
  END LOOP;

  -- Operational failure: the platform side needs to see it too.
  PERFORM public.notify_user(ur.user_id, 'payout_failed',
            'Disbursement failed',
            'Payout #' || _p.id::text || ' (PHP ' || (_p.amount_centavos / 100.0)::text || ') failed' ||
            CASE WHEN _code IS NOT NULL THEN ': ' || _code ELSE '.' END,
            '/admin/disbursements')
    FROM public.user_roles ur
   WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.payout_apply_failed(bigint, bigint, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 8. Admin: beginning an attempt.
-- ---------------------------------------------------------------------------
-- Moves the payout to `processing` (recording the approval it implies), makes
-- sure the amount is reserved (re-reserving after an earlier failure, under the
-- tenant's advisory lock and against the current available balance), and
-- opens the attempt. For PayMongo the attempt starts `submitting`, because the
-- server will call the API the moment this returns; for manual it starts
-- `created` and waits for the admin to record the transfer.
CREATE OR REPLACE FUNCTION public.admin_begin_payout_attempt(
  _payout_id bigint,
  _provider  text
) RETURNS TABLE (
  attempt_id bigint,
  attempt_no integer,
  idempotency_key text,
  amount_centavos bigint,
  tenant_id uuid,
  account_id bigint,
  destination_snapshot jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _p RECORD;
  _n integer;
  _held bigint;
  _available bigint;
  _open int;
  _won int;
  _new_id bigint;
  _key text;
  _from text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;
  IF _provider NOT IN ('manual', 'paymongo') THEN
    RAISE EXCEPTION 'Unknown payout provider %', _provider;
  END IF;

  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;
  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already % and is final', _p.id, _p.status USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO _open FROM public.tenant_payout_attempts
   WHERE payout_id = _payout_id AND status IN ('created', 'submitting', 'pending');
  IF _open > 0 THEN
    RAISE EXCEPTION 'Payout % already has a transfer in flight; wait for it to settle or reconcile it', _p.id
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO _won FROM public.tenant_payout_attempts
   WHERE payout_id = _payout_id AND status = 'succeeded';
  IF _won > 0 THEN
    RAISE EXCEPTION 'Payout % has a successful transfer already', _p.id USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(max(a.attempt_no), 0) + 1 INTO _n
    FROM public.tenant_payout_attempts a WHERE a.payout_id = _payout_id;

  -- Re-reserve after a failure. The earlier failure released the money back to
  -- available; sending it again needs it reserved again, and needs it to still
  -- be there — the tenant may have requested it since.
  _held := public.payout_reserved_held(_payout_id);
  IF _held = 0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(_p.tenant_id::text, 0));
    SELECT b.available_centavos INTO _available
      FROM public.tenant_balances b WHERE b.tenant_id = _p.tenant_id;
    _available := coalesce(_available, 0);
    IF _p.amount_centavos > _available THEN
      RAISE EXCEPTION 'Retrying payout % needs % but only % is available',
        _p.id, _p.amount_centavos, _available USING ERRCODE = '23514';
    END IF;
    PERFORM public.ledger_append(
      _tenant_id => _p.tenant_id,
      _entry_type => 'payout_reserved',
      _idempotency_key => 'payout:reserved:' || _p.id::text || ':a' || _n::text,
      _payout_id => _p.id,
      _reserved => _p.amount_centavos,
      _actor_id => _uid,
      _source => 'payout',
      _metadata => jsonb_build_object('retry_attempt', _n)
    );
  ELSIF _held <> _p.amount_centavos THEN
    RAISE EXCEPTION 'Payout % holds % of its % reservation; this needs manual reconciliation',
      _p.id, _held, _p.amount_centavos USING ERRCODE = '23514';
  END IF;

  _from := _p.status;
  IF _from IN ('requested', 'under_review') THEN
    INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, from_status, to_status, actor_id, metadata)
    VALUES (_p.id, _p.tenant_id, 'payout.approved', _from, 'approved', _uid,
            jsonb_build_object('via', 'attempt', 'provider', _provider));
    _from := 'approved';
  END IF;

  UPDATE public.tenant_payouts
     SET status = 'processing',
         provider = _provider,
         provider_status = CASE WHEN _provider = 'paymongo' THEN 'submitting' ELSE NULL END,
         provider_error_code = NULL,
         provider_error_message = NULL,
         reviewed_by = coalesce(reviewed_by, _uid),
         reviewed_at = coalesce(reviewed_at, now()),
         processing_at = now()
   WHERE id = _payout_id;

  _key := 'payout:' || _p.id::text || ':a' || _n::text;

  INSERT INTO public.tenant_payout_attempts (
    payout_id, tenant_id, attempt_no, provider, status, amount_centavos, currency,
    destination_snapshot, idempotency_key, created_by
  ) VALUES (
    _p.id, _p.tenant_id, _n, _provider,
    CASE WHEN _provider = 'paymongo' THEN 'submitting' ELSE 'created' END,
    _p.amount_centavos, _p.currency, _p.destination_snapshot, _key, _uid
  ) RETURNING id INTO _new_id;

  INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, from_status, to_status, actor_id, metadata)
  VALUES (_p.id, _p.tenant_id, 'payout.processing', _from, 'processing', _uid,
          jsonb_build_object('provider', _provider, 'attempt_id', _new_id, 'attempt_no', _n,
                             're_reserved', (_held = 0)));

  PERFORM public.write_admin_audit('payout.attempt_created', 'payout', _p.id::text,
    jsonb_build_object('attempt_id', _new_id, 'attempt_no', _n, 'provider', _provider,
                       'tenant_id', _p.tenant_id, 'amount_centavos', _p.amount_centavos));

  RETURN QUERY
    SELECT _new_id, _n, _key, _p.amount_centavos, _p.tenant_id, _p.account_id, _p.destination_snapshot;
END;
$$;


-- ---------------------------------------------------------------------------
-- 9. Admin: the provider accepted the transfer.
-- ---------------------------------------------------------------------------
-- Called by the server immediately after PayMongo returns 201. This is NOT
-- payment: the payout stays `processing` and the attempt becomes `pending`.
CREATE OR REPLACE FUNCTION public.admin_mark_payout_attempt_submitted(
  _attempt_id                bigint,
  _provider_transfer_id      text,
  _provider_batch_id         text DEFAULT NULL,
  _provider_reference_number text DEFAULT NULL,
  _provider_status           text DEFAULT 'pending',
  _provider_rail             text DEFAULT NULL,
  _destination_bic           text DEFAULT NULL,
  _livemode                  boolean DEFAULT NULL,
  _metadata                  jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _a RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;
  IF _provider_transfer_id IS NULL OR length(btrim(_provider_transfer_id)) = 0 THEN
    RAISE EXCEPTION 'A provider transfer id is required';
  END IF;

  SELECT * INTO _a FROM public.tenant_payout_attempts WHERE id = _attempt_id FOR UPDATE;
  IF _a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
  IF _a.status NOT IN ('created', 'submitting') THEN
    RAISE EXCEPTION 'Attempt % is already %', _a.id, _a.status USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.tenant_payouts WHERE id = _a.payout_id FOR UPDATE;

  UPDATE public.tenant_payout_attempts
     SET status = 'pending',
         provider_transfer_id = btrim(_provider_transfer_id),
         provider_batch_id = _provider_batch_id,
         provider_reference_number = _provider_reference_number,
         provider_status = coalesce(_provider_status, 'pending'),
         provider_rail = _provider_rail,
         destination_bic = _destination_bic,
         livemode = _livemode,
         submitted_at = now(),
         provider_metadata = provider_metadata || coalesce(_metadata, '{}'::jsonb)
   WHERE id = _attempt_id;

  UPDATE public.tenant_payouts
     SET provider_transfer_id = btrim(_provider_transfer_id),
         provider_status = coalesce(_provider_status, 'pending'),
         provider_submitted_at = now(),
         transfer_method = coalesce(transfer_method, 'paymongo:' || coalesce(_provider_rail, 'transfer'))
   WHERE id = _a.payout_id;

  INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, from_status, to_status, actor_id, metadata)
  VALUES (_a.payout_id, _a.tenant_id, 'payout.transfer_submitted', 'processing', 'processing', _uid,
          jsonb_build_object('attempt_id', _a.id, 'provider', _a.provider,
                             'provider_transfer_id', btrim(_provider_transfer_id),
                             'provider_batch_id', _provider_batch_id,
                             'provider_reference_number', _provider_reference_number,
                             'rail', _provider_rail, 'livemode', _livemode));

  PERFORM public.write_admin_audit('payout.transfer_submitted', 'payout', _a.payout_id::text,
    jsonb_build_object('attempt_id', _a.id, 'provider', _a.provider,
                       'provider_transfer_id', btrim(_provider_transfer_id), 'livemode', _livemode));
END;
$$;


-- ---------------------------------------------------------------------------
-- 10. Admin: the submission itself failed (the API refused it, or a check
--     before the API refused it). Nothing left the wallet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_mark_payout_attempt_failed(
  _attempt_id    bigint,
  _error_code    text,
  _error_message text,
  _metadata      jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _a RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;

  SELECT * INTO _a FROM public.tenant_payout_attempts WHERE id = _attempt_id FOR UPDATE;
  IF _a.id IS NULL THEN RAISE EXCEPTION 'Attempt not found'; END IF;
  -- A pending attempt is the provider's to settle. Failing it by hand would
  -- release money that PayMongo may be about to send; use reconciliation.
  IF _a.status NOT IN ('created', 'submitting') THEN
    RAISE EXCEPTION 'Attempt % is %; a submitted transfer is settled by the provider or by reconciliation',
      _a.id, _a.status USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.tenant_payouts WHERE id = _a.payout_id FOR UPDATE;

  PERFORM public.payout_apply_failed(_a.payout_id, _a.id, _error_code, _error_message, _uid,
    coalesce(_metadata, '{}'::jsonb) || jsonb_build_object('stage', 'submission'));

  PERFORM public.write_admin_audit('payout.attempt_failed', 'payout', _a.payout_id::text,
    jsonb_build_object('attempt_id', _a.id, 'provider', _a.provider, 'error_code', _error_code,
                       'stage', 'submission'));
END;
$$;


-- ---------------------------------------------------------------------------
-- 11. Admin: recording a manual transfer.
-- ---------------------------------------------------------------------------
-- The transfer happened outside. What is required is everything an auditor
-- would ask for: method, reference, the amount that was sent, a proof image,
-- and (implicitly) who and when. The amount must equal the payout amount —
-- the ledger pays out exactly the reservation, so a different figure is not a
-- partial payout, it is a mistake, and is refused rather than absorbed.
CREATE OR REPLACE FUNCTION public.admin_record_manual_payout(
  _payout_id           bigint,
  _transfer_method     text,
  _transfer_reference  text,
  _paid_amount_centavos bigint,
  _proof_path          text,
  _notes               text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _p RECORD;
  _a RECORD;
  _attempt_id bigint;
  _n integer;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;
  IF _transfer_method IS NULL OR length(btrim(_transfer_method)) = 0 THEN
    RAISE EXCEPTION 'The payment method is required';
  END IF;
  IF _transfer_reference IS NULL OR length(btrim(_transfer_reference)) = 0 THEN
    RAISE EXCEPTION 'A transfer reference is required to mark a payout paid';
  END IF;
  IF _proof_path IS NULL OR length(btrim(_proof_path)) = 0 THEN
    RAISE EXCEPTION 'A proof of transfer is required for a manual payout';
  END IF;

  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;
  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already % and is final', _p.id, _p.status USING ERRCODE = '23514';
  END IF;
  IF _paid_amount_centavos IS DISTINCT FROM _p.amount_centavos THEN
    RAISE EXCEPTION 'Paid amount % does not match the payout amount %; reject and re-request for a different amount',
      _paid_amount_centavos, _p.amount_centavos USING ERRCODE = '23514';
  END IF;

  -- Reuse an open manual attempt if the admin opened one, else open one now.
  -- A PayMongo attempt in flight blocks this: the provider may still pay.
  SELECT * INTO _a FROM public.tenant_payout_attempts
   WHERE payout_id = _payout_id AND status IN ('created', 'submitting', 'pending')
   FOR UPDATE;
  IF _a.id IS NOT NULL AND _a.provider <> 'manual' THEN
    RAISE EXCEPTION 'Payout % has a % transfer in flight; wait for it to settle or reconcile it',
      _p.id, _a.provider USING ERRCODE = '23514';
  END IF;

  IF _a.id IS NULL THEN
    SELECT a.attempt_id INTO _attempt_id
      FROM public.admin_begin_payout_attempt(_payout_id, 'manual') a;
  ELSE
    _attempt_id := _a.id;
  END IF;

  SELECT a.attempt_no INTO _n FROM public.tenant_payout_attempts a WHERE a.id = _attempt_id;

  UPDATE public.tenant_payout_attempts
     SET provider_reference_number = btrim(_transfer_reference),
         provider_status = 'succeeded',
         submitted_at = coalesce(submitted_at, now()),
         provider_metadata = provider_metadata || jsonb_build_object('method', btrim(_transfer_method), 'proof_path', _proof_path)
   WHERE id = _attempt_id;

  PERFORM public.payout_apply_paid(_payout_id, _attempt_id, _transfer_reference, btrim(_transfer_method),
    _proof_path, _uid, _notes, jsonb_build_object('provider', 'manual', 'attempt_no', _n));

  PERFORM public.write_admin_audit('payout.manual_paid', 'payout', _payout_id::text,
    jsonb_build_object('attempt_id', _attempt_id, 'method', btrim(_transfer_method),
                       'reference', btrim(_transfer_reference), 'proof_path', _proof_path,
                       'amount_centavos', _p.amount_centavos, 'tenant_id', _p.tenant_id));

  RETURN _attempt_id;
END;
$$;


-- ---------------------------------------------------------------------------
-- 12. The provider settled a transfer. Service role only: this is the webhook.
-- ---------------------------------------------------------------------------
-- Idempotent by construction. The event row is inserted first under a unique
-- (provider, event_id); a redelivery cannot insert, so it returns
-- 'duplicate_event' and touches nothing. The attempt is matched by its
-- provider transfer id (or reference number as a fallback), locked with its
-- payout, and settled only if it is still open. A success arriving twice, or a
-- failure arriving after a success, is recorded with an 'ignored_*' outcome
-- and moves no money. The one genuinely ambiguous case — a success arriving
-- after we already recorded a failure — is refused and flagged for a person.
CREATE OR REPLACE FUNCTION public.payout_provider_settle(
  _provider                  text,
  _event_id                  text,
  _event_type                text,
  _provider_transfer_id      text,
  _provider_reference_number text,
  _outcome                   text,
  _provider_status           text DEFAULT NULL,
  _error_code                text DEFAULT NULL,
  _error_message             text DEFAULT NULL,
  _livemode                  boolean DEFAULT NULL,
  _payload                   jsonb DEFAULT '{}'::jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ev_id bigint;
  _a RECORD;
  _p RECORD;
  _result text;
  _meta jsonb;
BEGIN
  IF _outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Unknown settlement outcome %', _outcome;
  END IF;

  INSERT INTO public.payout_provider_events (
    provider, event_id, event_type, provider_transfer_id, provider_reference_number,
    outcome, livemode, payload
  ) VALUES (
    _provider, _event_id, _event_type, _provider_transfer_id, _provider_reference_number,
    'received', _livemode, coalesce(_payload, '{}'::jsonb)
  )
  ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING id INTO _ev_id;

  IF _ev_id IS NULL THEN
    RETURN 'duplicate_event';
  END IF;

  SELECT * INTO _a FROM public.tenant_payout_attempts
   WHERE provider = _provider
     AND provider_transfer_id IS NOT NULL
     AND provider_transfer_id = _provider_transfer_id
   FOR UPDATE;
  IF _a.id IS NULL AND _provider_reference_number IS NOT NULL THEN
    SELECT * INTO _a FROM public.tenant_payout_attempts
     WHERE provider = _provider
       AND provider_reference_number = _provider_reference_number
       AND status IN ('submitting', 'pending')
     FOR UPDATE;
  END IF;

  IF _a.id IS NULL THEN
    UPDATE public.payout_provider_events SET outcome = 'unmatched' WHERE id = _ev_id;
    RETURN 'unmatched';
  END IF;

  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _a.payout_id FOR UPDATE;

  _meta := jsonb_build_object(
    'provider', _provider, 'event_id', _event_id, 'event_type', _event_type,
    'provider_status', _provider_status, 'livemode', _livemode,
    'provider_reference_number', _provider_reference_number
  );

  IF _a.status = 'succeeded' THEN
    _result := 'ignored_already_succeeded';
  ELSIF _a.status = 'failed' THEN
    IF _outcome = 'failed' THEN
      _result := 'ignored_already_failed';
    ELSE
      -- A success after we recorded a failure. Money may have moved; the
      -- reservation was released. Never auto-pay here — a person must look.
      _result := 'conflict_needs_review';
      PERFORM public.write_admin_audit('payout.settlement_conflict', 'payout', _p.id::text,
        jsonb_build_object('attempt_id', _a.id, 'event_id', _event_id,
                           'provider_transfer_id', _provider_transfer_id));
      PERFORM public.notify_user(ur.user_id, 'payout_reconcile',
                'Disbursement needs review',
                'PayMongo reported payout #' || _p.id::text || ' succeeded after it was recorded as failed. Reconcile it.',
                '/admin/disbursements')
        FROM public.user_roles ur
       WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;
    END IF;
  ELSIF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    _result := 'ignored_payout_' || _p.status;
  ELSIF _outcome = 'succeeded' THEN
    -- Reference: the provider's reference number is what appears on the
    -- recipient's statement; fall back to the transfer id.
    UPDATE public.tenant_payout_attempts
       SET provider_status = coalesce(_provider_status, 'succeeded'),
           provider_reference_number = coalesce(_provider_reference_number, provider_reference_number),
           livemode = coalesce(_livemode, livemode)
     WHERE id = _a.id;
    PERFORM public.payout_apply_paid(
      _p.id, _a.id,
      coalesce(_provider_reference_number, _a.provider_reference_number, _provider_transfer_id),
      coalesce(_p.transfer_method, 'paymongo'),
      NULL, _a.created_by, NULL, _meta
    );
    PERFORM public.write_admin_audit('payout.provider_succeeded', 'payout', _p.id::text,
      jsonb_build_object('attempt_id', _a.id, 'event_id', _event_id,
                         'provider_transfer_id', _provider_transfer_id, 'livemode', _livemode));
    _result := 'paid';
  ELSE
    PERFORM public.payout_apply_failed(_p.id, _a.id, _error_code, _error_message, _a.created_by,
      _meta || jsonb_build_object('stage', 'provider'));
    PERFORM public.write_admin_audit('payout.provider_failed', 'payout', _p.id::text,
      jsonb_build_object('attempt_id', _a.id, 'event_id', _event_id,
                         'provider_transfer_id', _provider_transfer_id,
                         'error_code', _error_code, 'livemode', _livemode));
    _result := 'failed';
  END IF;

  UPDATE public.payout_provider_events
     SET outcome = _result, attempt_id = _a.id, payout_id = _p.id
   WHERE id = _ev_id;

  RETURN _result;
END;
$$;


-- ---------------------------------------------------------------------------
-- 13. Admin: mapping a destination to a PayMongo receiving institution.
-- ---------------------------------------------------------------------------
-- The BIC comes from PayMongo's own list, chosen by an admin. Recorded on the
-- account so the mapping is made once, and in the account's event history so
-- the choice is auditable.
CREATE OR REPLACE FUNCTION public.admin_set_payout_account_bic(
  _account_id       bigint,
  _bic              text,
  _institution_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _acct RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may map a payout destination';
  END IF;
  IF _bic IS NULL OR length(btrim(_bic)) = 0 THEN
    RAISE EXCEPTION 'A receiving institution code is required';
  END IF;

  SELECT * INTO _acct FROM public.tenant_payout_accounts WHERE id = _account_id FOR UPDATE;
  IF _acct.id IS NULL THEN RAISE EXCEPTION 'Payout account not found'; END IF;

  UPDATE public.tenant_payout_accounts
     SET paymongo_bic = btrim(_bic),
         paymongo_institution_name = _institution_name,
         updated_at = now()
   WHERE id = _account_id;

  INSERT INTO public.tenant_payout_account_events (
    tenant_id, account_id, action, actor_id, old_value, new_value
  ) VALUES (
    _acct.tenant_id, _acct.id, 'payout_account.institution_mapped', _uid,
    jsonb_build_object('paymongo_bic', _acct.paymongo_bic, 'institution', _acct.paymongo_institution_name),
    jsonb_build_object('paymongo_bic', btrim(_bic), 'institution', _institution_name)
  );

  PERFORM public.write_admin_audit('payout_account.institution_mapped', 'payout_account', _acct.id::text,
    jsonb_build_object('tenant_id', _acct.tenant_id, 'bic', btrim(_bic), 'institution', _institution_name));
END;
$$;


-- ---------------------------------------------------------------------------
-- 14. The original transition function, made reservation-aware.
-- ---------------------------------------------------------------------------
-- Same signature. under_review / approved / rejected behave as before. `paid`
-- and `failed` now route through the shared settlement functions, which means
-- they release or pay exactly what the ledger holds; and a payout whose
-- PayMongo transfer is pending cannot be forced paid, failed or re-processed
-- by hand — the provider or the reconciliation path settles it.
CREATE OR REPLACE FUNCTION public.admin_transition_payout(
  _payout_id bigint,
  _to_status text,
  _transfer_reference text DEFAULT NULL,
  _transfer_method text DEFAULT NULL,
  _proof_path text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _p RECORD;
  _open RECORD;
  _owner uuid;
  _held bigint;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;

  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;

  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already %', _p.id, _p.status USING ERRCODE = '23514';
  END IF;

  IF _to_status NOT IN ('under_review', 'approved', 'processing', 'paid', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'Unknown payout status %', _to_status;
  END IF;

  SELECT * INTO _open FROM public.tenant_payout_attempts
   WHERE payout_id = _payout_id AND status IN ('submitting', 'pending');
  IF _open.id IS NOT NULL AND _to_status IN ('paid', 'failed', 'processing', 'rejected') THEN
    RAISE EXCEPTION 'Payout % has a % transfer in flight (attempt %); it is settled by the provider or by reconciliation',
      _p.id, _open.provider, _open.id USING ERRCODE = '23514';
  END IF;

  IF _to_status = 'paid' THEN
    -- Marking paid by hand IS a manual transfer. Record it as one so the
    -- attempt history is complete, then pay through the shared path.
    PERFORM public.admin_record_manual_payout(
      _payout_id, coalesce(_transfer_method, 'manual'), _transfer_reference,
      _p.amount_centavos, coalesce(_proof_path, _p.proof_path), _notes);
    RETURN 'paid';

  ELSIF _to_status = 'failed' THEN
    PERFORM public.payout_apply_failed(_payout_id, NULL, 'manual', _reason, _uid,
      jsonb_build_object('notes', _notes, 'stage', 'manual'));
    PERFORM public.write_admin_audit('payout.failed', 'payout', _p.id::text,
      jsonb_build_object('reason', _reason));
    RETURN 'failed';

  ELSIF _to_status = 'rejected' THEN
    UPDATE public.tenant_payouts
       SET status = 'rejected',
           rejection_reason = coalesce(_reason, rejection_reason),
           admin_notes = coalesce(_notes, admin_notes),
           reviewed_by = _uid,
           reviewed_at = now()
     WHERE id = _payout_id;

    -- Release only what is held: a payout rejected after a failure already
    -- gave the money back and must not give it back twice.
    _held := public.payout_reserved_held(_payout_id);
    IF _held > 0 THEN
      PERFORM public.ledger_append(
        _tenant_id => _p.tenant_id,
        _entry_type => 'payout_released',
        _idempotency_key => 'payout:released:' || _p.id::text || ':rejected',
        _payout_id => _p.id,
        _reserved => -_held,
        _actor_id => _uid,
        _source => 'payout',
        _metadata => jsonb_build_object('reason', _reason, 'status', 'rejected')
      );
    END IF;

  ELSE
    UPDATE public.tenant_payouts
       SET status = _to_status,
           admin_notes = coalesce(_notes, admin_notes),
           reviewed_by = _uid,
           reviewed_at = now(),
           processing_at = CASE WHEN _to_status = 'processing' THEN now() ELSE processing_at END
     WHERE id = _payout_id;
  END IF;

  INSERT INTO public.tenant_payout_events (
    payout_id, tenant_id, action, from_status, to_status, actor_id, metadata
  ) VALUES (
    _p.id, _p.tenant_id, 'payout.' || _to_status, _p.status, _to_status, _uid,
    jsonb_build_object('reference', _transfer_reference, 'method', _transfer_method,
                       'reason', _reason, 'notes', _notes)
  );

  PERFORM public.write_admin_audit('payout.' || _to_status, 'payout', _p.id::text,
    jsonb_build_object('reason', _reason, 'tenant_id', _p.tenant_id));

  FOR _owner IN
    SELECT tm.user_id FROM public.tenant_members tm
     WHERE tm.tenant_id = _p.tenant_id AND tm.role = 'admin' AND tm.status = 'active'
  LOOP
    PERFORM public.notify_user(
      _owner, 'payout_' || _to_status,
      CASE _to_status
        WHEN 'rejected' THEN 'Payout rejected'
        WHEN 'approved' THEN 'Payout approved'
        WHEN 'processing' THEN 'Payout processing'
        ELSE 'Payout updated'
      END,
      'PHP ' || (_p.amount_centavos / 100.0)::text ||
      CASE WHEN _to_status = 'rejected' THEN ' was not sent and is available again.'
           WHEN _to_status = 'processing' THEN ' is being sent to your payout account.'
           ELSE '' END,
      '/dashboard?section=finance');
  END LOOP;

  RETURN _to_status;
END;
$$;


-- ---------------------------------------------------------------------------
-- 15. Proof of a manual disbursement: platform admins may upload, into a
--     folder that says what it is.
-- ---------------------------------------------------------------------------
-- The existing policies let a tenant admin write its own folder and a platform
-- admin only read. A manual disbursement needs the admin to attach the proof
-- of THEIR transfer, so they may insert — but only under
--
--   payout-proofs/<tenant_id>/disbursements/<file>
--
-- which keeps the tenant's own destination proofs and the platform's transfer
-- proofs distinguishable by path, and keeps an admin from overwriting a
-- tenant's file: there is still no UPDATE or DELETE for admins. Tenant admins
-- can read it through the existing owner policy, because the first segment is
-- their tenant.
DROP POLICY IF EXISTS "Platform admin uploads disbursement proof" ON storage.objects;
CREATE POLICY "Platform admin uploads disbursement proof"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payout-proofs'
    AND public.is_courthub_admin()
    AND (storage.foldername(name))[2] = 'disbursements'
  );


-- ---------------------------------------------------------------------------
-- 16. Row-level security and grants.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_payout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_provider_events ENABLE ROW LEVEL SECURITY;

-- Attempts: the tenant's own admins see their own; platform admins see all.
-- No write policy at all — every write is a definer function above.
DROP POLICY IF EXISTS "Tenant admin reads own payout attempts" ON public.tenant_payout_attempts;
CREATE POLICY "Tenant admin reads own payout attempts"
  ON public.tenant_payout_attempts FOR SELECT TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
    OR public.is_courthub_admin()
  );

-- Provider events carry raw provider payloads. Platform admins only.
DROP POLICY IF EXISTS "Platform admins read provider events" ON public.payout_provider_events;
CREATE POLICY "Platform admins read provider events"
  ON public.payout_provider_events FOR SELECT TO authenticated
  USING (public.is_courthub_admin());

REVOKE ALL ON public.tenant_payout_attempts, public.payout_provider_events FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_payout_attempts, public.payout_provider_events TO authenticated;
GRANT ALL ON public.tenant_payout_attempts, public.payout_provider_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.tenant_payout_attempts_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.payout_provider_events_id_seq TO service_role;

-- Admin-gated functions: callable by any signed-in user, and every one of them
-- re-checks is_courthub_admin() inside. Nothing here trusts the grant.
REVOKE ALL ON FUNCTION public.admin_request_recurring_payout(uuid, bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_request_recurring_payout(uuid, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_begin_payout_attempt(bigint, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_begin_payout_attempt(bigint, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_mark_payout_attempt_submitted(bigint, text, text, text, text, text, text, boolean, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_mark_payout_attempt_submitted(bigint, text, text, text, text, text, text, boolean, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_mark_payout_attempt_failed(bigint, text, text, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_mark_payout_attempt_failed(bigint, text, text, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_record_manual_payout(bigint, text, text, bigint, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_record_manual_payout(bigint, text, text, bigint, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_set_payout_account_bic(bigint, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_set_payout_account_bic(bigint, text, text) TO authenticated, service_role;

-- The webhook settles. Only the service role, which only the server holds.
REVOKE ALL ON FUNCTION public.payout_provider_settle(text, text, text, text, text, text, text, text, text, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.payout_provider_settle(text, text, text, text, text, text, text, text, text, boolean, jsonb)
  TO service_role;

COMMENT ON TABLE public.tenant_payout_attempts IS
  'One row per time a payout was asked to move money. A retry is a new row; a '
  'failed row keeps its error. At most one open row per payout (partial unique '
  'index), and a provider transfer id maps to exactly one row.';

COMMENT ON TABLE public.payout_provider_events IS
  'Every provider webhook delivery about a payout, unique per (provider, '
  'event_id). outcome records what settlement decided, including ignored '
  'duplicates and stale events, so nothing is silently dropped.';
