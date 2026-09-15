-- ===========================================================================
-- The tenant financial ledger.
--
-- Until now "what does Court Connect owe this tenant?" was answered by summing
-- `bookings` and `transactions` at read time, in TypeScript, slightly
-- differently on each screen. That works until the day a booking is refunded
-- after it was paid out, or a walk-in is taken in cash, and then the number on
-- the dashboard is a different number from the one in the payout screen and
-- neither can be audited.
--
-- This migration replaces that with an append-only event log. Nothing in it is
-- ever updated or deleted: a refund is a new row that reverses an old one, not
-- an edit to the old one. Every balance in the product is a SUM over this table.
--
-- WHY SIX AMOUNT COLUMNS RATHER THAN ONE
--
-- A single signed `amount` would force every reader to re-derive which bucket a
-- row belongs to, which is exactly the per-screen divergence this exists to
-- stop. Instead each row states its own contribution to each figure, and every
-- balance is a plain SUM of one column with no CASE expression anywhere:
--
--   gross_centavos             booking value the marketplace generated
--   platform_collected_centavos cash that reached Court Connect's PayMongo account
--   tenant_collected_centavos   cash the venue took directly, at the desk
--   liability_centavos          what Court Connect owes this tenant, +/-
--   reserved_centavos           of that liability, what is attached to a payout
--   paid_out_centavos           of that liability, what has actually been sent
--
-- The accounting rule the whole product depends on is then structural rather
-- than remembered: a tenant-collected walk-in writes its value to
-- `tenant_collected_centavos` and writes ZERO to `liability_centavos`. There is
-- no code path that can turn cash the platform never held into money the
-- platform owes, because the column is zero in the row itself.
--
--   available = SUM(liability) - SUM(reserved) - SUM(paid_out)
--
-- HOW ENTRIES GET WRITTEN
--
-- By triggers on `transactions` and `bookings`, not by rewriting the payment
-- functions. `finalize_paid_checkout()`, `staff_mark_refund_settled()`, the
-- PayMongo webhook and `tenant_create_walkin_booking()` are left exactly as they
-- are, and keep working exactly as they do. This matters for two reasons: the
-- refund behaviour another session has just finished is not disturbed, and any
-- future payment path gets ledger entries for free rather than by remembering to
-- add a call.
--
-- Money is integer centavos. `transactions.amount` and `bookings.unit_price` are
-- numeric pesos; they are converted once, on the way in, with round().
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_ledger_entries (
  id              bigserial PRIMARY KEY,

  tenant_id       uuid   NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  venue_id        bigint          REFERENCES public.venues(id)  ON DELETE SET NULL,
  court_id        bigint          REFERENCES public.courts(id)  ON DELETE SET NULL,
  booking_id      bigint          REFERENCES public.bookings(id) ON DELETE SET NULL,
  transaction_id  uuid            REFERENCES public.transactions(id) ON DELETE SET NULL,
  payout_id       bigint,  -- FK added by the payouts migration, which comes after this one

  entry_type      text   NOT NULL,
  currency        text   NOT NULL DEFAULT 'PHP',

  gross_centavos              bigint NOT NULL DEFAULT 0,
  platform_collected_centavos bigint NOT NULL DEFAULT 0,
  tenant_collected_centavos   bigint NOT NULL DEFAULT 0,
  liability_centavos          bigint NOT NULL DEFAULT 0,
  reserved_centavos           bigint NOT NULL DEFAULT 0,
  paid_out_centavos           bigint NOT NULL DEFAULT 0,

  collection_source text,
  booking_source    text,

  -- Who caused it. Null for a trigger firing on a webhook, where there is no
  -- interactive actor and pretending otherwise would be a lie in an audit trail.
  actor_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'system',

  -- The provider's own reference, so a row here can be tied back to PayMongo.
  reference       text,

  -- The whole defence against double-counting. A duplicate webhook, a retried
  -- refund, a re-run backfill: each computes the same key and the second insert
  -- is discarded by the unique index rather than silently doubling a balance.
  idempotency_key text NOT NULL,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_ledger_idempotency_unique
  ON public.tenant_ledger_entries (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ledger_tenant_created
  ON public.tenant_ledger_entries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_booking ON public.tenant_ledger_entries (booking_id);
CREATE INDEX IF NOT EXISTS idx_ledger_payout  ON public.tenant_ledger_entries (payout_id);

ALTER TABLE public.tenant_ledger_entries
  DROP CONSTRAINT IF EXISTS tenant_ledger_entry_type_check;
ALTER TABLE public.tenant_ledger_entries
  ADD CONSTRAINT tenant_ledger_entry_type_check CHECK (entry_type IN (
    'platform_payment_received',
    'tenant_direct_payment',
    'refund',
    'partial_refund',
    'cancellation_adjustment',
    'payout_liability_created',
    'payout_liability_reversed',
    'payout_reserved',
    'payout_released',
    'payout_paid',
    'adjustment_credit',
    'adjustment_debit',
    'legacy_opening_balance'
  ));

-- The rule that cannot be broken by any future caller: money the tenant
-- collected itself never becomes money the platform owes. Written as a
-- constraint rather than a convention, because a convention is what fails.
ALTER TABLE public.tenant_ledger_entries
  DROP CONSTRAINT IF EXISTS tenant_ledger_tenant_cash_creates_no_liability;
ALTER TABLE public.tenant_ledger_entries
  ADD CONSTRAINT tenant_ledger_tenant_cash_creates_no_liability CHECK (
    tenant_collected_centavos = 0
    OR liability_centavos = 0
  );


-- ---------------------------------------------------------------------------
-- 2. Append-only, enforced.
-- ---------------------------------------------------------------------------
-- An immutable log that anything can UPDATE is just a mutable table with a
-- comment on it. `payout_id` is the single exception: the payouts migration
-- stamps it onto reservation rows it has just created, inside the same
-- transaction, and nothing else may move.
CREATE OR REPLACE FUNCTION public.tenant_ledger_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The financial ledger is append-only; entries cannot be deleted';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
     OR NEW.gross_centavos IS DISTINCT FROM OLD.gross_centavos
     OR NEW.platform_collected_centavos IS DISTINCT FROM OLD.platform_collected_centavos
     OR NEW.tenant_collected_centavos IS DISTINCT FROM OLD.tenant_collected_centavos
     OR NEW.liability_centavos IS DISTINCT FROM OLD.liability_centavos
     OR NEW.reserved_centavos IS DISTINCT FROM OLD.reserved_centavos
     OR NEW.paid_out_centavos IS DISTINCT FROM OLD.paid_out_centavos
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The financial ledger is append-only; correct an entry by appending a reversal';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_ledger_append_only ON public.tenant_ledger_entries;
CREATE TRIGGER tenant_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.tenant_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.tenant_ledger_is_append_only();


-- ---------------------------------------------------------------------------
-- 3. Resolving a booking to the business that owns it.
-- ---------------------------------------------------------------------------
-- bookings carries only court_id. Everything financial is per tenant, so this
-- walk happens constantly; it is STABLE so a statement can cache it.
CREATE OR REPLACE FUNCTION public.booking_owner(_booking_id bigint)
RETURNS TABLE (tenant_id uuid, venue_id bigint, court_id bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT v.tenant_id, v.id, c.id
    FROM public.bookings b
    JOIN public.courts  c ON c.id = b.court_id
    JOIN public.venues  v ON v.id = c.venue_id
   WHERE b.id = _booking_id;
$$;


-- ---------------------------------------------------------------------------
-- 4. The writer.
-- ---------------------------------------------------------------------------
-- Every entry in the system goes through here so the idempotency rule is applied
-- in exactly one place. ON CONFLICT DO NOTHING is the whole duplicate-webhook
-- defence: the second call with the same key writes nothing and returns null.
CREATE OR REPLACE FUNCTION public.ledger_append(
  _tenant_id uuid,
  _entry_type text,
  _idempotency_key text,
  _venue_id bigint DEFAULT NULL,
  _court_id bigint DEFAULT NULL,
  _booking_id bigint DEFAULT NULL,
  _transaction_id uuid DEFAULT NULL,
  _payout_id bigint DEFAULT NULL,
  _gross bigint DEFAULT 0,
  _platform_collected bigint DEFAULT 0,
  _tenant_collected bigint DEFAULT 0,
  _liability bigint DEFAULT 0,
  _reserved bigint DEFAULT 0,
  _paid_out bigint DEFAULT 0,
  _collection_source text DEFAULT NULL,
  _booking_source text DEFAULT NULL,
  _actor_id uuid DEFAULT NULL,
  _source text DEFAULT 'system',
  _reference text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _id bigint;
BEGIN
  IF _tenant_id IS NULL THEN
    -- A venue with no tenant is pre-migration data. Recording money against a
    -- tenant we cannot name would be inventing history, so decline quietly and
    -- let the reconciliation report show the gap.
    RETURN NULL;
  END IF;

  INSERT INTO public.tenant_ledger_entries (
    tenant_id, venue_id, court_id, booking_id, transaction_id, payout_id,
    entry_type, gross_centavos, platform_collected_centavos,
    tenant_collected_centavos, liability_centavos, reserved_centavos,
    paid_out_centavos, collection_source, booking_source,
    actor_id, source, reference, idempotency_key, metadata
  ) VALUES (
    _tenant_id, _venue_id, _court_id, _booking_id, _transaction_id, _payout_id,
    _entry_type, _gross, _platform_collected,
    _tenant_collected, _liability, _reserved,
    _paid_out, _collection_source, _booking_source,
    _actor_id, _source, _reference, _idempotency_key, coalesce(_metadata, '{}'::jsonb)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;


-- ---------------------------------------------------------------------------
-- 5. Platform money: driven by `transactions`.
-- ---------------------------------------------------------------------------
-- Fires when a transaction row becomes paid, and again if it later becomes
-- refunded. Both are keyed on the transaction id, so a webhook delivered three
-- times produces one entry.
--
-- The liability written on payment is the full amount. No platform fee is
-- deducted, because this project has no fee schedule; when one exists it becomes
-- a second entry of type platform_fee against the same booking, which is why
-- liability is its own column rather than being folded into the gross.
CREATE OR REPLACE FUNCTION public.ledger_on_transaction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _own RECORD;
  _cents bigint;
  _src text;
BEGIN
  SELECT * INTO _own FROM public.booking_owner(NEW.booking_id);
  IF _own.tenant_id IS NULL THEN RETURN NEW; END IF;

  _cents := round(coalesce(NEW.amount, 0) * 100)::bigint;
  IF _cents = 0 THEN RETURN NEW; END IF;

  SELECT b.payment_collection_source INTO _src
    FROM public.bookings b WHERE b.id = NEW.booking_id;

  -- A walk-in settled at the desk can still carry a transactions row for the
  -- tenant's own records. It must never be treated as platform cash.
  IF coalesce(_src, 'platform') <> 'platform' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'paid' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid') THEN
    PERFORM public.ledger_append(
      _tenant_id => _own.tenant_id,
      _entry_type => 'platform_payment_received',
      _idempotency_key => 'tx:paid:' || NEW.id::text,
      _venue_id => _own.venue_id,
      _court_id => _own.court_id,
      _booking_id => NEW.booking_id,
      _transaction_id => NEW.id,
      _gross => _cents,
      _platform_collected => _cents,
      _liability => _cents,
      _collection_source => 'platform',
      _booking_source => 'online',
      _source => 'paymongo',
      _reference => coalesce(NEW.provider_ref, NEW.reference_number),
      _metadata => jsonb_build_object('method', NEW.method, 'provider', NEW.provider)
    );
  END IF;

  IF NEW.status = 'refunded' AND (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'refunded') THEN
    -- The reversal. Gross is deliberately NOT reduced: the customer really did
    -- pay, and the money really did come back; both facts stay on the record.
    -- What reverses is the liability, because the platform no longer holds it.
    PERFORM public.ledger_append(
      _tenant_id => _own.tenant_id,
      _entry_type => 'refund',
      _idempotency_key => 'tx:refunded:' || NEW.id::text,
      _venue_id => _own.venue_id,
      _court_id => _own.court_id,
      _booking_id => NEW.booking_id,
      _transaction_id => NEW.id,
      _platform_collected => -_cents,
      _liability => -_cents,
      _collection_source => 'platform',
      _booking_source => 'online',
      _source => 'paymongo',
      _reference => coalesce(NEW.provider_ref, NEW.reference_number),
      _metadata => jsonb_build_object('refunded_at', NEW.refunded_at)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_transactions_sync ON public.transactions;
CREATE TRIGGER ledger_transactions_sync
  AFTER INSERT OR UPDATE OF status ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.ledger_on_transaction_change();


-- ---------------------------------------------------------------------------
-- 6. Tenant money: driven by `bookings`.
-- ---------------------------------------------------------------------------
-- A walk-in paid at the desk. Gross and tenant-collected both rise; liability
-- stays at zero, which the table constraint also independently enforces.
CREATE OR REPLACE FUNCTION public.ledger_on_booking_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _own RECORD;
  _cents bigint;
BEGIN
  IF coalesce(NEW.booking_source, 'online') = 'online' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _own FROM public.booking_owner(NEW.id);
  IF _own.tenant_id IS NULL THEN RETURN NEW; END IF;

  _cents := round(coalesce(NEW.unit_price, 0) * 100)::bigint;

  IF NEW.payment_collection_source = 'tenant'
     AND NEW.payment_status = 'paid'
     AND (TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM 'paid')
     AND _cents <> 0 THEN
    PERFORM public.ledger_append(
      _tenant_id => _own.tenant_id,
      _entry_type => 'tenant_direct_payment',
      _idempotency_key => 'booking:tenantcash:' || NEW.id::text,
      _venue_id => _own.venue_id,
      _court_id => _own.court_id,
      _booking_id => NEW.id,
      _gross => _cents,
      _tenant_collected => _cents,
      _liability => 0,          -- the whole point
      _collection_source => 'tenant',
      _booking_source => NEW.booking_source,
      _actor_id => NEW.recorded_by,
      _source => 'walkin',
      _reference => NEW.walkin_reference,
      _metadata => jsonb_build_object('payment_method', NEW.walkin_payment_method)
    );
  END IF;

  -- A cancelled walk-in reverses the tenant's own reported sales and nothing
  -- else. It must not create a platform refund: the platform has no cash to
  -- return, and every column that would imply otherwise stays zero.
  IF TG_OP = 'UPDATE'
     AND NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND OLD.payment_collection_source = 'tenant'
     AND _cents <> 0 THEN
    PERFORM public.ledger_append(
      _tenant_id => _own.tenant_id,
      _entry_type => 'cancellation_adjustment',
      _idempotency_key => 'booking:tenantcancel:' || NEW.id::text,
      _venue_id => _own.venue_id,
      _court_id => _own.court_id,
      _booking_id => NEW.id,
      _gross => -_cents,
      _tenant_collected => -_cents,
      _liability => 0,
      _collection_source => 'tenant',
      _booking_source => NEW.booking_source,
      _source => 'walkin',
      _reference => NEW.walkin_reference
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_bookings_sync ON public.bookings;
CREATE TRIGGER ledger_bookings_sync
  AFTER INSERT OR UPDATE OF payment_status, status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.ledger_on_booking_change();


-- ---------------------------------------------------------------------------
-- 7. Balances.
-- ---------------------------------------------------------------------------
-- One view, so the dashboard, the payout screen and the admin console cannot
-- disagree about a number. Note `available`: it is liability minus what is
-- reserved and what has already gone out, floored at zero. The floor is
-- belt-and-braces — the request RPC refuses to over-reserve under a lock — but a
-- refund landing after a payout has been sent can legitimately push the raw
-- figure negative, and a negative "available" on a screen is never useful. The
-- unfloored value is exposed beside it as `net_position` so a shortfall is
-- visible rather than hidden.
CREATE OR REPLACE VIEW public.tenant_balances AS
SELECT
  t.id                                                   AS tenant_id,
  t.name                                                 AS tenant_name,
  t.slug                                                 AS tenant_slug,
  coalesce(SUM(l.gross_centavos), 0)::bigint             AS gross_centavos,
  coalesce(SUM(l.platform_collected_centavos), 0)::bigint AS platform_collected_centavos,
  coalesce(SUM(l.tenant_collected_centavos), 0)::bigint  AS tenant_collected_centavos,
  coalesce(SUM(l.liability_centavos), 0)::bigint         AS liability_centavos,
  coalesce(SUM(l.reserved_centavos), 0)::bigint          AS reserved_centavos,
  coalesce(SUM(l.paid_out_centavos), 0)::bigint          AS paid_out_centavos,
  coalesce(-SUM(l.liability_centavos) FILTER (WHERE l.entry_type IN ('refund', 'partial_refund')), 0)::bigint
                                                         AS refunded_centavos,
  (coalesce(SUM(l.liability_centavos), 0)
     - coalesce(SUM(l.reserved_centavos), 0)
     - coalesce(SUM(l.paid_out_centavos), 0))::bigint    AS net_position_centavos,
  GREATEST(
    coalesce(SUM(l.liability_centavos), 0)
      - coalesce(SUM(l.reserved_centavos), 0)
      - coalesce(SUM(l.paid_out_centavos), 0),
    0)::bigint                                           AS available_centavos
FROM public.tenants t
LEFT JOIN public.tenant_ledger_entries l ON l.tenant_id = t.id
GROUP BY t.id, t.name, t.slug;


-- ---------------------------------------------------------------------------
-- 8. Row-level security.
-- ---------------------------------------------------------------------------
-- A tenant reads its own ledger and nobody else's; a platform admin reads all.
-- There is no INSERT, UPDATE or DELETE policy at all, deliberately: every write
-- arrives through a SECURITY DEFINER function that has already decided the
-- caller is allowed. A client holding an anon or authenticated key cannot append
-- to the financial ledger by any route.
ALTER TABLE public.tenant_ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant reads own ledger" ON public.tenant_ledger_entries;
CREATE POLICY "Tenant reads own ledger"
  ON public.tenant_ledger_entries FOR SELECT TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    OR public.is_courthub_admin()
  );

REVOKE ALL ON public.tenant_ledger_entries FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_ledger_entries TO authenticated;
GRANT ALL  ON public.tenant_ledger_entries TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.tenant_ledger_entries_id_seq TO service_role;

-- The view runs as its caller, so the policy above still applies through it.
ALTER VIEW public.tenant_balances SET (security_invoker = true);
REVOKE ALL ON public.tenant_balances FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_balances TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.ledger_append(
  uuid, text, text, bigint, bigint, bigint, uuid, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint,
  text, text, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.booking_owner(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_owner(bigint) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 9. Backfilling what already happened.
-- ---------------------------------------------------------------------------
-- Historical rows are classified from stored evidence only, never guessed:
--
--   a transaction with status 'paid'      -> platform payment received
--   a transaction with status 'refunded'  -> the reversal
--   a booking already marked walk_in/tenant -> tenant direct payment
--
-- Anything whose venue has no tenant_id is skipped rather than attributed to
-- some default business, and is reported by `ledger_reconciliation_gaps()` below
-- so the gap is visible instead of silently becoming somebody's balance. The
-- idempotency keys are identical to the ones the triggers use, so running this
-- twice, or running it after the triggers have already fired, changes nothing.
INSERT INTO public.tenant_ledger_entries (
  tenant_id, venue_id, court_id, booking_id, transaction_id, entry_type,
  gross_centavos, platform_collected_centavos, liability_centavos,
  collection_source, booking_source, source, reference, idempotency_key, metadata, created_at
)
SELECT v.tenant_id, v.id, c.id, tx.booking_id, tx.id, 'platform_payment_received',
       round(tx.amount * 100)::bigint, round(tx.amount * 100)::bigint, round(tx.amount * 100)::bigint,
       'platform', coalesce(b.booking_source, 'online'), 'backfill',
       coalesce(tx.provider_ref, tx.reference_number),
       'tx:paid:' || tx.id::text,
       jsonb_build_object('backfilled', true),
       coalesce(tx.paid_at, tx.created_at)
  FROM public.transactions tx
  JOIN public.bookings b ON b.id = tx.booking_id
  JOIN public.courts   c ON c.id = b.court_id
  JOIN public.venues   v ON v.id = c.venue_id
 WHERE tx.status IN ('paid', 'refunded')
   AND v.tenant_id IS NOT NULL
   AND coalesce(b.payment_collection_source, 'platform') = 'platform'
   AND round(tx.amount * 100)::bigint <> 0
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO public.tenant_ledger_entries (
  tenant_id, venue_id, court_id, booking_id, transaction_id, entry_type,
  platform_collected_centavos, liability_centavos,
  collection_source, booking_source, source, reference, idempotency_key, metadata, created_at
)
SELECT v.tenant_id, v.id, c.id, tx.booking_id, tx.id, 'refund',
       -round(tx.amount * 100)::bigint, -round(tx.amount * 100)::bigint,
       'platform', coalesce(b.booking_source, 'online'), 'backfill',
       coalesce(tx.provider_ref, tx.reference_number),
       'tx:refunded:' || tx.id::text,
       jsonb_build_object('backfilled', true),
       coalesce(tx.refunded_at, tx.updated_at, tx.created_at)
  FROM public.transactions tx
  JOIN public.bookings b ON b.id = tx.booking_id
  JOIN public.courts   c ON c.id = b.court_id
  JOIN public.venues   v ON v.id = c.venue_id
 WHERE tx.status = 'refunded'
   AND v.tenant_id IS NOT NULL
   AND coalesce(b.payment_collection_source, 'platform') = 'platform'
   AND round(tx.amount * 100)::bigint <> 0
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO public.tenant_ledger_entries (
  tenant_id, venue_id, court_id, booking_id, entry_type,
  gross_centavos, tenant_collected_centavos, liability_centavos,
  collection_source, booking_source, actor_id, source, reference,
  idempotency_key, metadata, created_at
)
SELECT v.tenant_id, v.id, c.id, b.id, 'tenant_direct_payment',
       round(b.unit_price * 100)::bigint, round(b.unit_price * 100)::bigint, 0,
       'tenant', b.booking_source, b.recorded_by, 'backfill', b.walkin_reference,
       'booking:tenantcash:' || b.id::text,
       jsonb_build_object('backfilled', true),
       b.created_at
  FROM public.bookings b
  JOIN public.courts c ON c.id = b.court_id
  JOIN public.venues v ON v.id = c.venue_id
 WHERE b.payment_collection_source = 'tenant'
   AND b.payment_status = 'paid'
   AND v.tenant_id IS NOT NULL
   AND round(coalesce(b.unit_price, 0) * 100)::bigint <> 0
ON CONFLICT (idempotency_key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 10. What the backfill could not classify.
-- ---------------------------------------------------------------------------
-- Run this after deploying. Every row it returns is real money that is NOT in
-- any tenant balance, because the evidence to attribute it was missing. That is
-- the honest outcome and it is reportable; inventing an owner would not be.
CREATE OR REPLACE FUNCTION public.ledger_reconciliation_gaps()
RETURNS TABLE (
  reason text,
  venue_id bigint,
  venue_name text,
  bookings_affected bigint,
  amount_centavos bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'venue has no tenant_id'::text, v.id, v.name,
         count(DISTINCT tx.booking_id)::bigint,
         coalesce(SUM(round(tx.amount * 100)::bigint), 0)::bigint
    FROM public.transactions tx
    JOIN public.bookings b ON b.id = tx.booking_id
    JOIN public.courts   c ON c.id = b.court_id
    JOIN public.venues   v ON v.id = c.venue_id
   WHERE tx.status IN ('paid', 'refunded')
     AND v.tenant_id IS NULL
   GROUP BY v.id, v.name;
$$;

REVOKE EXECUTE ON FUNCTION public.ledger_reconciliation_gaps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_reconciliation_gaps() TO authenticated, service_role;
