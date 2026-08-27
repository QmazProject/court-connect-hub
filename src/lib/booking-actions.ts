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
