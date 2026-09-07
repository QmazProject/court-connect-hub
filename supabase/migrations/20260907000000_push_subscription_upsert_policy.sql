-- Saving a push subscription returned 403 Forbidden.
--
-- src/lib/push.ts saves with
--   .upsert({ ... }, { onConflict: "endpoint" })
-- which PostgREST issues as INSERT ... ON CONFLICT (endpoint) DO UPDATE.
-- Under RLS that statement is checked against the UPDATE policy as well as the
-- INSERT one, and push_subscriptions only had SELECT, INSERT and DELETE. A
-- browser re-subscribing returns the same endpoint, so the row already exists
-- and every returning subscriber took the DO UPDATE branch and was denied.
-- Only the very first subscribe on a given device succeeded, which is why the
-- failure looked intermittent rather than total.
--
-- Scope deliberately matches the three sibling policies: a player may only
-- touch their own rows. WITH CHECK repeats the predicate so a row cannot be
-- reassigned to another user on update.

DROP POLICY IF EXISTS "Users update own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users update own push subscriptions"
ON public.push_subscriptions FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
