/**
 * Per-hour cancellation rules.
 *
 * The reported bug: a player books 7–9pm and starts playing; at 7:35 the venue cancels
 * and the WHOLE session is wiped, including the hour being played — refunding time the
 * player actually used and pretending 7–8pm is available again when nobody can book it.
 */

import { describe, expect, it } from "vitest";
import {
  IMMINENT_MINUTES,
  classifySlot,
  defaultSelection,
  hasPaidSelection,
  isLocked,
  isSelectable,
  needsOverride,
  refundableTotal,
  type CancellableSlot,
} from "@/lib/booking-cancellation";

const at = (h: number, m = 0) =>
  `2026-08-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const NOW_735 = Date.parse(at(19, 35)); // 7:35 pm, mid-first-hour
const NOW_759 = Date.parse(at(19, 59)); // 7:59 pm, one minute before 8

function slot(id: number, h: number, over: Partial<CancellableSlot> = {}): CancellableSlot {
  return {
    id,
    start_time: at(h),
    end_time: at(h + 1),
    status: "confirmed",
    payment_status: "paid",
    unit_price: 500,
    discount_amount: 0,
    ...over,
  };
}

// The reported scenario: 7–9pm, two hours.
const SESSION = [slot(1, 19), slot(2, 20)];

describe("the reported scenario — 7–9pm cancelled at 7:35", () => {
  it("marks the hour being played as in progress, not cancellable by default", () => {
    expect(classifySlot(SESSION[0], NOW_735)).toBe("in_progress");
    expect(isSelectable("in_progress", false)).toBe(false);
  });

  it("leaves the 8–9 hour freely cancellable", () => {
    expect(classifySlot(SESSION[1], NOW_735)).toBe("open");
    expect(isSelectable("open", false)).toBe(true);
  });

  it("pre-selects ONLY the 8–9 hour", () => {
    expect(defaultSelection(SESSION, NOW_735)).toEqual([2]);
  });

  it("refunds one hour, not the whole booking", () => {
    const selection = defaultSelection(SESSION, NOW_735);
    expect(refundableTotal(SESSION, selection)).toBe(500);
    // The bug would have refunded both hours.
    expect(refundableTotal(SESSION, [1, 2])).toBe(1000);
  });
});

describe("the 7:59 edge — no time to tell the player", () => {
  it("flags an 8–9 booking as imminent, not open", () => {
    expect(classifySlot(SESSION[1], NOW_759)).toBe("imminent");
    expect(needsOverride("imminent")).toBe(true);
  });

  it("is not pre-selected, so a careless click cannot take it", () => {
    expect(defaultSelection(SESSION, NOW_759)).toEqual([]);
  });

  it("becomes selectable once the venue explicitly overrides", () => {
    expect(isSelectable("imminent", false)).toBe(false);
    expect(isSelectable("imminent", true)).toBe(true);
  });

  it("treats exactly IMMINENT_MINUTES away as still imminent", () => {
    const boundary = Date.parse(SESSION[1].start_time) - IMMINENT_MINUTES * 60_000;
    expect(classifySlot(SESSION[1], boundary)).toBe("imminent");
    expect(classifySlot(SESSION[1], boundary - 1)).toBe("open");
  });
});

describe("hours that are simply gone", () => {
  it("locks an hour that has finished, even with the override on", () => {
    const nowAfter = Date.parse(at(21));
    expect(classifySlot(SESSION[0], nowAfter)).toBe("completed");
    expect(isLocked("completed")).toBe(true);
    expect(isSelectable("completed", true)).toBe(false);
  });

  it("locks an already cancelled hour", () => {
    expect(classifySlot(slot(3, 22, { status: "cancelled" }), NOW_735)).toBe("already_cancelled");
    expect(isSelectable("already_cancelled", true)).toBe(false);
  });

  it("never refunds a completed hour, because it cannot be selected", () => {
    const nowAfter = Date.parse(at(20, 30)); // first hour done, second running
    expect(defaultSelection(SESSION, nowAfter)).toEqual([]);
  });
});

describe("the emergency override", () => {
  it("can clear a court mid-game — a flood or power cut", () => {
    expect(isSelectable(classifySlot(SESSION[0], NOW_735), true)).toBe(true);
  });

  it("still cannot resurrect an hour that already finished", () => {
    const nowAfter = Date.parse(at(21));
    for (const s of SESSION) {
      expect(isSelectable(classifySlot(s, nowAfter), true)).toBe(false);
    }
  });
});

describe("money follows the selection", () => {
  it("counts only paid hours", () => {
    const mixed = [slot(1, 19), slot(2, 20, { payment_status: "pending" })];
    expect(refundableTotal(mixed, [1, 2])).toBe(500);
    expect(hasPaidSelection(mixed, [2])).toBe(false);
    expect(hasPaidSelection(mixed, [1, 2])).toBe(true);
  });

  it("subtracts a discount", () => {
    const discounted = [slot(1, 19, { discount_amount: 150 })];
    expect(refundableTotal(discounted, [1])).toBe(350);
  });

  it("is zero when nothing is selected", () => {
    expect(refundableTotal(SESSION, [])).toBe(0);
  });
});

describe("a single-hour booking still behaves", () => {
  it("is cancellable well ahead of time", () => {
    const one = [slot(1, 22)];
    expect(defaultSelection(one, NOW_735)).toEqual([1]);
  });
});
