import { describe, expect, it } from "vitest";
import { BUSINESS_NAME_MAX, checkBusinessName } from "../tenant-workspace";

describe("checkBusinessName", () => {
  it("accepts ordinary trading names and returns them normalised", () => {
    expect(checkBusinessName("ABC Sports")).toEqual({ ok: true, value: "ABC Sports" });
    expect(checkBusinessName("  Lapu-Lapu   Courts  ")).toEqual({
      ok: true,
      value: "Lapu-Lapu Courts",
    });
    expect(checkBusinessName("Ángeles Sports Center")).toEqual({
      ok: true,
      value: "Ángeles Sports Center",
    });
  });

  it("refuses an empty or whitespace-only name", () => {
    expect(checkBusinessName("").ok).toBe(false);
    expect(checkBusinessName("   ").ok).toBe(false);
  });

  it("refuses a name with no letters in it", () => {
    for (const value of ["123", "---", "!!!", "2026"]) {
      const result = checkBusinessName(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/letter/i);
    }
  });

  it("enforces the length cap after normalising", () => {
    expect(checkBusinessName("A".repeat(BUSINESS_NAME_MAX)).ok).toBe(true);
    expect(checkBusinessName("A".repeat(BUSINESS_NAME_MAX + 1)).ok).toBe(false);
    /* Padding does not count against the cap, because it is stripped first. */
    expect(checkBusinessName("  " + "A".repeat(BUSINESS_NAME_MAX) + "  ").ok).toBe(true);
  });
});

import {
  DUPLICATE_BUSINESS_NAME_MESSAGE,
  isDuplicateBusinessNameError,
  normalizeBusinessNameForComparison,
} from "../tenant-workspace";

describe("normalizeBusinessNameForComparison", () => {
  /* The four spellings the brief lists must be one business. */
  it("treats case and padding variants as the same name", () => {
    const forms = ["QMAZ Holdings", "qmaz holdings", "  QMAZ Holdings  ", "QMAZ HOLDINGS"];
    const norms = new Set(forms.map(normalizeBusinessNameForComparison));
    expect(norms.size).toBe(1);
    expect([...norms][0]).toBe("qmaz holdings");
  });

  it("collapses internal whitespace runs, matching the SQL rule", () => {
    expect(normalizeBusinessNameForComparison("QMAZ   Holdings")).toBe("qmaz holdings");
    expect(normalizeBusinessNameForComparison("QMAZ\tHoldings")).toBe("qmaz holdings");
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeBusinessNameForComparison("ABC Sports")).not.toBe(
      normalizeBusinessNameForComparison("ABC Sports Center"),
    );
  });

  /* checkBusinessName stores the value it returns; the comparison of that value must
     be the same business as the comparison of what was typed. */
  it("agrees with checkBusinessName on what was stored", () => {
    const typed = "  Lapu   Lapu Courts ";
    const stored = checkBusinessName(typed);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(normalizeBusinessNameForComparison(stored.value)).toBe(
        normalizeBusinessNameForComparison(typed),
      );
    }
  });
});

describe("isDuplicateBusinessNameError", () => {
  it("recognises the unique-violation SQLSTATE", () => {
    expect(isDuplicateBusinessNameError({ code: "23505", message: "duplicate key" })).toBe(true);
  });

  it("recognises the index by name when the code is missing", () => {
    expect(
      isDuplicateBusinessNameError({
        message: 'duplicate key value violates unique constraint "uq_tenants_name_normalized"',
      }),
    ).toBe(true);
  });

  it("does not misread other failures as duplicates", () => {
    expect(isDuplicateBusinessNameError({ code: "42501", message: "permission denied" })).toBe(
      false,
    );
    expect(isDuplicateBusinessNameError(new Error("network"))).toBe(false);
    expect(isDuplicateBusinessNameError(null)).toBe(false);
  });

  it("never lets the raw wording through", () => {
    expect(DUPLICATE_BUSINESS_NAME_MESSAGE).not.toMatch(/duplicate key|constraint|uq_|SQLSTATE/i);
  });
});

import { isVenueCreationRefused, VENUE_CREATION_REFUSED_MESSAGE } from "../tenant-workspace";

describe("isVenueCreationRefused", () => {
  it("recognises the policy refusal by SQLSTATE and by message", () => {
    expect(isVenueCreationRefused({ code: "42501", message: "permission denied" })).toBe(true);
    expect(
      isVenueCreationRefused({
        message: 'new row violates row-level security policy for table "venues"',
      }),
    ).toBe(true);
  });
  it("does not misread other failures", () => {
    expect(isVenueCreationRefused({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isVenueCreationRefused(new Error("network"))).toBe(false);
    expect(isVenueCreationRefused(null)).toBe(false);
  });
  it("never lets the raw wording through", () => {
    expect(VENUE_CREATION_REFUSED_MESSAGE).not.toMatch(/row-level|policy|42501|SQLSTATE/i);
  });
});
