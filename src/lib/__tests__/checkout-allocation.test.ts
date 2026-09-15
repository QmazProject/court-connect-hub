import { describe, it, expect } from "vitest";
import { allocateCheckoutAmounts, allocateCheckoutCents } from "../checkout-allocation";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateCheckoutCents", () => {
  it("gives a single booking the whole charge", () => {
    expect(allocateCheckoutCents(100000, [100000])).toEqual([100000]);
  });

  /* The headline case: three equal hours of a ₱1,000 checkout used to come to
     ₱999.99. The odd centavo now goes to the first hour. */
  it("keeps the centavo that even division used to lose", () => {
    const out = allocateCheckoutCents(100000, [33333, 33333, 33333]);
    expect(out).toEqual([33334, 33333, 33333]);
    expect(sum(out)).toBe(100000);
  });

  it("gives each hour its own price when the hours are priced differently", () => {
    expect(allocateCheckoutCents(100000, [30000, 35000, 35000])).toEqual([30000, 35000, 35000]);
  });

  it("spreads a discount in proportion, still adding up exactly", () => {
    /* ₱1,000 of court time, ₱100 voucher, ₱900 charged. */
    const out = allocateCheckoutCents(90000, [30000, 35000, 35000]);
    expect(sum(out)).toBe(90000);
    expect(out).toEqual([27000, 31500, 31500]);
  });

  it("adds up exactly however awkward the numbers are", () => {
    const cases: [number, number[]][] = [
      [100000, [33333, 33333, 33334]],
      [99999, [33333, 33333, 33333]],
      [12345, [1000, 2000, 3000, 4000, 5000]],
      [2000, [700, 700, 700]],
      [100001, [1, 1, 1, 1, 1, 1, 1]],
      [7, [5, 5, 5, 5, 5]],
      [100000, [50000, 25000, 12500, 6250, 6250]],
    ];
    for (const [gateway, units] of cases) {
      const out = allocateCheckoutCents(gateway, units);
      expect(sum(out)).toBe(gateway);
      expect(out.every((c) => c >= 0)).toBe(true);
      expect(out).toHaveLength(units.length);
    }
  });

  it("never allocates a negative amount", () => {
    for (const units of [
      [0, 0, 0],
      [100, 0],
      [-5, 10],
      [Number.NaN, 10],
    ]) {
      expect(allocateCheckoutCents(5000, units).every((c) => c >= 0)).toBe(true);
    }
  });

  it("falls back to an even split when no hour has a usable price", () => {
    const out = allocateCheckoutCents(1000, [0, 0, 0]);
    expect(out).toEqual([334, 333, 333]);
    expect(sum(out)).toBe(1000);
  });

  it("is deterministic — the same checkout always allocates the same way", () => {
    const once = allocateCheckoutCents(100000, [33333, 33333, 33333]);
    const twice = allocateCheckoutCents(100000, [33333, 33333, 33333]);
    expect(once).toEqual(twice);
  });

  it("handles the empty and zero cases without inventing money", () => {
    expect(allocateCheckoutCents(1000, [])).toEqual([]);
    expect(allocateCheckoutCents(0, [100, 100])).toEqual([0, 0]);
    expect(sum(allocateCheckoutCents(-1, [100, 100]))).toBe(0);
  });

  it("keeps the order it was given, so each row matches its own booking", () => {
    expect(allocateCheckoutCents(100000, [10000, 80000, 10000])).toEqual([10000, 80000, 10000]);
  });
});

describe("allocateCheckoutAmounts", () => {
  it("works in pesos and still totals the charge exactly", () => {
    const out = allocateCheckoutAmounts(100000, [333.33, 333.33, 333.33]);
    expect(out).toEqual([333.34, 333.33, 333.33]);
    expect(Math.round(sum(out) * 100)).toBe(100000);
  });

  it("reproduces real hourly rates untouched", () => {
    expect(allocateCheckoutAmounts(100000, [300, 350, 350])).toEqual([300, 350, 350]);
  });

  /* A full sweep: whatever the prices, the rows always reconcile to the charge. */
  it("reconciles for a wide range of generated checkouts", () => {
    for (let n = 1; n <= 24; n += 1) {
      for (const rate of [150, 333.33, 499.99, 1000]) {
        const prices = Array.from({ length: n }, (_, i) => rate + (i % 3) * 12.5);
        const gateway = Math.round(prices.reduce((a, b) => a + b, 0) * 100);
        const out = allocateCheckoutAmounts(gateway, prices);
        expect(Math.round(sum(out) * 100)).toBe(gateway);
        expect(out.every((v) => v >= 0)).toBe(true);
      }
    }
  });
});
