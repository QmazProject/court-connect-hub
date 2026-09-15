/**
 * Which actions a booking row should offer.
 *
 * Extracted so the rules are testable rather than living inside a 5,000-line route,
 * and because two of them were wrong in production: a booking whose time had already
 * passed still offered "Cancel", and a refund the venue agreed to settle itself had no
 * way to be marked done.
 */

export type BookingActionInput = {
  status: string;
  refund_status: string;
  /** End of the whole session, not the hourly row. */
  sessionEndsAt: string;
};

/**
 * Cancelling is about releasing court time that has not happened yet. Once the last
 * hour has finished there is nothing left to release: flipping it to cancelled would
 * misreport history, and for a paid booking it would offer a refund for a slot the
 * venue actually held open.
 */
export function canCancel(b: BookingActionInput, nowMs: number): boolean {
  if (b.status === "cancelled" || b.status === "expired") return false;
  return new Date(b.sessionEndsAt).getTime() > nowMs;
}

/** A refund only needs settling while it is still owed. */
export function canSettleRefund(b: BookingActionInput): boolean {
  return b.refund_status === "pending";
}

/** How a completed refund should be described in the booking history. */
export function describeRefund(
  refundStatus: string,
  method: string | null | undefined,
): string | null {
  if (refundStatus !== "refunded") return null;
  if (method === "paymongo") return "via PayMongo";
  if (method === "manual") return "settled manually";
  // Refunded before this was recorded, or by a path that did not set it.
  return "refunded";
}

/**
 * How close to the start a player may still call off their own booking.
 *
 * A venue may cancel mid-session with an explicit override (see `classifySlot`), because
 * a court can flood. A player has no such case: once the hour is essentially upon them
 * the court has been held, nobody else can take it, and letting the booking evaporate a
 * second before it starts is how a venue loses an hour it could never resell.
 *
 * One minute rather than a policy window, because this is not the refund rule — the
 * venue's `refund_cutoff_hours` still decides what money comes back. This only decides
 * whether the button is there at all.
 */
export const PLAYER_CANCEL_CUTOFF_MS = 60_000;

/** A player cancel needs the start as well as the end, which `canCancel` never did. */
export type PlayerCancelInput = BookingActionInput & { sessionStartsAt: string };

export type PlayerCancelBlocked = "already_cancelled" | "in_progress" | "too_late" | "finished";

export type PlayerCancelState =
  { allowed: true } | { allowed: false; reason: PlayerCancelBlocked; message: string };

/**
 * Whether a player may still cancel, and if not, what to tell them.
 *
 * A reason rather than a bare false: the button vanishing with no explanation is the
 * thing players ask support about. Every branch returns a sentence the UI can print
 * beside the booking instead of the action.
 *
 * The clock is read once by the caller and passed in, so a card cannot decide the
 * button is live and the handler decide it is not a millisecond later.
 */
export function playerCancelState(b: PlayerCancelInput, nowMs: number): PlayerCancelState {
  if (b.status === "cancelled" || b.status === "expired") {
    return {
      allowed: false,
      reason: "already_cancelled",
      message: "This booking is already cancelled.",
    };
  }

  const start = new Date(b.sessionStartsAt).getTime();
  const end = new Date(b.sessionEndsAt).getTime();

  if (end <= nowMs) {
    return {
      allowed: false,
      reason: "finished",
      message: "This booking has already finished, so there is nothing left to cancel.",
    };
  }
  if (start <= nowMs) {
    return {
      allowed: false,
      reason: "in_progress",
      message:
        "This booking has already started and can no longer be cancelled. Message the venue if you need help.",
    };
  }
  if (start - nowMs <= PLAYER_CANCEL_CUTOFF_MS) {
    return {
      allowed: false,
      reason: "too_late",
      message:
        "This booking starts in less than a minute, so it can no longer be cancelled. Message the venue if you need help.",
    };
  }
  return { allowed: true };
}

/**
 * Whether the booking's message thread still accepts messages.
 *
 * A thread belongs to a booking, and once that booking has been played there is
 * usually nothing left to arrange — a thread that stays open for ever is one a venue
 * has to keep watching long after the court was swept.
 *
 * With one exception, which is the reason this is not simply "has it ended yet": this
 * thread is where a refund settled by hand gets agreed, and that conversation happens
 * *after* the booking was supposed to be played. Closing it on the end time would shut
 * the door on the one discussion that has to outlive the booking. So a cancelled
 * booking, or one whose refund is still owed, keeps its thread open.
 *
 * Closing is symmetric — the player and the venue lose the composer together. A thread
 * one side can still write to is not closed, it is just unfair.
 *
 * History is never hidden by this. Only the composer goes.
 */
export type ChatWindow = { open: true } | { open: false; message: string };

export function bookingChatWindow(b: BookingActionInput, nowMs: number): ChatWindow {
  if (new Date(b.sessionEndsAt).getTime() > nowMs) return { open: true };

  /* Past its time, but the money is not finished. */
  if (b.status === "cancelled" || b.refund_status === "pending" || b.refund_status === "failed") {
    return { open: true };
  }

  return {
    open: false,
    message:
      "This booking has been played, so its messages are now closed. You can still read the conversation.",
  };
}
