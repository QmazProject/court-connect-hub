/**
 * CourtHub Admin.
 *
 * Everything shown here is read from a table the database only lets an admin read.
 * There are no invented metrics: each number is a count of rows that exist.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LogOut, ScrollText, ShieldCheck, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Route as AdminRoute } from "./route";

export const Route = createFileRoute("/admin/")({
  ssr: false,
  component: AdminHome,
});

type Section = "overview" | "accounts" | "audit";

function AdminHome() {
  const { admin } = AdminRoute.useRouteContext();
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>("overview");

  const auditQ = useQuery({
    queryKey: ["admin-audit", section],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("admin_audit_log")
        .select("id, actor_id, action, target_type, target_id, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const adminsQ = useQuery({
    queryKey: ["admin-accounts"],
    enabled: admin.isSuperAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_courthub_admins");
      if (error) throw error;
      return data ?? [];
    },
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    await navigate({ to: "/admin/login" });
  };

  const nav: { key: Section; label: string; icon: typeof Users }[] = [
    { key: "overview", label: "Overview", icon: ShieldCheck },
    { key: "accounts", label: "Admin accounts", icon: Users },
    { key: "audit", label: "Audit log", icon: ScrollText },
  ];

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
            {nav.map(({ key, label, icon: Icon }) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setSection(key)}
                  className={
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition " +
                    (section === key
                      ? "bg-foreground text-popover"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground")
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              </li>
            ))}
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

      <main className="min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-4xl">
          {section === "overview" && (
            <>
              <h1 className="font-display text-2xl font-semibold text-foreground">Overview</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Signed in as {admin.email ?? "an admin"}.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Stat
                  label="Recent admin actions"
                  value={auditQ.isLoading ? "…" : String(auditQ.data?.length ?? 0)}
                  hint="last 50 recorded"
                />
                <Stat
                  label="Admin accounts"
                  value={
                    !admin.isSuperAdmin
                      ? "—"
                      : adminsQ.isLoading
                        ? "…"
                        : String(adminsQ.data?.length ?? 0)
                  }
                  hint={admin.isSuperAdmin ? "including revoked" : "super admin only"}
                />
              </div>
              <p className="mt-5 text-xs text-muted-foreground">
                Assistant Insights arrives with the next migration. Nothing is shown here that is
                not a count of rows that exist.
              </p>
            </>
          )}

          {section === "accounts" && (
            <>
              <h1 className="font-display text-2xl font-semibold text-foreground">
                Admin accounts
              </h1>
              {!admin.isSuperAdmin ? (
                <p className="mt-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                  Only a super admin can view admin accounts. The database refuses this list to
                  everyone else, so there is nothing to show.
                </p>
              ) : adminsQ.isLoading ? (
                <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {(adminsQ.data ?? []).map((a) => (
                    <li
                      key={`${a.user_id}-${a.role}`}
                      className="rounded-lg border border-border bg-card px-4 py-3"
                    >
                      <p className="text-sm font-semibold text-foreground">
                        {a.full_name || a.email}
                      </p>
                      <p className="text-xs text-muted-foreground">{a.email}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {a.role} · granted {new Date(a.granted_at).toLocaleDateString("en-PH")}
                        {a.revoked_at ? " · revoked" : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {section === "audit" && (
            <>
              <h1 className="font-display text-2xl font-semibold text-foreground">Audit log</h1>
              {auditQ.isLoading ? (
                <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
              ) : (auditQ.data ?? []).length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Nothing recorded yet. Entries appear when an admin role is granted or revoked.
                </p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {(auditQ.data ?? []).map((row) => (
                    <li key={row.id} className="rounded-lg border border-border bg-card px-4 py-3">
                      <p className="text-sm font-semibold text-foreground">{row.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.target_type ? `${row.target_type} ${row.target_id ?? ""}` : "—"}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {new Date(row.created_at).toLocaleString("en-PH")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
