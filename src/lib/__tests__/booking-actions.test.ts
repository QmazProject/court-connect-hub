import { describe, expect, it } from "vitest";
import { canCancel, canSettleRefund, describeRefund } from "@/lib/booking-actions";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const future = "2026-08-28T14:00:00.000Z";
const past = "2026-08-28T11:00:00.000Z";

const b = (over: Partial<Parameters<typeof canCancel>[0]> = {}) => ({
  status: "confirmed",
  refund_status: "none",
  sessionEndsAt: future,
  ...over,
});

describe("canCancel", () => {
  it("allows cancelling a confirmed booking that has not happened yet", () => {
    expect(canCancel(b(), NOW)).toBe(true);
  });

  it("does NOT offer cancel once the session has finished", () => {
    // The reported bug: past bookings still showed a Cancel button.
    expect(canCancel(b({ sessionEndsAt: past }), NOW)).toBe(false);
  });

  it("treats a session ending exactly now as past", () => {
    expect(canCancel(b({ sessionEndsAt: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it("never offers cancel for already cancelled or expired bookings", () => {
    expect(canCancel(b({ status: "cancelled" }), NOW)).toBe(false);
    expect(canCancel(b({ status: "expired" }), NOW)).toBe(false);
  });

  it("uses the SESSION end, so a multi-hour booking stays cancellable mid-way", () => {
    // 11:00–14:00: the first hour is over but the booking is still live.
    expect(canCancel(b({ sessionEndsAt: "2026-08-28T14:00:00.000Z" }), NOW)).toBe(true);
  });
});

describe("canSettleRefund", () => {
  it("offers settling only while a refund is owed", () => {
    expect(canSettleRefund(b({ refund_status: "pending" }))).toBe(true);
  });

  it("does not offer it once refunded, or when none was due", () => {
    expect(canSettleRefund(b({ refund_status: "refunded" }))).toBe(false);
    expect(canSettleRefund(b({ refund_status: "none" }))).toBe(false);
  });
});

describe("describeRefund", () => {
  it("distinguishes an automatic refund from a hand-settled one", () => {
    expect(describeRefund("refunded", "paymongo")).toBe("via PayMongo");
    expect(describeRefund("refunded", "manual")).toBe("settled manually");
  });

  it("still says something for refunds recorded before the method existed", () => {
    expect(describeRefund("refunded", null)).toBe("refunded");
  });

  it("says nothing while a refund is still pending", () => {
    expect(describeRefund("pending", null)).toBeNull();
  });
});
