-- ===========================================================================
-- Rollback for 20260924000000_backfill_manual_refund_ledger.sql
--
-- Reverts exactly the rows that migration repaired, and no others.
--
-- This is why the log table exists. A rollback written as "set every refunded
-- transaction back to paid" would destroy every genuine refund in the ledger —
-- the automatic ones, the webhook ones, and every manual settlement recorded
-- after 20260923 — turning money the business returned back into income it
-- appears to hold. Nothing here touches a row the backfill did not change.
--
-- Two guards beyond the id match, so a row that legitimately moved on after the
-- backfill is left alone:
--   * it must still be `refunded` — if something set it otherwise, that is a
--     later decision and not this migration's to undo;
--   * its `refunded_at` must still be the value the backfill wrote — a refund
--     re-settled since then carries a different timestamp and is skipped.
--
-- Bookings are not touched at all. They were already correct: the booking said
-- refunded before the backfill ran, and it says refunded after this.
-- ===========================================================================

DO $$
DECLARE
  _reverted integer;
  _skipped integer;
BEGIN
  UPDATE public.transactions t
     SET status      = l.previous_status,
         refunded_at = l.previous_refunded_at
    FROM public.refund_ledger_backfill_log l
   WHERE t.id = l.transaction_id
     AND t.status = 'refunded'
     AND t.refunded_at IS NOT DISTINCT FROM l.new_refunded_at;
  GET DIAGNOSTICS _reverted = ROW_COUNT;

  SELECT count(*) - _reverted INTO _skipped FROM public.refund_ledger_backfill_log;

  RAISE NOTICE 'refund ledger backfill rolled back: % row(s) reverted, % left alone because they changed after the backfill', _reverted, _skipped;
END;
$$;

DROP TABLE IF EXISTS public.refund_ledger_backfill_log;
