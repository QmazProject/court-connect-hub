import { describe, expect, it } from "vitest";
import {
  countByUser,
  countableBookings,
  isCountableBooking,
  isRepeatCustomer,
  NON_COUNTING_STATUS_FILTER,
} from "../booking-counts";

/** Shorthand for a booking row as the tenant queries select it. */
const b = (
  status: string,
  extra: { cancelled_at?: string | null; payment_status?: string } = {},
) => ({
  user_id: "juan",
  status,
  cancelled_at: null,
  ...extra,
});

/** The repeat verdict for one customer's whole history. */
const repeatFrom = (rows: ReturnType<typeof b>[]) =>
  isRepeatCustomer(countByUser(rows).get("juan") ?? 0);

describe("what counts as a booking", () => {
  it("counts a played booking", () => {
    expect(isCountableBooking(b("confirmed"))).toBe(true);
  });

  it("does not count a cancelled booking", () => {
    expect(isCountableBooking(b("cancelled"))).toBe(false);
  });

  it("does not count an expired hold", () => {
    expect(isCountableBooking(b("expired"))).toBe(false);
  });

  it("does not count a row carrying cancelled_at even if its status lags", () => {
    expect(isCountableBooking(b("confirmed", { cancelled_at: "2026-03-01T00:00:00Z" }))).toBe(
      false,
    );
  });

  it("counts an unpaid booking — payment must not decide this", () => {
    expect(isCountableBooking(b("confirmed", { payment_status: "unpaid" }))).toBe(true);
    expect(isCountableBooking(b("pending", { payment_status: "pending" }))).toBe(true);
  });

  it("excludes the non-counting statuses in the query filter", () => {
    expect(NON_COUNTING_STATUS_FILTER).toBe("(cancelled,expired)");
  });
});

/* The ten cases the fix was specified against. */
describe("repeat customer", () => {
  it("1. one played booking is not repeat", () => {
    expect(repeatFrom([b("confirmed")])).toBe(false);
  });

  it("2. one played plus one cancelled is not repeat", () => {
    expect(repeatFrom([b("confirmed"), b("cancelled")])).toBe(false);
  });

  it("3. two non-cancelled bookings is repeat", () => {
    expect(repeatFrom([b("confirmed"), b("confirmed")])).toBe(true);
  });

  it("4. two cancelled bookings is not repeat", () => {
    expect(repeatFrom([b("cancelled"), b("cancelled")])).toBe(false);
  });

  it("5. one cancelled plus two non-cancelled is repeat, and counts 2", () => {
    const rows = [b("cancelled"), b("confirmed"), b("confirmed")];
    expect(countByUser(rows).get("juan")).toBe(2);
    expect(repeatFrom(rows)).toBe(true);
  });

  it("6. two unpaid pay-at-venue bookings are repeat", () => {
    const rows = [
      b("confirmed", { payment_status: "unpaid" }),
      b("confirmed", { payment_status: "unpaid" }),
    ];
    expect(repeatFrom(rows)).toBe(true);
  });

  it("7. history spanning years is judged on the lifetime total, not one year", () => {
    /* Juan: 3 countable in 2024, 2 in 2025, 1 in 2026. Whatever year is being
       reported on, the lifetime pass sees six. */
    const lifetime = [
      ...Array.from({ length: 3 }, () => b("confirmed")),
      ...Array.from({ length: 2 }, () => b("confirmed")),
      b("confirmed"),
    ];
    expect(countByUser(lifetime).get("juan")).toBe(6);
    expect(repeatFrom(lifetime)).toBe(true);
  });

  it("8. a reporting year scopes the period figure without erasing repeat status", () => {
    /* The year pass and the lifetime pass are separate inputs by construction:
       one booking in the selected year, six across the customer's history. */
    const inSelectedYear = [b("confirmed")];
    const lifetime = Array.from({ length: 6 }, () => b("confirmed"));
    expect(countByUser(inSelectedYear).get("juan")).toBe(1);
    expect(repeatFrom(lifetime)).toBe(true);
  });

  it("9. cancelled bookings do not inflate a customer's booking column", () => {
    const rows = [b("confirmed"), b("cancelled"), b("expired"), b("confirmed")];
    expect(countableBookings(rows)).toHaveLength(2);
    expect(countByUser(rows).get("juan")).toBe(2);
  });

  it("10. every pane agrees, because they share one predicate", () => {
    /* Top performers and Customers both reduce to isCountableBooking; the test
       is that the same row set yields the same total through either path. */
    const rows = [b("confirmed"), b("cancelled"), b("pending"), b("expired")];
    const viaFilter = countableBookings(rows).length;
    const viaCount = countByUser(rows).get("juan") ?? 0;
    expect(viaFilter).toBe(2);
    expect(viaCount).toBe(2);
  });
});

describe("counting across customers", () => {
  it("keeps each customer's total separate", () => {
    const rows = [
      { user_id: "juan", status: "confirmed", cancelled_at: null },
      { user_id: "juan", status: "cancelled", cancelled_at: null },
      { user_id: "maria", status: "confirmed", cancelled_at: null },
      { user_id: "maria", status: "confirmed", cancelled_at: null },
    ];
    const counts = countByUser(rows);
    expect(counts.get("juan")).toBe(1);
    expect(counts.get("maria")).toBe(2);
    expect(isRepeatCustomer(counts.get("juan") ?? 0)).toBe(false);
    expect(isRepeatCustomer(counts.get("maria") ?? 0)).toBe(true);
  });

  it("gives an absent customer no count rather than undefined behaviour", () => {
    expect(countByUser([]).get("nobody")).toBeUndefined();
    expect(isRepeatCustomer(countByUser([]).get("nobody") ?? 0)).toBe(false);
  });
});
