import { describe, expect, it } from "vitest";
import {
  bookingChatWindow,
  canCancel,
  canSettleRefund,
  describeRefund,
  playerCancelState,
  PLAYER_CANCEL_CUTOFF_MS,
  type PlayerCancelInput,
} from "@/lib/booking-actions";

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

describe("playerCancelState", () => {
  const p = (over: Partial<PlayerCancelInput> = {}): PlayerCancelInput => ({
    status: "confirmed",
    refund_status: "none",
    sessionStartsAt: "2026-08-28T13:00:00.000Z",
    sessionEndsAt: "2026-08-28T14:00:00.000Z",
    ...over,
  });

  it("allows cancelling a booking that is comfortably ahead", () => {
    expect(playerCancelState(p(), NOW).allowed).toBe(true);
  });

  it("still allows it with just over a minute to go", () => {
    const start = new Date(NOW + 61_000).toISOString();
    expect(playerCancelState(p({ sessionStartsAt: start }), NOW).allowed).toBe(true);
  });

  it("blocks it with less than a minute to go", () => {
    // The rule the request asked for: inside the last minute the court is gone.
    const start = new Date(NOW + 59_000).toISOString();
    const state = playerCancelState(p({ sessionStartsAt: start }), NOW);
    expect(state.allowed).toBe(false);
    expect(state.allowed === false && state.reason).toBe("too_late");
  });

  it("treats exactly one minute as too late, so the boundary cannot be raced", () => {
    const start = new Date(NOW + PLAYER_CANCEL_CUTOFF_MS).toISOString();
    expect(playerCancelState(p({ sessionStartsAt: start }), NOW).allowed).toBe(false);
  });

  it("blocks a booking already under way, and says so rather than saying too late", () => {
    const state = playerCancelState(
      p({ sessionStartsAt: "2026-08-28T11:30:00.000Z", sessionEndsAt: future }),
      NOW,
    );
    expect(state.allowed === false && state.reason).toBe("in_progress");
  });

  it("blocks a booking that has finished", () => {
    const state = playerCancelState(
      p({ sessionStartsAt: "2026-08-28T10:00:00.000Z", sessionEndsAt: past }),
      NOW,
    );
    expect(state.allowed === false && state.reason).toBe("finished");
  });

  it("never offers to cancel something already cancelled or expired", () => {
    expect(playerCancelState(p({ status: "cancelled" }), NOW).allowed).toBe(false);
    expect(playerCancelState(p({ status: "expired" }), NOW).allowed).toBe(false);
  });

  it("always gives a reason a screen can print", () => {
    const start = new Date(NOW + 10_000).toISOString();
    const state = playerCancelState(p({ sessionStartsAt: start }), NOW);
    expect(state.allowed === false && state.message.length).toBeGreaterThan(0);
  });
});

describe("bookingChatWindow", () => {
  it("is open while the booking has not finished", () => {
    expect(bookingChatWindow(b(), NOW).open).toBe(true);
  });

  it("closes once the booking has been played", () => {
    expect(bookingChatWindow(b({ sessionEndsAt: past }), NOW).open).toBe(false);
  });

  it("closes exactly on the end time", () => {
    expect(bookingChatWindow(b({ sessionEndsAt: new Date(NOW).toISOString() }), NOW).open).toBe(
      false,
    );
  });

  it("stays open past the end while a refund is still owed", () => {
    // This thread is where a manual refund gets agreed, and that conversation
    // necessarily happens after the booking was meant to be played.
    expect(bookingChatWindow(b({ sessionEndsAt: past, refund_status: "pending" }), NOW).open).toBe(
      true,
    );
  });

  it("stays open past the end when the refund attempt failed", () => {
    expect(bookingChatWindow(b({ sessionEndsAt: past, refund_status: "failed" }), NOW).open).toBe(
      true,
    );
  });

  it("stays open past the end for a cancelled booking", () => {
    expect(bookingChatWindow(b({ sessionEndsAt: past, status: "cancelled" }), NOW).open).toBe(true);
  });

  it("closes once the refund has actually been settled", () => {
    const w = bookingChatWindow(b({ sessionEndsAt: past, refund_status: "refunded" }), NOW);
    expect(w.open).toBe(false);
  });

  it("explains itself when closed", () => {
    const w = bookingChatWindow(b({ sessionEndsAt: past }), NOW);
    expect(w.open === false && w.message.length).toBeGreaterThan(0);
  });
});
