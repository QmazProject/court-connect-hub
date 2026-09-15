-- ===========================================================================
-- Down: 20260929000000_payout_proof_storage_policies
--
-- Removes the tenant-scoped policies on the payout-proofs bucket. Afterwards the
-- bucket is still private, so no object is exposed; it simply becomes unreachable
-- by any client key, and only the service role can read or write it. Existing
-- objects are not deleted.
-- ===========================================================================

DROP POLICY IF EXISTS "Tenant admin uploads own payout proof" ON storage.objects;
DROP POLICY IF EXISTS "Tenant admin replaces own payout proof" ON storage.objects;
DROP POLICY IF EXISTS "Payout proof is readable by its owner or a platform admin" ON storage.objects;
DROP POLICY IF EXISTS "Tenant admin deletes own payout proof" ON storage.objects;
