-- ===========================================================================
-- Repairing the ledger rows that manual refund settlement never closed.
--
-- Until 20260923, `staff_mark_refund_settled()` marked the booking refunded and
-- left the matching `transactions` row saying `paid`. That migration stopped it
-- happening again; this one repairs what it already left behind.
--
-- Only provably manual settlements are touched. The signature is one no other
-- path produces: a booking whose refund is settled — status, timestamp, the
-- admin who settled it, and a method, all present — sitting against a payment
-- row that still reads `paid`. The automatic and webhook refunds write the row
-- themselves, so theirs already read `refunded` and are excluded by that alone.
--
-- Every change is recorded, so the rollback can undo exactly these rows and
-- nothing else. A blanket "set refunded rows back to paid" would corrupt every
-- legitimate refund in the table.
--
-- ---------------------------------------------------------------------------
-- DRY RUN — run this first. It changes nothing and returns the exact candidates
-- this migration will repair:
--
--   SELECT count(*) AS candidates,
--          count(DISTINCT t.booking_id) AS bookings,
--          count(DISTINCT t.provider_ref) AS checkouts,
--          sum(t.amount) AS amount_to_reclassify
--     FROM public.transactions t
--     JOIN public.bookings b ON b.id = t.booking_id
--    WHERE t.status = 'paid'
--      AND b.refund_status = 'refunded'
--      AND b.refund_settled_at IS NOT NULL
--      AND b.refund_settled_by IS NOT NULL
--      AND b.refund_method IN ('manual', 'paymongo');
--
-- To see them individually, swap the count list for
--   t.id, t.booking_id, t.amount, t.provider_ref, b.refund_settled_at, b.refund_method
-- ---------------------------------------------------------------------------
--
-- What is deliberately NOT repaired:
--   * a refund still `pending` — requested, not returned;
--   * a refund that `failed` — the money never left;
--   * a booking cancelled without a refund — the venue still holds it;
--   * any row not currently `paid`, so nothing pending, failed or cancelled is
--     promoted into a refund;
--   * sibling rows of the same checkout, which are judged on their own booking.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The record of what this migration changes.
-- ---------------------------------------------------------------------------
-- Kept rather than dropped at the end: it is the only thing that makes the
-- rollback safe, and it is also the answer to "why did this row change?" months
-- from now. One row per repaired payment, holding what it said before.
CREATE TABLE IF NOT EXISTS public.refund_ledger_backfill_log (
  transaction_id       uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  booking_id           bigint NOT NULL,
  previous_status      text NOT NULL,
  previous_refunded_at timestamptz,
  new_refunded_at      timestamptz NOT NULL,
  applied_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.refund_ledger_backfill_log IS
  'One row per transaction repaired by 20260924000000. Holds the pre-repair state so the rollback can revert exactly these rows. Not written by the application.';

-- Nobody reads this from a browser. It is migration bookkeeping, and leaving it
-- readable would put refund history in front of clients for no reason.
ALTER TABLE public.refund_ledger_backfill_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.refund_ledger_backfill_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.refund_ledger_backfill_log TO service_role;


-- ---------------------------------------------------------------------------
-- 2. The repair.
-- ---------------------------------------------------------------------------
-- Safe to run twice. Candidates are chosen by the predicate above, logged with
-- `ON CONFLICT DO NOTHING`, and the update touches only rows still `paid` — so a
-- second run finds nothing left to do rather than rewriting timestamps.
DO $$
DECLARE
  _logged integer;
  _updated integer;
BEGIN
  WITH candidates AS (
    SELECT t.id AS transaction_id,
           t.booking_id,
           t.status AS previous_status,
           t.refunded_at AS previous_refunded_at,
           -- The most authoritative time available: when an admin recorded that
           -- the money had gone. Never invented, and never `now()`, which would
           -- date a refund from last month to today.
           b.refund_settled_at AS new_refunded_at
      FROM public.transactions t
      JOIN public.bookings b ON b.id = t.booking_id
     WHERE t.status = 'paid'
       AND b.refund_status = 'refunded'
       AND b.refund_settled_at IS NOT NULL
       AND b.refund_settled_by IS NOT NULL
       AND b.refund_method IN ('manual', 'paymongo')
  )
  INSERT INTO public.refund_ledger_backfill_log
    (transaction_id, booking_id, previous_status, previous_refunded_at, new_refunded_at)
  SELECT transaction_id, booking_id, previous_status, previous_refunded_at, new_refunded_at
    FROM candidates
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS _logged = ROW_COUNT;

  -- Driven off the log, so exactly what was recorded is what changes. Amount,
  -- booking_id, venue_id, user_id, provider_ref, reference_number, raw and the
  -- payment id are all left exactly as they are; only the two columns that
  -- describe the refund move.
  UPDATE public.transactions t
     SET status      = 'refunded',
         refunded_at = l.new_refunded_at
    FROM public.refund_ledger_backfill_log l
   WHERE t.id = l.transaction_id
     AND t.status = 'paid';
  GET DIAGNOSTICS _updated = ROW_COUNT;

  RAISE NOTICE 'refund ledger backfill: % candidate(s) recorded, % row(s) repaired', _logged, _updated;
END;
$$;
