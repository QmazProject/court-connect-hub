import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { cancelBookingsWithRefund } from "@/lib/refunds.functions";
import { AlertTriangle, Lock, X } from "lucide-react";
import {
  IMMINENT_MINUTES,
  classifySlot,
  defaultSelection,
  hasPaidSelection,
  isLocked,
  isSelectable,
  needsOverride,
  refundableTotal,
  slotStateLabel,
  type CancellableSlot,
} from "@/lib/booking-cancellation";

export type CancelTarget = {
  label: string;
  /** Every hourly row of the session. Cancelling is decided per hour, not per
   *  session — see @/lib/booking-cancellation for why. */
  slots: CancellableSlot[];
};

const peso = (n: number) =>
  "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hourLabel = (slot: CancellableSlot) => {
  const f = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  return `${f(slot.start_time)} – ${f(slot.end_time)}`;
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
  const [override, setOverride] = useState(false);

  /* Frozen when the dialog opens. Re-reading the clock as the tenant types would let
     an hour change category mid-decision — a slot ticking from "imminent" to
     "in progress" while a reason is being written would silently drop it from the
     selection. */
  const [nowMs] = useState(() => Date.now());

  const [selected, setSelected] = useState<number[]>(() => defaultSelection(target.slots, nowMs));

  const states = useMemo(
    () => new Map(target.slots.map((s) => [s.id, classifySlot(s, nowMs)])),
    [target.slots, nowMs],
  );
  const selectedPaid = hasPaidSelection(target.slots, selected);
  const refundTotal = refundableTotal(target.slots, selected);
  const lockedCount = target.slots.filter((s) => isLocked(states.get(s.id)!)).length;
  const overrideNeeded = target.slots.some(
    (s) => selected.includes(s.id) && needsOverride(states.get(s.id)!),
  );
  const reasonMissing = reason.trim().length === 0;
  const canSubmit = selected.length > 0 && !reasonMissing && !busy;

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [result, setResult] = useState<{
    cancelled: number;
    refunded: number;
    failures: string[];
  } | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await cancelFn({
        data: {
          bookingIds: selected,
          reason: reason.trim(),
          refundMode: selectedPaid ? mode : "none",
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
              {result.refunded > 0
                ? ` · ${result.refunded} refund${result.refunded === 1 ? "" : "s"} sent`
                : ""}
              . The player has been notified.
            </p>
            {result.failures.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-300">
                {result.failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <button
              onClick={onClose}
              className="mt-2 w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Which hours to cancel
              </p>
              {target.slots.length > 1 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Each hour is released separately. Hours already played stay on the booking.
                </p>
              )}
              <ul className="mt-2 space-y-1.5">
                {target.slots.map((slot) => {
                  const state = states.get(slot.id)!;
                  const locked = isLocked(state);
                  const selectable = isSelectable(state, override);
                  const checked = selected.includes(slot.id);
                  const note = slotStateLabel(state);
                  return (
                    <li key={slot.id}>
                      <label
                        className={
                          "flex items-center gap-2.5 rounded-xl border p-2.5 text-sm " +
                          (selectable
                            ? "cursor-pointer border-border has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                            : "cursor-not-allowed border-dashed border-border bg-muted/40 text-muted-foreground")
                        }
                      >
                        <input
                          type="checkbox"
                          disabled={!selectable}
                          checked={checked && selectable}
                          onChange={() => toggle(slot.id)}
                        />
                        <span className="flex-1 font-medium">{hourLabel(slot)}</span>
                        {slot.payment_status === "paid" && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                            paid
                          </span>
                        )}
                        {note && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider">
                            {locked && <Lock className="h-3 w-3" />}
                            {note}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>

              {lockedCount > 0 && (
                <p className="mt-2 rounded-lg bg-secondary/60 p-2.5 text-[11px] text-muted-foreground">
                  {lockedCount} hour{lockedCount === 1 ? "" : "s"} cannot be cancelled — that court
                  time has already passed, so it cannot be given back to anyone. The remaining hours
                  can still be released.
                </p>
              )}

              {/* The escape hatch for a flooded court or a power cut. Off by default, and
                  it says out loud what it is overriding. */}
              {target.slots.some((sl) => needsOverride(states.get(sl.id)!)) && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={override}
                    onChange={(e) => {
                      setOverride(e.target.checked);
                      if (!e.target.checked) {
                        setSelected((prev) => prev.filter((id) => !needsOverride(states.get(id)!)));
                      }
                    }}
                  />
                  <span>
                    Also allow hours in progress or starting within {IMMINENT_MINUTES} minutes. Only
                    for maintenance, an emergency or a court closure — the player has little or no
                    notice, so message them as well.
                  </span>
                </label>
              )}

              {selected.length === 0 && (
                <p className="mt-2 text-[11px] font-medium text-destructive">
                  Pick at least one hour to cancel.
                </p>
              )}
            </div>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Reason for the player <span className="text-destructive">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="e.g. Court maintenance on this date — sorry for the trouble."
              className={
                "mt-1.5 w-full resize-none rounded-xl border bg-background px-3 py-2 text-sm " +
                (reasonMissing ? "border-destructive/60" : "border-input")
              }
            />
            {/* Required, because "cancelled" with no explanation is the single most
                complained-about thing a venue can do. It is shown on the player's
                booking and in the notification they receive. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Shown to the player on their booking and in their notification.
            </p>

            {selectedPaid ? (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Refund
                </p>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <input
                      type="radio"
                      className="mt-0.5"
                      checked={mode === "auto"}
                      onChange={() => setMode("auto")}
                    />
                    <span>
                      Refund automatically via PayMongo
                      {/* Stated plainly because it is the part venues most often get
                          wrong: a PayMongo refund is bound to the original payment and
                          cannot be redirected. If the player wants the money somewhere
                          else, the only route is the manual option below. */}
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        PayMongo returns the money along the same route it arrived — the exact GCash
                        wallet, Maya account, card or bank the player paid with. You cannot choose a
                        different destination, and you never need their account details. Usually
                        lands in minutes for e-wallets; card refunds can take several banking days.
                        Recommended.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <input
                      type="radio"
                      className="mt-0.5"
                      checked={mode === "manual"}
                      onChange={() => setMode("manual")}
                    />
                    <span>
                      Settle the refund myself
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        For when the player wants the money somewhere else — a different GCash
                        number, or an account they still have access to. Agree the destination in
                        the booking chat, send it, then use <b>Mark refund settled</b> on the
                        booking to record how and close it off. It stays “Awaiting refund” until you
                        do. Ask for an account number only — never a password, OTP or card CVV.
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

            {overrideNeeded && (
              <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                You are cancelling court time that is already running or about to. Message the
                player as well — a notification alone will not reach someone on their way.
              </p>
            )}

            {err && <p className="mt-3 text-xs text-destructive">{err}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold"
              >
                Keep booking
              </button>
              <button
                onClick={submit}
                disabled={!canSubmit}
                title={reasonMissing ? "Add a reason for the player first" : undefined}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? "Cancelling…"
                  : selectedPaid
                    ? `Cancel ${selected.length} hr${selected.length === 1 ? "" : "s"} & refund ${peso(refundTotal)}`
                    : `Cancel ${selected.length} hr${selected.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
