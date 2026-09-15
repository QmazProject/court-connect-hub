-- ===========================================================================
-- A completed payout must not make its admin undeletable.
--
-- Found by live verification against the production project, not by any test:
-- deleting a user who had completed a payout failed with
--
--   new row for relation "tenant_payouts" violates check constraint
--   "tenant_payouts_paid_needs_reference"                        (SQLSTATE 23514)
--
-- The cause is two rules in 20260927 that contradict each other. The column says
-- losing the user must not destroy the payout:
--
--   completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
--
-- and the constraint says a paid payout must always name its actor:
--
--   status <> 'paid' OR (... AND completed_by IS NOT NULL)
--
-- So the FK nulls the column and the CHECK immediately rejects the row. The
-- delete cannot succeed, and the practical effect is that any staff member who
-- has ever marked a payout paid can never be removed from auth — which is an
-- ordinary thing to need when someone leaves the company.
--
-- The fix keeps the audit facts that cannot evaporate and drops the one that
-- can. `transfer_reference` and `completed_at` are still required, because they
-- are what prove the money left and when; they live on the payout row itself and
-- no cascade can null them. `completed_by` becomes advisory: it is still written,
-- still shown, and still in `tenant_payout_events`, which is the append-only
-- record of who did what and is not affected by this at all.
--
-- Nothing is relaxed about paying a payout. A payout still cannot be marked paid
-- without a reference, still cannot be paid twice, and still cannot exceed its
-- reservation. Only the deletability of a person changes.
-- ===========================================================================

ALTER TABLE public.tenant_payouts
  DROP CONSTRAINT IF EXISTS tenant_payouts_paid_needs_reference;

ALTER TABLE public.tenant_payouts
  ADD CONSTRAINT tenant_payouts_paid_needs_reference CHECK (
    status <> 'paid'
    OR (transfer_reference IS NOT NULL
        AND length(btrim(transfer_reference)) > 0
        AND completed_at IS NOT NULL)
  );

COMMENT ON CONSTRAINT tenant_payouts_paid_needs_reference ON public.tenant_payouts IS
  'A paid payout must carry the reference and time of the transfer. completed_by is '
  'deliberately not required: it is ON DELETE SET NULL, and requiring it made any '
  'admin who had completed a payout impossible to delete. Who acted is preserved in '
  'tenant_payout_events, which is append-only.';
