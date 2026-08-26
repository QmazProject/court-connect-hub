/**
 * Which hours a player still owns on a court's booking grid.
 *
 * The reported bug: after cancelling, the player revisited the court and their old
 * slots still read "Your booking" and were styled unclickable, while every other
 * player saw the same hours as free. The cancelled rows were still being counted as
 * "mine". These pin the rule so that cannot come back.
 */

import { describe, expect, it } from "vitest";
import { ownedSlots, type OwnBookingRow } from "@/lib/court-slots";

const DAY_START = Date.parse("2026-08-28T00:00:00.000Z");
const at = (h: number) => new Date(DAY_START + h * 3600000).toISOString();

function row(h: number, over: Partial<OwnBookingRow> = {}): OwnBookingRow {
  return {
    start_time: at(h),
    end_time: at(h + 1),
    status: "confirmed",
    payment_status: "paid",
    ...over,
  };
}

describe("ownedSlots", () => {
  it("marks a confirmed booking as yours", () => {
    const map = ownedSlots([row(18)], DAY_START);
    expect(map.get(18)).toEqual({ kind: "booking" });
  });

  it("marks an unpaid pending booking as a hold, not a booking", () => {
    const map = ownedSlots([row(18, { status: "pending", payment_status: "pending" })], DAY_START);
    expect(map.get(18)).toEqual({ kind: "hold" });
  });

  it("does NOT claim a cancelled booking — the hour is free again", () => {
    // The regression. Before the fix this returned {kind:"booking"}, so the owner saw
    // "Your booking" on an hour anyone else could book.
    const map = ownedSlots([row(18, { status: "cancelled" })], DAY_START);
    expect(map.get(18)).toBeUndefined();
  });

  it("does NOT claim an expired hold", () => {
    const map = ownedSlots(
      [row(18, { status: "expired", payment_status: "cancelled" })],
      DAY_START,
    );
    expect(map.get(18)).toBeUndefined();
  });

  it("frees only the cancelled hours of a partly cancelled session", () => {
    const map = ownedSlots([row(18), row(19, { status: "cancelled" }), row(20)], DAY_START);
    expect(map.get(18)).toEqual({ kind: "booking" });
    expect(map.get(19)).toBeUndefined();
    expect(map.get(20)).toEqual({ kind: "booking" });
  });

  it("covers every hour of a multi-hour booking", () => {
    const map = ownedSlots(
      [{ start_time: at(18), end_time: at(21), status: "confirmed", payment_status: "paid" }],
      DAY_START,
    );
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([18, 19, 20]);
  });

  it("re-booking a previously cancelled hour marks it yours again", () => {
    const map = ownedSlots(
      [row(18, { status: "cancelled" }), row(18)], // old cancelled row + the new one
      DAY_START,
    );
    expect(map.get(18)).toEqual({ kind: "booking" });
  });
});
