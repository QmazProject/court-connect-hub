-- ===========================================================================
-- Payout accounts, payout requests, and admin disbursement.
--
-- Money reaches a tenant in three steps, and this migration makes each of them a
-- recorded fact rather than a message someone sent:
--
--   1. the tenant says where to send it        -> tenant_payout_accounts
--   2. the tenant asks for some of its balance -> tenant_payouts (reserves it)
--   3. an admin actually sends it and says so  -> tenant_payouts (pays it out)
--
-- Nothing here moves money by itself. There is no disbursement API integration
-- in this product, so the transfer is performed by a person, out of band, and
-- what the system does is reserve the balance beforehand and record the
-- reference afterwards. Pretending otherwise would be the worst possible bug in
-- this file.
--
-- Every balance change is written to `tenant_ledger_entries` from the previous
-- migration. This table never stores a balance of its own; if it did, the two
-- would eventually disagree and there would be no way to say which was right.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Where the money should go.
-- ---------------------------------------------------------------------------
-- One active account per tenant is enforced by a partial unique index rather
-- than by deleting the old one: a superseded account must stay readable, because
-- a payout that was sent last month has to keep resolving to the destination it
-- was actually sent to.
CREATE TABLE IF NOT EXISTS public.tenant_payout_accounts (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  account_type   text NOT NULL,
  account_name   text NOT NULL,
  account_number text,          -- mobile number, or bank account number
  bank_name      text,
  instructions   text,

  -- Private Storage object path. Never a public URL: the client asks for a
  -- signed URL at read time, so the QR cannot be enumerated by anyone who
  -- guesses the path.
  proof_path     text,

  status         text NOT NULL DEFAULT 'pending_verification',
  is_active      boolean NOT NULL DEFAULT true,

  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_payout_accounts
  DROP CONSTRAINT IF EXISTS tenant_payout_accounts_type_check;
ALTER TABLE public.tenant_payout_accounts
  ADD CONSTRAINT tenant_payout_accounts_type_check
  CHECK (account_type IN ('gcash', 'maya', 'bank', 'other_ewallet', 'other'));

ALTER TABLE public.tenant_payout_accounts
  DROP CONSTRAINT IF EXISTS tenant_payout_accounts_status_check;
ALTER TABLE public.tenant_payout_accounts
  ADD CONSTRAINT tenant_payout_accounts_status_check
  CHECK (status IN ('draft', 'pending_verification', 'verified', 'rejected', 'disabled'));

-- A bank destination without a bank name is not a destination.
ALTER TABLE public.tenant_payout_accounts
  DROP CONSTRAINT IF EXISTS tenant_payout_accounts_bank_needs_name;
ALTER TABLE public.tenant_payout_accounts
  ADD CONSTRAINT tenant_payout_accounts_bank_needs_name CHECK (
    account_type <> 'bank'
    OR (bank_name IS NOT NULL AND length(btrim(bank_name)) > 0
        AND account_number IS NOT NULL AND length(btrim(account_number)) > 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS tenant_payout_accounts_one_active
  ON public.tenant_payout_accounts (tenant_id) WHERE is_active;


-- ---------------------------------------------------------------------------
-- 2. Every change to a payout destination, kept.
-- ---------------------------------------------------------------------------
-- Changing where money is sent is the single most attractive action in this
-- system to an attacker who has taken over a tenant account, so it is the one
-- most worth being able to reconstruct afterwards. Old and new are stored
-- already masked: the audit trail answers "what changed and who changed it",
-- which never requires the full account number in a second place.
CREATE TABLE IF NOT EXISTS public.tenant_payout_account_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  account_id  bigint REFERENCES public.tenant_payout_accounts(id) ON DELETE SET NULL,
  action      text NOT NULL,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_account_events_tenant
  ON public.tenant_payout_account_events (tenant_id, created_at DESC);


-- ---------------------------------------------------------------------------
-- 3. Settlement preference.
-- ---------------------------------------------------------------------------
-- A preference and an operational hint, nothing more: no scheduler reads this
-- and no money moves because of it.
CREATE TABLE IF NOT EXISTS public.tenant_payout_preferences (
  tenant_id  uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  frequency  text NOT NULL DEFAULT 'manual',
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_payout_preferences
  DROP CONSTRAINT IF EXISTS tenant_payout_preferences_frequency_check;
ALTER TABLE public.tenant_payout_preferences
  ADD CONSTRAINT tenant_payout_preferences_frequency_check
  CHECK (frequency IN ('weekly', 'twice_monthly', 'monthly', 'manual'));


-- ---------------------------------------------------------------------------
-- 4. The payout itself.
-- ---------------------------------------------------------------------------
-- `destination_snapshot` is the reason this table is not simply a foreign key to
-- the account. A tenant may change its GCash number the day after requesting a
-- payout; the payout that was already in flight must keep showing, forever,
-- where the money was actually sent. The snapshot is written once at request
-- time and never updated.
CREATE TABLE IF NOT EXISTS public.tenant_payouts (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,

  amount_centavos    bigint NOT NULL CHECK (amount_centavos > 0),
  currency           text NOT NULL DEFAULT 'PHP',
  status             text NOT NULL DEFAULT 'requested',

  account_id         bigint REFERENCES public.tenant_payout_accounts(id) ON DELETE SET NULL,
  destination_snapshot jsonb NOT NULL,

  available_at_request_centavos bigint,

  requested_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz,
  processing_at      timestamptz,
  completed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at       timestamptz,

  transfer_reference text,
  transfer_method    text,
  proof_path         text,
  admin_notes        text,
  rejection_reason   text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_status_check;
ALTER TABLE public.tenant_payouts
  ADD CONSTRAINT tenant_payouts_status_check CHECK (status IN (
    'requested', 'under_review', 'approved', 'processing',
    'paid', 'rejected', 'failed', 'cancelled'
  ));

-- A payout that says it was paid must say how. Without this the settlement
-- record is unauditable exactly where auditing matters most.
ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_paid_needs_reference;
ALTER TABLE public.tenant_payouts
  ADD CONSTRAINT tenant_payouts_paid_needs_reference CHECK (
    status <> 'paid'
    OR (transfer_reference IS NOT NULL
        AND length(btrim(transfer_reference)) > 0
        AND completed_at IS NOT NULL
        AND completed_by IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_payouts_tenant ON public.tenant_payouts (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON public.tenant_payouts (status, requested_at);

-- Terminal states are terminal. Combined with the status transition checks in
-- the RPCs below, this is what makes "a payout cannot be paid twice" true even
-- if an admin double-clicks or two admins act at once: the second UPDATE finds
-- the row already terminal and refuses.
CREATE OR REPLACE FUNCTION public.tenant_payouts_guard_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('paid', 'rejected', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Payout % is already %, and that is final', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  -- The snapshot is the historical record of where money went. Nothing may edit it.
  IF NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot THEN
    RAISE EXCEPTION 'A payout destination snapshot cannot be changed after the request';
  END IF;

  IF NEW.amount_centavos IS DISTINCT FROM OLD.amount_centavos THEN
    RAISE EXCEPTION 'A payout amount cannot be changed; cancel it and request again';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_payouts_transitions ON public.tenant_payouts;
CREATE TRIGGER tenant_payouts_transitions
  BEFORE UPDATE ON public.tenant_payouts
  FOR EACH ROW EXECUTE FUNCTION public.tenant_payouts_guard_transitions();


-- Now that the table exists, the ledger's payout_id can point at it.
ALTER TABLE public.tenant_ledger_entries
  DROP CONSTRAINT IF EXISTS tenant_ledger_entries_payout_id_fkey;
ALTER TABLE public.tenant_ledger_entries
  ADD CONSTRAINT tenant_ledger_entries_payout_id_fkey
  FOREIGN KEY (payout_id) REFERENCES public.tenant_payouts(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- 5. Lifecycle audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_payout_events (
  id         bigserial PRIMARY KEY,
  payout_id  bigint NOT NULL REFERENCES public.tenant_payouts(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  action     text NOT NULL,
  from_status text,
  to_status   text,
  actor_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_events_payout
  ON public.tenant_payout_events (payout_id, created_at);


-- ---------------------------------------------------------------------------
-- 6. Masking.
-- ---------------------------------------------------------------------------
-- Used for list views and for the destination snapshot. The last four digits are
-- enough for a tenant to recognise their own account and not enough for anyone
-- else to use it.
CREATE OR REPLACE FUNCTION public.mask_account_number(_n text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _n IS NULL OR length(btrim(_n)) = 0 THEN NULL
    WHEN length(btrim(_n)) <= 4 THEN repeat('•', length(btrim(_n)))
    ELSE repeat('•', length(btrim(_n)) - 4) || right(btrim(_n), 4)
  END;
$$;


-- ---------------------------------------------------------------------------
-- 7. Saving a payout destination.
-- ---------------------------------------------------------------------------
-- Tenant admin only. Not manager, and certainly not staff: this is the control
-- that decides who receives the business's money, and the existing role ladder
-- already reserves that class of decision for `is_tenant_admin()`.
CREATE OR REPLACE FUNCTION public.tenant_save_payout_account(
  _account_type   text,
  _account_name   text,
  _account_number text DEFAULT NULL,
  _bank_name      text DEFAULT NULL,
  _instructions   text DEFAULT NULL,
  _proof_path     text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _tid uuid := public.current_tenant_id();
  _old RECORD;
  _new_id bigint;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _tid IS NULL THEN RAISE EXCEPTION 'No tenant workspace for this account'; END IF;
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin may change the payout destination';
  END IF;

  SELECT * INTO _old FROM public.tenant_payout_accounts
   WHERE tenant_id = _tid AND is_active;

  -- Superseded, never deleted: a completed payout still refers to it.
  UPDATE public.tenant_payout_accounts
     SET is_active = false, status = 'disabled', updated_at = now()
   WHERE tenant_id = _tid AND is_active;

  INSERT INTO public.tenant_payout_accounts (
    tenant_id, account_type, account_name, account_number, bank_name,
    instructions, proof_path, status, is_active, created_by
  ) VALUES (
    _tid, _account_type, btrim(_account_name), nullif(btrim(coalesce(_account_number,'')),''),
    nullif(btrim(coalesce(_bank_name,'')),''), nullif(btrim(coalesce(_instructions,'')),''),
    _proof_path, 'pending_verification', true, _uid
  ) RETURNING id INTO _new_id;

  INSERT INTO public.tenant_payout_account_events (
    tenant_id, account_id, action, actor_id, old_value, new_value
  ) VALUES (
    _tid, _new_id,
    CASE WHEN _old.id IS NULL THEN 'payout_account.added' ELSE 'payout_account.changed' END,
    _uid,
    CASE WHEN _old.id IS NULL THEN NULL ELSE jsonb_build_object(
      'account_type', _old.account_type,
      'account_name', _old.account_name,
      'account_number', public.mask_account_number(_old.account_number),
      'bank_name', _old.bank_name) END,
    jsonb_build_object(
      'account_type', _account_type,
      'account_name', btrim(_account_name),
      'account_number', public.mask_account_number(_account_number),
      'bank_name', _bank_name)
  );

  RETURN _new_id;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8. Requesting a payout.
-- ---------------------------------------------------------------------------
-- The concurrency-critical function in this system. Two tabs, or two admins of
-- the same business, pressing Request at the same instant must not both reserve
-- the same peso.
--
-- The defence is `pg_advisory_xact_lock` keyed on the tenant, taken BEFORE the
-- balance is read. Everything after it — read available, compare, insert the
-- payout, append the reservation — happens with the second caller blocked, and
-- the lock is released only at commit. So the second caller reads a balance that
-- already has the first reservation subtracted from it, and is refused. A
-- SELECT-then-INSERT without this lock is the classic way to pay the same money
-- twice, and no amount of frontend disabling closes it.
CREATE OR REPLACE FUNCTION public.tenant_request_payout(_amount_centavos bigint)
RETURNS TABLE (payout_id bigint, reserved_centavos bigint, remaining_available_centavos bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid uuid := auth.uid();
  _tid uuid := public.current_tenant_id();
  _acct RECORD;
  _available bigint;
  _new_id bigint;
  _snapshot jsonb;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF _tid IS NULL THEN RAISE EXCEPTION 'No tenant workspace for this account'; END IF;
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin may request a payout';
  END IF;
  IF _amount_centavos IS NULL OR _amount_centavos <= 0 THEN
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

  IF _amount_centavos > _available THEN
    RAISE EXCEPTION 'Requested % exceeds the available balance of %',
      _amount_centavos, _available USING ERRCODE = '23514';
  END IF;

  -- Frozen here, deliberately. See the table comment.
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
    available_at_request_centavos, requested_by
  ) VALUES (
    _tid, _amount_centavos, 'requested', _acct.id, _snapshot, _available, _uid
  ) RETURNING id INTO _new_id;

  PERFORM public.ledger_append(
    _tenant_id => _tid,
    _entry_type => 'payout_reserved',
    _idempotency_key => 'payout:reserved:' || _new_id::text,
    _payout_id => _new_id,
    _reserved => _amount_centavos,
    _actor_id => _uid,
    _source => 'payout',
    _metadata => jsonb_build_object('available_at_request', _available)
  );

  INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, to_status, actor_id, metadata)
  VALUES (_new_id, _tid, 'payout.requested', 'requested', _uid,
          jsonb_build_object('amount_centavos', _amount_centavos));

  -- Platform admins need to know there is something to process.
  PERFORM public.notify_user(ur.user_id, 'payout_requested',
            'New payout request',
            'A tenant has requested a payout of PHP ' || (_amount_centavos / 100.0)::text,
            '/admin/disbursements')
    FROM public.user_roles ur
   WHERE ur.role IN ('admin', 'super_admin') AND ur.revoked_at IS NULL;

  RETURN QUERY SELECT _new_id, _amount_centavos, (_available - _amount_centavos);
END;
$$;


-- ---------------------------------------------------------------------------
-- 9. Admin: moving a payout through its life.
-- ---------------------------------------------------------------------------
-- One function for every transition, so the rules about which transition is
-- legal live in one readable place instead of being spread across an admin UI.
-- Releasing a reservation and paying it out are both ledger appends, never
-- edits, so the history of a payout that failed and was retried stays legible.
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
  _owner uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_courthub_admin() THEN
    RAISE EXCEPTION 'Only a platform admin may process a payout';
  END IF;

  -- Row lock: two admins acting at once serialise here, and the second one sees
  -- the first one's status rather than a stale copy.
  SELECT * INTO _p FROM public.tenant_payouts WHERE id = _payout_id FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;

  IF _p.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Payout % is already %', _p.id, _p.status USING ERRCODE = '23514';
  END IF;

  IF _to_status NOT IN ('under_review', 'approved', 'processing', 'paid', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'Unknown payout status %', _to_status;
  END IF;

  IF _to_status = 'paid' THEN
    IF _transfer_reference IS NULL OR length(btrim(_transfer_reference)) = 0 THEN
      RAISE EXCEPTION 'A transfer reference is required to mark a payout paid';
    END IF;

    UPDATE public.tenant_payouts
       SET status = 'paid',
           transfer_reference = btrim(_transfer_reference),
           transfer_method = _transfer_method,
           proof_path = coalesce(_proof_path, proof_path),
           admin_notes = coalesce(_notes, admin_notes),
           completed_by = _uid,
           completed_at = now()
     WHERE id = _payout_id;

    -- Reserved becomes paid out. The amount can only be the reserved amount,
    -- because it is read from the row rather than supplied by the caller — which
    -- is how "a payout can never exceed its reserved amount" is guaranteed
    -- rather than validated.
    PERFORM public.ledger_append(
      _tenant_id => _p.tenant_id,
      _entry_type => 'payout_paid',
      _idempotency_key => 'payout:paid:' || _p.id::text,
      _payout_id => _p.id,
      _reserved => -_p.amount_centavos,
      _paid_out => _p.amount_centavos,
      _actor_id => _uid,
      _source => 'payout',
      _reference => btrim(_transfer_reference)
    );

  ELSIF _to_status IN ('rejected', 'failed') THEN
    UPDATE public.tenant_payouts
       SET status = _to_status,
           rejection_reason = coalesce(_reason, rejection_reason),
           admin_notes = coalesce(_notes, admin_notes),
           reviewed_by = _uid,
           reviewed_at = now()
     WHERE id = _payout_id;

    -- The reservation goes back to available. Without this the tenant's money
    -- would be stranded: not paid, and not requestable either.
    PERFORM public.ledger_append(
      _tenant_id => _p.tenant_id,
      _entry_type => 'payout_released',
      _idempotency_key => 'payout:released:' || _p.id::text,
      _payout_id => _p.id,
      _reserved => -_p.amount_centavos,
      _actor_id => _uid,
      _source => 'payout',
      _metadata => jsonb_build_object('reason', _reason, 'status', _to_status)
    );

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

  -- Tell the tenant admins what happened to their money.
  FOR _owner IN
    SELECT tm.user_id FROM public.tenant_members tm
     WHERE tm.tenant_id = _p.tenant_id AND tm.role = 'admin' AND tm.status = 'active'
  LOOP
    PERFORM public.notify_user(
      _owner, 'payout_' || _to_status,
      CASE _to_status
        WHEN 'paid'     THEN 'Payout sent'
        WHEN 'rejected' THEN 'Payout rejected'
        WHEN 'failed'   THEN 'Payout failed'
        WHEN 'approved' THEN 'Payout approved'
        WHEN 'processing' THEN 'Payout processing'
        ELSE 'Payout updated'
      END,
      'PHP ' || (_p.amount_centavos / 100.0)::text ||
      CASE WHEN _to_status = 'paid' THEN ' has been sent. Reference ' || btrim(coalesce(_transfer_reference,''))
           WHEN _to_status IN ('rejected','failed') THEN ' was not sent and is available again.'
           ELSE '' END,
      '/dashboard?section=finance');
  END LOOP;

  RETURN _to_status;
END;
$$;


-- ---------------------------------------------------------------------------
-- 10. Tenant: cancelling its own request while it is still untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenant_cancel_payout(_payout_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _uid uuid := auth.uid(); _tid uuid := public.current_tenant_id(); _p RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'Only a tenant admin may cancel a payout request';
  END IF;

  SELECT * INTO _p FROM public.tenant_payouts
   WHERE id = _payout_id AND tenant_id = _tid FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payout not found'; END IF;

  -- Once an admin has started moving money, it is no longer the tenant's to call back.
  IF _p.status NOT IN ('requested', 'under_review') THEN
    RAISE EXCEPTION 'This payout is already % and can no longer be cancelled', _p.status
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.tenant_payouts SET status = 'cancelled' WHERE id = _payout_id;

  PERFORM public.ledger_append(
    _tenant_id => _tid,
    _entry_type => 'payout_released',
    _idempotency_key => 'payout:released:' || _p.id::text,
    _payout_id => _p.id,
    _reserved => -_p.amount_centavos,
    _actor_id => _uid,
    _source => 'payout',
    _metadata => jsonb_build_object('cancelled_by_tenant', true)
  );

  INSERT INTO public.tenant_payout_events (payout_id, tenant_id, action, from_status, to_status, actor_id)
  VALUES (_p.id, _tid, 'payout.cancelled', _p.status, 'cancelled', _uid);

  RETURN 'cancelled';
END;
$$;


-- ---------------------------------------------------------------------------
-- 11. Row-level security.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_payout_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payout_account_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payout_preferences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payouts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_payout_events         ENABLE ROW LEVEL SECURITY;

-- Bank details are readable by the tenant's own ADMINS and by platform admins,
-- and by nobody else. A manager or a member of staff signed into the same
-- workspace gets no row: `is_tenant_admin()` is in the predicate, so this is
-- enforced by the database and not by which buttons the screen chooses to draw.
DROP POLICY IF EXISTS "Tenant admin reads own payout account" ON public.tenant_payout_accounts;
CREATE POLICY "Tenant admin reads own payout account"
  ON public.tenant_payout_accounts FOR SELECT TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
    OR public.is_courthub_admin()
  );

DROP POLICY IF EXISTS "Tenant admin reads own payout account history" ON public.tenant_payout_account_events;
CREATE POLICY "Tenant admin reads own payout account history"
  ON public.tenant_payout_account_events FOR SELECT TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
    OR public.is_courthub_admin()
  );

-- Preference is operational rather than sensitive, so any member of the
-- workspace may read it; only an admin may write it.
DROP POLICY IF EXISTS "Tenant reads own payout preference" ON public.tenant_payout_preferences;
CREATE POLICY "Tenant reads own payout preference"
  ON public.tenant_payout_preferences FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_courthub_admin());

DROP POLICY IF EXISTS "Tenant admin writes own payout preference" ON public.tenant_payout_preferences;
CREATE POLICY "Tenant admin writes own payout preference"
  ON public.tenant_payout_preferences FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.is_tenant_admin());

-- A payout is money, so reading one is an admin-level act on both sides.
DROP POLICY IF EXISTS "Tenant admin reads own payouts" ON public.tenant_payouts;
CREATE POLICY "Tenant admin reads own payouts"
  ON public.tenant_payouts FOR SELECT TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
    OR public.is_courthub_admin()
  );

DROP POLICY IF EXISTS "Tenant admin reads own payout events" ON public.tenant_payout_events;
CREATE POLICY "Tenant admin reads own payout events"
  ON public.tenant_payout_events FOR SELECT TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND public.is_tenant_admin())
    OR public.is_courthub_admin()
  );

-- No INSERT/UPDATE/DELETE policy anywhere above, on purpose. Every write goes
-- through the SECURITY DEFINER functions, which is the only place the balance
-- rules and the lock exist.
REVOKE ALL ON public.tenant_payout_accounts, public.tenant_payout_account_events,
              public.tenant_payout_preferences, public.tenant_payouts,
              public.tenant_payout_events
  FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_payout_accounts, public.tenant_payout_account_events,
                public.tenant_payouts, public.tenant_payout_events
  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tenant_payout_preferences TO authenticated;
GRANT ALL ON public.tenant_payout_accounts, public.tenant_payout_account_events,
             public.tenant_payout_preferences, public.tenant_payouts,
             public.tenant_payout_events
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.tenant_save_payout_account(text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.tenant_save_payout_account(text, text, text, text, text, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_request_payout(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.tenant_request_payout(bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_cancel_payout(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.tenant_cancel_payout(bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_transition_payout(bigint, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_transition_payout(bigint, text, text, text, text, text, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mask_account_number(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mask_account_number(text) TO authenticated, service_role;
