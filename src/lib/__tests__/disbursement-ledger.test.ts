/**
 * Balance reconciliation across a disbursement's life, in the client mirror
 * of the ledger arithmetic (`deriveBalances`). The database view is the
 * authority; this pins that the same entries the settlement functions write
 * — reserve, pay, release, re-reserve on retry — always leave available,
 * reserved and paid-out reconciled, and that liability is never lost.
 */
import { describe, expect, it } from "vitest";
import { deriveBalances, type LedgerEntry } from "../ledger";

const entry = (entry_type: string, fields: Partial<LedgerEntry> = {}): LedgerEntry => ({
  entry_type,
  gross_centavos: 0,
  platform_collected_centavos: 0,
  tenant_collected_centavos: 0,
  liability_centavos: 0,
  reserved_centavos: 0,
  paid_out_centavos: 0,
  ...fields,
});

const sale = entry("platform_payment_received", {
  gross_centavos: 15000,
  platform_collected_centavos: 15000,
  liability_centavos: 15000,
});

describe("a successful PayMongo disbursement", () => {
  it("moves the amount from reserved to paid out and leaves available untouched by the settlement", () => {
    const requested = deriveBalances([
      sale,
      entry("payout_reserved", { reserved_centavos: 10000, payout_id: 1 }),
    ]);
    expect(requested).toMatchObject({
      reservedCentavos: 10000,
      availableCentavos: 5000,
      paidOutCentavos: 0,
    });

    const paid = deriveBalances([
      sale,
      entry("payout_reserved", { reserved_centavos: 10000, payout_id: 1 }),
      entry("payout_paid", { reserved_centavos: -10000, paid_out_centavos: 10000, payout_id: 1 }),
    ]);
    expect(paid).toMatchObject({
      reservedCentavos: 0,
      paidOutCentavos: 10000,
      availableCentavos: 5000,
      liabilityCentavos: 15000,
    });
  });
});

describe("a failed PayMongo disbursement", () => {
  it("releases the reservation back to available and loses no liability", () => {
    const b = deriveBalances([
      sale,
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }),
    ]);
    expect(b).toMatchObject({
      reservedCentavos: 0,
      paidOutCentavos: 0,
      availableCentavos: 15000,
      liabilityCentavos: 15000,
    });
  });

  it("a retry re-reserves, and a second failure releases exactly that — never twice", () => {
    const b = deriveBalances([
      sale,
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }),
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }), // :a2
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }), // :a2
    ]);
    expect(b.reservedCentavos).toBe(0);
    expect(b.availableCentavos).toBe(15000);
  });

  it("a retry that then succeeds pays exactly the amount once", () => {
    const b = deriveBalances([
      sale,
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }),
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_paid", { reserved_centavos: -5000, paid_out_centavos: 5000, payout_id: 2 }),
    ]);
    expect(b).toMatchObject({
      reservedCentavos: 0,
      paidOutCentavos: 5000,
      availableCentavos: 10000,
    });
  });
});

describe("the whole verification run nets to zero", () => {
  it("seed, success, failure+retry, manual, then the reversing debit", () => {
    const b = deriveBalances([
      entry("adjustment_credit", { liability_centavos: 15000 }),
      entry("payout_reserved", { reserved_centavos: 10000, payout_id: 1 }),
      entry("payout_paid", { reserved_centavos: -10000, paid_out_centavos: 10000, payout_id: 1 }),
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }),
      entry("payout_reserved", { reserved_centavos: 5000, payout_id: 2 }),
      entry("payout_released", { reserved_centavos: -5000, payout_id: 2 }),
      entry("payout_reserved", { reserved_centavos: 3000, payout_id: 3 }),
      entry("payout_paid", { reserved_centavos: -3000, paid_out_centavos: 3000, payout_id: 3 }),
      entry("adjustment_debit", { liability_centavos: -2000 }),
    ]);
    expect(b).toMatchObject({
      reservedCentavos: 0,
      paidOutCentavos: 13000,
      availableCentavos: 0,
      netPositionCentavos: 0,
    });
  });
});
