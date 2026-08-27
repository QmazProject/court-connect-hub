/**
 * Which hours of a booking a venue may still cancel, and which are gone.
 *
 * Bookings are stored one row per hour, and cancelling used to take the whole session
 * — so cancelling a 7–9pm booking at 7:35, with the player already on court, wiped out
 * an hour that had been played and refunded it. Court time that has started is not
 * recoverable, and releasing it back to availability is a lie: nobody else can book
 * 7–8pm at 7:35.
 *
 * So each hour is judged on its own:
 *
 *   completed    the hour has finished          — never cancellable, no refund
 *   in_progress  being played right now         — only with an explicit override
 *   imminent     starts within IMMINENT_MINUTES — only with an explicit override
 *   open         far enough out to tell someone — freely cancellable
 *
 * The override exists because a court can flood, lose power, or be commandeered for an
 * emergency, and a venue must be able to clear it whatever the clock says. It is
 * deliberately a separate, conscious action rather than the default.
 */

export type CancellableSlot = {
  id: number;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  unit_price: number | null;
  discount_amount: number | null;
};

export type SlotState = "already_cancelled" | "completed" | "in_progress" | "imminent" | "open";

/**
 * How much warning a player is owed before their court is taken away. Inside this
 * window the venue can still cancel, but has to say it means to — at 7:59 for an
 * 8:00 slot there is no realistic way to reach someone already travelling.
 *
 * Fifteen minutes, chosen against the two real cases: cancelling the 8–9pm hour at
 * 7:35 (25 minutes' notice) is ordinary and should not need a warning, while doing it
 * at 7:59 should. A wider window would have made the ordinary case need an override,
 * which trains people to tick the override every time and defeats the point of it.
 */
export const IMMINENT_MINUTES = 15;

export function classifySlot(
  slot: CancellableSlot,
  nowMs: number,
  imminentMinutes: number = IMMINENT_MINUTES,
): SlotState {
  if (slot.status === "cancelled" || slot.status === "expired") return "already_cancelled";
  const start = new Date(slot.start_time).getTime();
  const end = new Date(slot.end_time).getTime();
  if (end <= nowMs) return "completed";
  if (start <= nowMs) return "in_progress";
  if (start - nowMs <= imminentMinutes * 60_000) return "imminent";
  return "open";
}

/** Hours that can never be cancelled, whatever the venue chooses. */
export function isLocked(state: SlotState): boolean {
  return state === "completed" || state === "already_cancelled";
}

/** Hours the venue may cancel only after confirming it means to. */
export function needsOverride(state: SlotState): boolean {
  return state === "in_progress" || state === "imminent";
}

/** Can this hour be picked, given whether the override is on? */
export function isSelectable(state: SlotState, override: boolean): boolean {
  if (isLocked(state)) return false;
  return override || !needsOverride(state);
}

/** What the dialog should tick when it opens: everything safely cancellable. */
export function defaultSelection(slots: CancellableSlot[], nowMs: number): number[] {
  return slots.filter((s) => classifySlot(s, nowMs) === "open").map((s) => s.id);
}

/** Money at stake for the chosen hours. Only paid hours carry a refund; an unpaid
 *  hour releases the court without any money moving. */
export function refundableTotal(slots: CancellableSlot[], selectedIds: number[]): number {
  const chosen = new Set(selectedIds);
  return slots
    .filter((s) => chosen.has(s.id) && s.payment_status === "paid")
    .reduce((sum, s) => sum + (Number(s.unit_price ?? 0) - Number(s.discount_amount ?? 0)), 0);
}

export function hasPaidSelection(slots: CancellableSlot[], selectedIds: number[]): boolean {
  const chosen = new Set(selectedIds);
  return slots.some((s) => chosen.has(s.id) && s.payment_status === "paid");
}

/** Plain-language reason an hour cannot be picked, for the row in the dialog. */
export function slotStateLabel(state: SlotState): string {
  switch (state) {
    case "already_cancelled":
      return "Already cancelled";
    case "completed":
      return "Already played";
    case "in_progress":
      return "In progress now";
    case "imminent":
      return "Starts very soon";
    case "open":
      return "";
  }
}
