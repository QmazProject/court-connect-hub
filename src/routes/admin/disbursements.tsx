/**
 * Admin → Finance → Disbursements.
 *
 * Where a person actually sends the money and then says so. Court Connect has no
 * disbursement API, so the transfer itself happens outside this screen — in a
 * banking app, by hand. What this page is for is making that act recorded:
 * which payout, to which destination, with which reference, by whom, when.
 *
 * Every transition posts to `admin_transition_payout`, which re-checks that the
 * caller is a platform admin, takes a row lock, refuses a payout that is already
 * terminal, and writes the ledger entry that moves money from reserved to paid
 * out. None of that is decided here; this screen only offers the transitions the
 * database would accept and shows what came back.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, X } from "lucide-react";
import { adminListPayouts, adminTransitionPayout } from "@/lib/payouts.functions";
import { pesoFromCentavos } from "@/lib/ledger";
import {
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  adminTransitionsFrom,
  describeDestination,
  type PayoutDestinationSnapshot,
  type PayoutStatus,
} from "@/lib/payouts";

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

type PayoutRow = {
  id: number;
  tenant_id: string;
  amount_centavos: number;
  status: string;
  destination_snapshot: unknown;
  available_at_request_centavos: number | null;
  requested_at: string;
  transfer_reference: string | null;
  admin_notes: string | null;
  tenants?: { name: string | null; slug: string | null } | null;
};

function Disbursements() {
  const qc = useQueryClient();
  const listFn = useServerFn(adminListPayouts);
  const [filter, setFilter] = useState<string>("");
  const [target, setTarget] = useState<PayoutRow | null>(null);

  const q = useQuery({
    queryKey: ["admin-payouts", filter],
    queryFn: () => listFn({ data: filter ? { status: filter } : {} }),
  });

  const rows = (q.data ?? []) as PayoutRow[];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold">Disbursements</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Payout requests from tenants. Court Connect sends the money manually; this is where it is
          recorded.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {["", "requested", "under_review", "approved", "processing", "paid", "rejected"].map(
          (s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter(s)}
              className={`rounded-lg px-3 py-1.5 text-xs ${
                filter === s ? "bg-primary text-primary-foreground" : "hover:bg-secondary"
              }`}
            >
              {s ? (PAYOUT_STATUS_LABEL[s as PayoutStatus] ?? s) : "All"}
            </button>
          ),
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="nice-scroll max-h-[65vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Payout</th>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Destination</th>
                <th className="px-4 py-2">Requested</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    No payout requests{filter ? ` with status "${filter}"` : ""}.
                  </td>
                </tr>
              ) : (
                rows.map((p) => {
                  const status = p.status as PayoutStatus;
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setTarget(p)}
                      className="cursor-pointer border-t border-border hover:bg-secondary/30"
                    >
                      <td className="px-4 py-3 font-mono text-xs">#{p.id}</td>
                      <td className="px-4 py-3">{p.tenants?.name ?? p.tenant_id.slice(0, 8)}</td>
                      <td className="px-4 py-3 font-medium">
                        {pesoFromCentavos(p.amount_centavos)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {describeDestination(
                          p.destination_snapshot as PayoutDestinationSnapshot | null,
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {new Date(p.requested_at).toLocaleString("en-PH", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
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
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {target && (
        <PayoutDrawer
          payout={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            qc.invalidateQueries({ queryKey: ["admin-payouts"] });
          }}
        />
      )}
    </div>
  );
}

function PayoutDrawer({
  payout,
  onClose,
  onDone,
}: {
  payout: PayoutRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const transitionFn = useServerFn(adminTransitionPayout);
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const dest = payout.destination_snapshot as PayoutDestinationSnapshot | null;
  const next = adminTransitionsFrom(payout.status);

  const go = useMutation({
    mutationFn: async (toStatus: string) =>
      transitionFn({
        data: {
          payoutId: payout.id,
          toStatus: toStatus as
            "under_review" | "approved" | "processing" | "paid" | "rejected" | "failed",
          transferReference: reference.trim() || undefined,
          transferMethod: method.trim() || undefined,
          notes: notes.trim() || undefined,
          reason: reason.trim() || undefined,
        },
      }),
    onSuccess: onDone,
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="font-display text-lg font-semibold">
              Payout #{payout.id} · {pesoFromCentavos(payout.amount_centavos)}
            </h3>
            <p className="text-xs text-muted-foreground">
              {payout.tenants?.name ?? payout.tenant_id}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5 text-sm">
          {/* The full destination, read from the snapshot frozen at request time
              rather than from the tenant's current account — so a destination
              changed since the request cannot silently redirect this transfer. */}
          <dl className="space-y-1.5 rounded-xl border border-border p-3 text-xs">
            <Row term="Destination" value={describeDestination(dest)} />
            <Row term="Account name" value={dest?.account_name ?? "—"} />
            <Row term="Account" value={dest?.account_number_masked ?? "—"} mono />
            {dest?.bank_name && <Row term="Bank" value={dest.bank_name} />}
            <Row
              term="Available at request"
              value={
                payout.available_at_request_centavos != null
                  ? pesoFromCentavos(payout.available_at_request_centavos)
                  : "—"
              }
            />
          </dl>

          {next.includes("paid") && (
            <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-medium">Record the transfer</p>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Transfer reference number"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="Method (GCash, bank transfer…)"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                A reference is required. Once marked paid this payout is final and cannot be edited
                or paid again.
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

          {err && (
            <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {err}
            </p>
          )}

          {next.length === 0 ? (
            <p className="rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
              This payout is {PAYOUT_STATUS_LABEL[payout.status as PayoutStatus] ?? payout.status}{" "}
              and is final.
              {payout.transfer_reference ? ` Reference ${payout.transfer_reference}.` : ""}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {next.map((s) => (
                <button
                  key={s}
                  onClick={() => go.mutate(s)}
                  disabled={go.isPending || (s === "paid" && !reference.trim())}
                  className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                    s === "rejected" || s === "failed"
                      ? "border border-destructive/40 text-destructive"
                      : "bg-primary text-primary-foreground"
                  }`}
                >
                  {go.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Mark {PAYOUT_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          )}
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
