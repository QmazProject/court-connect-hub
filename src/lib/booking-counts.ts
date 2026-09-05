/** The single definition of "a booking that counts", shared by every pane that
 *  reports one. It lives here rather than being restated at each call site
 *  because the panes drifted apart once already: the tenant Customers table was
 *  counting cancelled rows toward a customer's booking total — and therefore
 *  toward repeat-customer status — while the Dashboard's own metrics skipped
 *  them. Two readings of the word "booking" in one workspace is the bug this
 *  module exists to make impossible. */

/** Statuses that mean the session never happened. `expired` is an unpaid hold
 *  that timed out; neither it nor a cancellation is a booking the venue served. */
export const NON_COUNTING_STATUSES = ["cancelled", "expired"] as const;

export type CountableBooking = {
  status?: string | null;
  /** Set when a booking was cancelled through the refund flow. Checked as well as
   *  `status` because a row can carry the timestamp while its status lags. */
  cancelled_at?: string | null;
};

/** True when a booking should count toward booking totals, occupancy, court and
 *  venue leaderboards, and a customer's lifetime history.
 *
 *  Payment is deliberately not consulted. A pay-at-venue booking that was played
 *  and settled in cash is a real booking; gating on `payment_status` would erase
 *  exactly the customers a venue most wants to recognise. */
export function isCountableBooking(booking: CountableBooking): boolean {
  if (booking.cancelled_at != null) return false;
  const status = booking.status ?? "";
  return !(NON_COUNTING_STATUSES as readonly string[]).includes(status);
}

/** The countable subset, in the order given. */
export function countableBookings<T extends CountableBooking>(rows: readonly T[]): T[] {
  return rows.filter(isCountableBooking);
}

/** How many countable bookings each user has, keyed by user id. */
export function countByUser<T extends CountableBooking & { user_id: string }>(
  rows: readonly T[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isCountableBooking(row)) continue;
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  }
  return counts;
}

/** A repeat customer has come back: more than one countable booking across their
 *  whole history with this tenant. Deliberately a lifetime measure — a reporting
 *  period scopes what a customer spent, never whether they ever returned. */
export function isRepeatCustomer(lifetimeCountableBookings: number): boolean {
  return lifetimeCountableBookings > 1;
}

/** PostgREST filter value for excluding the non-counting statuses in the query
 *  itself, so a row cap is spent only on rows that can count. Used as
 *  `.not("status", "in", NON_COUNTING_STATUS_FILTER)`. */
export const NON_COUNTING_STATUS_FILTER = `(${NON_COUNTING_STATUSES.join(",")})`;
