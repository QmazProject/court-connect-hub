/** Walk-in bookings: what they are, and whose money they represent.
 *
 *  A walk-in is a booking taken at the desk. It occupies a court exactly as an
 *  online booking does — the same calendar, the same conflict rules — but the
 *  cash went into the venue's till, not into Court Connect Hub's PayMongo
 *  account. Every rule in this file exists to keep those two facts apart, and
 *  the one that matters most is this: money a tenant collected itself is never
 *  money the platform owes that tenant.
 *
 *  Nothing here reaches a database. The authority for who may create a walk-in
 *  is `venue_allows(venue_id, 'manager')` inside
 *  `tenant_create_walkin_booking()`, and the authority for whether a slot is
 *  free is the `validate_booking()` trigger. These are the pure rules the
 *  screens and the tests share, so both read the same arithmetic.
 */

export const BOOKING_SOURCES = ["online", "walk_in", "admin_manual"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const COLLECTION_SOURCES = ["platform", "tenant", "unpaid"] as const;
export type PaymentCollectionSource = (typeof COLLECTION_SOURCES)[number];

/** Badge text, matching the wording the request asked for. */
export const BOOKING_SOURCE_LABEL: Record<BookingSource, string> = {
  online: "ONLINE",
  walk_in: "WALK-IN",
  admin_manual: "MANUAL",
};

/** How a walk-in customer paid the venue. Every one of these is tenant-collected;
 *  none of them touches the platform's PayMongo account. */
export const WALKIN_PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash — paid to venue" },
  { value: "maya", label: "Maya — paid to venue" },
  { value: "bank", label: "Bank / direct transfer" },
  { value: "other", label: "Other" },
] as const;

export type WalkInPaymentMethod = (typeof WALKIN_PAYMENT_METHODS)[number]["value"];

/** The collection source implied by a walk-in's payment state. Kept as a
 *  function rather than a literal so the screen and the database agree: the
 *  same mapping is written into `tenant_create_walkin_booking()`. */
export function collectionForWalkIn(paid: boolean): PaymentCollectionSource {
  return paid ? "tenant" : "unpaid";
}

/** The pairing rule the `bookings_source_collection_agree` constraint enforces.
 *  Anything this rejects the database will reject too. */
export function sourcePairingIsValid(
  source: BookingSource,
  collection: PaymentCollectionSource,
): boolean {
  if (source === "online") return collection === "platform";
  if (source === "walk_in") return collection === "tenant" || collection === "unpaid";
  return true; // admin_manual may be settled either way
}

/* ------------------------------------------------------------------ money -- */

/** Centavos, so no total is ever the sum of floating-point pesos. Mirrors
 *  `allocateCheckoutAmounts`, which already treats integer centavos as this
 *  project's settled representation of money. */
export function toCentavos(pesos: number | string | null | undefined): number {
  return Math.round((Number(pesos) || 0) * 100);
}

export type MoneyBooking = {
  booking_source: BookingSource;
  payment_collection_source: PaymentCollectionSource;
  payment_status: string;
  unit_price?: number | null;
};

/** What one booking contributes to each figure, in centavos.
 *
 *  `platformOwesTenant` is the number a payout is eventually paid from, and it
 *  is the reason this function exists. A walk-in adds to the tenant's sales and
 *  adds exactly nothing to it: the platform cannot owe money it never held.
 *
 *  Platform fees are deliberately not modelled here. No fee schedule exists in
 *  this project yet, and inventing one would put a fabricated number into a
 *  settlement figure. Until the ledger phase introduces a real schedule, an
 *  online booking's liability is its gross — which is an overstatement the
 *  fee will later reduce, never an understatement that could overpay. */
export function bookingMoney(b: MoneyBooking) {
  const amount = toCentavos(b.unit_price);
  const settled = b.payment_status === "paid";
  const refunded = b.payment_status === "refunded";

  const counts = settled && !refunded;
  const platformHeld = counts && b.payment_collection_source === "platform";
  const tenantHeld = counts && b.payment_collection_source === "tenant";

  return {
    /** Booking value the marketplace generated, whoever collected it. */
    grossValue: refunded ? 0 : amount,
    /** Cash that actually reached Court Connect Hub's PayMongo account. */
    platformCollected: platformHeld ? amount : 0,
    /** Cash the venue took directly, at the desk. */
    tenantCollected: tenantHeld ? amount : 0,
    /** The only figure a payout may be drawn from. */
    platformOwesTenant: platformHeld ? amount : 0,
  };
}

export type MoneyTotals = ReturnType<typeof bookingMoney>;

export function totalBookingMoney(rows: readonly MoneyBooking[]): MoneyTotals {
  return rows.reduce<MoneyTotals>(
    (acc, row) => {
      const m = bookingMoney(row);
      return {
        grossValue: acc.grossValue + m.grossValue,
        platformCollected: acc.platformCollected + m.platformCollected,
        tenantCollected: acc.tenantCollected + m.tenantCollected,
        platformOwesTenant: acc.platformOwesTenant + m.platformOwesTenant,
      };
    },
    { grossValue: 0, platformCollected: 0, tenantCollected: 0, platformOwesTenant: 0 },
  );
}

/* -------------------------------------------------------------- receipts -- */

/** `CCH-WI-20260914-0042`.
 *
 *  The number is the per-venue `booking_no` that `assign_booking_no()` has
 *  already allocated, not a second counter — two counters would eventually
 *  disagree about the same sale. Mirrors the SQL in
 *  `tenant_create_walkin_booking()`. */
export function walkInReference(venueDateISO: string, bookingNo: number): string {
  return `CCH-WI-${venueDateISO.replace(/-/g, "")}-${String(bookingNo).padStart(4, "0")}`;
}

/* ------------------------------------------------------------ validation -- */

export type WalkInDraft = {
  courtId: number | null;
  dateISO: string;
  startHour: number | null;
  endHour: number | null;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  playerCount?: number | null;
  paid: boolean;
  paymentMethod: WalkInPaymentMethod;
};

/** Client-side checks only, and they grant nothing: every one of them is
 *  re-made by `tenant_create_walkin_booking()` or by the booking trigger. Their
 *  job is to say "no" before a staff member watches a spinner, not to decide
 *  anything. A slot that looks free here can still lose the race, and the
 *  server's refusal is the answer that counts. */
export function validateWalkInDraft(d: WalkInDraft): string[] {
  const errors: string[] = [];
  if (!d.courtId) errors.push("Choose a court.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateISO)) errors.push("Choose a date.");
  if (d.startHour === null || d.endHour === null) errors.push("Choose a time.");
  else if (d.endHour <= d.startHour) errors.push("The booking must end after it starts.");
  if (!d.customerName.trim()) errors.push("Enter the customer's name.");
  if (d.customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.customerEmail))
    errors.push("That email address does not look right.");
  if (d.playerCount != null && (!Number.isInteger(d.playerCount) || d.playerCount < 1))
    errors.push("Number of players must be a whole number above zero.");
  return errors;
}
