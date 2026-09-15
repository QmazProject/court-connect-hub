/**
 * The source-aware half of the transactions module.
 *
 * `memberState` answers "what happened to this payment?" and is asserted
 * elsewhere. These helpers answer the second question the marketplace needs —
 * "and whose money is it?" — which is what keeps a walk-in out of the payout
 * balance. They are separate functions precisely so the first question's answers
 * could not change, and these tests pin both halves of that boundary.
 */
import { describe, expect, it } from "vitest";
import {
  bookingSourceLabel,
  collectionSourceLabel,
  memberState,
  memberStateBySource,
  summariseRevenueBySource,
  transactionAmounts,
  type RevenueRow,
  type TxLike,
} from "../transaction-groups";

const tx = (
  amount: number,
  status: string,
  booking: Partial<NonNullable<TxLike["bookings"]>> = {},
): TxLike =>
  ({
    id: "t",
    booking_id: 1,
    venue_id: 1,
    user_id: "u",
    amount,
    method: "cash",
    status,
    created_at: "2026-09-14T00:00:00Z",
    bookings: {
      booking_no: 1,
      court_id: 1,
      start_time: "2026-09-14T02:00:00Z",
      end_time: "2026-09-14T03:00:00Z",
      status: "confirmed",
      payment_status: "paid",
      ...booking,
    },
  }) as TxLike;

describe("who collected the money", () => {
  it("a walk-in settled at the desk reads as tenant-collected, not paid", () => {
    const row = tx(500, "paid", { payment_collection_source: "tenant" });
    expect(memberStateBySource(row)).toBe("tenant_collected");
  });

  it("an online payment still reads as paid", () => {
    const row = tx(1000, "paid", { payment_collection_source: "platform" });
    expect(memberStateBySource(row)).toBe("paid");
  });

  it("a row with no recorded source is treated as platform, as every booking was", () => {
    expect(memberStateBySource(tx(1000, "paid"))).toBe("paid");
  });

  /* The compatibility boundary: the original function must not have changed, or
     the grouping and filtering built on it would silently shift. */
  it("memberState is unchanged by the new field", () => {
    const row = tx(500, "paid", { payment_collection_source: "tenant" });
    expect(memberState(row)).toBe("paid");
  });

  it("a refund outranks the collection source", () => {
    const row = tx(500, "refunded", { payment_collection_source: "tenant" });
    expect(memberStateBySource(row)).toBe("refunded");
  });

  it("a cancelled booking whose money has not gone back is refund_due, not a sale", () => {
    const row = tx(1000, "paid", { status: "cancelled" });
    expect(memberStateBySource(row)).toBe("refund_due");
  });
});

describe("gross, refunded and net per row", () => {
  it("an online sale is kept in full", () => {
    const a = transactionAmounts(tx(1000, "paid"));
    expect(a).toMatchObject({ gross: 1000, refunded: 0, net: 1000, state: "paid" });
  });

  it("a walk-in is also kept in full, and is still a sale", () => {
    const a = transactionAmounts(tx(500, "paid", { payment_collection_source: "tenant" }));
    expect(a).toMatchObject({
      gross: 500,
      refunded: 500 - 500,
      net: 500,
      state: "tenant_collected",
    });
  });

  it("a refunded row keeps its gross and nets to nothing", () => {
    const a = transactionAmounts(tx(1000, "refunded"));
    expect(a.gross).toBe(1000);
    expect(a.refunded).toBe(1000);
    expect(a.net).toBe(0);
  });

  it("money owed back on a cancelled booking is not net revenue", () => {
    const a = transactionAmounts(tx(1000, "paid", { status: "cancelled" }));
    expect(a.gross).toBe(1000);
    expect(a.net).toBe(0);
  });

  it("a failed attempt is neither gross nor net", () => {
    const a = transactionAmounts(tx(1000, "failed", { payment_status: "failed" }));
    expect(a.gross).toBe(0);
    expect(a.net).toBe(0);
  });
});

describe("revenue split by who holds the cash", () => {
  const row = (amount: number, collection: string, status = "paid"): RevenueRow => ({
    status,
    amount,
    bookings: {
      payment_status: status === "refunded" ? "refunded" : "paid",
      refund_status: status === "refunded" ? "refunded" : null,
      status: "confirmed",
      payment_collection_source: collection,
    },
  });

  /* The worked example: ₱1,000 online and ₱500 cash is ₱1,500 of trade, of which
     only ₱1,000 is money Court Connect is holding. */
  it("separates platform-collected from tenant-collected", () => {
    const out = summariseRevenueBySource([row(1000, "platform"), row(500, "tenant")]);
    expect(out.gross).toBe(1500);
    expect(out.platformCollected).toBe(1000);
    expect(out.tenantCollected).toBe(500);
    expect(out.platformCollected).not.toBe(1500);
  });

  it("a refund reduces net without erasing gross", () => {
    const out = summariseRevenueBySource([row(1000, "platform", "refunded")]);
    expect(out.gross).toBe(1000);
    expect(out.refunded).toBe(1000);
    expect(out.net).toBe(0);
    expect(out.platformCollected).toBe(0);
  });

  it("no quantity of walk-ins becomes platform-collected", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(100 + i, "tenant"));
    expect(summariseRevenueBySource(rows).platformCollected).toBe(0);
    expect(summariseRevenueBySource(rows).tenantCollected).toBeGreaterThan(0);
  });
});

describe("badges say what happened in words", () => {
  it("labels every booking source", () => {
    expect(bookingSourceLabel("online")).toBe("ONLINE");
    expect(bookingSourceLabel("walk_in")).toBe("WALK-IN");
    expect(bookingSourceLabel("admin_manual")).toBe("MANUAL");
    expect(bookingSourceLabel(null)).toBe("ONLINE");
  });

  it("says who collected, without accounting vocabulary", () => {
    expect(collectionSourceLabel("tenant")).toBe("Collected by you");
    expect(collectionSourceLabel("platform")).toBe("Collected by Court Connect");
    expect(collectionSourceLabel("unpaid")).toBe("Unpaid");
    expect(collectionSourceLabel(undefined)).toBe("Collected by Court Connect");
  });
});
