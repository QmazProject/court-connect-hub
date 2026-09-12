import { describe, it, expect } from "vitest";
import { hasGoogleProvider, isFreshGoogleAccount } from "../google-account";

const at = (ms: number) => new Date(ms).toISOString();
const T = Date.parse("2026-09-12T10:00:00.000Z");

describe("hasGoogleProvider", () => {
  it("reads either shape Supabase uses", () => {
    expect(hasGoogleProvider({ app_metadata: { providers: ["google"] } })).toBe(true);
    expect(hasGoogleProvider({ app_metadata: { provider: "google" } })).toBe(true);
    expect(hasGoogleProvider({ app_metadata: { providers: ["email", "google"] } })).toBe(true);
  });

  it("is false for an account with no Google identity", () => {
    expect(hasGoogleProvider({ app_metadata: { provider: "email" } })).toBe(false);
    expect(hasGoogleProvider({ app_metadata: {} })).toBe(false);
    expect(hasGoogleProvider({ app_metadata: null })).toBe(false);
    expect(hasGoogleProvider({})).toBe(false);
  });
});

describe("isFreshGoogleAccount", () => {
  /* The case both sign-in pages exist to catch: a Google address with no CourtHub
     account behind it. Supabase creates the account during the round trip, so the
     only signal is that it was created moments ago. */
  it("is true when the account was created by the sign-in happening right now", () => {
    expect(
      isFreshGoogleAccount({
        app_metadata: { providers: ["google"] },
        created_at: at(T),
        last_sign_in_at: at(T + 400),
      }),
    ).toBe(true);
  });

  it("is true when there is no recorded sign-in yet", () => {
    expect(isFreshGoogleAccount({ app_metadata: { provider: "google" }, created_at: at(T) })).toBe(
      true,
    );
  });

  /* A member invited by an admin: the account was created when the invitation was
     sent, so their first Google sign-in days later must not be mistaken for this. */
  it("is false for a returning account, however it was originally created", () => {
    expect(
      isFreshGoogleAccount({
        app_metadata: { providers: ["google"] },
        created_at: at(T),
        last_sign_in_at: at(T + 60_000),
      }),
    ).toBe(false);
    expect(
      isFreshGoogleAccount({
        app_metadata: { providers: ["google"] },
        created_at: at(T),
        last_sign_in_at: at(T + 3 * 24 * 3600 * 1000),
      }),
    ).toBe(false);
  });

  it("never fires for a non-Google account, however new", () => {
    expect(
      isFreshGoogleAccount({
        app_metadata: { provider: "email" },
        created_at: at(T),
        last_sign_in_at: at(T),
      }),
    ).toBe(false);
  });

  it("treats the boundary consistently either side of the window", () => {
    const fresh = (gap: number) =>
      isFreshGoogleAccount({
        app_metadata: { providers: ["google"] },
        created_at: at(T),
        last_sign_in_at: at(T + gap),
      });
    expect(fresh(9_999)).toBe(true);
    expect(fresh(10_000)).toBe(false);
    expect(fresh(10_001)).toBe(false);
  });
});
