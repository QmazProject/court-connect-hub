/**
 * Whether the signed-in account is a CourtHub admin.
 *
 * The answer always comes from the database. `is_courthub_admin()` reads
 * `user_roles`, which the browser has no write grant on, so nothing the client
 * holds — state, storage, a URL parameter — can change the answer. What is stored
 * here is the *result* of asking, never the authority itself; every admin table and
 * function re-checks server-side regardless of what this returns.
 */

import { supabase } from "@/integrations/supabase/client";

export type AdminIdentity = {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
};

/**
 * Returns null when there is no session or the account holds no admin role.
 * Callers must treat null as "not an admin" — there is no third state.
 */
export async function fetchAdminIdentity(): Promise<AdminIdentity | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;

  /* Two round trips rather than trusting one flag: super admin is a strictly
     stronger claim and is asked for separately. */
  const [{ data: isAdmin, error: adminErr }, { data: isSuper }] = await Promise.all([
    supabase.rpc("is_courthub_admin"),
    supabase.rpc("is_courthub_super_admin"),
  ]);
  if (adminErr) throw adminErr;
  if (isAdmin !== true) return null;

  return {
    userId: user.id,
    email: user.email ?? null,
    isAdmin: true,
    isSuperAdmin: isSuper === true,
  };
}

/** Query options shared by the guard and the shell, so both see one answer. */
export const adminIdentityQuery = {
  queryKey: ["courthub-admin-identity"] as const,
  queryFn: fetchAdminIdentity,
  /* Short: a revoked admin should lose the console quickly, without a reload. */
  staleTime: 30_000,
  retry: false,
};
