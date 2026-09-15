-- ===========================================================================
-- Down: 20260927000000_tenant_payouts
--
-- Destroys every payout record, payout account and payout audit event. If any
-- payout has been marked paid, the record of where that money went is in these
-- tables and nowhere else — export before running this.
--
-- Ledger entries are NOT removed here: they belong to the ledger migration, and
-- payout reservations recorded there would be orphaned but still correct. Run
-- the ledger rollback too if the intention is to remove both.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.admin_transition_payout(bigint, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.tenant_cancel_payout(bigint);
DROP FUNCTION IF EXISTS public.tenant_request_payout(bigint);
DROP FUNCTION IF EXISTS public.tenant_save_payout_account(text, text, text, text, text, text);

DROP TRIGGER IF EXISTS tenant_payouts_transitions ON public.tenant_payouts;
DROP FUNCTION IF EXISTS public.tenant_payouts_guard_transitions();

ALTER TABLE public.tenant_ledger_entries
  DROP CONSTRAINT IF EXISTS tenant_ledger_entries_payout_id_fkey;

DROP TABLE IF EXISTS public.tenant_payout_events;
DROP TABLE IF EXISTS public.tenant_payouts;
DROP TABLE IF EXISTS public.tenant_payout_preferences;
DROP TABLE IF EXISTS public.tenant_payout_account_events;
DROP TABLE IF EXISTS public.tenant_payout_accounts;

DROP FUNCTION IF EXISTS public.mask_account_number(text);
