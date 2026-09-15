/** Tenant → Finance.
 *
 *  The screen that has to stop a tenant believing their sales figure is money
 *  Court Connect is holding for them. Those are different numbers and the whole
 *  layout is arranged around saying so: sales on one side, what the platform
 *  actually holds on the other, and only the second one has a Request payout
 *  button under it.
 *
 *  Every figure comes from `tenant_balances`, which sums the append-only ledger.
 *  Nothing is computed here from bookings, because a second computation is how
 *  two screens end up disagreeing about what a business is owed.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Banknote, Loader2, ShieldCheck, Upload, Wallet, X, Paperclip } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getTenantBalance,
  getTenantLedger,
  getPayoutAccount,
  savePayoutAccount,
  requestPayout,
  cancelPayout,
  listPayouts,
} from "@/lib/payouts.functions";
import {
  pesoFromCentavos,
  canRequestPayout,
  deriveBalances,
  toCentavos,
  ZERO_BALANCE,
  type LedgerEntry,
} from "@/lib/ledger";
import { DEFAULT_TIMEZONE, zonedDateISO, addZonedDays, zonedHourToUtc } from "@/lib/tz";
import {
  PAYOUT_ACCOUNT_TYPES,
  PAYOUT_FREQUENCIES,
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  describeDestination,
  maskAccountNumber,
  tenantCanCancel,
  validatePayoutAccount,
  type PayoutAccountType,
  type PayoutDestinationSnapshot,
  type PayoutStatus,
  describeTransferMethod,
} from "@/lib/payouts";

type RangeKey = "today" | "week" | "month" | "all" | "custom";

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  all: "All time",
  custom: "Custom",
};

/** A window in UTC instants, from venue-local calendar days.
 *
 *  Every boundary goes through `zonedHourToUtc`, the same helper the booking
 *  system uses, so a day here is the same day a court is booked in. Using the
 *  browser's local midnight instead would put a Manila tenant's "today" an hour
 *  out for anyone travelling, and quietly move money between periods.
 *
 *  `to` is exclusive — the query uses `lt` — so the last second of a day cannot
 *  be counted twice at a period boundary. */
function resolveRange(
  key: RangeKey,
  customFrom: string,
  customTo: string,
): { from?: string; to?: string } {
  if (key === "all") return {};
  const today = zonedDateISO(new Date(), DEFAULT_TIMEZONE);

  if (key === "custom") {
    if (!customFrom && !customTo) return {};
    return {
      from: customFrom ? zonedHourToUtc(customFrom, 0, DEFAULT_TIMEZONE).toISOString() : undefined,
      /* One day past the chosen end, so a custom range includes its final day. */
      to: customTo
        ? zonedHourToUtc(addZonedDays(customTo, 1), 0, DEFAULT_TIMEZONE).toISOString()
        : undefined,
    };
  }

  let startISO = today;
  if (key === "week") {
    /* Monday as the first day, matching how a venue thinks about its week. */
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    startISO = addZonedDays(today, -((dow + 6) % 7));
  } else if (key === "month") {
    startISO = `${today.slice(0, 7)}-01`;
  }

  return {
    from: zonedHourToUtc(startISO, 0, DEFAULT_TIMEZONE).toISOString(),
    to: zonedHourToUtc(addZonedDays(today, 1), 0, DEFAULT_TIMEZONE).toISOString(),
  };
}

const TONE_CLASS: Record<string, string> = {
  neutral: "bg-secondary text-foreground",
  info: "bg-sky-500/15 text-sky-700",
  success: "bg-primary/15 text-primary",
  danger: "bg-destructive/15 text-destructive",
};

export function TenantFinancePanel({ canManagePayouts }: { canManagePayouts: boolean }) {
  const qc = useQueryClient();
  const balanceFn = useServerFn(getTenantBalance);
  const accountFn = useServerFn(getPayoutAccount);
  const payoutsFn = useServerFn(listPayouts);
  const ledgerFn = useServerFn(getTenantLedger);

  const [tab, setTab] = useState<"overview" | "payouts" | "account">("overview");
  const [range, setRange] = useState<RangeKey>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  /* The window, resolved in the venue's timezone rather than the browser's, so a
     tenant in Manila sees "today" end at midnight where the courts are. */
  const window_ = useMemo(
    () => resolveRange(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  const balanceQ = useQuery({
    queryKey: ["tenant-balance"],
    queryFn: () => balanceFn({}),
  });
  const accountQ = useQuery({
    queryKey: ["tenant-payout-account"],
    queryFn: () => accountFn({}),
    /* A manager or a member of staff gets no row: RLS on this table asks
       is_tenant_admin(). That is not an error and must not render as one. */
    enabled: canManagePayouts,
  });
  const payoutsQ = useQuery({
    queryKey: ["tenant-payouts"],
    queryFn: () => payoutsFn({}),
    enabled: canManagePayouts,
  });

  /* Sales for the chosen window are summed from the ledger with the SAME column
     arithmetic the `tenant_balances` view uses — `deriveBalances` is its mirror —
     so a date-filtered figure can never be computed by a different formula from
     the lifetime one. Settlement figures below are deliberately NOT filtered:
     "available for payout" is a position right now, not an amount earned during
     a period, and showing last month's available balance would be meaningless. */
  const ledgerQ = useQuery({
    queryKey: ["tenant-ledger-range", window_.from, window_.to],
    queryFn: () => ledgerFn({ data: { limit: 1000, from: window_.from, to: window_.to } }),
  });

  const b = balanceQ.data ?? ZERO_BALANCE;
  const ranged = deriveBalances((ledgerQ.data ?? []) as LedgerEntry[]);
  const hasAccount = Boolean(accountQ.data?.id);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold">Finance</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What your venues sold, and what Court Connect is holding for you. They are not the same
          number.
        </p>
      </div>

      <div className="flex gap-1.5">
        {(["overview", "payouts", "account"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm capitalize ${
              tab === t ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
            }`}
          >
            {t === "account" ? "Payout account" : t}
          </button>
        ))}
      </div>

      {balanceQ.isLoading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your finances…
        </div>
      ) : balanceQ.error ? (
        <p className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {(balanceQ.error as Error).message}
        </p>
      ) : tab === "overview" ? (
        <>
          {/* Sales for the chosen period. */}
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Sales · {RANGE_LABEL[range]}
              </p>
              <div className="flex flex-wrap gap-1">
                {(["today", "week", "month", "all", "custom"] as RangeKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setRange(k)}
                    className={`rounded-lg px-2.5 py-1 text-[11px] ${
                      range === k ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
                    }`}
                  >
                    {RANGE_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            {range === "custom" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi
                label="Gross sales"
                value={pesoFromCentavos(ranged.grossCentavos)}
                hint={ledgerQ.isLoading ? "Loading…" : undefined}
              />
              <Kpi
                label="Collected by you"
                value={pesoFromCentavos(ranged.tenantCollectedCentavos)}
                hint="Cash and direct payments taken at your venue"
              />
              <Kpi
                label="Collected by Court Connect"
                value={pesoFromCentavos(ranged.platformCollectedCentavos)}
                hint="Paid online through PayMongo"
              />
            </div>
          </div>

          {/* Settlement. Only this half can ever be paid out. */}
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Held by Court Connect for you · right now
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Kpi
                label="Available for payout"
                value={pesoFromCentavos(b.availableCentavos)}
                strong
              />
              <Kpi label="Pending payout" value={pesoFromCentavos(b.reservedCentavos)} />
              <Kpi label="Already paid out" value={pesoFromCentavos(b.paidOutCentavos)} />
              <Kpi label="Refunded" value={pesoFromCentavos(b.refundedCentavos)} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Money you collected yourself at the venue is yours already, so it is not part of your
              payout balance. These four are your position today and do not change with the period
              selected above.
            </p>
            {b.netPositionCentavos < 0 && (
              <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                A refund was settled after a payout had already been sent, so{" "}
                {pesoFromCentavos(-b.netPositionCentavos)} is currently owed back. It will be
                recovered from future earnings before any new payout.
              </p>
            )}
          </div>
        </>
      ) : tab === "payouts" ? (
        <PayoutsTab
          canManagePayouts={canManagePayouts}
          available={b.availableCentavos}
          reserved={b.reservedCentavos}
          hasAccount={hasAccount}
          rows={payoutsQ.data ?? []}
          loading={payoutsQ.isLoading}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["tenant-balance"] });
            qc.invalidateQueries({ queryKey: ["tenant-payouts"] });
          }}
        />
      ) : (
        <AccountTab
          canManagePayouts={canManagePayouts}
          account={accountQ.data ?? null}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["tenant-payout-account"] });
          }}
        />
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        strong ? "border-primary/40 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- payouts -- */

type PayoutRow = {
  id: number;
  amount_centavos: number;
  status: string;
  destination_snapshot: unknown;
  requested_at: string;
  processing_at?: string | null;
  completed_at?: string | null;
  reviewed_at?: string | null;
  transfer_reference?: string | null;
  transfer_method?: string | null;
  rejection_reason?: string | null;
  request_type?: string | null;
  provider?: string | null;
  provider_transfer_id?: string | null;
  provider_status?: string | null;
  provider_error_code?: string | null;
  provider_error_message?: string | null;
  provider_submitted_at?: string | null;
  paid_amount_centavos?: number | null;
  proof_path?: string | null;
};

const fmtWhen = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";

function PayoutsTab({
  canManagePayouts,
  available,
  reserved,
  hasAccount,
  rows,
  loading,
  onChanged,
}: {
  canManagePayouts: boolean;
  available: number;
  reserved: number;
  hasAccount: boolean;
  rows: PayoutRow[];
  loading: boolean;
  onChanged: () => void;
}) {
  const requestFn = useServerFn(requestPayout);
  const cancelFn = useServerFn(cancelPayout);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const amountCentavos = toCentavos(amount);
  const check = useMemo(
    () =>
      canRequestPayout(
        { ...ZERO_BALANCE, availableCentavos: available, reservedCentavos: reserved },
        amountCentavos,
        hasAccount,
      ),
    [available, reserved, amountCentavos, hasAccount],
  );

  const request = useMutation({
    mutationFn: async () => requestFn({ data: { amountCentavos } }),
    onSuccess: () => {
      setOpen(false);
      setAmount("");
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const cancel = useMutation({
    mutationFn: async (payoutId: number) => cancelFn({ data: { payoutId } }),
    onSuccess: onChanged,
    onError: (e) => setErr((e as Error).message),
  });

  /* The proof the platform attached when it sent the money. A fresh signed URL
     each time; Storage's owner policy is what lets this tenant, and only this
     tenant, sign a path under its own folder. */
  const openProof = async (path: string) => {
    const { data, error } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(path, PROOF_SIGNED_EXPIRY);
    if (error) {
      setErr(error.message);
      return;
    }
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  if (!canManagePayouts) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 text-sm">
        <p className="font-semibold">Payouts are limited to tenant admins.</p>
        <p className="mt-1 text-muted-foreground">
          Your role can see bookings and sales, but not settlement details or payout destinations.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div>
          <p className="text-xs text-muted-foreground">Available for payout</p>
          <p className="font-display text-2xl font-semibold">{pesoFromCentavos(available)}</p>
          {reserved > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {pesoFromCentavos(reserved)} already requested and awaiting processing
            </p>
          )}
        </div>
        <button
          onClick={() => setOpen(true)}
          disabled={available <= 0 || !hasAccount}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Wallet className="h-4 w-4" />
          Request payout
        </button>
      </div>

      {!hasAccount && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          Add a payout account before requesting a payout.
        </p>
      )}
      {err && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {err}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="nice-scroll max-h-[55vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Payout</th>
                <th className="px-4 py-2">Requested</th>
                <th className="px-4 py-2">Sent</th>
                <th className="px-4 py-2">Destination</th>
                <th className="px-4 py-2">Sent by</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Reference</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No payouts yet. When Court Connect is holding money for you, request it here.
                  </td>
                </tr>
              ) : (
                rows.map((p) => {
                  const status = p.status as PayoutStatus;
                  return (
                    <tr key={p.id} className="border-t border-border align-top">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs">#{p.id}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.request_type === "recurring" ? "Scheduled" : "Requested"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{pesoFromCentavos(p.amount_centavos)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {fmtWhen(p.requested_at)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {/* The amount that actually left: equal to the request by
                            construction (the ledger pays exactly the reservation),
                            shown separately so the statement reads as a statement. */}
                        <p className="font-medium">
                          {p.paid_amount_centavos != null
                            ? pesoFromCentavos(p.paid_amount_centavos)
                            : "—"}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.status === "paid"
                            ? fmtWhen(p.completed_at)
                            : p.status === "failed"
                              ? `Failed ${fmtWhen(p.reviewed_at)}`
                              : p.provider_submitted_at
                                ? `Submitted ${fmtWhen(p.provider_submitted_at)}`
                                : p.processing_at
                                  ? `Processing since ${fmtWhen(p.processing_at)}`
                                  : "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {describeDestination(
                          p.destination_snapshot as PayoutDestinationSnapshot | null,
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {describeTransferMethod(p.provider, p.transfer_method)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            TONE_CLASS[PAYOUT_STATUS_TONE[status] ?? "neutral"]
                          }`}
                        >
                          {PAYOUT_STATUS_LABEL[status] ?? p.status}
                        </span>
                        {p.status === "processing" && p.provider === "paymongo" && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Submitted to PayMongo · waiting for confirmation
                          </p>
                        )}
                        {p.rejection_reason && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {p.rejection_reason}
                          </p>
                        )}
                        {p.status === "failed" && p.provider_error_message && (
                          <p className="mt-1 text-[11px] text-destructive">
                            {p.provider_error_message} — the amount is available again.
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <p className="font-mono">
                          {p.provider_transfer_id ?? p.transfer_reference ?? "—"}
                        </p>
                        {p.provider_transfer_id &&
                          p.transfer_reference &&
                          p.transfer_reference !== p.provider_transfer_id && (
                            <p className="font-mono text-[11px] text-muted-foreground">
                              {p.transfer_reference}
                            </p>
                          )}
                        {p.proof_path && (
                          <button
                            onClick={() => openProof(p.proof_path!)}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] underline"
                          >
                            <Paperclip className="h-3 w-3" /> Proof of transfer
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {tenantCanCancel(p.status) && (
                          <button
                            onClick={() => cancel.mutate(p.id)}
                            disabled={cancel.isPending}
                            className="text-xs text-muted-foreground underline hover:text-foreground"
                          >
                            Cancel
                          </button>
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

      {open && (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <h3 className="font-display text-lg font-semibold">Request payout</h3>
              <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-sm text-muted-foreground">
              {pesoFromCentavos(available)} is available.
            </p>

            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0.00"
              inputMode="decimal"
              className="mt-3 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={() => setAmount(String(available / 100))}
              className="mt-1.5 text-xs text-muted-foreground underline"
            >
              Request the full {pesoFromCentavos(available)}
            </button>

            {amountCentavos > 0 && check.ok && (
              <p className="mt-2 text-xs text-muted-foreground">
                {pesoFromCentavos(available - amountCentavos)} would remain available.
              </p>
            )}
            {!check.ok && amount !== "" && (
              <p className="mt-2 text-xs text-destructive">{check.reason}</p>
            )}

            <button
              onClick={() => request.mutate()}
              disabled={!check.ok || request.isPending}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {request.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Request payout
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Court Connect reviews and sends payouts manually. This reserves the amount so it
              cannot be requested twice.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- account -- */

type AccountRow = {
  id: number;
  account_type: string;
  account_name: string;
  account_number: string | null;
  bank_name: string | null;
  status: string;
  proof_path: string | null;
};

const PROOF_BUCKET = "payout-proofs";
/* Long-lived like the chat attachments this mirrors: the URL is only ever handed
   to someone Storage has already authorised through the bucket's policies. */
const PROOF_SIGNED_EXPIRY = 60 * 60;

function AccountTab({
  canManagePayouts,
  account,
  onSaved,
}: {
  canManagePayouts: boolean;
  account: AccountRow | null;
  onSaved: () => void;
}) {
  const saveFn = useServerFn(savePayoutAccount);
  const [accountType, setAccountType] = useState<PayoutAccountType>(
    (account?.account_type as PayoutAccountType) ?? "gcash",
  );
  const [accountName, setAccountName] = useState(account?.account_name ?? "");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState(account?.bank_name ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [proofPath, setProofPath] = useState<string | null>(account?.proof_path ?? null);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  /* The tenant that owns this workspace, read from the balances view rather than
     passed down: the view is security_invoker over an RLS-protected table, so it
     can only ever return the caller's own tenant. It is also the folder name the
     storage policies check, so taking it from anywhere the client could influence
     would be the wrong source. */
  const tenantQ = useQuery({
    queryKey: ["tenant-id"],
    enabled: canManagePayouts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_balances")
        .select("tenant_id")
        .maybeSingle();
      if (error) throw error;
      return data?.tenant_id ?? null;
    },
  });

  const prefQ = useQuery({
    queryKey: ["tenant-payout-preference"],
    enabled: canManagePayouts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_payout_preferences")
        .select("frequency")
        .maybeSingle();
      if (error) throw error;
      return data?.frequency ?? "manual";
    },
  });

  const savePref = useMutation({
    mutationFn: async (frequency: string) => {
      const tenantId = tenantQ.data;
      if (!tenantId) throw new Error("No tenant workspace for this account.");
      const { error } = await supabase
        .from("tenant_payout_preferences")
        .upsert({ tenant_id: tenantId, frequency }, { onConflict: "tenant_id" });
      if (error) throw error;
      return frequency;
    },
    onSuccess: () => prefQ.refetch(),
    onError: (e) => setErr((e as Error).message),
  });

  /* Upload straight from the browser, exactly as booking chat attachments do.
     The bucket is private and its policies require the first path segment to be
     the caller's own tenant, so a forged path is refused by Storage rather than
     by this component. */
  const uploadProof = async (file: File) => {
    const tenantId = tenantQ.data;
    if (!tenantId) {
      setErr("No tenant workspace for this account.");
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
      const path = `${tenantId}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(PROOF_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      setProofPath(path);
      const { data: signed } = await supabase.storage
        .from(PROOF_BUCKET)
        .createSignedUrl(path, PROOF_SIGNED_EXPIRY);
      setProofUrl(signed?.signedUrl ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  /* Never a public URL: the stored value is an object path, and a fresh signature
     is minted each time somebody actually looks. */
  const viewProof = async () => {
    if (!proofPath) return;
    const { data, error } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(proofPath, PROOF_SIGNED_EXPIRY);
    if (error) {
      setErr(error.message);
      return;
    }
    setProofUrl(data?.signedUrl ?? null);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const errors = validatePayoutAccount({ accountType, accountName, accountNumber, bankName });

  const save = useMutation({
    mutationFn: async () =>
      saveFn({
        data: {
          accountType,
          accountName: accountName.trim(),
          accountNumber: accountNumber.trim() || undefined,
          bankName: bankName.trim() || undefined,
          proofPath: proofPath ?? undefined,
        },
      }),
    onSuccess: () => {
      setAccountNumber("");
      setErr(null);
      onSaved();
    },
    onError: (e) => setErr((e as Error).message),
  });

  if (!canManagePayouts) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 text-sm">
        <p className="font-semibold">Payout details are limited to tenant admins.</p>
        <p className="mt-1 text-muted-foreground">
          This is where your business's money is sent, so only an admin can see or change it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {account && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Current destination</p>
          </div>
          <p className="mt-2 text-sm">
            {PAYOUT_ACCOUNT_TYPES.find((t) => t.value === account.account_type)?.label ??
              account.account_type}
            {account.bank_name ? ` · ${account.bank_name}` : ""}
          </p>
          <p className="text-sm text-muted-foreground">
            {account.account_name} · {maskAccountNumber(account.account_number) ?? "—"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Payouts already requested keep the destination they were created with, so changing this
            never redirects money that is already in flight.
          </p>
        </div>
      )}

      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">
            {account ? "Change payout destination" : "Add a payout destination"}
          </p>
        </div>

        <select
          value={accountType}
          onChange={(e) => setAccountType(e.target.value as PayoutAccountType)}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
        >
          {PAYOUT_ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        <input
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
          placeholder="Account holder name"
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
        />

        {accountType === "bank" && (
          <input
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="Bank name"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
          />
        )}

        <input
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          placeholder={accountType === "bank" ? "Account number" : "Mobile number"}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
        />

        {/* QR or bank screenshot. Stored as an object path in a private bucket,
            never a public URL. */}
        <div className="rounded-xl border border-dashed border-border p-3">
          <p className="text-xs font-medium">Payment QR or proof (optional)</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Kept private. Only you and Court Connect can open it, through a link that expires.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary">
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {proofPath ? "Replace image" : "Upload image"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadProof(f);
                }}
              />
            </label>
            {proofPath && (
              <button
                type="button"
                onClick={() => void viewProof()}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                View current
              </button>
            )}
          </div>
          {proofUrl && (
            <p className="mt-1.5 text-[11px] text-primary">Uploaded. Link expires in an hour.</p>
          )}
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}
        {errors.length > 0 && accountName !== "" && (
          <p className="text-xs text-muted-foreground">{errors[0]}</p>
        )}

        <button
          onClick={() => save.mutate()}
          disabled={errors.length > 0 || save.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save destination
        </button>
        <p className="text-[11px] text-muted-foreground">
          Every change is recorded with who made it. Court Connect verifies new destinations before
          sending money to them.
        </p>
      </div>

      {/* Settlement preference. An operational hint and nothing more — no
          scheduler reads it and no money moves because of it, which the copy
          says plainly so nobody waits for a transfer that will not arrive. */}
      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-medium">Preferred payout schedule</p>
        <select
          value={prefQ.data ?? "manual"}
          disabled={savePref.isPending || prefQ.isLoading}
          onChange={(e) => savePref.mutate(e.target.value)}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
        >
          {PAYOUT_FREQUENCIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          A preference, not a schedule. Court Connect reviews and sends every payout by hand, and
          you still request each one yourself.
        </p>
      </div>
    </div>
  );
}
