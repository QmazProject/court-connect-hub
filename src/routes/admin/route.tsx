/**
 * The guarded /admin layout and its shell.
 *
 * `beforeLoad` asks the database, not local state, and redirects when the answer is
 * no. That guard is a convenience: every table and function behind it re-checks
 * authority server-side, so reaching this route by any other means still returns
 * nothing. Nav links render only after authority resolves, so no admin chrome
 * flashes for a player.
 */

import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { LogOut, MessageSquareWarning, ScrollText, ShieldCheck, Tags } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
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
    return { admin: identity };
  },
  component: AdminShell,
});

const NAV = [
  { to: "/admin", label: "Overview", icon: ShieldCheck, exact: true },
  { to: "/admin/assistant-insights", label: "Assistant Insights", icon: MessageSquareWarning },
  { to: "/admin/assistant-mappings", label: "Assistant Mappings", icon: Tags },
] as const;

function AdminShell() {
  const { admin } = Route.useRouteContext();
  const navigate = useNavigate();

  const signOut = async () => {
    await supabase.auth.signOut();
    await navigate({ to: "/admin/login" });
  };

  return (
    <div className="flex min-h-dvh w-full bg-background">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex items-center gap-2 border-b border-border px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-popover">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-bold text-foreground">
              CourtHub Admin
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {admin.isSuperAdmin ? "Super admin" : "Admin"}
            </p>
          </div>
        </div>
        <nav className="flex-1 p-2">
          <ul className="space-y-1">
            {NAV.map(({ to, label, icon: Icon, ...rest }) => (
              <li key={to}>
                <Link
                  to={to}
                  activeOptions={{ exact: "exact" in rest }}
                  activeProps={{ className: "bg-foreground text-popover" }}
                  inactiveProps={{
                    className: "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition"
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                to="/admin"
                search={{ view: "audit" } as never}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <ScrollText className="h-4 w-4 shrink-0" />
                Audit log
              </Link>
            </li>
          </ul>
        </nav>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
