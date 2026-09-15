/**
 * Admin → Tenants.
 *
 * The marketplace from the platform's side: what each business sold, and what
 * Court Connect is actually holding for it. The two columns that matter most sit
 * next to each other on purpose — "Gross sales" and "Available" — because the
 * whole point of the ledger is that they are different numbers, and an admin
 * looking at a tenant owed ₱12,500 out of ₱400,000 of trade should be able to
 * see why at a glance.
 *
 * Every figure is read from `tenant_balances`, the same view the tenant's own
 * Finance screen reads. Deliberately not a second query with its own arithmetic:
 * an admin and a tenant disagreeing about a balance is the bug this prevents.
 *
 * Why this page was empty before: `tenant_balances` is security_invoker over
 * `public.tenants`, and until migration 20260930 that table had no policy
 * letting a platform admin read it. The fix is that policy, not anything here.
 *
 * Beside the balances: how many venues, the payout schedule the tenant chose,
 * whether it is due, and any payout already open — the facts an admin needs
 * before deciding to send money, read from tables an admin is allowed to read
 * and joined by `adminListTenantOverview`.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { adminListTenantOverview, type TenantOverviewRow } from "@/lib/payouts.functions";
import { balanceFromRow, pesoFromCentavos } from "@/lib/ledger";
import { PAYOUT_FREQUENCIES, PAYOUT_STATUS_LABEL, type PayoutStatus } from "@/lib/payouts";

export const Route = createFileRoute("/admin/tenants")({
  ssr: false,
  component: AdminTenants,
});

type Filter = "all" | "due" | "open" | "holding";

function AdminTenants() {
  const listFn = useServerFn(adminListTenantOverview);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const overviewQ = useQuery({
    queryKey: ["admin-tenant-overview"],
    queryFn: () => listFn({}),
  });

  const all = useMemo(() => (overviewQ.data ?? []) as TenantOverviewRow[], [overviewQ.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (needle) {
        const hit =
          (r.tenant_name ?? "").toLowerCase().includes(needle) ||
          (r.tenant_slug ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      if (filter === "due") return r.recurring.due;
      if (filter === "open") return !!r.open_payout;
      if (filter === "holding") return balanceFromRow(r).availableCentavos > 0;
      return true;
    });
  }, [all, q, filter]);

  /* Platform-wide totals. A sum of the same rows shown below, so the header and
     the table can never tell different stories. */
  const totals = useMemo(() => {
    let gross = 0;
    let platform = 0;
    let tenant = 0;
    let available = 0;
    let reserved = 0;
    let paidOut = 0;
    for (const r of rows) {
      const b = balanceFromRow(r);
      gross += b.grossCentavos;
      platform += b.platformCollectedCentavos;
      tenant += b.tenantCollectedCentavos;
      available += b.availableCentavos;
      reserved += b.reservedCentavos;
      paidOut += b.paidOutCentavos;
    }
    return { gross, platform, tenant, available, reserved, paidOut };
  }, [rows]);

  const dueCount = all.filter((r) => r.recurring.due).length;
  const openCount = all.filter((r) => r.open_payout).length;

  return (
    <div className="space-y-5 px-5 py-6 sm:px-8">
      <div>
        <h1 className="font-display text-xl font-semibold">Tenants</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What each business sold, what the platform is holding for it, and when it is next paid.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Gross sales" value={pesoFromCentavos(totals.gross)} />
        <Kpi label="Platform collected" value={pesoFromCentavos(totals.platform)} />
        <Kpi label="Tenant collected" value={pesoFromCentavos(totals.tenant)} />
        <Kpi label="Available" value={pesoFromCentavos(totals.available)} strong />
        <Kpi label="Reserved" value={pesoFromCentavos(totals.reserved)} />
        <Kpi label="Paid out" value={pesoFromCentavos(totals.paidOut)} />
      </div>

      <p className="rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
        Platform liability is {pesoFromCentavos(totals.available + totals.reserved)} — the available
        plus reserved columns only. The {pesoFromCentavos(totals.tenant)} tenants collected at their
        own venues is real trade the marketplace generated, and is not money Court Connect owes
        anybody.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tenants…"
          className="w-full max-w-xs rounded-xl border border-border bg-background px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", `All (${all.length})`],
              ["due", `Due now (${dueCount})`],
              ["open", `Payout open (${openCount})`],
              ["holding", "Holding a balance"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-lg px-3 py-1.5 text-xs ${
                filter === key ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="nice-scroll max-h-[60vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-3 py-2 text-right">Venues</th>
                <th className="px-3 py-2 text-right">Gross sales</th>
                <th className="px-3 py-2 text-right">Platform</th>
                <th className="px-3 py-2 text-right">Tenant cash</th>
                <th className="px-3 py-2 text-right">Available</th>
                <th className="px-3 py-2 text-right">Reserved</th>
                <th className="px-3 py-2 text-right">Paid out</th>
                <th className="px-3 py-2">Schedule</th>
                <th className="px-3 py-2">Next due</th>
                <th className="px-3 py-2">Pending payout</th>
              </tr>
            </thead>
            <tbody>
              {overviewQ.isLoading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : overviewQ.error ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-destructive">
                    {(overviewQ.error as Error).message}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">
                    {all.length === 0
                      ? "No tenants are visible. If businesses exist, the platform-admin read policy on public.tenants (migration 20260930) has not been applied."
                      : "No tenants match."}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const b = balanceFromRow(r);
                  const freq =
                    PAYOUT_FREQUENCIES.find((f) => f.value === r.frequency)?.label ?? r.frequency;
                  return (
                    <tr key={r.tenant_id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <Link
                          to="/admin/tenants/$tenantId"
                          params={{ tenantId: r.tenant_id }}
                          className="font-medium hover:underline"
                        >
                          {r.tenant_name ?? "Unnamed business"}
                        </Link>
                        <p className="text-[11px] text-muted-foreground">{r.tenant_slug}</p>
                      </td>
                      <td className="px-3 py-3 text-right">{r.venue_count}</td>
                      <td className="px-3 py-3 text-right">{pesoFromCentavos(b.grossCentavos)}</td>
                      <td className="px-3 py-3 text-right">
                        {pesoFromCentavos(b.platformCollectedCentavos)}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {pesoFromCentavos(b.tenantCollectedCentavos)}
                      </td>
                      <td className="px-3 py-3 text-right font-medium">
                        {pesoFromCentavos(b.availableCentavos)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {pesoFromCentavos(b.reservedCentavos)}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground">
                        {pesoFromCentavos(b.paidOutCentavos)}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {freq}
                        {!r.has_account && (
                          <p className="text-[11px] text-amber-700">No payout account</p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {r.recurring.due ? (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                            Due now
                          </span>
                        ) : r.recurring.nextDueAt ? (
                          <span title={r.recurring.reason}>
                            {new Date(r.recurring.nextDueAt).toLocaleDateString("en-PH", {
                              dateStyle: "medium",
                            })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title={r.recurring.reason}>
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {r.open_payout ? (
                          <Link
                            to="/admin/disbursements"
                            className="hover:underline"
                            title={`Payout #${r.open_payout.id}`}
                          >
                            #{r.open_payout.id} ·{" "}
                            {PAYOUT_STATUS_LABEL[r.open_payout.status as PayoutStatus] ??
                              r.open_payout.status}{" "}
                            · {pesoFromCentavos(r.open_payout.amount_centavos)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`rounded-2xl border p-3 ${
        strong ? "border-primary/40 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-display text-base font-semibold">{value}</p>
    </div>
  );
}
