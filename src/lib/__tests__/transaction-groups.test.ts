import { describe, it, expect } from "vitest";
import {
  groupTransactions,
  groupStatus,
  isSpentAttempt,
  memberState,
  type TxLike,
} from "../transaction-groups";

const H = (day: string, hour: number) =>
  new Date(Date.UTC(2026, 8, Number(day), hour, 0, 0)).toISOString();

let seq = 0;
function tx(over: Partial<TxLike> & { booking?: Partial<NonNullable<TxLike["bookings"]>> } = {}) {
  seq += 1;
  const { booking, ...rest } = over;
  const row: TxLike = {
    id: `tx-${seq}`,
    booking_id: seq,
    venue_id: 1,
    user_id: "juan",
    amount: 500,
    method: "gcash",
    status: "paid",
    provider_ref: "cs_A",
    reference_number: null,
    raw: { payment_id: "pay_A" },
    paid_at: H("12", 10),
    created_at: H("12", 9),
    bookings: {
      booking_no: seq,
      court_id: 1,
      start_time: H("12", 18),
      end_time: H("12", 19),
      status: "confirmed",
      payment_status: "paid",
      refund_status: "none",
      unit_price: 500,
      discount_amount: 0,
      courts: { name: "Court 1" },
      ...booking,
    },
    ...rest,
  };
  return row;
}

describe("grouping key", () => {
  it("puts one booking in its own group", () => {
    const groups = groupTransactions([tx()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].bookingCount).toBe(1);
  });

  it("groups three consecutive bookings of one checkout into one row of 3h", () => {
    const rows = [18, 19, 20].map((h) =>
      tx({ booking: { start_time: H("12", h), end_time: H("12", h + 1) } }),
    );
    const [g] = groupTransactions(rows);
    expect(g.bookingCount).toBe(3);
    expect(g.sessions).toEqual([{ start: H("12", 18), end: H("12", 21), hours: 3 }]);
    expect(g.totalHours).toBe(3);
  });

  /* The case the brief was explicit about: 6-7 and 9-10 must never read as 6-10. */
  it("keeps non-consecutive slots as separate ranges in one group", () => {
    const rows = [
      tx({ booking: { start_time: H("12", 18), end_time: H("12", 19) } }),
      tx({ booking: { start_time: H("12", 21), end_time: H("12", 22) } }),
    ];
    const [g] = groupTransactions(rows);
    expect(g.sessions).toEqual([
      { start: H("12", 18), end: H("12", 19), hours: 1 },
      { start: H("12", 21), end: H("12", 22), hours: 1 },
    ]);
    expect(g.totalHours).toBe(2);
    expect(g.sessions.some((s) => s.start === H("12", 18) && s.end === H("12", 22))).toBe(false);
  });

  it("keeps courts apart inside one checkout and lists them all", () => {
    const rows = [
      tx({ booking: { court_id: 1, courts: { name: "Court 1" } } }),
      tx({
        booking: {
          court_id: 2,
          courts: { name: "Court 2" },
          start_time: H("12", 19),
          end_time: H("12", 20),
        },
      }),
    ];
    const [g] = groupTransactions(rows);
    expect(g.courts).toEqual(["Court 1", "Court 2"]);
    expect(g.sessions).toHaveLength(2);
  });

  /* Two payments from different people must never merge just because neither has a
     gateway reference. */
  it("leaves every null-reference row standing alone", () => {
    const rows = [
      tx({ provider_ref: null, user_id: "juan" }),
      tx({ provider_ref: null, user_id: "maria" }),
      tx({ provider_ref: "   ", user_id: "pedro" }),
    ];
    const groups = groupTransactions(rows);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.userId))).toEqual(new Set(["juan", "maria", "pedro"]));
  });

  it("treats a retry as a separate group, never merged with the failed attempt", () => {
    const failed = [18, 19].map((h) =>
      tx({
        provider_ref: "cs_FAIL",
        status: "failed",
        paid_at: null,
        raw: null,
        booking: { start_time: H("12", h), end_time: H("12", h + 1), payment_status: "failed" },
      }),
    );
    const paid = [18, 19].map((h) =>
      tx({
        provider_ref: "cs_OK",
        booking: { start_time: H("12", h), end_time: H("12", h + 1) },
      }),
    );
    const groups = groupTransactions([...failed, ...paid]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.status).sort()).toEqual(["failed", "paid"]);
  });

  it("never groups by the gateway payment id", () => {
    /* Same payment id, different checkouts: they must stay apart. */
    const rows = [
      tx({ provider_ref: "cs_A", raw: { payment_id: "pay_SHARED" } }),
      tx({ provider_ref: "cs_B", raw: { payment_id: "pay_SHARED" } }),
    ];
    expect(groupTransactions(rows)).toHaveLength(2);
  });
});

describe("group status", () => {
  it("reports a fully paid and a fully refunded checkout", () => {
    expect(groupStatus(["paid", "paid", "paid"])).toBe("paid");
    expect(groupStatus(["refunded", "refunded"])).toBe("refunded");
  });

  it("reports a partial refund when some hours were given back", () => {
    expect(groupStatus(["paid", "refunded", "paid"])).toBe("partially_refunded");
  });

  it("reports pending, failed and cancelled attempts", () => {
    expect(groupStatus(["pending", "pending"])).toBe("pending");
    expect(groupStatus(["failed"])).toBe("failed");
    expect(groupStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });

  it("refuses to guess when the states genuinely conflict", () => {
    expect(groupStatus(["paid", "failed"])).toBe("mixed");
    expect(groupStatus(["pending", "refunded"])).toBe("mixed");
    expect(groupStatus(["paid", "unknown"])).toBe("mixed");
  });

  it("never takes the first row's word for it", () => {
    const rows = [
      tx({ booking: { start_time: H("12", 18), end_time: H("12", 19) } }),
      tx({ status: "refunded", booking: { start_time: H("12", 19), end_time: H("12", 20) } }),
      tx({ booking: { start_time: H("12", 20), end_time: H("12", 21) } }),
    ];
    const [g] = groupTransactions(rows);
    expect(rows[0].status).toBe("paid");
    expect(g.status).toBe("partially_refunded");
  });

  /* Two refund paths update the booking and never the ledger row. Reading the
     payment row alone would call a settled refund "paid". */
  it("sees a manually settled refund even though the payment row still says paid", () => {
    const row = tx({ status: "paid", booking: { refund_status: "refunded" } });
    expect(row.status).toBe("paid");
    expect(memberState(row)).toBe("refunded");
    expect(groupTransactions([row])[0].status).toBe("refunded");
  });

  it("sees a player-cancelled paid booking the same way", () => {
    expect(memberState(tx({ status: "paid", booking: { payment_status: "refunded" } }))).toBe(
      "refunded",
    );
  });

  it("hides only spent attempts", () => {
    expect(isSpentAttempt("failed")).toBe(true);
    expect(isSpentAttempt("cancelled")).toBe(true);
    for (const s of ["paid", "refunded", "partially_refunded", "pending", "mixed"] as const) {
      expect(isSpentAttempt(s)).toBe(false);
    }
  });
});

describe("money", () => {
  it("totals from the payment rows, so it reconciles against the gateway", () => {
    const rows = [333.33, 333.33, 333.33].map((a, i) =>
      tx({ amount: a, booking: { start_time: H("12", 18 + i), end_time: H("12", 19 + i) } }),
    );
    expect(groupTransactions(rows)[0].total).toBe(999.99);
  });

  /* The even-split problem: the ledger says 333.33 a row, the slots cost 300/400/500.
     Neither number is quietly adjusted; the mismatch is reported. */
  it("flags a discrepancy between the payment total and the slot prices", () => {
    const prices = [300, 400, 500];
    const rows = prices.map((p, i) =>
      tx({
        amount: 400,
        booking: {
          unit_price: p,
          start_time: H("12", 18 + i),
          end_time: H("12", 19 + i),
        },
      }),
    );
    const [g] = groupTransactions(rows);
    expect(g.total).toBe(1200);
    expect(g.bookingTotal).toBe(1200);
    expect(g.discrepancy).toBe(false);

    const drift = groupTransactions(
      [333.33, 333.33, 333.33].map((a, i) =>
        tx({
          amount: a,
          booking: { unit_price: 333.34, start_time: H("12", 18 + i), end_time: H("12", 19 + i) },
        }),
      ),
    )[0];
    expect(drift.total).toBe(999.99);
    expect(drift.bookingTotal).toBe(1000.02);
    expect(drift.discrepancy).toBe(true);
  });

  it("does not invent a booking total when a slot has no price", () => {
    const [g] = groupTransactions([tx({ booking: { unit_price: null } })]);
    expect(g.bookingTotal).toBeNull();
    expect(g.discrepancy).toBe(false);
  });

  it("subtracts the discount from the slot price", () => {
    const [g] = groupTransactions([tx({ booking: { unit_price: 500, discount_amount: 50 } })]);
    expect(g.lines[0].price).toBe(450);
    expect(g.bookingTotal).toBe(450);
  });

  it("reports how much of a partly refunded checkout came back", () => {
    const rows = [
      tx({ amount: 500, booking: { start_time: H("12", 18), end_time: H("12", 19) } }),
      tx({
        amount: 500,
        status: "refunded",
        booking: { start_time: H("12", 19), end_time: H("12", 20) },
      }),
      tx({ amount: 500, booking: { start_time: H("12", 20), end_time: H("12", 21) } }),
    ];
    const [g] = groupTransactions(rows);
    expect(g.total).toBe(1500);
    expect(g.refundedTotal).toBe(500);
    expect(g.status).toBe("partially_refunded");
  });

  it("floating point noise never trips the discrepancy flag", () => {
    const rows = [0.1, 0.2].map((a, i) =>
      tx({
        amount: a,
        booking: { unit_price: a, start_time: H("12", 18 + i), end_time: H("12", 19 + i) },
      }),
    );
    expect(groupTransactions(rows)[0].discrepancy).toBe(false);
  });
});

describe("reference and lines", () => {
  it("prefers CourtHub's own reference over the gateway's", () => {
    const [g] = groupTransactions([tx({ reference_number: "bk_12_abc", provider_ref: "cs_A" })]);
    expect(g.reference).toBe("bk_12_abc");
    expect(g.referenceKind).toBe("merchant");
  });

  it("falls back to the gateway reference for historical rows, inventing nothing", () => {
    const [g] = groupTransactions([tx({ reference_number: null, provider_ref: "cs_A" })]);
    expect(g.reference).toBe("cs_A");
    expect(g.referenceKind).toBe("gateway");
  });

  it("reports no reference at all rather than making one up", () => {
    const [g] = groupTransactions([tx({ reference_number: null, provider_ref: null })]);
    expect(g.reference).toBeNull();
    expect(g.referenceKind).toBe("none");
  });

  it("keeps the gateway payment id available for reconciliation", () => {
    expect(groupTransactions([tx()])[0].paymentId).toBe("pay_A");
    expect(groupTransactions([tx({ raw: null })])[0].paymentId).toBeNull();
  });

  it("gives each expanded line the slot's own price and state, in time order", () => {
    const rows = [
      tx({
        amount: 400,
        booking: { unit_price: 500, start_time: H("12", 20), end_time: H("12", 21) },
      }),
      tx({
        amount: 400,
        status: "refunded",
        booking: { unit_price: 400, start_time: H("12", 19), end_time: H("12", 20) },
      }),
      tx({
        amount: 400,
        booking: { unit_price: 300, start_time: H("12", 18), end_time: H("12", 19) },
      }),
    ];
    const [g] = groupTransactions(rows);
    expect(g.lines.map((l) => l.price)).toEqual([300, 400, 500]);
    expect(g.lines.map((l) => l.state)).toEqual(["paid", "refunded", "paid"]);
  });

  it("marks the method mixed rather than picking one when rows disagree", () => {
    const rows = [
      tx({ method: "gcash" }),
      tx({ method: "card", booking: { start_time: H("12", 19), end_time: H("12", 20) } }),
    ];
    expect(groupTransactions(rows)[0].method).toBe("mixed");
  });

  it("orders groups newest first", () => {
    const older = tx({ provider_ref: "cs_OLD", paid_at: H("11", 10) });
    const newer = tx({ provider_ref: "cs_NEW", paid_at: H("13", 10) });
    expect(groupTransactions([older, newer]).map((g) => g.key)).toEqual([
      "ref:cs_NEW",
      "ref:cs_OLD",
    ]);
  });
});

import { splitPageAtCheckoutBoundary, type TxPage } from "../transaction-groups";

/** A whole ledger paged the way the screen pages it, so a test can assert what a
 *  reader would actually end up seeing across several "Load more" presses. */
function readAllPages<T extends { created_at: string }>(ledger: T[], pageSize: number) {
  const seen: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    /* Inclusive, mirroring the query's `lte`. Annotated because `cursor` is written
       from the result below, and inference would otherwise chase its own tail. */
    const slice: T[] = (cursor ? ledger.filter((r) => r.created_at <= cursor!) : ledger).slice(
      0,
      pageSize,
    );
    const page: TxPage<T> = splitPageAtCheckoutBoundary(slice, pageSize);
    seen.push(...page.rows);
    if (!page.cursor) return seen;
    cursor = page.cursor;
  }
  throw new Error("pagination did not terminate");
}

describe("checkout-aware paging", () => {
  /** Newest first, as the query orders them. */
  const ledger = (checkouts: { at: string; rows: number }[]) =>
    checkouts
      .flatMap((c) =>
        Array.from({ length: c.rows }, (_, i) => ({ created_at: c.at, id: `${c.at}-${i}` })),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

  it("returns everything and ends when the history is shorter than a page", () => {
    const rows = ledger([{ at: "2026-09-12T10:00:00Z", rows: 3 }]);
    expect(splitPageAtCheckoutBoundary(rows, 10)).toEqual({ rows, cursor: null });
  });

  /* The 499/500/501 case: a checkout straddling the fetch boundary must not be
     reported as a shorter checkout. */
  it("never hands back a checkout the fetch cut in half", () => {
    const all = ledger([
      { at: "2026-09-12T12:00:00Z", rows: 2 },
      { at: "2026-09-12T11:00:00Z", rows: 3 },
    ]);
    const page = splitPageAtCheckoutBoundary(all.slice(0, 4), 4);
    /* The straddling checkout is held back entire, not partly delivered. */
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((r) => r.created_at === "2026-09-12T12:00:00Z")).toBe(true);
    expect(page.cursor).toBe("2026-09-12T11:00:00Z");
  });

  it("delivers every row exactly once across pages, whatever the page size", () => {
    const checkouts = [
      { at: "2026-09-12T18:00:00Z", rows: 12 },
      { at: "2026-09-12T17:00:00Z", rows: 1 },
      { at: "2026-09-12T16:00:00Z", rows: 7 },
      { at: "2026-09-12T15:00:00Z", rows: 3 },
      { at: "2026-09-12T14:00:00Z", rows: 12 },
      { at: "2026-09-12T13:00:00Z", rows: 2 },
    ];
    const all = ledger(checkouts);
    for (const pageSize of [13, 14, 20, 37, 100]) {
      const seen = readAllPages(all, pageSize);
      expect(seen).toHaveLength(all.length);
      expect(new Set(seen.map((r) => r.id)).size).toBe(all.length);
      /* And every checkout arrives with all of its rows. */
      for (const c of checkouts) {
        expect(seen.filter((r) => r.created_at === c.at)).toHaveLength(c.rows);
      }
    }
  });

  it("keeps rows whose checkout has no sibling independent of each other", () => {
    const all = ledger([
      { at: "2026-09-12T12:00:00Z", rows: 1 },
      { at: "2026-09-12T11:00:00Z", rows: 1 },
      { at: "2026-09-12T10:00:00Z", rows: 1 },
    ]);
    const seen = readAllPages(all, 2);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((r) => r.created_at)).size).toBe(3);
  });

  /* The degenerate case: a page filled entirely by one checkout. Unreachable in
     practice, since a checkout holds at most twelve hours and a page is far larger.
     What matters is that it stops rather than re-reading the same page for ever,
     because the cursor is inclusive. */
  it("terminates instead of looping when one checkout fills an entire page", () => {
    const all = ledger([
      { at: "2026-09-12T12:00:00Z", rows: 4 },
      { at: "2026-09-12T11:00:00Z", rows: 1 },
    ]);
    const page = splitPageAtCheckoutBoundary(all.slice(0, 4), 4);
    expect(page.rows).toHaveLength(4);
    expect(page.cursor).toBeNull();
    /* And the walk ends rather than hanging. */
    expect(() => readAllPages(all, 4)).not.toThrow();
  });

  /* A payment taken while someone reads page one must not shuffle older pages. */
  it("is unaffected by newer payments arriving mid-read", () => {
    const original = ledger([
      { at: "2026-09-12T12:00:00Z", rows: 2 },
      { at: "2026-09-12T11:00:00Z", rows: 2 },
      { at: "2026-09-12T10:00:00Z", rows: 2 },
    ]);
    const firstPage = splitPageAtCheckoutBoundary(original.slice(0, 3), 3);
    const withNewPayment = ledger([
      { at: "2026-09-12T13:00:00Z", rows: 2 },
      { at: "2026-09-12T12:00:00Z", rows: 2 },
      { at: "2026-09-12T11:00:00Z", rows: 2 },
      { at: "2026-09-12T10:00:00Z", rows: 2 },
    ]);
    const nextSlice = withNewPayment.filter((r) => r.created_at <= firstPage.cursor!).slice(0, 3);
    const secondPage = splitPageAtCheckoutBoundary(nextSlice, 3);
    /* The second page still resumes exactly where the first stopped; the new payment
       belongs to page one and cannot push an older row into being read twice. */
    expect(secondPage.rows.every((r) => r.created_at <= firstPage.cursor!)).toBe(true);
    expect(secondPage.rows.some((r) => firstPage.rows.some((f) => f.id === r.id))).toBe(false);
  });

  it("groups correctly after paging, not merely fetches correctly", () => {
    /* End to end: page the ledger, then group what was read. */
    const rows = [
      ...[18, 19, 20].map((h) =>
        tx({
          provider_ref: "cs_BIG",
          booking: { start_time: H("12", h), end_time: H("12", h + 1) },
        }),
      ),
      tx({ provider_ref: "cs_SMALL", paid_at: H("11", 9) }),
    ].map((r, i) => ({ ...r, created_at: i < 3 ? H("12", 9) : H("11", 8) }));

    const seen = readAllPages(rows, 4);
    expect(seen).toHaveLength(4);
    const groups = groupTransactions(seen as TxLike[]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === "ref:cs_BIG")!.bookingCount).toBe(3);
  });
});

import {
  effectiveTxState,
  isRetainedSale,
  isSettledRefund,
  revenueState,
  summariseRevenue,
  type RevenueRow,
} from "../transaction-groups";

describe("effective transaction state", () => {
  /* The reported bug: staff settle a refund, the booking says refunded, and the
     ledger row is never touched. Reading the row alone calls it money in hand. */
  it("believes a settled refund even when the ledger row still says paid", () => {
    expect(effectiveTxState("paid", "refunded", "refunded")).toBe("refunded");
    expect(effectiveTxState("paid", "paid", "refunded")).toBe("refunded");
    expect(effectiveTxState("paid", "refunded", null)).toBe("refunded");
  });

  it("keeps a plain paid payment paid", () => {
    expect(effectiveTxState("paid", "paid", "none")).toBe("paid");
    expect(effectiveTxState("paid", "paid", null)).toBe("paid");
  });

  /* Only a finalised refund moves money. A request is not a refund. */
  it("does not treat a pending or failed refund as money returned", () => {
    expect(effectiveTxState("paid", "paid", "pending")).toBe("paid");
    expect(effectiveTxState("paid", "paid", "failed")).toBe("paid");
  });

  it("still reports attempts that never became money", () => {
    expect(effectiveTxState("pending", "pending", null)).toBe("pending");
    expect(effectiveTxState("failed", "failed", null)).toBe("failed");
    expect(effectiveTxState("cancelled", "cancelled", null)).toBe("cancelled");
  });

  it("agrees with the automatic refund path, which does update the ledger", () => {
    expect(effectiveTxState("refunded", "refunded", "refunded")).toBe("refunded");
    /* And with a ledger row refunded before the booking caught up. */
    expect(effectiveTxState("refunded", "paid", "pending")).toBe("refunded");
  });

  it("names the two questions revenue actually asks", () => {
    expect(isRetainedSale("paid")).toBe(true);
    expect(isSettledRefund("refunded")).toBe(true);
    for (const s of ["refunded", "pending", "failed", "cancelled", "unknown"] as const) {
      expect(isRetainedSale(s)).toBe(false);
    }
    for (const s of ["paid", "pending", "failed", "cancelled", "unknown"] as const) {
      expect(isSettledRefund(s)).toBe(false);
    }
  });
});

describe("revenue summary", () => {
  const row = (amount: number, status: string, payment?: string, refund?: string) => ({
    amount,
    status,
    bookings: { payment_status: payment ?? status, refund_status: refund ?? null },
  });

  /* The reported scenario, end to end: ₱230 + ₱400 + ₱200, the middle hour
     refunded by hand, and the ledger row for it still reading paid. */
  it("reports gross, refunds and net for the reported checkout", () => {
    const out = summariseRevenue([
      row(230, "paid"),
      row(400, "paid", "refunded", "refunded"),
      row(200, "paid"),
    ]);
    expect(out.gross).toBe(830);
    expect(out.refunded).toBe(400);
    expect(out.net).toBe(430);
  });

  it("net equals gross when nothing was refunded", () => {
    const out = summariseRevenue([row(230, "paid"), row(200, "paid")]);
    expect(out).toEqual({ gross: 430, refunded: 0, refundDue: 0, net: 430 });
  });

  it("net reaches zero when everything was refunded", () => {
    const out = summariseRevenue([
      row(230, "paid", "refunded", "refunded"),
      row(200, "refunded", "refunded", "refunded"),
    ]);
    expect(out).toEqual({ gross: 430, refunded: 430, refundDue: 0, net: 0 });
  });

  it("a pending refund has not reduced sales yet", () => {
    const out = summariseRevenue([row(400, "paid", "paid", "pending")]);
    expect(out).toEqual({ gross: 400, refunded: 0, refundDue: 0, net: 400 });
  });

  it("a failed refund has not reduced sales either", () => {
    expect(summariseRevenue([row(400, "paid", "paid", "failed")]).net).toBe(400);
  });

  /* Money that never arrived is not gross. */
  it("ignores attempts that were never paid", () => {
    const out = summariseRevenue([
      row(500, "pending", "pending"),
      row(500, "failed", "failed"),
      row(500, "cancelled", "cancelled"),
      row(230, "paid"),
    ]);
    expect(out).toEqual({ gross: 230, refunded: 0, refundDue: 0, net: 230 });
  });

  it("adds up in centavos, so the odd allocation does not drift", () => {
    const out = summariseRevenue([row(333.34, "paid"), row(333.33, "paid"), row(333.33, "paid")]);
    expect(out.gross).toBe(1000);
    expect(out.net).toBe(1000);
  });

  it("reads a row's state the same way the screens do", () => {
    expect(revenueState(row(400, "paid", "refunded", "refunded"))).toBe("refunded");
    expect(revenueState(row(400, "paid"))).toBe("paid");
  });
});

describe("the reported bug, grouped", () => {
  /* 4-5pm ₱230 paid, 5-6pm ₱400 refunded by hand, 11pm-12am ₱200 paid. */
  const checkout = () => [
    tx({
      amount: 230,
      booking: { unit_price: 230, start_time: H("12", 16), end_time: H("12", 17) },
    }),
    tx({
      amount: 400,
      status: "paid",
      booking: {
        unit_price: 400,
        start_time: H("12", 17),
        end_time: H("12", 18),
        payment_status: "refunded",
        refund_status: "refunded",
      },
    }),
    tx({
      amount: 200,
      booking: { unit_price: 200, start_time: H("12", 23), end_time: H("13", 0) },
    }),
  ];

  it("reads Partially refunded, with the refunded hour marked", () => {
    const [g] = groupTransactions(checkout());
    expect(g.status).toBe("partially_refunded");
    expect(g.lines.map((l) => l.state)).toEqual(["paid", "refunded", "paid"]);
  });

  it("shows gross 830 and 400 returned", () => {
    const [g] = groupTransactions(checkout());
    expect(g.total).toBe(830);
    expect(g.refundedTotal).toBe(400);
  });

  it("does not merge the two non-consecutive stretches", () => {
    const [g] = groupTransactions(checkout());
    expect(g.sessions).toHaveLength(2);
    expect(g.sessions[0].hours).toBe(2);
    expect(g.sessions[1].hours).toBe(1);
  });

  it("nets to 430 in the sales figures", () => {
    expect(summariseRevenue(checkout() as never).net).toBe(430);
  });
});

describe("the backfill's effect, once applied", () => {
  /* A repaired row now says `refunded` on the ledger itself. The screens must read
     it identically to how they read it before the repair, through the booking. */
  it("reads the same before and after a row is repaired", () => {
    const before = effectiveTxState("paid", "refunded", "refunded");
    const after = effectiveTxState("refunded", "refunded", "refunded");
    expect(before).toBe("refunded");
    expect(after).toBe("refunded");
  });

  /* The predicate's exclusions, as behaviour rather than as SQL. */
  it("leaves a legitimate paid booking alone", () => {
    expect(effectiveTxState("paid", "paid", null)).toBe("paid");
  });

  it("leaves a pending refund alone", () => {
    expect(effectiveTxState("paid", "paid", "pending")).toBe("paid");
  });

  it("leaves a failed refund alone", () => {
    expect(effectiveTxState("paid", "paid", "failed")).toBe("paid");
  });

  it("leaves an already-refunded automatic refund alone", () => {
    expect(effectiveTxState("refunded", "refunded", "refunded")).toBe("refunded");
  });

  /* A cancelled booking that was never refunded is still the venue's money. */
  it("does not turn a cancellation into a refund", () => {
    expect(effectiveTxState("paid", "paid", null)).toBe("paid");
    expect(
      summariseRevenue([{ amount: 400, status: "paid", bookings: { payment_status: "paid" } }]),
    ).toEqual({ gross: 400, refunded: 0, refundDue: 0, net: 400 });
  });

  /* One hour of a three-hour checkout repaired, the siblings untouched: the group
     is partial, and the money reconciles. */
  it("keeps a partially refunded checkout partial after repair", () => {
    const repaired = [
      tx({ amount: 230, booking: { start_time: H("12", 16), end_time: H("12", 17) } }),
      tx({
        amount: 400,
        status: "refunded",
        booking: {
          start_time: H("12", 17),
          end_time: H("12", 18),
          payment_status: "refunded",
          refund_status: "refunded",
        },
      }),
      tx({ amount: 200, booking: { start_time: H("12", 18), end_time: H("12", 19) } }),
    ];
    const [g] = groupTransactions(repaired);
    expect(g.status).toBe("partially_refunded");
    expect(g.lines.map((l) => l.state)).toEqual(["paid", "refunded", "paid"]);
    expect(summariseRevenue(repaired as never)).toEqual({
      gross: 830,
      refunded: 400,
      refundDue: 0,
      net: 430,
    });
  });

  it("reports a fully repaired checkout as refunded", () => {
    const all = [18, 19].map((h) =>
      tx({
        amount: 400,
        status: "refunded",
        booking: {
          start_time: H("12", h),
          end_time: H("12", h + 1),
          payment_status: "refunded",
          refund_status: "refunded",
        },
      }),
    );
    const [g] = groupTransactions(all);
    expect(g.status).toBe("refunded");
    expect(summariseRevenue(all as never).net).toBe(0);
  });
});

describe("a cancelled booking is not a sale", () => {
  it("reports a player-cancelled paid booking as refund_due, not paid", () => {
    /* The reported bug, exactly: the player cancels, the bookings module shows
       cancelled, and the Transactions module went on showing Paid because nothing
       here ever asked the booking what its own status was. */
    expect(effectiveTxState("paid", "paid", "pending", "cancelled")).toBe("refund_due");
  });

  it("reports it as refund_due even before any refund column is written", () => {
    expect(effectiveTxState("paid", "paid", null, "cancelled")).toBe("refund_due");
  });

  it("treats an expired booking the same way", () => {
    expect(effectiveTxState("paid", "paid", null, "expired")).toBe("refund_due");
  });

  it("counts a failed refund as still owed, because the money has not gone back", () => {
    expect(effectiveTxState("paid", "paid", "failed", "cancelled")).toBe("refund_due");
  });

  it("still lets a settled refund outrank everything", () => {
    expect(effectiveTxState("refunded", "paid", "pending", "cancelled")).toBe("refunded");
    expect(effectiveTxState("paid", "paid", "refunded", "cancelled")).toBe("refunded");
  });

  it("leaves an ordinary confirmed booking paid", () => {
    expect(effectiveTxState("paid", "paid", "none", "confirmed")).toBe("paid");
  });

  it("does not invent money for a booking that was never paid", () => {
    expect(effectiveTxState("pending", "unpaid", null, "cancelled")).toBe("pending");
  });

  it("keeps working for callers that pass no booking status at all", () => {
    expect(effectiveTxState("paid", "paid", "none")).toBe("paid");
  });

  /* The boundary of this change, kept explicit because it is tempting to widen. A
     refund merely requested on a booking that is still going ahead is not money gone,
     and it stays a sale. Only cancelling the booking takes it out of sales. */
  it("leaves a pending refund on a live booking counted as a sale", () => {
    expect(effectiveTxState("paid", "paid", "pending", "confirmed")).toBe("paid");
  });

  it("is not a retained sale, and is not a settled refund either", () => {
    expect(isRetainedSale("refund_due")).toBe(false);
    expect(isSettledRefund("refund_due")).toBe(false);
  });

  it("reads through memberState from an embedded booking", () => {
    const row = tx({ booking: { status: "cancelled", refund_status: "pending" } });
    expect(memberState(row)).toBe("refund_due");
  });

  it("gives the whole checkout a status of its own rather than 'mixed'", () => {
    expect(groupStatus(["refund_due", "refund_due"])).toBe("refund_due");
  });
});

describe("summariseRevenue with money owed back", () => {
  const revRow = (over: Partial<RevenueRow> = {}): RevenueRow => ({
    status: "paid",
    amount: 500,
    bookings: { status: "confirmed", payment_status: "paid", refund_status: "none" },
    ...over,
  });

  it("takes a cancelled booking out of net sales", () => {
    const s = summariseRevenue([
      revRow(),
      revRow({
        bookings: { status: "cancelled", payment_status: "paid", refund_status: "pending" },
      }),
    ]);
    expect(s.net).toBe(500);
  });

  it("still counts it in gross, because the money really did arrive", () => {
    const s = summariseRevenue([
      revRow({
        bookings: { status: "cancelled", payment_status: "paid", refund_status: "pending" },
      }),
    ]);
    expect(s.gross).toBe(500);
    expect(s.refundDue).toBe(500);
    expect(s.net).toBe(0);
  });

  it("keeps money owed apart from money already returned", () => {
    const s = summariseRevenue([
      revRow({
        bookings: { status: "cancelled", payment_status: "paid", refund_status: "pending" },
      }),
      revRow({ status: "refunded" }),
    ]);
    expect(s.refunded).toBe(500);
    expect(s.refundDue).toBe(500);
    expect(s.net).toBe(0);
  });

  it("still reconciles: gross minus refunded minus owed is net", () => {
    const s = summariseRevenue([
      revRow(),
      revRow({ status: "refunded" }),
      revRow({ bookings: { status: "cancelled", payment_status: "paid", refund_status: null } }),
    ]);
    expect(s.gross - s.refunded - s.refundDue).toBeCloseTo(s.net, 2);
  });
});
