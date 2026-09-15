-- Rollback for 20260930000000_admin_tenant_visibility_and_payout_providers.
--
-- Removes the platform-admin read policy on tenants, the provider seam
-- (attempts, provider events, provider columns, the new RPCs and the storage
-- policy), and restores `tenant_request_payout` and `admin_transition_payout`
-- exactly as 20260927 defined them.
--
-- Data note: ledger entries written by the new keys (payout:reserved:<id>:a<n>,
-- payout:released:<id>:a<n>, :r<n>, :rejected) are append-only history and are
-- NOT deleted — the ledger is never edited. Attempt rows are dropped with their
-- table; the payouts they belonged to keep their status.

DROP POLICY IF EXISTS "Platform admins read all tenants" ON public.tenants;
DROP POLICY IF EXISTS "Platform admin uploads disbursement proof" ON storage.objects;

DROP FUNCTION IF EXISTS public.payout_provider_settle(text, text, text, text, text, text, text, text, text, boolean, jsonb);
DROP FUNCTION IF EXISTS public.admin_set_payout_account_bic(bigint, text, text);
DROP FUNCTION IF EXISTS public.admin_record_manual_payout(bigint, text, text, bigint, text, text);
DROP FUNCTION IF EXISTS public.admin_mark_payout_attempt_failed(bigint, text, text, jsonb);
DROP FUNCTION IF EXISTS public.admin_mark_payout_attempt_submitted(bigint, text, text, text, text, text, text, boolean, jsonb);
DROP FUNCTION IF EXISTS public.admin_begin_payout_attempt(bigint, text);
DROP FUNCTION IF EXISTS public.admin_request_recurring_payout(uuid, bigint);
DROP FUNCTION IF EXISTS public.payout_apply_failed(bigint, bigint, text, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.payout_apply_paid(bigint, bigint, text, text, text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.payout_reserve_internal(uuid, bigint, uuid, text);
DROP FUNCTION IF EXISTS public.payout_reserved_held(bigint);

DROP TABLE IF EXISTS public.payout_provider_events;
DROP TABLE IF EXISTS public.tenant_payout_attempts;

DROP INDEX IF EXISTS public.uq_payouts_provider_transfer_id;
ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_request_type_check,
  DROP CONSTRAINT IF EXISTS tenant_payouts_provider_check,
  DROP COLUMN IF EXISTS request_type,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS provider_transfer_id,
  DROP COLUMN IF EXISTS provider_status,
  DROP COLUMN IF EXISTS provider_error_code,
  DROP COLUMN IF EXISTS provider_error_message,
  DROP COLUMN IF EXISTS provider_submitted_at,
  DROP COLUMN IF EXISTS paid_amount_centavos;

ALTER TABLE public.tenant_payout_accounts
  DROP COLUMN IF EXISTS paymongo_bic,
  DROP COLUMN IF EXISTS paymongo_institution_name;

-- Original definitions from 20260927000000_tenant_payouts.sql, verbatim.
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
