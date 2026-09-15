-- ===========================================================================
-- Down: 20260928000000_payout_completed_by_optional
--
-- Restores the 20260927 constraint exactly, including `completed_by IS NOT NULL`.
--
-- Be aware this reintroduces the defect it was written to fix: after running it,
-- deleting any user who has completed a payout fails with SQLSTATE 23514. It will
-- also fail outright if any paid payout currently has a null `completed_by`
-- (because its admin was deleted while the fix was in place) — those rows must be
-- given an actor, or left alone, before this can be applied.
-- ===========================================================================

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
