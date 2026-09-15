/**
 * Recurring payouts: who is due, computed and never acted on.
 *
 * The rule the Disbursements queue rests on is that being due changes nothing
 * by itself. These pin the arithmetic — when weekly, twice-monthly and monthly
 * schedules fall due, and the four things that make a due tenant NOT due:
 * manual frequency, no available balance, an open payout, no payout account.
 */
import { describe, expect, it } from "vitest";
import { nextDueDate, recurringStatus } from "../payout-providers";

const at = (iso: string) => new Date(iso);

const base = {
  lastPaidAt: null as string | null,
  scheduleSetAt: "2026-09-01T00:00:00Z",
  availableCentavos: 150_000,
  hasOpenPayout: false,
  hasPayoutAccount: true,
};

describe("next due date", () => {
  it("weekly is seven days after the anchor", () => {
    expect(nextDueDate("weekly", at("2026-09-01T10:00:00Z"))?.toISOString()).toBe(
      "2026-09-08T10:00:00.000Z",
    );
  });

  it("twice monthly is the next 1st or 16th strictly after the anchor", () => {
    expect(nextDueDate("twice_monthly", at("2026-09-03T00:00:00Z"))?.toISOString()).toBe(
      "2026-09-16T00:00:00.000Z",
    );
    expect(nextDueDate("twice_monthly", at("2026-09-16T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(nextDueDate("twice_monthly", at("2026-09-30T23:00:00Z"))?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("monthly is the 1st of the following month, including across a year end", () => {
    expect(nextDueDate("monthly", at("2026-09-15T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(nextDueDate("monthly", at("2026-12-20T00:00:00Z"))?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("manual has no next date", () => {
    expect(nextDueDate("manual", at("2026-09-01T00:00:00Z"))).toBeNull();
  });
});

describe("who is due", () => {
  it("weekly: due once a week has passed since the last payout", () => {
    const paid = "2026-09-01T00:00:00Z";
    expect(
      recurringStatus({
        ...base,
        frequency: "weekly",
        lastPaidAt: paid,
        now: at("2026-09-07T00:00:00Z"),
      }).due,
    ).toBe(false);
    const r = recurringStatus({
      ...base,
      frequency: "weekly",
      lastPaidAt: paid,
      now: at("2026-09-08T00:00:00Z"),
    });
    expect(r.due).toBe(true);
    expect(r.nextDueAt?.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  it("twice monthly: due on the 16th and the 1st", () => {
    const paid = "2026-09-02T00:00:00Z";
    expect(
      recurringStatus({
        ...base,
        frequency: "twice_monthly",
        lastPaidAt: paid,
        now: at("2026-09-15T23:59:00Z"),
      }).due,
    ).toBe(false);
    expect(
      recurringStatus({
        ...base,
        frequency: "twice_monthly",
        lastPaidAt: paid,
        now: at("2026-09-16T00:00:00Z"),
      }).due,
    ).toBe(true);
  });

  it("monthly: due on the 1st of the next month", () => {
    const paid = "2026-09-10T00:00:00Z";
    expect(
      recurringStatus({
        ...base,
        frequency: "monthly",
        lastPaidAt: paid,
        now: at("2026-09-30T00:00:00Z"),
      }).due,
    ).toBe(false);
    expect(
      recurringStatus({
        ...base,
        frequency: "monthly",
        lastPaidAt: paid,
        now: at("2026-10-01T00:00:00Z"),
      }).due,
    ).toBe(true);
  });

  it("a tenant that has never been paid anchors on when the schedule was set", () => {
    const r = recurringStatus({
      ...base,
      frequency: "weekly",
      scheduleSetAt: "2026-09-01T00:00:00Z",
      now: at("2026-09-09T00:00:00Z"),
    });
    expect(r.due).toBe(true);
  });

  it("manual never appears, however long it has been", () => {
    const r = recurringStatus({
      ...base,
      frequency: "manual",
      lastPaidAt: "2020-01-01T00:00:00Z",
      now: at("2026-09-15T00:00:00Z"),
    });
    expect(r.due).toBe(false);
    expect(r.nextDueAt).toBeNull();
  });

  it("a zero available balance is not due", () => {
    const r = recurringStatus({
      ...base,
      frequency: "weekly",
      availableCentavos: 0,
      now: at("2026-10-01T00:00:00Z"),
    });
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/nothing available/i);
  });

  it("an open payout already holds the money, so the tenant is not due again", () => {
    const r = recurringStatus({
      ...base,
      frequency: "weekly",
      hasOpenPayout: true,
      now: at("2026-10-01T00:00:00Z"),
    });
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/in progress/i);
  });

  it("no payout account: due, but not sendable — reported, not hidden", () => {
    const r = recurringStatus({
      ...base,
      frequency: "weekly",
      hasPayoutAccount: false,
      now: at("2026-10-01T00:00:00Z"),
    });
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/no payout account/i);
    expect(r.nextDueAt).not.toBeNull();
  });

  it("an unknown or missing anchor is never due", () => {
    expect(
      recurringStatus({
        ...base,
        frequency: "weekly",
        scheduleSetAt: null,
        now: at("2026-10-01T00:00:00Z"),
      }).due,
    ).toBe(false);
  });
});
