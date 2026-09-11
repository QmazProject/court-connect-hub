import { describe, expect, it } from "vitest";
import {
  classifyOAuthReturn,
  isWellFormedSlug,
  slugsMatch,
  TENANT_LOGIN_PENDING_SLUG_KEY,
  WORKSPACE_SIGN_IN_FAILED,
} from "../tenant-login";

describe("WORKSPACE_SIGN_IN_FAILED", () => {
  it("is the exact approved sentence", () => {
    expect(WORKSPACE_SIGN_IN_FAILED).toBe("These credentials don't work for this workspace.");
  });

  /* The whole point of one message: it must not hint at which failure occurred. */
  it("names no cause, role, or membership state", () => {
    expect(WORKSPACE_SIGN_IN_FAILED).not.toMatch(
      /password|email|account|player|tenant|admin|manager|staff|member|invite|inactive|exist|another|business/i,
    );
  });
});

describe("isWellFormedSlug", () => {
  it("accepts generated slugs and placeholders", () => {
    for (const s of ["qmaz-holdings-inc", "abc-sports", "abc-sports-2", "t-a7f3c2e1", "cebu"]) {
      expect(isWellFormedSlug(s)).toBe(true);
    }
  });

  it("refuses anything that is not a slug", () => {
    for (const s of [
      "",
      "   ",
      "UPPER",
      "has space",
      "trailing-",
      "-leading",
      "double--hyphen",
      "../etc",
      "a/b",
      "sql'injection",
      null,
      undefined,
      "x".repeat(81),
    ]) {
      expect(isWellFormedSlug(s as string)).toBe(false);
    }
  });
});

describe("slugsMatch", () => {
  it("ignores case and padding, matching the SQL lower(btrim(…))", () => {
    expect(slugsMatch("abc-sports", "ABC-Sports")).toBe(true);
    expect(slugsMatch("  abc-sports ", "abc-sports")).toBe(true);
  });

  it("keeps different slugs apart, and treats empty as matching nothing", () => {
    expect(slugsMatch("abc-sports", "abc-sports-2")).toBe(false);
    expect(slugsMatch("", "")).toBe(false);
    expect(slugsMatch(null, null)).toBe(false);
  });
});

describe("classifyOAuthReturn", () => {
  it("verifies when the stash matches the URL", () => {
    expect(classifyOAuthReturn("abc-sports", "abc-sports")).toEqual({
      kind: "verify",
      slug: "abc-sports",
    });
  });

  it("treats no stash as an ordinary visit, not an attempt", () => {
    expect(classifyOAuthReturn("abc-sports", null)).toEqual({ kind: "none" });
    expect(classifyOAuthReturn("abc-sports", "")).toEqual({ kind: "none" });
  });

  /* Editing the URL between leaving for Google and coming back is the attack this
     exists to refuse. The answer is neither slug — it is a refusal. */
  it("fails closed when the URL was changed during the round trip", () => {
    expect(classifyOAuthReturn("other-tenant", "abc-sports")).toEqual({ kind: "mismatch" });
    expect(classifyOAuthReturn("", "abc-sports")).toEqual({ kind: "mismatch" });
  });

  it("never returns the URL's slug as the one to verify", () => {
    const result = classifyOAuthReturn("attacker-tenant", "abc-sports");
    expect(result.kind).toBe("mismatch");
    if (result.kind === "verify") expect(result.slug).not.toBe("attacker-tenant");
  });

  it("uses its own storage key, not the landing page's OAuth keys", () => {
    expect(TENANT_LOGIN_PENDING_SLUG_KEY).toBe("courthub_tenant_login_pending_slug");
    expect(TENANT_LOGIN_PENDING_SLUG_KEY).not.toMatch(/pending_role|pending_business|signin_side/);
  });
});
