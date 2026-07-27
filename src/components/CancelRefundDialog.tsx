import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { cancelBookingsWithRefund } from "@/lib/refunds.functions";
import { AlertTriangle, X } from "lucide-react";

export type CancelTarget = {
  bookingIds: number[];
  label: string;
  hasPaid: boolean;
};

/**
 * Venue-staff cancellation. Bookings are never deleted — they move to
 * "cancelled" so receipts, reporting and the player's history stay intact.
 */
export function CancelRefundDialog({
  target,
  onClose,
  onDone,
}: {
  target: CancelTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const cancelFn = useServerFn(cancelBookingsWithRefund);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ cancelled: number; refunded: number; failures: string[] } | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await cancelFn({
        data: {
          bookingIds: target.bookingIds,
          reason: reason.trim() || undefined,
          refundMode: target.hasPaid ? mode : "none",
        },
      });
      setResult(res);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1400] grid place-items-center bg-black/50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <h3 className="font-display text-lg font-semibold">Cancel booking</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{target.label}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="mt-4 space-y-2 text-sm">
            <p className="rounded-xl bg-secondary/60 p-3">
              {result.cancelled} slot{result.cancelled === 1 ? "" : "s"} cancelled
              {result.refunded > 0 ? ` · ${result.refunded} refund${result.refunded === 1 ? "" : "s"} sent` : ""}.
              The player has been notified.
            </p>
            {result.failures.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-300">
                {result.failures.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
            <button onClick={onClose} className="mt-2 w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              Done
            </button>
          </div>
        ) : (
          <>
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Reason for the player
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="e.g. Court maintenance on this date — sorry for the trouble."
              className="mt-1.5 w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm"
            />

            {target.hasPaid ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Refund</p>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <input type="radio" className="mt-0.5" checked={mode === "auto"} onChange={() => setMode("auto")} />
                    <span>
                      Refund automatically via PayMongo
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        Money goes back to the exact source the player paid from. Recommended.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <input type="radio" className="mt-0.5" checked={mode === "manual"} onChange={() => setMode("manual")} />
                    <span>
                      Settle the refund myself
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        Marked as “refund pending” until you mark it settled. Arrange it in the booking chat — never ask for card or e-wallet numbers.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
                Nothing was paid for this booking, so there is no refund to process.
              </p>
            )}

            {err && <p className="mt-3 text-xs text-destructive">{err}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold">
                Keep booking
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Cancelling…" : target.hasPaid ? "Cancel & refund" : "Cancel booking"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
