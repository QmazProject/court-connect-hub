-- ===========================================================================
-- Who may read and write a payout proof.
--
-- The `payout-proofs` bucket is private, so nothing in it is reachable without a
-- signed URL. That alone is not access control: any authenticated user could ask
-- Storage to sign any path, and a signature is granted on the strength of the
-- policies below and nothing else. Without them the bucket is either unusable
-- (Storage refuses everyone) or, if someone later flips it public, wide open.
--
-- Objects are laid out one folder per tenant:
--
--   payout-proofs/<tenant_id>/<file>
--
-- so the first path segment is the tenant that owns the file, and every policy
-- here is the same sentence: you may touch this object if that segment is your
-- tenant and you are one of its admins.
--
-- Admin, deliberately, not manager or staff. This is the QR code or bank
-- screenshot that says where a business's money goes; the table that stores the
-- account number beside it is already `is_tenant_admin()` only, and a proof image
-- that leaked to the whole workspace would make that restriction pointless.
--
-- A platform admin may read, because processing a disbursement means looking at
-- the destination, but may not write: proof of where a tenant wants its money
-- sent is the tenant's claim to make.
-- ===========================================================================

-- Uploading a proof: tenant admins, into their own folder only. `upsert` in the
-- client turns into an UPDATE, so that is granted on the same terms.
DROP POLICY IF EXISTS "Tenant admin uploads own payout proof" ON storage.objects;
CREATE POLICY "Tenant admin uploads own payout proof"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payout-proofs'
    AND public.is_tenant_admin()
    AND (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

DROP POLICY IF EXISTS "Tenant admin replaces own payout proof" ON storage.objects;
CREATE POLICY "Tenant admin replaces own payout proof"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'payout-proofs'
    AND public.is_tenant_admin()
    AND (storage.foldername(name))[1] = public.current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'payout-proofs'
    AND public.is_tenant_admin()
    AND (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

-- Reading — which is also what signing a URL requires. Tenant admins see their
-- own folder; platform admins see every folder, because a disbursement cannot be
-- checked against a destination nobody is allowed to look at.
DROP POLICY IF EXISTS "Payout proof is readable by its owner or a platform admin" ON storage.objects;
CREATE POLICY "Payout proof is readable by its owner or a platform admin"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'payout-proofs'
    AND (
      public.is_courthub_admin()
      OR (
        public.is_tenant_admin()
        AND (storage.foldername(name))[1] = public.current_tenant_id()::text
      )
    )
  );

-- Deleting a superseded proof. Tenant admins only, own folder only; a platform
-- admin deliberately cannot, so evidence attached to a payout under review
-- cannot be removed by the person reviewing it.
DROP POLICY IF EXISTS "Tenant admin deletes own payout proof" ON storage.objects;
CREATE POLICY "Tenant admin deletes own payout proof"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'payout-proofs'
    AND public.is_tenant_admin()
    AND (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
