-- ===========================================================================
-- Down: 20260926000000_tenant_financial_ledger
--
-- Removes the ledger and the triggers that feed it. Balances revert to being
-- whatever the screens compute from bookings and transactions.
--
-- The ledger is rebuildable: its backfill derives entries from `transactions`
-- and `bookings`, which this does not touch, so re-applying the up migration
-- reconstructs everything except manual adjustments, which exist only here.
-- Export `tenant_ledger_entries` first if any adjustment_credit or
-- adjustment_debit row has been written.
--
-- Run the payouts rollback BEFORE this one: its tables reference this table.
-- ===========================================================================

DROP TRIGGER IF EXISTS ledger_transactions_sync ON public.transactions;
DROP TRIGGER IF EXISTS ledger_bookings_sync     ON public.bookings;
DROP FUNCTION IF EXISTS public.ledger_on_transaction_change();
DROP FUNCTION IF EXISTS public.ledger_on_booking_change();

DROP VIEW IF EXISTS public.tenant_balances;

DROP FUNCTION IF EXISTS public.ledger_reconciliation_gaps();
DROP FUNCTION IF EXISTS public.ledger_append(
  uuid, text, text, bigint, bigint, bigint, uuid, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint,
  text, text, uuid, text, text, jsonb
);
DROP FUNCTION IF EXISTS public.booking_owner(bigint);

DROP TRIGGER IF EXISTS tenant_ledger_append_only ON public.tenant_ledger_entries;
DROP FUNCTION IF EXISTS public.tenant_ledger_is_append_only();

DROP TABLE IF EXISTS public.tenant_ledger_entries;
