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
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { adminListTenantBalances } from "@/lib/payouts.functions";
import { balanceFromRow, pesoFromCentavos, type TenantBalanceRow } from "@/lib/ledger";

export const Route = createFileRoute("/admin/tenants")({
  ssr: false,
  component: AdminTenants,
});

function AdminTenants() {
  const listFn = useServerFn(adminListTenantBalances);
  const [q, setQ] = useState("");

  const balancesQ = useQuery({
    queryKey: ["admin-tenant-balances"],
    queryFn: () => listFn({}),
  });

  const rows = useMemo(() => {
    const all = (balancesQ.data ?? []) as TenantBalanceRow[];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        (r.tenant_name ?? "").toLowerCase().includes(needle) ||
        (r.tenant_slug ?? "").toLowerCase().includes(needle),
    );
  }, [balancesQ.data, q]);

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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold">Tenants</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What each business sold, and what the platform is holding for it.
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

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search tenants…"
        className="w-full max-w-xs rounded-xl border border-border bg-background px-3 py-2 text-sm"
      />

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="nice-scroll max-h-[60vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2 text-right">Gross sales</th>
                <th className="px-4 py-2 text-right">Platform</th>
                <th className="px-4 py-2 text-right">Tenant cash</th>
                <th className="px-4 py-2 text-right">Refunded</th>
                <th className="px-4 py-2 text-right">Available</th>
                <th className="px-4 py-2 text-right">Reserved</th>
                <th className="px-4 py-2 text-right">Paid out</th>
              </tr>
            </thead>
            <tbody>
              {balancesQ.isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : balancesQ.error ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-destructive">
                    {(balancesQ.error as Error).message}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    No tenants match.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const b = balanceFromRow(r);
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
                      <td className="px-4 py-3 text-right">{pesoFromCentavos(b.grossCentavos)}</td>
                      <td className="px-4 py-3 text-right">
                        {pesoFromCentavos(b.platformCollectedCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {pesoFromCentavos(b.tenantCollectedCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {pesoFromCentavos(b.refundedCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {pesoFromCentavos(b.availableCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {pesoFromCentavos(b.reservedCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {pesoFromCentavos(b.paidOutCentavos)}
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
