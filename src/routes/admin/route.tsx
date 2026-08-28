/**
 * The guarded /admin layout.
 *
 * `beforeLoad` asks the database, not local state, and redirects to the admin login
 * when the answer is no. That guard is a convenience, not the security boundary:
 * every table and function behind it re-checks authority server-side, so a player
 * who reaches this route by any means still gets nothing back.
 */

import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { fetchAdminIdentity } from "@/lib/admin";

export const Route = createFileRoute("/admin")({
  ssr: false,
  beforeLoad: async () => {
    let identity = null;
    try {
      identity = await fetchAdminIdentity();
    } catch {
      /* A failed check is not an admin. Never fall open. */
      identity = null;
    }
    if (!identity) throw redirect({ to: "/admin/login" });
    /* Available to child routes, so the shell renders nothing before authority is
       resolved and there is no admin UI flash. */
    return { admin: identity };
  },
  component: () => <Outlet />,
});
