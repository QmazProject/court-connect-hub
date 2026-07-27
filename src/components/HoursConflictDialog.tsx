import { AlertTriangle, X } from "lucide-react";
import { formatDateLabel, formatSessionLabel } from "@/lib/booking-groups";

export type HoursConflict = {
  bookingIds: number[];
  startTime: string;
  endTime: string;
  courtName: string;
  playerName: string;
  paid: boolean;
};

/**
 * Shown before narrowing operating hours. Existing bookings are always
 * grandfathered — new hours only ever gate NEW bookings.
 */
export function HoursConflictDialog({
  conflicts,
  onKeep,
  onCancelThem,
  onDismiss,
  busy,
}: {
  conflicts: HoursConflict[];
  onKeep: () => void;
  onCancelThem: () => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const total = conflicts.reduce((n, c) => n + c.bookingIds.length, 0);
  return (
    <div className="fixed inset-0 z-[1400] grid place-items-center bg-black/50 px-4">
      <div className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <h3 className="font-display text-lg font-semibold">
                {conflicts.length} upcoming booking{conflicts.length === 1 ? "" : "s"} fall outside the new hours
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {total} reserved hour{total === 1 ? "" : "s"} in total. Existing bookings are honoured by default — the new
                schedule only applies to bookings made from now on.
              </p>
            </div>
          </div>
          <button onClick={onDismiss} disabled={busy} className="rounded-md p-1 hover:bg-secondary" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="nice-scroll flex-1 divide-y divide-border overflow-y-auto px-5">
          {conflicts.map((c) => (
            <li key={c.bookingIds.join(",")} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{formatDateLabel(c.startTime)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatSessionLabel(c.startTime, c.endTime)} · {c.courtName} · {c.playerName}
                </p>
              </div>
              {c.paid && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  Paid
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border p-5">
          <button onClick={onDismiss} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold">
            Back to editing
          </button>
          <button
            onClick={onCancelThem}
            disabled={busy}
            className="rounded-lg border border-destructive/40 px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Cancel &amp; refund them
          </button>
          <button
            onClick={onKeep}
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Keep them (recommended)"}
          </button>
        </div>
      </div>
    </div>
  );
}
