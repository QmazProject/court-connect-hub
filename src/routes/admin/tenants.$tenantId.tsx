/**
 * Admin → Tenants → one tenant.
 *
 * The page an admin opens before deciding whether to send a business money. Its
 * job is to make that decision answerable from one screen: what the business
 * sold, how much of it Court Connect actually holds, where the money would go,
 * and everything that has already been done to it.
 *
 * Every figure is read through `adminGetTenantDetail`, which reads the same
 * `tenant_balances` view the tenant's own Finance page reads. No accounting is
 * recomputed here — an admin and a tenant seeing different balances for the same
 * business is precisely the failure the ledger exists to prevent, and it would
 * be reintroduced the moment this page did its own arithmetic.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2 } from "lucide-react";
import { adminGetTenantDetail, adminGetPayoutEvents } from "@/lib/payouts.functions";
import { pesoFromCentavos } from "@/lib/ledger";
import {
  PAYOUT_ACCOUNT_TYPES,
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  describeDestination,
  maskAccountNumber,
  type PayoutDestinationSnapshot,
  type PayoutStatus,
} from "@/lib/payouts";

export const Route = createFileRoute("/admin/tenants/$tenantId")({
  ssr: false,
  component: TenantDetail,
});

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-secondary text-foreground",
  info: "bg-sky-500/15 text-sky-700",
  success: "bg-primary/15 text-primary",
  danger: "bg-destructive/15 text-destructive",
};

type Tab = "overview" | "transactions" | "venues" | "payouts" | "account" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "transactions", label: "Transactions" },
  { key: "venues", label: "Venues" },
  { key: "payouts", label: "Payouts" },
  { key: "account", label: "Payout account" },
  { key: "audit", label: "Audit history" },
];

function TenantDetail() {
  const { tenantId } = Route.useParams();
  const detailFn = useServerFn(adminGetTenantDetail);
  const eventsFn = useServerFn(adminGetPayoutEvents);
  const [tab, setTab] = useState<Tab>("overview");

  const q = useQuery({
    queryKey: ["admin-tenant-detail", tenantId],
    queryFn: () => detailFn({ data: { tenantId } }),
  });

  const eventsQ = useQuery({
    queryKey: ["admin-tenant-payout-events", tenantId],
    queryFn: () => eventsFn({ data: { tenantId } }),
    enabled: tab === "audit",
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading tenant…
      </div>
    );
  }
  if (q.error) {
    return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  }

  const d = q.data!;
  const b = d.balance;

  if (!d.tenant) {
    /* Either it does not exist or the caller may not see it. Saying which would
       leak the existence of a business to someone with no right to know. */
    return (
      <div className="space-y-3">
        <BackLink />
        <p className="rounded-2xl border border-border bg-card p-5 text-sm">
          No tenant available at this address.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <BackLink />

      <div>
        <h1 className="font-display text-xl font-semibold">
          {d.tenant.name ?? "Unnamed business"}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {d.tenant.slug} · registered{" "}
          {new Date(d.tenant.created_at).toLocaleDateString("en-PH", { dateStyle: "medium" })}
        </p>
      </div>

      {/* The one sentence this page exists to make unmissable. */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Gross sales" value={pesoFromCentavos(b.grossCentavos)} />
        <Kpi label="Platform collected" value={pesoFromCentavos(b.platformCollectedCentavos)} />
        <Kpi label="Tenant collected" value={pesoFromCentavos(b.tenantCollectedCentavos)} />
        <Kpi label="Available" value={pesoFromCentavos(b.availableCentavos)} strong />
        <Kpi label="Reserved" value={pesoFromCentavos(b.reservedCentavos)} />
        <Kpi label="Paid out" value={pesoFromCentavos(b.paidOutCentavos)} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-xs ${
              tab === t.key ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-3">
          <Panel title="What Court Connect owes this business">
            <p className="text-sm">
              Of {pesoFromCentavos(b.grossCentavos)} in booking value, the platform collected{" "}
              {pesoFromCentavos(b.platformCollectedCentavos)} and currently holds{" "}
              <strong>{pesoFromCentavos(b.availableCentavos + b.reservedCentavos)}</strong> for this
              tenant.
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {pesoFromCentavos(b.tenantCollectedCentavos)} was collected by the venue itself and is
              not a platform liability. {pesoFromCentavos(b.refundedCentavos)} has been refunded to
              players.
            </p>
            {b.netPositionCentavos < 0 && (
              <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                Refunds settled after a payout was sent leave{" "}
                {pesoFromCentavos(-b.netPositionCentavos)} owed back by this tenant.
              </p>
            )}
          </Panel>
          <Panel title="Payout destination">
            {d.account ? (
              <p className="text-sm">
                {PAYOUT_ACCOUNT_TYPES.find((t) => t.value === d.account!.account_type)?.label ??
                  d.account.account_type}
                {d.account.bank_name ? ` · ${d.account.bank_name}` : ""} · {d.account.account_name}{" "}
                ·{" "}
                <span className="font-mono">
                  {maskAccountNumber(d.account.account_number) ?? "—"}
                </span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No payout account configured. This tenant cannot request a payout yet.
              </p>
            )}
          </Panel>
        </div>
      )}

      {tab === "transactions" && (
        <Table
          head={["When", "Type", "Gross", "Platform", "Tenant cash", "Liability", "Reference"]}
          empty="No ledger entries for this tenant."
          rows={d.ledger.map((e) => [
            new Date(e.created_at).toLocaleString("en-PH", {
              dateStyle: "medium",
              timeStyle: "short",
            }),
            e.entry_type,
            pesoFromCentavos(e.gross_centavos),
            pesoFromCentavos(e.platform_collected_centavos),
            pesoFromCentavos(e.tenant_collected_centavos),
            pesoFromCentavos(e.liability_centavos),
            e.reference ?? "—",
          ])}
        />
      )}

      {tab === "venues" && (
        <Table
          head={["Venue", "Status"]}
          empty="This tenant has no venues."
          rows={d.venues.map((v) => [v.name, v.is_active === false ? "Inactive" : "Active"])}
        />
      )}

      {tab === "payouts" && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Payout</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Destination</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Reference</th>
              </tr>
            </thead>
            <tbody>
              {d.payouts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No payouts requested yet.
                  </td>
                </tr>
              ) : (
                d.payouts.map((p) => {
                  const status = p.status as PayoutStatus;
                  return (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-4 py-3 font-mono text-xs">#{p.id}</td>
                      <td className="px-4 py-3 font-medium">
                        {pesoFromCentavos(p.amount_centavos)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {describeDestination(
                          p.destination_snapshot as PayoutDestinationSnapshot | null,
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            TONE_CLASS[PAYOUT_STATUS_TONE[status] ?? "neutral"]
                          }`}
                        >
                          {PAYOUT_STATUS_LABEL[status] ?? p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{p.transfer_reference ?? "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "account" && (
        <div className="space-y-3">
          <Panel title="Current destination">
            {d.account ? (
              <dl className="space-y-1.5 text-sm">
                <Row term="Type" value={d.account.account_type} />
                <Row term="Account name" value={d.account.account_name} />
                <Row
                  term="Account"
                  value={maskAccountNumber(d.account.account_number) ?? "—"}
                  mono
                />
                {d.account.bank_name && <Row term="Bank" value={d.account.bank_name} />}
                <Row term="Verification" value={d.account.status} />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No payout account configured.</p>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Account numbers are shown masked here. A payout that has already been requested keeps
              its own frozen copy of the destination, so a change made now cannot redirect money
              already in flight.
            </p>
          </Panel>

          <Table
            head={["When", "Action", "Was", "Now"]}
            empty="No changes recorded to this tenant's payout destination."
            rows={d.accountEvents.map((e) => [
              new Date(e.created_at).toLocaleString("en-PH", {
                dateStyle: "medium",
                timeStyle: "short",
              }),
              e.action,
              summariseDestination(e.old_value),
              summariseDestination(e.new_value),
            ])}
          />
        </div>
      )}

      {tab === "audit" && (
        <Table
          head={["When", "Action", "From", "To"]}
          empty="No payout lifecycle events yet."
          loading={eventsQ.isLoading}
          rows={(eventsQ.data ?? []).map((e) => [
            new Date(e.created_at).toLocaleString("en-PH", {
              dateStyle: "medium",
              timeStyle: "short",
            }),
            e.action,
            e.from_status ?? "—",
            e.to_status ?? "—",
          ])}
        />
      )}
    </div>
  );
}

/** Account details in an audit row are already masked when they are written, so
 *  this only has to read them back — it never sees a full number. */
function summariseDestination(v: unknown): string {
  if (!v || typeof v !== "object") return "—";
  const o = v as Record<string, unknown>;
  const parts = [o.account_type, o.bank_name, o.account_name, o.account_number]
    .filter((x) => typeof x === "string" && x)
    .join(" · ");
  return parts || "—";
}

function BackLink() {
  return (
    <Link
      to="/admin/tenants"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> All tenants
    </Link>
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className={mono ? "font-mono" : ""}>{value}</dd>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
  loading,
}: {
  head: string[];
  rows: (string | number)[][];
  empty: string;
  loading?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="nice-scroll max-h-[55vh] overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/50 text-xs text-muted-foreground">
            <tr>
              {head.map((h) => (
                <th key={h} className="px-4 py-2 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={head.length} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={head.length} className="px-4 py-10 text-center text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {r.map((c, j) => (
                    <td key={j} className="px-4 py-2.5 whitespace-nowrap">
                      {c}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
