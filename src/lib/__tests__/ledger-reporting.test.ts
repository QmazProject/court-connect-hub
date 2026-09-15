/**
 * What `refunded_centavos` is, and what it is not.
 *
 * Live verification against the production project left Tenant A's
 * `refunded_centavos` reading 156,400 where the real refunds sum to 56,400,
 * while gross, platform-collected, liability, reserved, paid-out and available
 * were all restored to the centavo. This file pins why, in executable form,
 * using the exact figures from that database.
 *
 * `refunded` is not a balance. The view defines it as the sum of liability
 * reversed by rows whose entry_type is `refund` or `partial_refund` — a count
 * of refund events, kept so a refund stays visible after the money it reversed
 * has been backed out. That is deliberate: a refund that vanished from the
 * record would be the unauditable case. The consequence is that no other entry
 * type can lower it, and the only one that could — a `refund` row with positive
 * liability — would also raise what the platform owes, which is why such a row
 * must never be written to make a reporting number look tidy.
 */
import { describe, expect, it } from "vitest";
import { balanceViolations, deriveBalances, type LedgerEntry } from "../ledger";

const zero = {
  gross_centavos: 0,
  platform_collected_centavos: 0,
  tenant_collected_centavos: 0,
  liability_centavos: 0,
  reserved_centavos: 0,
  paid_out_centavos: 0,
};

const paid = (c: number): LedgerEntry => ({
  ...zero,
  entry_type: "platform_payment_received",
  gross_centavos: c,
  platform_collected_centavos: c,
  liability_centavos: c,
});

const refund = (c: number): LedgerEntry => ({
  ...zero,
  entry_type: "refund",
  platform_collected_centavos: -c,
  liability_centavos: -c,
});

const adjustmentDebit = (fields: Partial<LedgerEntry>): LedgerEntry => ({
  ...zero,
  entry_type: "adjustment_debit",
  ...fields,
});

describe("refunded counts refund events, nothing else", () => {
  it("is zero until a refund row exists", () => {
    expect(deriveBalances([paid(100_000)]).refundedCentavos).toBe(0);
  });

  it("rises by the liability a refund row reverses", () => {
    const b = deriveBalances([paid(100_000), refund(100_000)]);
    expect(b.refundedCentavos).toBe(100_000);
    expect(b.liabilityCentavos).toBe(0);
    expect(b.grossCentavos).toBe(100_000); // the payment still happened
  });

  it("ignores an adjustment_debit, even one that backs out the refunded sale's gross", () => {
    const b = deriveBalances([
      paid(100_000),
      refund(100_000),
      adjustmentDebit({ gross_centavos: -100_000 }),
    ]);
    expect(b.grossCentavos).toBe(0);
    expect(b.liabilityCentavos).toBe(0);
    expect(b.availableCentavos).toBe(0);
    expect(b.refundedCentavos).toBe(100_000); // untouched, by design
  });
});

describe("the verification residue on the live tenant, reproduced exactly", () => {
  /* Real history, aggregated: 244,300 paid across 50 transactions, 56,400 of it
     refunded across 10. Then the synthetic pair used to prove the refund trigger
     live, and the adjustment that backed out its gross once the synthetic
     transaction was deleted. */
  const live = [
    paid(244_300),
    refund(56_400),
    paid(100_000),
    refund(100_000),
    adjustmentDebit({ gross_centavos: -100_000 }),
  ];

  it("leaves every settlement-critical figure exactly where the real history puts it", () => {
    const b = deriveBalances(live);
    expect(b.grossCentavos).toBe(244_300);
    expect(b.platformCollectedCentavos).toBe(187_900);
    expect(b.tenantCollectedCentavos).toBe(0);
    expect(b.liabilityCentavos).toBe(187_900);
    expect(b.reservedCentavos).toBe(0);
    expect(b.paidOutCentavos).toBe(0);
    expect(b.availableCentavos).toBe(187_900);
  });

  it("carries the synthetic refund in the reporting figure only", () => {
    const b = deriveBalances(live);
    expect(b.refundedCentavos).toBe(156_400);
    expect(b.refundedCentavos - 56_400).toBe(100_000);
  });

  it("violates no balance invariant, which is what makes it reporting-only", () => {
    expect(balanceViolations(deriveBalances(live))).toEqual([]);
  });
});

describe("why the residue is not corrected with another entry", () => {
  it("the only row that could lower refunded is a refund with positive liability, which raises what the platform owes", () => {
    const before = deriveBalances([paid(100_000), refund(100_000)]);
    const falseReversal: LedgerEntry = {
      ...zero,
      entry_type: "refund",
      platform_collected_centavos: 100_000,
      liability_centavos: 100_000,
    };
    const after = deriveBalances([paid(100_000), refund(100_000), falseReversal]);
    expect(after.refundedCentavos).toBe(before.refundedCentavos - 100_000);
    /* ...and the platform would now owe the tenant money it never held. */
    expect(after.liabilityCentavos).toBe(before.liabilityCentavos + 100_000);
    expect(after.availableCentavos).toBe(100_000);
  });
});
