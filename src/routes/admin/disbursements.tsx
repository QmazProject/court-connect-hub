/**
 * Admin → Disbursements.
 *
 * The operational payout queue: what tenants have asked for, who is due on a
 * schedule, what is in flight, and what settled. An admin ticks the rows to
 * send and chooses how — PayMongo Money Movement, or a manual transfer they
 * record afterwards with a reference and a proof image.
 *
 * Nothing here decides money. Every action is an RPC that re-checks the caller
 * is a platform admin, takes the payout's row lock, and refuses a transition
 * the ledger would not support; the PayMongo call happens on the server only
 * after `admin_begin_payout_attempt` has opened an attempt. A PayMongo
 * acceptance is NOT payment: the row shows "Submitted · Processing" until the
 * `transfer.outward.*` webhook settles it, and cannot be forced paid from here.
 *
 * Batch selection is a loop over independent disbursements, one attempt and
 * one provider call each, reported per row. One failure changes nothing about
 * its neighbours.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  adminGetDisbursementConfig,
  adminGetPayoutAttempts,
  adminListDisbursementQueue,
  adminListReceivingInstitutions,
  adminMapPayoutAccountBic,
  adminReconcilePayoutAttempt,
  adminRecordManualPayout,
  adminSubmitPayouts,
  adminTransitionPayout,
  type PayoutAttemptRow,
  type SubmitResult,
  type TenantOverviewRow,
} from "@/lib/payouts.functions";
import { balanceFromRow, pesoFromCentavos } from "@/lib/ledger";
import {
  DISBURSEMENT_SECTIONS,
  PAYOUT_FREQUENCIES,
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  adminTransitionsFrom,
  canSubmitPayout,
  describeDestination,
  describeTransferMethod,
  sectionForStatus,
  type DisbursementSection,
  type PayoutDestinationSnapshot,
  type PayoutStatus,
} from "@/lib/payouts";
import {
  ATTEMPT_STATUS_LABEL,
  PAYOUT_PROVIDER_LABEL,
  pendingLooksStuck,
  railForAmount,
  type AttemptStatus,
  type PayoutProvider,
  type ReceivingInstitution,
} from "@/lib/payout-providers";

export const Route = createFileRoute("/admin/disbursements")({
  ssr: false,
  component: Disbursements,
});

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-secondary text-foreground",
  info: "bg-sky-500/15 text-sky-700",
  success: "bg-primary/15 text-primary",
  danger: "bg-destructive/15 text-destructive",
};

type QueueRow = {
  id: number;
  tenant_id: string;
  amount_centavos: number;
  status: string;
  request_type: string;
  provider: string | null;
  provider_transfer_id: string | null;
  provider_status: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  provider_submitted_at: string | null;
  destination_snapshot: unknown;
  available_at_request_centavos: number | null;
  requested_at: string;
  processing_at: string | null;
  completed_at: string | null;
  transfer_reference: string | null;
  transfer_method: string | null;
  proof_path: string | null;
  admin_notes: string | null;
  rejection_reason: string | null;
  tenants?: { name: string | null; slug: string | null } | null;
  attempts: PayoutAttemptRow[];
  open_attempt: PayoutAttemptRow | null;
  available_centavos: number | null;
  frequency: string;
  paymongo_bic: string | null;
};

type Config = Awaited<ReturnType<typeof adminGetDisbursementConfig>>;

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";

function Disbursements() {
  const qc = useQueryClient();
  const queueFn = useServerFn(adminListDisbursementQueue);
  const configFn = useServerFn(adminGetDisbursementConfig);
  const submitFn = useServerFn(adminSubmitPayouts);

  const [section, setSection] = useState<DisbursementSection>("requested");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<QueueRow | null>(null);
  const [results, setResults] = useState<SubmitResult[] | null>(null);
  const [mapping, setMapping] = useState<NonNullable<SubmitResult["needsMapping"]> | null>(null);

  const queueQ = useQuery({ queryKey: ["admin-disbursement-queue"], queryFn: () => queueFn({}) });
  const configQ = useQuery({
    queryKey: ["admin-disbursement-config"],
    queryFn: () => configFn({}),
  });

  const payouts = useMemo(
    () => (queueQ.data?.payouts ?? []) as unknown as QueueRow[],
    [queueQ.data?.payouts],
  );
  const due = useMemo(
    () => (queueQ.data?.recurringDue ?? []) as TenantOverviewRow[],
    [queueQ.data?.recurringDue],
  );
  const config = configQ.data as Config | undefined;

  const needle = search.trim().toLowerCase();
  const matches = (name: string | null | undefined, slug: string | null | undefined, id?: number) =>
    !needle ||
    (name ?? "").toLowerCase().includes(needle) ||
    (slug ?? "").toLowerCase().includes(needle) ||
    (id != null && String(id) === needle.replace(/^#/, ""));

  const rows = useMemo(
    () =>
      payouts.filter(
        (p) =>
          sectionForStatus(p.status) === section && matches(p.tenants?.name, p.tenants?.slug, p.id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payouts, section, needle],
  );
  const dueRows = useMemo(
    () => due.filter((d) => matches(d.tenant_name, d.tenant_slug)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [due, needle],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { recurring_due: due.length };
    for (const p of payouts) {
      const k = sectionForStatus(p.status);
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [payouts, due]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-disbursement-queue"] });
    qc.invalidateQueries({ queryKey: ["admin-tenant-overview"] });
    qc.invalidateQueries({ queryKey: ["admin-disbursement-config"] });
  };

  /* Which selected keys are eligible right now. A key is `p:<payoutId>` or
     `t:<tenantId>` (a recurring-due tenant with no payout row yet). */
  const eligibleKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of rows) if (canSubmitPayout(p.status, !!p.open_attempt)) set.add(`p:${p.id}`);
    if (section === "recurring_due") for (const d of dueRows) set.add(`t:${d.tenant_id}`);
    return set;
  }, [rows, dueRows, section]);

  const chosen = [...selected].filter((k) => eligibleKeys.has(k));

  const submit = useMutation({
    mutationFn: async (provider: PayoutProvider) => {
      const items = chosen.map((k) => {
        if (k.startsWith("p:")) return { payoutId: Number(k.slice(2)) };
        const tenantId = k.slice(2);
        const d = due.find((x) => x.tenant_id === tenantId)!;
        return { tenantId, amountCentavos: balanceFromRow(d).availableCentavos };
      });
      return submitFn({ data: { provider, items } });
    },
    onSuccess: (res) => {
      setResults(res);
      setSelected(new Set());
      const needs = res.find((r) => r.needsMapping)?.needsMapping ?? null;
      if (needs) setMapping(needs);
      invalidate();
    },
  });

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const all = [...eligibleKeys];
      const every = all.every((k) => s.has(k));
      return every ? new Set() : new Set(all);
    });

  const testMode = config?.mode === "test";
  const paymongoReady = !!config?.wallet && (config.mode === "test" || config.mode === "live");

  return (
    <div className="space-y-5 px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">Disbursements</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Payouts to tenants. Tick what to send, then send it through PayMongo or record a manual
            transfer.
          </p>
        </div>
        <button
          onClick={invalidate}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* The mode banner. Loud on purpose: it is the one thing a person must
          know before pressing Send. */}
      {configQ.isLoading ? null : config?.mode === "unconfigured" ? (
        <Banner tone="warn">
          PayMongo is not configured on this server (no secret key). Only manual transfers can be
          recorded.
        </Banner>
      ) : testMode ? (
        <Banner tone="test">
          <strong>PAYMONGO TEST MODE</strong> — No real money will be transferred.
          {config?.wallet
            ? ` Test wallet ${config.wallet.account_name ?? ""} ${config.wallet.account_number_masked ?? ""} · available ${
                config.wallet.available_centavos != null
                  ? pesoFromCentavos(config.wallet.available_centavos)
                  : "—"
              }.`
            : ` ${config?.walletError ?? "No wallet"}.`}
        </Banner>
      ) : (
        <Banner tone="live">
          <strong>PAYMONGO LIVE KEY</strong> — transfers submitted here move real money.
          {config?.wallet
            ? ` Wallet ${config.wallet.account_name ?? ""} ${config.wallet.account_number_masked ?? ""} · available ${
                config.wallet.available_centavos != null
                  ? pesoFromCentavos(config.wallet.available_centavos)
                  : "—"
              }.`
            : ` ${config?.walletError ?? "No wallet"}.`}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {DISBURSEMENT_SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                setSection(s.key);
                setSelected(new Set());
              }}
              className={`rounded-lg px-3 py-1.5 text-xs ${
                section === s.key ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
              }`}
            >
              {s.label}
              <span className="ml-1.5 opacity-70">{counts[s.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tenant or #id…"
          className="ml-auto w-full max-w-xs rounded-xl border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      {/* Batch bar */}
      {(section === "requested" ||
        section === "recurring_due" ||
        section === "processing" ||
        section === "closed") && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3 text-sm">
          <span className="text-muted-foreground">
            {chosen.length} selected{eligibleKeys.size ? ` of ${eligibleKeys.size} eligible` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={() => submit.mutate("paymongo")}
              disabled={chosen.length === 0 || submit.isPending || !paymongoReady}
              title={!paymongoReady ? (config?.walletError ?? "PayMongo not ready") : undefined}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Send via PayMongo{testMode ? " (TEST)" : ""}
            </button>
            <button
              onClick={() => submit.mutate("manual")}
              disabled={chosen.length === 0 || submit.isPending}
              className="rounded-xl border border-border px-3 py-2 text-sm font-medium disabled:opacity-50"
              title="Moves the payouts to Processing as manual transfers; record each transfer's reference and proof from its row."
            >
              Start manual transfer
            </button>
          </div>
        </div>
      )}

      {!configQ.isLoading && config && !paymongoReady && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          <p className="font-medium">Sending through PayMongo is unavailable right now.</p>
          <p className="mt-0.5">
            {config.mode === "unconfigured"
              ? "The server has no PayMongo secret key."
              : (config.walletError ?? "No source wallet.")}
          </p>
          <p className="mt-1 text-[11px] opacity-80">
            This is decided by the wallet on the PayMongo account, not by webhook subscriptions or
            by a tenant's payout schedule. Manual transfers can still be recorded. Press Refresh
            after the wallet is activated.
          </p>
        </div>
      )}

      {results && <ResultsPanel results={results} onClose={() => setResults(null)} />}

      {section === "recurring_due" ? (
        <RecurringDueTable
          rows={dueRows}
          loading={queueQ.isLoading}
          selected={selected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          allSelected={eligibleKeys.size > 0 && [...eligibleKeys].every((k) => selected.has(k))}
        />
      ) : (
        <PayoutTable
          rows={rows}
          loading={queueQ.isLoading}
          error={queueQ.error as Error | null}
          section={section}
          selected={selected}
          eligible={eligibleKeys}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onOpen={setTarget}
        />
      )}

      {target && (
        <PayoutDrawer
          payout={payouts.find((p) => p.id === target.id) ?? target}
          config={config}
          onClose={() => setTarget(null)}
          onChanged={invalidate}
          onNeedsMapping={(m) => setMapping(m)}
        />
      )}

      {mapping && (
        <MappingDialog
          needs={mapping}
          onClose={() => setMapping(null)}
          onMapped={() => {
            setMapping(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- tables -- */

function PayoutTable({
  rows,
  loading,
  error,
  section,
  selected,
  eligible,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  rows: QueueRow[];
  loading: boolean;
  error: Error | null;
  section: DisbursementSection;
  selected: Set<string>;
  eligible: Set<string>;
  onToggle: (k: string) => void;
  onToggleAll: () => void;
  onOpen: (r: QueueRow) => void;
}) {
  const selectable = section !== "paid";
  const allSelected = eligible.size > 0 && [...eligible].every((k) => selected.has(k));
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="nice-scroll max-h-[65vh] overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/50 text-xs text-muted-foreground">
            <tr>
              {selectable && (
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={onToggleAll}
                    aria-label="Select all eligible"
                  />
                </th>
              )}
              <th className="px-3 py-2">Payout</th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Available</th>
              <th className="px-3 py-2">Destination</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2">Requested</th>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={13} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={13} className="px-4 py-8 text-center text-destructive">
                  {error.message}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-4 py-10 text-center text-muted-foreground">
                  Nothing here.
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const key = `p:${p.id}`;
                const status = p.status as PayoutStatus;
                const a = p.open_attempt ?? p.attempts[0] ?? null;
                const stuck =
                  a && a.status === "pending" && a.submitted_at
                    ? pendingLooksStuck(a.provider_rail, a.submitted_at)
                    : false;
                return (
                  <tr key={p.id} className="border-t border-border hover:bg-secondary/30">
                    {selectable && (
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          disabled={!eligible.has(key)}
                          onChange={() => onToggle(key)}
                          aria-label={`Select payout ${p.id}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-3 font-mono text-xs">#{p.id}</td>
                    <td className="px-3 py-3">
                      <Link
                        to="/admin/tenants/$tenantId"
                        params={{ tenantId: p.tenant_id }}
                        className="hover:underline"
                      >
                        {p.tenants?.name ?? p.tenant_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-right font-medium">
                      {pesoFromCentavos(p.amount_centavos)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted-foreground">
                      {p.available_centavos != null ? pesoFromCentavos(p.available_centavos) : "—"}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {describeDestination(
                        p.destination_snapshot as PayoutDestinationSnapshot | null,
                      )}
                      {p.paymongo_bic && <p className="font-mono text-[10px]">{p.paymongo_bic}</p>}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {p.request_type === "recurring" ? "Recurring" : "Request"}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {PAYOUT_FREQUENCIES.find((f) => f.value === p.frequency)?.label ??
                        p.frequency}
                    </td>
                    <td className="px-3 py-3 text-xs">{fmt(p.requested_at)}</td>
                    <td className="px-3 py-3 text-xs">
                      {p.provider
                        ? (PAYOUT_PROVIDER_LABEL[p.provider as PayoutProvider] ?? p.provider)
                        : "—"}
                      {a && (
                        <p className="text-[11px] text-muted-foreground">
                          {ATTEMPT_STATUS_LABEL[a.status as AttemptStatus] ?? a.status}
                          {a.livemode === false ? " · test" : ""}
                        </p>
                      )}
                      {stuck && (
                        <p className="flex items-center gap-1 text-[11px] text-amber-700">
                          <Clock className="h-3 w-3" /> pending longer than expected
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-[11px]">
                      {p.provider_transfer_id ?? p.transfer_reference ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${TONE_CLASS[PAYOUT_STATUS_TONE[status] ?? "neutral"]}`}
                      >
                        {PAYOUT_STATUS_LABEL[status] ?? p.status}
                      </span>
                      {p.provider_error_message && (
                        <p
                          className="mt-1 max-w-[16rem] truncate text-[11px] text-destructive"
                          title={p.provider_error_message}
                        >
                          {p.provider_error_code ? `${p.provider_error_code}: ` : ""}
                          {p.provider_error_message}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => onOpen(p)}
                        className="text-xs underline hover:text-foreground"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecurringDueTable({
  rows,
  loading,
  selected,
  onToggle,
  onToggleAll,
  allSelected,
}: {
  rows: TenantOverviewRow[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (k: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Tenants whose schedule says they are due, who hold an available balance and have no payout
        open. Nothing is created until you tick one and send: at that moment a payout is reserved
        for the full available balance, its destination frozen, and the transfer submitted.
      </p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all due"
                />
              </th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2 text-right">Available (to send)</th>
              <th className="px-3 py-2">Destination</th>
              <th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2">Due since</th>
              <th className="px-3 py-2">Last paid</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  No tenant is due right now.
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const key = `t:${d.tenant_id}`;
                const b = balanceFromRow(d);
                return (
                  <tr key={d.tenant_id} className="border-t border-border">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => onToggle(key)}
                        aria-label={`Select ${d.tenant_name}`}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Link
                        to="/admin/tenants/$tenantId"
                        params={{ tenantId: d.tenant_id }}
                        className="font-medium hover:underline"
                      >
                        {d.tenant_name ?? "Unnamed business"}
                      </Link>
                      <p className="text-[11px] text-muted-foreground">{d.tenant_slug}</p>
                    </td>
                    <td className="px-3 py-3 text-right font-medium">
                      {pesoFromCentavos(b.availableCentavos)}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {d.account_type ?? "—"}
                      {d.paymongo_bic && <p className="font-mono text-[10px]">{d.paymongo_bic}</p>}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {PAYOUT_FREQUENCIES.find((f) => f.value === d.frequency)?.label ??
                        d.frequency}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {d.recurring.nextDueAt ? fmt(d.recurring.nextDueAt) : "—"}
                    </td>
                    <td className="px-3 py-3 text-xs">{fmt(d.last_paid_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- results -- */

function ResultsPanel({ results, onClose }: { results: SubmitResult[]; onClose: () => void }) {
  const ok = results.filter((r) => r.ok).length;
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">
          {ok} of {results.length} submitted
        </p>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-secondary">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="space-y-1">
        {results.map((r) => (
          <li key={r.key} className="flex items-start gap-2 text-xs">
            {r.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            <span>
              {r.payoutId != null ? `Payout #${r.payoutId}` : r.key} —{" "}
              {r.status === "awaiting_manual"
                ? "moved to Processing; record the manual transfer from its row"
                : r.status === "submitted"
                  ? `Submitted to PayMongo (${r.transferId}) · Processing until the webhook settles it`
                  : r.status.startsWith("settled_")
                    ? `PayMongo answered ${r.providerStatus} immediately (${r.transferId})`
                    : r.status}
              {r.error ? ` · ${r.error}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Banner({ tone, children }: { tone: "test" | "live" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "test"
      ? "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200"
      : tone === "live"
        ? "border-destructive/50 bg-destructive/10 text-destructive"
        : "border-border bg-secondary/40 text-muted-foreground";
  return <div className={`rounded-xl border p-3 text-sm ${cls}`}>{children}</div>;
}

/* ----------------------------------------------------------------- drawer -- */

const PROOF_BUCKET = "payout-proofs";

function PayoutDrawer({
  payout,
  config,
  onClose,
  onChanged,
  onNeedsMapping,
}: {
  payout: QueueRow;
  config: Config | undefined;
  onClose: () => void;
  onChanged: () => void;
  onNeedsMapping: (m: NonNullable<SubmitResult["needsMapping"]>) => void;
}) {
  const transitionFn = useServerFn(adminTransitionPayout);
  const manualFn = useServerFn(adminRecordManualPayout);
  const submitFn = useServerFn(adminSubmitPayouts);
  const reconcileFn = useServerFn(adminReconcilePayoutAttempt);
  const attemptsFn = useServerFn(adminGetPayoutAttempts);

  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [paidAmount, setPaidAmount] = useState(String(payout.amount_centavos / 100));
  const [proofPath, setProofPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [manualTransferId, setManualTransferId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const attemptsQ = useQuery({
    queryKey: ["admin-payout-attempts", payout.id],
    queryFn: () => attemptsFn({ data: { payoutId: payout.id } }),
  });

  const dest = payout.destination_snapshot as PayoutDestinationSnapshot | null;
  const open = payout.open_attempt;
  const next = adminTransitionsFrom(payout.status).filter(
    (s) => s !== "paid" && s !== "failed" && s !== "processing",
  );
  const canSend = canSubmitPayout(payout.status, !!open);
  const canRecordManual =
    !payout.status.match(/^(paid|rejected|cancelled)$/) && (!open || open.provider === "manual");
  const testMode = config?.mode === "test";

  const done = (m?: string) => {
    setErr(null);
    if (m) setMsg(m);
    onChanged();
    attemptsQ.refetch();
  };
  const fail = (e: unknown) => setErr((e as Error).message);

  const transition = useMutation({
    mutationFn: (toStatus: string) =>
      transitionFn({
        data: {
          payoutId: payout.id,
          toStatus: toStatus as "under_review" | "approved" | "rejected",
          notes: notes.trim() || undefined,
          reason: reason.trim() || undefined,
        },
      }),
    onSuccess: () => done(),
    onError: fail,
  });

  const send = useMutation({
    mutationFn: () =>
      submitFn({ data: { provider: "paymongo", items: [{ payoutId: payout.id }] } }),
    onSuccess: (res) => {
      const r = res[0];
      if (r?.needsMapping) onNeedsMapping(r.needsMapping);
      if (r && !r.ok) setErr(r.error ?? r.status);
      done(r?.ok ? `Submitted to PayMongo${r.transferId ? ` · ${r.transferId}` : ""}` : undefined);
    },
    onError: fail,
  });

  const uploadProof = async (file: File) => {
    setUploading(true);
    setErr(null);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
      /* Under <tenant>/disbursements/: the folder the platform-admin insert
         policy allows, and the folder the tenant's owner policy can read. */
      const path = `${payout.tenant_id}/disbursements/${payout.id}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from(PROOF_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      setProofPath(path);
    } catch (e) {
      fail(e);
    } finally {
      setUploading(false);
    }
  };

  const recordManual = useMutation({
    mutationFn: () =>
      manualFn({
        data: {
          payoutId: payout.id,
          method: method.trim(),
          reference: reference.trim(),
          paidAmountCentavos: Math.round(Number(paidAmount) * 100),
          proofPath: proofPath!,
          notes: notes.trim() || undefined,
        },
      }),
    onSuccess: () => done("Recorded as paid."),
    onError: fail,
  });

  const reconcile = useMutation({
    mutationFn: (attemptId: number) =>
      reconcileFn({ data: { attemptId, transferId: manualTransferId.trim() || undefined } }),
    onSuccess: (r) => done(`PayMongo says ${r.providerStatus} → ${r.outcome}`),
    onError: fail,
  });

  const viewProof = async (path: string) => {
    const { data, error } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(path, 60 * 10);
    if (error) return fail(error);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const manualReady =
    method.trim() &&
    reference.trim() &&
    proofPath &&
    Math.round(Number(paidAmount) * 100) === payout.amount_centavos;

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="font-display text-lg font-semibold">
              Payout #{payout.id} · {pesoFromCentavos(payout.amount_centavos)}
            </h3>
            <p className="text-xs text-muted-foreground">
              {payout.tenants?.name ?? payout.tenant_id} ·{" "}
              {PAYOUT_STATUS_LABEL[payout.status as PayoutStatus] ?? payout.status}
              {payout.provider
                ? ` · ${PAYOUT_PROVIDER_LABEL[payout.provider as PayoutProvider] ?? payout.provider}`
                : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5 text-sm">
          <dl className="grid gap-x-4 gap-y-1.5 rounded-xl border border-border p-3 text-xs sm:grid-cols-2">
            <Row term="Destination" value={describeDestination(dest)} />
            <Row term="Account name" value={dest?.account_name ?? "—"} />
            <Row term="Account" value={dest?.account_number_masked ?? "—"} mono />
            <Row term="PayMongo institution" value={payout.paymongo_bic ?? "not mapped"} mono />
            <Row
              term="Type"
              value={payout.request_type === "recurring" ? "Recurring" : "Request"}
            />
            <Row
              term="Rail if sent"
              value={
                railForAmount(payout.amount_centavos) === "instapay"
                  ? "InstaPay"
                  : "PESONet (over ₱50,000)"
              }
            />
            <Row term="Requested" value={fmt(payout.requested_at)} />
            <Row term="Processing since" value={fmt(payout.processing_at)} />
            <Row term="Submitted" value={fmt(payout.provider_submitted_at)} />
            <Row term="Completed" value={fmt(payout.completed_at)} />
            <Row
              term="Reference"
              value={payout.provider_transfer_id ?? payout.transfer_reference ?? "—"}
              mono
            />
            <Row
              term="Method"
              value={describeTransferMethod(payout.provider, payout.transfer_method)}
            />
            {payout.proof_path && (
              <div className="sm:col-span-2">
                <button onClick={() => viewProof(payout.proof_path!)} className="text-xs underline">
                  View proof of transfer
                </button>
              </div>
            )}
          </dl>

          {payout.provider_error_message && (
            <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {payout.provider_error_code ? `${payout.provider_error_code}: ` : ""}
              {payout.provider_error_message}
            </p>
          )}

          {/* PayMongo in flight */}
          {open && open.provider === "paymongo" && (
            <div className="space-y-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Clock className="h-3.5 w-3.5" />
                {open.status === "submitting"
                  ? "Submitting to PayMongo — no transfer id recorded"
                  : "Submitted to PayMongo · Processing"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {open.status === "submitting"
                  ? "The API call did not complete. Check the PayMongo dashboard for a transfer with reference " +
                    `"CCH P${payout.id} A${open.attempt_no}". If it exists, paste its tr_ id and reconcile; if not, reconcile to release the money.`
                  : "This payout is marked paid or failed only when PayMongo's webhook arrives. If it has been pending longer than the rail allows, ask PayMongo now."}
              </p>
              {open.status === "submitting" && (
                <input
                  value={manualTransferId}
                  onChange={(e) => setManualTransferId(e.target.value)}
                  placeholder="tr_… from the PayMongo dashboard (optional)"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
                />
              )}
              <button
                onClick={() => reconcile.mutate(open.id)}
                disabled={
                  reconcile.isPending || (open.status === "submitting" && !manualTransferId.trim())
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {reconcile.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Reconcile with PayMongo
              </button>
            </div>
          )}

          {/* Send via PayMongo */}
          {canSend && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs">
                Send {pesoFromCentavos(payout.amount_centavos)} through PayMongo
                {testMode ? " (TEST MODE — no real money)" : ""}.
              </p>
              {!config?.wallet && (
                <p className="w-full text-[11px] text-amber-800 dark:text-amber-300">
                  {config?.walletError ?? "PayMongo wallet not available."}
                </p>
              )}
              <button
                onClick={() => send.mutate()}
                disabled={send.isPending || !config?.wallet}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {send.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Send via PayMongo
              </button>
            </div>
          )}

          {/* Manual transfer */}
          {canRecordManual && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <p className="text-xs font-medium">Record a manual transfer</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="Method (GCash, InstaPay, bank…)"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Transfer reference number"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                  placeholder="Paid amount"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {proofPath ? "Proof attached" : "Attach proof (required)"}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && uploadProof(e.target.files[0])}
                  />
                </label>
              </div>
              {Math.round(Number(paidAmount) * 100) !== payout.amount_centavos &&
                paidAmount !== "" && (
                  <p className="text-[11px] text-destructive">
                    The paid amount must equal {pesoFromCentavos(payout.amount_centavos)}. For a
                    different amount, reject and let the tenant re-request.
                  </p>
                )}
              <button
                onClick={() => recordManual.mutate()}
                disabled={!manualReady || recordManual.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {recordManual.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Mark paid (manual)
              </button>
              <p className="text-[11px] text-muted-foreground">
                Final once saved: the reservation becomes paid out, the tenant is notified, and the
                reference and proof appear in their Finance screen.
              </p>
            </div>
          )}

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Internal note (optional)"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          />

          {next.includes("rejected") && (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason, if rejecting"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
          )}

          {next.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {next.map((s) => (
                <button
                  key={s}
                  onClick={() => transition.mutate(s)}
                  disabled={transition.isPending}
                  className={`rounded-xl px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                    s === "rejected"
                      ? "border border-destructive/40 text-destructive"
                      : "border border-border"
                  }`}
                >
                  Mark {PAYOUT_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          )}

          {/* Attempt history */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Attempts</p>
            {attemptsQ.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (attemptsQ.data?.attempts ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No transfer attempted yet.</p>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Provider</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Transfer id</th>
                    <th className="py-1 pr-2">Created</th>
                    <th className="py-1 pr-2">Settled</th>
                    <th className="py-1">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {(attemptsQ.data?.attempts ?? []).map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-1 pr-2">{a.attempt_no}</td>
                      <td className="py-1 pr-2">
                        {a.provider}
                        {a.livemode === false ? " (test)" : ""}
                      </td>
                      <td className="py-1 pr-2">
                        {ATTEMPT_STATUS_LABEL[a.status as AttemptStatus] ?? a.status}
                      </td>
                      <td className="py-1 pr-2 font-mono">
                        {a.provider_transfer_id ?? a.provider_reference_number ?? "—"}
                      </td>
                      <td className="py-1 pr-2">{fmt(a.created_at)}</td>
                      <td className="py-1 pr-2">{fmt(a.completed_at)}</td>
                      <td className="py-1 text-destructive">
                        {a.error_code
                          ? `${a.error_code}${a.error_message ? `: ${a.error_message}` : ""}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {msg && <p className="rounded-xl bg-primary/10 p-3 text-xs text-primary">{msg}</p>}
          {err && (
            <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {err}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- mapping dialog -- */

function MappingDialog({
  needs,
  onClose,
  onMapped,
}: {
  needs: NonNullable<SubmitResult["needsMapping"]>;
  onClose: () => void;
  onMapped: () => void;
}) {
  const listFn = useServerFn(adminListReceivingInstitutions);
  const mapFn = useServerFn(adminMapPayoutAccountBic);
  const [q, setQ] = useState("");
  const [bic, setBic] = useState<string | null>(needs.candidates[0]?.bic ?? null);
  const [err, setErr] = useState<string | null>(null);

  const instQ = useQuery({
    queryKey: ["paymongo-institutions", needs.rail],
    queryFn: () => listFn({ data: { rail: needs.rail } }),
  });
  const all = (instQ.data ?? []) as ReceivingInstitution[];
  const needle = q.trim().toLowerCase();
  const shown = (
    needle
      ? all.filter(
          (i) => i.name.toLowerCase().includes(needle) || i.bic.toLowerCase().includes(needle),
        )
      : needs.candidates.length
        ? needs.candidates
        : all
  ).slice(0, 60);

  const save = useMutation({
    mutationFn: () => mapFn({ data: { accountId: needs.accountId!, bic: bic!, rail: needs.rail } }),
    onSuccess: onMapped,
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="font-display text-lg font-semibold">Map the destination</h3>
            <p className="text-xs text-muted-foreground">{needs.reason}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-5 text-sm">
          <p className="text-[11px] text-muted-foreground">
            Choose the PayMongo receiving institution ({needs.rail}) this tenant's account belongs
            to. The code is taken from PayMongo's own list and remembered for future payouts.
          </p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search institutions…"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          {instQ.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading PayMongo institutions…</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {shown.map((i) => (
                <li key={i.bic}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary">
                    <input
                      type="radio"
                      name="bic"
                      checked={bic === i.bic}
                      onChange={() => setBic(i.bic)}
                    />
                    <span className="flex-1">{i.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{i.bic}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <button
            onClick={() => save.mutate()}
            disabled={!bic || !needs.accountId || save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Save mapping
          </button>
          <p className="text-[11px] text-muted-foreground">Then send the payout again.</p>
        </div>
      </div>
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
