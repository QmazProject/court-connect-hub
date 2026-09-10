import { describe, expect, it } from "vitest";
import {
  BOOKING_PREFIX_MAX,
  checkBookingPrefix,
  formatBookingNo,
  normaliseBookingPrefix,
} from "../booking-numbers";

describe("checkBookingPrefix", () => {
  it("accepts plain letters", () => {
    for (const value of ["BN", "INV", "bn", "Inv", "B", "ABCDEF"]) {
      expect(checkBookingPrefix(value).ok).toBe(true);
    }
  });

  it("accepts empty, which means the number stands alone", () => {
    expect(checkBookingPrefix("").ok).toBe(true);
    expect(checkBookingPrefix("   ").ok).toBe(true);
  });

  /* The case the tenant described: a prefix that already carries the counter.
     Accepting BN01 would make the second booking read BN012. */
  it("rejects a prefix with the number written into it", () => {
    for (const value of ["BN01", "INV01", "bn02", "inv02", "BN1", "1", "INV2026"]) {
      const result = checkBookingPrefix(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/added for you/i);
    }
  });

  it("rejects spaces, punctuation and symbols", () => {
    for (const value of ["B N", "BN-", "IN_V", "BN.", "BN#", "üñ"]) {
      expect(checkBookingPrefix(value).ok).toBe(false);
    }
  });

  it("rejects a prefix longer than the cap", () => {
    const tooLong = "A".repeat(BOOKING_PREFIX_MAX + 1);
    const result = checkBookingPrefix(tooLong);
    expect(result.ok).toBe(false);
    expect(checkBookingPrefix("A".repeat(BOOKING_PREFIX_MAX)).ok).toBe(true);
  });
});

describe("normaliseBookingPrefix", () => {
  it("folds case and trims, so one setting cannot exist three ways", () => {
    expect(normaliseBookingPrefix(" bn ")).toBe("BN");
    expect(normaliseBookingPrefix("Inv")).toBe("INV");
    expect(normaliseBookingPrefix("")).toBe("");
  });
});

describe("formatBookingNo", () => {
  it("counts normally — no zero padding at any width", () => {
    expect(formatBookingNo("BN", 1)).toBe("BN1");
    expect(formatBookingNo("BN", 2)).toBe("BN2");
    expect(formatBookingNo("BN", 9)).toBe("BN9");
    expect(formatBookingNo("BN", 10)).toBe("BN10");
    expect(formatBookingNo("BN", 11)).toBe("BN11");
    expect(formatBookingNo("BN", 12)).toBe("BN12");
    expect(formatBookingNo("BN", 130)).toBe("BN130");
  });

  it("uses the tenant's chosen word", () => {
    expect(formatBookingNo("INV", 1)).toBe("INV1");
    expect(formatBookingNo("inv", 7)).toBe("INV7");
  });

  it("prints the bare number when no prefix is set", () => {
    expect(formatBookingNo("", 1)).toBe("1");
    expect(formatBookingNo(null, 42)).toBe("42");
    expect(formatBookingNo(undefined, 3)).toBe("3");
  });

  /* An unnumbered booking has no number; the caller decides what to draw. */
  it("returns null rather than inventing a number", () => {
    expect(formatBookingNo("BN", null)).toBeNull();
    expect(formatBookingNo("BN", undefined)).toBeNull();
    expect(formatBookingNo("BN", 0)).toBeNull();
    expect(formatBookingNo("BN", -1)).toBeNull();
    expect(formatBookingNo("BN", Number.NaN)).toBeNull();
  });

  it("never emits a decimal", () => {
    expect(formatBookingNo("BN", 3.7)).toBe("BN3");
  });

  /* The sequence a tenant actually sees over its first dozen bookings. */
  it("reads as normal counting across the 9-to-10 boundary", () => {
    const run = Array.from({ length: 12 }, (_, i) => formatBookingNo("BN", i + 1));
    expect(run).toEqual([
      "BN1",
      "BN2",
      "BN3",
      "BN4",
      "BN5",
      "BN6",
      "BN7",
      "BN8",
      "BN9",
      "BN10",
      "BN11",
      "BN12",
    ]);
  });
});
