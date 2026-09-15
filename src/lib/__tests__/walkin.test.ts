import { describe, expect, it } from "vitest";
import {
  BOOKING_SOURCE_LABEL,
  bookingMoney,
  collectionForWalkIn,
  sourcePairingIsValid,
  totalBookingMoney,
  toCentavos,
  validateWalkInDraft,
  walkInReference,
  type MoneyBooking,
  type WalkInDraft,
} from "../walkin";

const online = (unit_price: number, payment_status = "paid"): MoneyBooking => ({
  booking_source: "online",
  payment_collection_source: "platform",
  payment_status,
  unit_price,
});

const walkIn = (unit_price: number, paid = true): MoneyBooking => ({
  booking_source: "walk_in",
  payment_collection_source: paid ? "tenant" : "unpaid",
  payment_status: paid ? "paid" : "unpaid",
  unit_price,
});

describe("walk-in accounting — the distinction the feature exists for", () => {
  it("walk-in cash raises tenant sales and NOT platform payout liability", () => {
    const m = bookingMoney(walkIn(600));
    expect(m.grossValue).toBe(60_000);
    expect(m.tenantCollected).toBe(60_000);
    expect(m.platformCollected).toBe(0);
    expect(m.platformOwesTenant).toBe(0);
  });

  it("an online payment does contribute to what the platform owes", () => {
    const m = bookingMoney(online(1000));
    expect(m.grossValue).toBe(100_000);
    expect(m.platformCollected).toBe(100_000);
    expect(m.tenantCollected).toBe(0);
    expect(m.platformOwesTenant).toBe(100_000);
  });

  /* The worked example from the request: ₱1,000 online and ₱1,000 walk-in are
     ₱2,000 of booking value, but only ₱1,000 of it is money the platform holds. */
  it("mixed trade: gross counts everything, liability counts only platform cash", () => {
    const t = totalBookingMoney([online(1000), walkIn(1000)]);
    expect(t.grossValue).toBe(200_000);
    expect(t.platformCollected).toBe(100_000);
    expect(t.tenantCollected).toBe(100_000);
    expect(t.platformOwesTenant).toBe(100_000);
  });

  it("an unpaid walk-in is nobody's cash yet", () => {
    const m = bookingMoney(walkIn(500, false));
    expect(m.tenantCollected).toBe(0);
    expect(m.platformCollected).toBe(0);
    expect(m.platformOwesTenant).toBe(0);
  });

  it("a refunded online booking stops counting as revenue or as liability", () => {
    const m = bookingMoney(online(1000, "refunded"));
    expect(m.grossValue).toBe(0);
    expect(m.platformCollected).toBe(0);
    expect(m.platformOwesTenant).toBe(0);
  });

  it("no quantity of walk-ins can ever create payout liability", () => {
    const many = Array.from({ length: 250 }, (_, i) => walkIn(100 + i));
    expect(totalBookingMoney(many).platformOwesTenant).toBe(0);
    expect(totalBookingMoney(many).tenantCollected).toBeGreaterThan(0);
  });

  /* Money is centavos precisely so a long day of odd prices cannot drift. */
  it("totals are exact across prices that do not divide evenly", () => {
    const t = totalBookingMoney([online(33.33), online(33.33), online(33.34)]);
    expect(t.platformOwesTenant).toBe(10_000);
  });

  it("converts pesos to centavos without floating-point drift", () => {
    expect(toCentavos(0.1 + 0.2)).toBe(30);
    expect(toCentavos(1000.005)).toBe(100_001);
    expect(toCentavos(null)).toBe(0);
  });
});

describe("source and collection must agree", () => {
  it("matches the database CHECK constraint", () => {
    expect(sourcePairingIsValid("online", "platform")).toBe(true);
    expect(sourcePairingIsValid("online", "tenant")).toBe(false);
    expect(sourcePairingIsValid("online", "unpaid")).toBe(false);
    expect(sourcePairingIsValid("walk_in", "tenant")).toBe(true);
    expect(sourcePairingIsValid("walk_in", "unpaid")).toBe(true);
    expect(sourcePairingIsValid("walk_in", "platform")).toBe(false);
  });

  it("a paid walk-in is tenant-collected, an unpaid one is neither", () => {
    expect(collectionForWalkIn(true)).toBe("tenant");
    expect(collectionForWalkIn(false)).toBe("unpaid");
  });

  it("labels every source for a badge", () => {
    expect(BOOKING_SOURCE_LABEL.online).toBe("ONLINE");
    expect(BOOKING_SOURCE_LABEL.walk_in).toBe("WALK-IN");
    expect(BOOKING_SOURCE_LABEL.admin_manual).toBe("MANUAL");
  });
});

describe("receipt reference", () => {
  it("reads as the request specified", () => {
    expect(walkInReference("2026-09-14", 42)).toBe("CCH-WI-20260914-0042");
  });

  it("does not truncate a venue past its four-thousandth booking", () => {
    expect(walkInReference("2026-09-14", 12345)).toBe("CCH-WI-20260914-12345");
  });

  it("is distinct per booking number, so one reference means one sale", () => {
    const refs = new Set([1, 2, 3].map((n) => walkInReference("2026-09-14", n)));
    expect(refs.size).toBe(3);
  });
});

describe("draft validation", () => {
  const good: WalkInDraft = {
    courtId: 7,
    dateISO: "2026-09-14",
    startHour: 18,
    endHour: 19,
    customerName: "Mark Santos",
    paid: true,
    paymentMethod: "cash",
  };

  it("accepts a complete draft", () => {
    expect(validateWalkInDraft(good)).toEqual([]);
  });

  it("requires a customer name, since a walk-in has no account to fall back on", () => {
    expect(validateWalkInDraft({ ...good, customerName: "   " })).toContain(
      "Enter the customer's name.",
    );
  });

  it("rejects a backwards or empty time range", () => {
    expect(validateWalkInDraft({ ...good, startHour: 19, endHour: 18 })).toContain(
      "The booking must end after it starts.",
    );
    expect(validateWalkInDraft({ ...good, startHour: 19, endHour: 19 })).toContain(
      "The booking must end after it starts.",
    );
  });

  it("rejects a malformed email and a nonsense player count", () => {
    expect(validateWalkInDraft({ ...good, customerEmail: "nope" }).length).toBe(1);
    expect(validateWalkInDraft({ ...good, playerCount: 0 }).length).toBe(1);
  });

  it("requires a court and a date", () => {
    expect(validateWalkInDraft({ ...good, courtId: null })).toContain("Choose a court.");
    expect(validateWalkInDraft({ ...good, dateISO: "14/09/2026" })).toContain("Choose a date.");
  });
});
