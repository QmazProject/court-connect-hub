-- Creating a venue requires being an active admin of the workspace it goes into.
--
-- "Tenants can insert venues" has asked one question since the first migration:
-- `is_tenant(auth.uid())` — does `profiles.role` say 'tenant'? That was the whole of
-- tenancy once. It is not any more. Every invited member is created with that role,
-- so a Staff account, or a Manager, or an invitation that was never accepted, could
-- create a venue; and the row's `tenant_id` was whatever the client sent, filled in
-- from membership only when the client sent nothing.
--
-- Two changes, one policy. Who may insert: an active admin — `is_tenant_admin()`,
-- the same function every tenant-level policy already reads. Where it may go: the
-- inserting admin's own tenant, checked as `tenant_id = current_tenant_id()`. The
-- client never has to know its tenant id: `venues_set_booking_prefix` runs BEFORE
-- INSERT and fills a NULL `tenant_id` from that same membership, and Postgres
-- evaluates WITH CHECK against the row *after* BEFORE triggers — so an honest insert
-- arrives already carrying the right id, and a supplied foreign one is refused by
-- the equality rather than quietly rewritten.
--
-- The no-membership fallback that was floated for founders is not here, on purpose.
-- `ensure_tenant_workspace()` gives a founder an active admin membership on their
-- first dashboard load, and the dashboard is the only place a venue can be created:
-- the app has exactly one insert, no SQL function writes this table, and no server
-- or service-role flow does either. A fallback would reopen the very path this
-- closes, for a case the bootstrap already handles.
--
-- Untouched: `venues_assign_owner`, `venues_grant_team_access`,
-- `venues_set_booking_prefix`, `venues_audit_ins`, every SELECT/UPDATE/DELETE policy
-- on venues (Stage 3), every player and public policy, and every existing row.

-- ---------------------------------------------------------------------------
-- 1. Refuse to proceed if live data already contradicts the rule.
-- ---------------------------------------------------------------------------
-- A venue with no tenant, a venue whose tenant has no active admin, or a venue whose
-- owner is not an admin of its own tenant would each mean the assumption behind this
-- policy is already false for a real business. None of that is corrected here — only
-- named — and the raise leaves the whole migration unapplied.
DO $$
DECLARE
  _no_tenant int;
  _no_admin int;
  _owner_mismatch int;
  _detail text;
BEGIN
  SELECT count(*) INTO _no_tenant FROM public.venues v WHERE v.tenant_id IS NULL;

  SELECT count(*) INTO _no_admin
    FROM public.venues v
   WHERE v.tenant_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_members tm
        WHERE tm.tenant_id = v.tenant_id AND tm.role = 'admin' AND tm.status = 'active'
     );

  SELECT count(*) INTO _owner_mismatch
    FROM public.venues v
    JOIN public.staff s ON s.venue_id = v.id AND s.role = 'owner'
   WHERE NOT EXISTS (
       SELECT 1 FROM public.tenant_members tm
        WHERE tm.user_id = s.user_id
          AND tm.tenant_id = v.tenant_id
          AND tm.role = 'admin' AND tm.status = 'active'
     );

  IF _no_tenant > 0 OR _no_admin > 0 OR _owner_mismatch > 0 THEN
    SELECT string_agg(format('venue %s "%s" (tenant %s)', v.id, v.name, coalesce(v.tenant_id::text, 'NULL')), '; ' ORDER BY v.id)
      INTO _detail
      FROM public.venues v
     WHERE v.tenant_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.tenant_members tm
                        WHERE tm.tenant_id = v.tenant_id AND tm.role = 'admin' AND tm.status = 'active')
        OR EXISTS (SELECT 1 FROM public.staff s WHERE s.venue_id = v.id AND s.role = 'owner'
                      AND NOT EXISTS (SELECT 1 FROM public.tenant_members tm
                                       WHERE tm.user_id = s.user_id AND tm.tenant_id = v.tenant_id
                                         AND tm.role = 'admin' AND tm.status = 'active'));
    RAISE EXCEPTION
      'Cannot restrict venue creation: % venue(s) without a tenant, % whose tenant has no active admin, % whose owner is not an admin of their tenant. Review before re-running: %',
      _no_tenant, _no_admin, _owner_mismatch, _detail
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Tenants can insert venues" ON public.venues;
CREATE POLICY "Admins can insert venues in their tenant"
  ON public.venues FOR INSERT TO authenticated
  WITH CHECK (
    public.is_tenant_admin()
    AND tenant_id IS NOT NULL
    AND tenant_id = public.current_tenant_id()
  );
