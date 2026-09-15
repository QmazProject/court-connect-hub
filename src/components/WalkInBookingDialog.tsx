/** Taking a booking for someone standing at the desk.
 *
 *  The screen shows availability, but it never decides it. Every hour drawn here
 *  came from `get_court_availability`, and by the time a member of staff has read
 *  a name off a phone screen and typed it in, that answer is seconds old. The
 *  authority is the `validate_booking()` trigger, which re-checks capacity under
 *  `pg_advisory_xact_lock(physical_court_id)` at the moment of insert. So a slot
 *  shown free here can still be refused, and when it is, this dialog says so and
 *  reloads availability rather than pretending the booking exists.
 *
 *  Money: the total below is a quotation drawn from the same rate rules the
 *  server prices with, shown so the customer can be told a number. It is not
 *  sent. `tenant_create_walkin_booking()` prices the booking itself, which is
 *  what stops a discount being applied by editing a request.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CalendarDays, Check, Loader2, Receipt, X } from "lucide-react";
import { createWalkInBooking, type WalkInResult } from "@/lib/walkin.functions";
import { getCourtAvailability, type CourtAvailabilityRow } from "@/lib/availability.functions";
import {
  WALKIN_PAYMENT_METHODS,
  validateWalkInDraft,
  type WalkInDraft,
  type WalkInPaymentMethod,
} from "@/lib/walkin";
import { normalizeRules, rateForHour, peso, fmtHour12 } from "@/lib/court-pricing";
import { zonedDateISO, zonedDayBoundsUtc, zonedHour } from "@/lib/tz";

export type WalkInCourt = {
  id: number;
  name: string;
  hourly_rate: number;
  rate_rules: unknown;
  sport?: string | null;
};

type SlotState = "free" | "taken" | "blocked" | "held";

export function WalkInBookingDialog({
  venueName,
  courts,
  onClose,
  onCreated,
}: {
  venueName: string;
  courts: WalkInCourt[];
  onClose: () => void;
  onCreated?: (result: WalkInResult) => void;
}) {
  const createFn = useServerFn(createWalkInBooking);
  const availabilityFn = useServerFn(getCourtAvailability);

  const [courtId, setCourtId] = useState<number | null>(courts[0]?.id ?? null);
  const [dateISO, setDateISO] = useState(() => zonedDateISO());
  const [startHour, setStartHour] = useState<number | null>(null);
  const [endHour, setEndHour] = useState<number | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [playerCount, setPlayerCount] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<WalkInPaymentMethod>("cash");
  const [paid, setPaid] = useState(true);

  const [rows, setRows] = useState<CourtAvailabilityRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WalkInResult | null>(null);

  const court = courts.find((c) => c.id === courtId) ?? null;

  const loadAvailability = useCallback(async () => {
    if (!courtId) return;
    setLoading(true);
    setErr(null);
    try {
      const { start, end } = zonedDayBoundsUtc(dateISO);
      const data = await availabilityFn({
        data: { courtId, from: start.toISOString(), to: end.toISOString() },
      });
      setRows(data);
    } catch (e) {
      setErr((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [availabilityFn, courtId, dateISO]);

  useEffect(() => {
    void loadAvailability();
    setStartHour(null);
    setEndHour(null);
  }, [loadAvailability]);

  /** One entry per hour the court is open that day, with why it cannot be taken. */
  const slots = useMemo(() => {
    return (rows ?? []).map((r) => {
      const hour = zonedHour(r.hour_start);
      const state: SlotState = r.blocked_by_other_sport
        ? "blocked"
        : r.held_for_payment
          ? "held"
          : r.remaining > 0
            ? "free"
            : "taken";
      return { hour, state, remaining: r.remaining };
    });
  }, [rows]);

  const rules = useMemo(() => normalizeRules(court?.rate_rules), [court]);

  /* The quotation. Priced per hour from the court's own rules, exactly as
     `court_price_for_hours` does on the server. */
  const quotedTotal = useMemo(() => {
    if (!court || startHour === null || endHour === null || endHour <= startHour) return 0;
    let sum = 0;
    for (let h = startHour; h < endHour; h += 1) {
      sum += rateForHour(Number(court.hourly_rate), rules, dateISO, h);
    }
    return sum;
  }, [court, rules, dateISO, startHour, endHour]);

  const draft: WalkInDraft = {
    courtId,
    dateISO,
    startHour,
    endHour,
    customerName,
    customerEmail: customerEmail || undefined,
    playerCount: playerCount ? Number(playerCount) : null,
    paid,
    paymentMethod,
  };
  const errors = validateWalkInDraft(draft);
  const canSubmit = errors.length === 0 && !busy;

  /** Clicking an hour starts a selection; clicking a later free hour extends it. */
  const pickHour = (hour: number, state: SlotState) => {
    if (state !== "free") return;
    if (startHour === null || endHour !== null) {
      setStartHour(hour);
      setEndHour(hour + 1);
      return;
    }
    if (hour < startHour) {
      setStartHour(hour);
      setEndHour(hour + 1);
      return;
    }
    setEndHour(hour + 1);
  };

  const submit = async () => {
    if (!courtId || startHour === null || endHour === null) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await createFn({
        data: {
          courtId,
          date: dateISO,
          startHour,
          endHour,
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim() || undefined,
          customerEmail: customerEmail.trim() || undefined,
          playerCount: playerCount ? Number(playerCount) : undefined,
          notes: notes.trim() || undefined,
          paymentMethod,
          paid,
        },
      });
      setReceipt(res);
      onCreated?.(res);
    } catch (e) {
      setErr((e as Error).message);
      // Somebody may have taken the slot. Re-read rather than leave a stale grid.
      void loadAvailability();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h3 className="font-display text-lg font-semibold">
                {receipt ? "Walk-in booking" : "New walk-in booking"}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{venueName}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {receipt ? (
          <div className="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5 text-sm">
            <div className="flex items-center gap-2 rounded-xl bg-secondary/60 p-3">
              <Check className="h-4 w-4 text-primary" />
              <span>Booked. The court is now unavailable to online players.</span>
            </div>
            <dl className="space-y-1.5 rounded-xl border border-border p-3 text-xs">
              <Line term="Booking" value={receipt.reference} mono />
              <Line term="Customer" value={customerName.trim()} />
              <Line term="Venue" value={venueName} />
              <Line term="Court" value={court?.name ?? ""} />
              <Line term="Date" value={dateISO} />
              <Line
                term="Time"
                value={
                  startHour !== null && endHour !== null
                    ? `${fmtHour12(startHour)} – ${fmtHour12(endHour)}`
                    : ""
                }
              />
              <Line term="Amount" value={peso(receipt.total)} />
              <Line
                term="Payment"
                value={
                  paid
                    ? `${WALKIN_PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label} — paid at venue`
                    : "Unpaid — pay later"
                }
              />
            </dl>
            <p className="rounded-xl border border-border bg-secondary/40 p-3 text-[11px] text-muted-foreground">
              <Receipt className="mr-1 inline h-3 w-3" />
              Collected by the venue. This sale is not part of your Court Connect Hub payout
              balance.
            </p>
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="nice-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5 text-sm">
            <Field label="Court">
              <select
                value={courtId ?? ""}
                onChange={(e) => setCourtId(Number(e.target.value))}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              >
                {courts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.sport ? ` · ${c.sport}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date">
              <input
                type="date"
                value={dateISO}
                min={zonedDateISO()}
                onChange={(e) => setDateISO(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </Field>

            <Field label="Time">
              {loading ? (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Checking availability…
                </div>
              ) : slots.length === 0 ? (
                <p className="rounded-xl border border-border p-3 text-xs text-muted-foreground">
                  This court is not open on that date.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-1.5">
                    {slots.map((s) => {
                      const chosen =
                        startHour !== null &&
                        endHour !== null &&
                        s.hour >= startHour &&
                        s.hour < endHour;
                      return (
                        <button
                          key={s.hour}
                          type="button"
                          disabled={s.state !== "free"}
                          onClick={() => pickHour(s.hour, s.state)}
                          title={SLOT_TITLE[s.state]}
                          className={`rounded-lg border px-1 py-1.5 text-[11px] transition ${
                            chosen
                              ? "border-primary bg-primary text-primary-foreground"
                              : s.state === "free"
                                ? "border-border hover:bg-secondary"
                                : "cursor-not-allowed border-border/60 bg-muted/50 text-muted-foreground line-through"
                          }`}
                        >
                          {fmtHour12(s.hour)}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Unavailable hours are already booked online or at the desk, held for a payment
                    in progress, or blocked by another sport on the same court.
                  </p>
                </>
              )}
            </Field>

            <Field label="Customer">
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Full name"
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <input
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="Mobile (optional)"
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  value={playerCount}
                  onChange={(e) => setPlayerCount(e.target.value.replace(/\D/g, ""))}
                  placeholder="Players (optional)"
                  inputMode="numeric"
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <input
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="Email (optional)"
                className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)"
                rows={2}
                className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </Field>

            <Field label="Payment">
              <div className="flex flex-wrap gap-1.5">
                {WALKIN_PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      setPaymentMethod(m.value);
                      setPaid(true);
                    }}
                    className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                      paid && paymentMethod === m.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-secondary"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPaid(false)}
                  className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                    !paid
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-secondary"
                  }`}
                >
                  Unpaid / pay later
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Collected by the venue, not by Court Connect Hub. This does not change your payout
                balance.
              </p>
            </Field>

            {quotedTotal > 0 && (
              <div className="flex items-center justify-between rounded-xl bg-secondary/60 px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {startHour !== null && endHour !== null
                    ? `${fmtHour12(startHour)} – ${fmtHour12(endHour)}`
                    : ""}
                </span>
                <span className="font-display text-base font-semibold">{peso(quotedTotal)}</span>
              </div>
            )}

            {err && (
              <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {err}
              </p>
            )}

            <button
              onClick={submit}
              disabled={!canSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? "Booking…" : "Confirm walk-in booking"}
            </button>
            {errors.length > 0 && <p className="text-[11px] text-muted-foreground">{errors[0]}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const SLOT_TITLE: Record<SlotState, string> = {
  free: "Available",
  taken: "Already booked",
  held: "Held for a payment in progress",
  blocked: "Blocked by another sport on this court",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function Line({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className={mono ? "font-mono" : ""}>{value}</dd>
    </div>
  );
}
