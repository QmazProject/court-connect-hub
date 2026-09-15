/**
 * Turning payment rows into checkouts.
 *
 * The ledger stores one row per booked hour, not one per payment: a customer who
 * books 6–9pm in a single checkout leaves three rows. This module puts them back
 * together for the accounting view, and it is deliberately pure so the rules can be
 * tested without a browser or a database.
 *
 * The key is `provider_ref`, the payment gateway's checkout session. That is not a
 * guess: `finalize_paid_checkout()` and the payment webhook both already resolve a
 * checkout with `WHERE provider_ref = _session_id`, so it is the ledger's own
 * definition of one payment attempt. The gateway's *payment* id is deliberately not
 * used — it is written only once a payment succeeds, so every pending, failed and
 * cancelled row would fall into one meaningless bucket together.
 */

import { groupBookingSessions, type HourlyBooking } from "@/lib/booking-groups";

/** One payment row, with the booking it settled embedded alongside it. */
export type TxLike = {
  id: string;
  booking_id: number;
  venue_id: number;
  user_id: string;
  /** The ledger's own figure: the checkout total split evenly across its rows. */
  amount: number;
  method: string;
  status: string;
  provider_ref?: string | null;
  reference_number?: string | null;
  raw?: { payment_id?: string } | null;
  paid_at?: string | null;
  created_at: string;
  bookings?: {
    booking_no: number | null;
    court_id: number;
    start_time: string;
    end_time: string;
    status: string;
    payment_status: string;
    refund_status?: string | null;
    /** Where the booking came from, and who ended up holding the cash. Absent on
     *  rows fetched by older queries, which every reader below defaults to the
     *  classification every booking had before walk-ins existed. */
    booking_source?: string | null;
    payment_collection_source?: string | null;
    /** How the money was given back, for the refund column. */
    refund_reference?: string | null;
    refund_method?: string | null;
    walkin_payment_method?: string | null;
    /** What this hour actually cost, which is not the even split above. */
    unit_price?: number | null;
    discount_amount?: number | null;
    courts?: { name: string } | null;
  } | null;
};

export type MemberState =
  | "paid"
  /** Money the VENUE took directly — a walk-in paid at the desk. A real sale, and
   *  never part of what Court Connect owes the tenant. */
  | "tenant_collected"
  | "refunded"
  /** Money that arrived, for a booking that is gone and has not been paid back yet. */
  | "refund_due"
  | "pending"
  | "failed"
  | "cancelled"
  | "unknown";

export type GroupStatus =
  | "paid"
  /** Every line was collected by the venue itself — a walk-in session. */
  | "tenant_collected"
  | "refunded"
  | "partially_refunded"
  | "refund_due"
  | "pending"
  | "failed"
  | "cancelled"
  | "mixed";

export type GroupLine = {
  txId: string;
  bookingId: number;
  bookingNo: number | null;
  court: string | null;
  startTime: string;
  endTime: string;
  /** The booking's own price, not the ledger's even split. Null when unpriced. */
  price: number | null;
  state: MemberState;
};

export type TxGroup = {
  /** Stable across renders: the checkout, or the row itself when it has no checkout. */
  key: string;
  /** What to show a human. Never invented — null when the data has no identifier. */
  reference: string | null;
  /** Where `reference` came from, so the UI can label it honestly. */
  referenceKind: "merchant" | "gateway" | "none";
  userId: string;
  venueId: number;
  /** Summed from the payment rows, so it reconciles against the gateway. */
  total: number;
  /** Summed from the bookings' own prices. May legitimately differ from `total`. */
  bookingTotal: number | null;
  /** True when the two totals disagree by more than a centavo. */
  discrepancy: boolean;
  /** Payment rows whose booking or row says refunded. */
  refundedTotal: number;
  method: string;
  status: GroupStatus;
  courts: string[];
  /** Consecutive hours merged; non-consecutive stay separate. */
  sessions: { start: string; end: string; hours: number }[];
  totalHours: number;
  bookingCount: number;
  /** The latest settlement time in the group, or the earliest creation if unpaid. */
  at: string;
  paymentId: string | null;
  lines: GroupLine[];
};

/** Money is compared in centavos: 0.1 + 0.2 is not 0.3, and a reconciliation
 *  indicator that fires on float noise is worse than none. */
const cents = (n: number) => Math.round(n * 100);

/** What one row of a checkout actually amounts to.
 *
 *  The booking is consulted as well as the payment row because two refund paths —
 *  a manually settled refund, and a player cancelling a paid booking — update the
 *  booking and never touch the ledger. Reading the payment row alone would report a
 *  refund your staff already settled as still paid. */
/**
 * What a payment row actually amounts to, once the booking is taken into account.
 *
 * The single source of truth on the tenant side. Every screen that shows a payment's
 * state, and every figure that adds money up, goes through here — otherwise the
 * Transactions table and the revenue tiles drift apart, which is exactly what
 * happened before this existed.
 *
 * The booking is consulted because a refund can be finalised without the ledger row
 * being touched at all: `staff_mark_refund_settled()` writes to `bookings` alone, and
 * a player cancelling a paid booking does the same. Reading the payment row by itself
 * reports a refund settled last week as money the business still holds.
 *
 * Three outcomes for money that arrived, not two. `refunded` is money given back.
 * `paid` is money kept. Between them sits `refund_due`: the booking is cancelled or the
 * refund is still owed, so the venue holds money it is going to return. Counting that as
 * a sale is what made a cancelled booking go on reading `paid` in the Transactions
 * table while the bookings module showed it cancelled.
 */
export function effectiveTxState(
  txStatus: string | null | undefined,
  bookingPaymentStatus?: string | null,
  bookingRefundStatus?: string | null,
  bookingStatus?: string | null,
  collectionSource?: string | null,
): MemberState {
  /* Settled refunds first: a booking that has been refunded outranks whatever the
     payment row still says about itself. */
  if (
    txStatus === "refunded" ||
    bookingRefundStatus === "refunded" ||
    bookingPaymentStatus === "refunded"
  )
    return "refunded";

  const moneyArrived = txStatus === "paid" || bookingPaymentStatus === "paid";

  /* Money in, booking gone, nothing paid back yet.
     A cancelled booking is not a sale. It was being reported as one because this
     function only ever asked the payment row and the refund column, and a player
     cancelling their own booking touches neither — so the ledger went on calling it
     `paid` while the bookings module showed it cancelled. The two now agree.

     It is deliberately NOT `refunded`: nothing has been given back. The venue still
     holds the money and still owes it, which is a third state and reads as one, so
     `gross` keeps counting it and `net` does not.

     The trigger is the booking's own status and nothing else. A `pending` refund on a
     booking that is still going ahead stays `paid`, which is the long-standing rule
     here and the right one — a refund that has merely been requested has not happened,
     and the money is still the venue's until somebody cancels the booking or sends it
     back. What changed is only that a cancelled booking is no longer counted as a sale
     while its refund is outstanding. */
  if (moneyArrived && (bookingStatus === "cancelled" || bookingStatus === "expired"))
    return "refund_due";

  /* Walk-in cash. It is money in hand for the venue, so it is a sale and reads as
     one, but it is not money Court Connect holds and must never reach a payout
     figure. Keeping it as its own state is what stops a later reader adding it to
     `paid` and quietly inflating the platform's liability. */
  if (moneyArrived && collectionSource === "tenant") return "tenant_collected";

  if (moneyArrived) return "paid";
  if (txStatus === "pending") return "pending";
  if (txStatus === "failed") return "failed";
  if (txStatus === "cancelled") return "cancelled";
  return "unknown";
}

/** The same question, for a row with its booking embedded. */
export function memberState(tx: TxLike): MemberState {
  return effectiveTxState(
    tx.status,
    tx.bookings?.payment_status,
    tx.bookings?.refund_status,
    tx.bookings?.status,
  );
}

/** The same, but distinguishing money the venue took itself. Separate from
 *  `memberState` rather than replacing it, because the grouping and filtering
 *  logic above is asserted against that one's answers; screens that want to show
 *  a walk-in as tenant-collected ask for it explicitly. */
export function memberStateBySource(tx: TxLike): MemberState {
  return effectiveTxState(
    tx.status,
    tx.bookings?.payment_status,
    tx.bookings?.refund_status,
    tx.bookings?.status,
    tx.bookings?.payment_collection_source ?? "platform",
  );
}

/** Gross, refunded and net for one payment row, in pesos.
 *
 *  `net` is what the business actually keeps: nothing for a settled refund, and
 *  nothing for money owed back on a cancelled booking. Derived here rather than
 *  in the screen so the transactions table and the revenue tiles cannot round or
 *  classify a row differently from one another. */
export function transactionAmounts(tx: TxLike): {
  gross: number;
  refunded: number;
  net: number;
  state: MemberState;
} {
  const state = memberStateBySource(tx);
  const grossCents = Math.round((Number(tx.amount) || 0) * 100);
  const counted =
    state === "paid" ||
    state === "tenant_collected" ||
    state === "refunded" ||
    state === "refund_due";
  const refundedCents = state === "refunded" ? grossCents : 0;
  const keptCents = state === "paid" || state === "tenant_collected" ? grossCents : 0;
  return {
    gross: counted ? grossCents / 100 : 0,
    refunded: refundedCents / 100,
    net: keptCents / 100,
    state,
  };
}

/** Badge text for where a booking came from. */
export function bookingSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "walk_in":
      return "WALK-IN";
    case "admin_manual":
      return "MANUAL";
    default:
      return "ONLINE";
  }
}

/** Who held the cash, said plainly enough that nobody has to infer it. */
export function collectionSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "tenant":
      return "Collected by you";
    case "unpaid":
      return "Unpaid";
    default:
      return "Collected by Court Connect";
  }
}

/** Money the business still holds, however it was collected. The one test any
 *  revenue figure should apply. */
export function isRetainedSale(state: MemberState): boolean {
  return state === "paid" || state === "tenant_collected";
}

/** Money COURT CONNECT holds, which is the only money a payout can be drawn
 *  from. Deliberately narrower than `isRetainedSale`: a walk-in is a retained
 *  sale and is not platform-held, and conflating the two is the accounting error
 *  this whole module exists to prevent. */
export function isPlatformHeld(state: MemberState): boolean {
  return state === "paid";
}

/** Money that has been given back — finalised, not merely requested. */
export function isSettledRefund(state: MemberState): boolean {
  return state === "refunded";
}

/** Shape shared by every tenant query that needs the effective state of a payment. */
export type RevenueRow = {
  status: string;
  amount: number | string;
  bookings?: {
    payment_status?: string | null;
    refund_status?: string | null;
    /** The booking's own status. Without it a cancelled booking still reads as a sale. */
    status?: string | null;
    /** platform | tenant | unpaid. Absent on rows fetched by older queries, which
     *  is why every reader below defaults it to 'platform' — the classification
     *  every booking had before walk-ins existed. */
    payment_collection_source?: string | null;
    booking_source?: string | null;
  } | null;
};

/** The effective state of a revenue row, wherever it was fetched from.
 *
 *  Unchanged on purpose: it does NOT pass the collection source, so every
 *  existing caller keeps classifying walk-in cash as `paid` exactly as it did
 *  before. Readers that need the platform/tenant split ask
 *  `revenueStateBySource` below, which is additive. */
export function revenueState(row: RevenueRow): MemberState {
  return effectiveTxState(
    row.status,
    row.bookings?.payment_status,
    row.bookings?.refund_status,
    row.bookings?.status,
  );
}

/** The same question, but distinguishing who actually holds the money. Rows with
 *  no recorded source are treated as `platform`, which is what every booking was
 *  before walk-ins existed. */
export function revenueStateBySource(row: RevenueRow): MemberState {
  return effectiveTxState(
    row.status,
    row.bookings?.payment_status,
    row.bookings?.refund_status,
    row.bookings?.status,
    row.bookings?.payment_collection_source ?? "platform",
  );
}

/** Gross taken, refunds returned, refunds still owed, and what is actually kept. */
export function summariseRevenue(rows: RevenueRow[]): {
  gross: number;
  refunded: number;
  /** Money still held against a booking that was cancelled and not yet paid back. */
  refundDue: number;
  net: number;
} {
  let grossCents = 0;
  let refundedCents = 0;
  let refundDueCents = 0;
  for (const row of rows) {
    const state = revenueState(row);
    const amount = Math.round((Number(row.amount) || 0) * 100);
    /* Gross is everything the customer actually paid, refunded or not — a refund is
       money that arrived and then left, not money that never came. Money that is on its
       way back has still arrived, so it belongs here too. */
    if (state === "paid" || state === "refunded" || state === "refund_due") grossCents += amount;
    if (state === "refunded") refundedCents += amount;
    if (state === "refund_due") refundDueCents += amount;
  }
  /* Net is what the business gets to keep. A refund that has been agreed but not yet
     sent is already spent — reporting it as revenue until the transfer clears is how a
     venue reconciles against a bank balance that was never going to match. */
  return {
    gross: grossCents / 100,
    refunded: refundedCents / 100,
    refundDue: refundDueCents / 100,
    net: (grossCents - refundedCents - refundDueCents) / 100,
  };
}

/** The group's status, from every member rather than the first one. */
export function groupStatus(states: MemberState[]): GroupStatus {
  if (states.length === 0) return "mixed";
  const has = (s: MemberState) => states.includes(s);
  const all = (s: MemberState) => states.every((x) => x === s);

  if (all("refunded")) return "refunded";
  if (all("paid")) return "paid";
  if (all("tenant_collected")) return "tenant_collected";
  if (all("refund_due")) return "refund_due";
  if (all("pending")) return "pending";
  if (all("failed")) return "failed";
  if (all("cancelled")) return "cancelled";
  /* The case partial refunds actually produce: some hours given back, the rest kept. */
  if (has("refunded") && has("paid") && !has("pending") && !has("failed") && !has("unknown"))
    return "partially_refunded";
  return "mixed";
}

/** An attempt that never became money. Hidden from the grouped view by default. */
export function isSpentAttempt(status: GroupStatus): boolean {
  return status === "failed" || status === "cancelled";
}

const priceOf = (tx: TxLike): number | null => {
  const b = tx.bookings;
  if (!b || b.unit_price == null) return null;
  return Number(b.unit_price) - Number(b.discount_amount ?? 0);
};

/**
 * Groups payment rows into checkouts.
 *
 * Rows sharing a non-null `provider_ref` are one checkout. A row without one stands
 * alone under its own id — never bundled with other null rows, which would merge
 * unrelated payments from different customers into a single fictional checkout.
 */
export function groupTransactions(rows: TxLike[]): TxGroup[] {
  const buckets = new Map<string, TxLike[]>();
  for (const tx of rows) {
    const ref = tx.provider_ref?.trim();
    const key = ref ? `ref:${ref}` : `tx:${tx.id}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(tx);
    else buckets.set(key, [tx]);
  }

  const groups: TxGroup[] = [];
  for (const [key, members] of buckets) {
    const states = members.map(memberState);
    const status = groupStatus(states);

    const totalCents = members.reduce((s, m) => s + cents(Number(m.amount)), 0);
    const prices = members.map(priceOf);
    const bookingTotalCents = prices.some((p) => p === null)
      ? null
      : prices.reduce((s: number, p) => s + cents(p as number), 0);
    const refundedCents = members.reduce(
      (s, m, i) => (states[i] === "refunded" ? s + cents(Number(m.amount)) : s),
      0,
    );

    /* Consecutive hours only, and only within this checkout. Booking adjacency is a
       display rule here, never the grouping key: two separate checkouts for adjacent
       hours are two payments and must stay two rows. */
    const hourly: HourlyBooking[] = members
      .filter((m) => m.bookings)
      .map((m) => ({
        id: m.booking_id,
        court_id: m.bookings!.court_id,
        user_id: m.user_id,
        start_time: m.bookings!.start_time,
        end_time: m.bookings!.end_time,
        /* One run per court and customer. Booking status is deliberately not part of
           the key: a refunded hour in the middle of a paid checkout is still the same
           stretch of time, and splitting on it would misreport what was booked. */
        status: "",
        payment_status: "",
      }));
    const sessions = groupBookingSessions(hourly)
      .map((s) => ({ start: s.start_time, end: s.end_time, hours: s.hours }))
      .sort((a, b) => a.start.localeCompare(b.start));

    const courts = Array.from(
      new Set(members.map((m) => m.bookings?.courts?.name).filter((n): n is string => !!n)),
    ).sort();

    const methods = Array.from(new Set(members.map((m) => m.method)));
    const settled = members.map((m) => m.paid_at).filter((d): d is string => !!d);
    const paymentId = members.map((m) => m.raw?.payment_id).find((p) => !!p) ?? null;

    /* The merchant's own reference is preferred and the gateway's is the fallback.
       When a row has neither, nothing is invented — the UI shows the row id it
       already has rather than a reference that never existed. */
    const merchant = members.map((m) => m.reference_number?.trim()).find((r) => !!r) ?? null;
    const gateway = members.map((m) => m.provider_ref?.trim()).find((r) => !!r) ?? null;

    const lines: GroupLine[] = members
      .map((m, i) => ({
        txId: m.id,
        bookingId: m.booking_id,
        bookingNo: m.bookings?.booking_no ?? null,
        court: m.bookings?.courts?.name ?? null,
        startTime: m.bookings?.start_time ?? m.created_at,
        endTime: m.bookings?.end_time ?? m.created_at,
        price: prices[i],
        state: states[i],
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    groups.push({
      key,
      reference: merchant ?? gateway,
      referenceKind: merchant ? "merchant" : gateway ? "gateway" : "none",
      userId: members[0].user_id,
      venueId: members[0].venue_id,
      total: totalCents / 100,
      bookingTotal: bookingTotalCents === null ? null : bookingTotalCents / 100,
      discrepancy: bookingTotalCents !== null && bookingTotalCents !== totalCents,
      refundedTotal: refundedCents / 100,
      method: methods.length === 1 ? methods[0] : "mixed",
      status,
      courts,
      sessions,
      totalHours: sessions.reduce((s, x) => s + x.hours, 0),
      bookingCount: new Set(members.map((m) => m.booking_id)).size,
      at:
        settled.sort().at(-1) ??
        members
          .map((m) => m.created_at)
          .sort()
          .at(-1) ??
        members[0].created_at,
      paymentId,
      lines,
    });
  }

  /* Newest first, matching the detailed table above it. */
  return groups.sort((a, b) => b.at.localeCompare(a.at));
}

/** One page of payment rows, and where the next page should resume.
 *
 *  `cursor` is **inclusive**: the next page asks for rows at or older than it. The
 *  run sharing that timestamp was held back from this page precisely because it might
 *  have been cut in half, so the next page has to start by reading it whole. An
 *  exclusive cursor would step straight over those rows and lose them. */
export type TxPage<T> = { rows: T[]; cursor: string | null };

/**
 * Cuts a fetched block of rows at a boundary that cannot fall inside a checkout.
 *
 * Every row of one checkout carries the same `created_at`, because they are written
 * by a single multi-row INSERT and Postgres `now()` is the transaction's start time.
 * So the only place a fixed-size fetch can split a checkout is inside a run of rows
 * sharing the last timestamp. That run is held back and re-read next time, whole.
 *
 * A page shorter than `pageSize` is the end of the history: nothing was cut off, so
 * nothing is withheld and there is no next page.
 */
export function splitPageAtCheckoutBoundary<T extends { created_at: string }>(
  page: T[],
  pageSize: number,
): TxPage<T> {
  if (page.length < pageSize) return { rows: page, cursor: null };

  const boundary = page[page.length - 1].created_at;
  const whole = page.filter((r) => r.created_at !== boundary);

  /* Every row on the page shares one timestamp, so holding the run back would leave
     nothing to show and an inclusive cursor would re-read the same page for ever.
     Unreachable in practice — a checkout is capped at twelve hours and a page is far
     larger — so the safe answer is to return what was read and stop, rather than
     loop. */
  if (whole.length === 0) return { rows: page, cursor: null };

  return { rows: whole, cursor: boundary };
}

/** Revenue split by who collected it.
 *
 *  A separate function from `summariseRevenue` rather than extra fields on it,
 *  because that one's shape is asserted exactly by existing tests and its
 *  meaning — "what did this venue take?" — is still the right answer for the
 *  screens that ask it. This one answers the different question the settlement
 *  system needs: of what this venue took, how much is Court Connect holding?
 *
 *  `platformCollected` is the only figure that may inform a payout.
 */
export function summariseRevenueBySource(rows: RevenueRow[]): {
  gross: number;
  platformCollected: number;
  tenantCollected: number;
  refunded: number;
  refundDue: number;
  net: number;
} {
  let grossCents = 0;
  let platformCents = 0;
  let tenantCents = 0;
  let refundedCents = 0;
  let refundDueCents = 0;

  for (const row of rows) {
    const state = revenueStateBySource(row);
    const amount = Math.round((Number(row.amount) || 0) * 100);

    if (
      state === "paid" ||
      state === "tenant_collected" ||
      state === "refunded" ||
      state === "refund_due"
    ) {
      grossCents += amount;
    }
    if (state === "paid") platformCents += amount;
    if (state === "tenant_collected") tenantCents += amount;
    if (state === "refunded") refundedCents += amount;
    if (state === "refund_due") refundDueCents += amount;
  }

  return {
    gross: grossCents / 100,
    platformCollected: platformCents / 100,
    tenantCollected: tenantCents / 100,
    refunded: refundedCents / 100,
    refundDue: refundDueCents / 100,
    net: (grossCents - refundedCents - refundDueCents) / 100,
  };
}

/** What a transaction row should say it is, in the tenant transaction module.
 *  The states the request asked for, derived rather than stored. */
export function transactionStateLabel(state: MemberState): string {
  switch (state) {
    case "paid":
      return "Paid";
    case "tenant_collected":
      return "Tenant Collected";
    case "refunded":
      return "Refunded";
    case "refund_due":
      return "Refund due";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}
