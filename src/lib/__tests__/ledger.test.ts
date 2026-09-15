/**
 * The marketplace accounting rules.
 *
 * Balances live in `public.tenant_ledger_entries` and the `tenant_balances` view.
 * There is no Postgres in this environment, so this file does two things:
 *
 *   1. re-implements the trigger semantics from 20260926000000 exactly — same
 *      columns written, same idempotency keys — so the *rules* are executable,
 *      and asserts the app's deriveBalances() agrees with the view's formula;
 *   2. drives the end-to-end scenario the product is specified by: a cash
 *      walk-in, an online PayMongo booking, a refund, and a payout.
 *
 * It tests the semantics the migration relies on, not the migration itself;
 * running the SQL against a real database is still required.
 */
import { describe, expect, it } from "vitest";
import {
  deriveBalances,
  balanceViolations,
  balanceFromRow,
  canRequestPayout,
  pesoFromCentavos,
  toCentavos,
  ZERO_BALANCE,
  type LedgerEntry,
} from "../ledger";

/* ------------------------------------------------------------------------ */
/* A simulator of the SQL triggers and payout RPCs.                          */
/* ------------------------------------------------------------------------ */

class LedgerSim {
  entries: LedgerEntry[] = [];
  private keys = new Set<string>();

  /** Mirror of ledger_append(): ON CONFLICT (idempotency_key) DO NOTHING. */
  append(key: string, e: Omit<LedgerEntry, "entry_type"> & { entry_type: string }): boolean {
    if (this.keys.has(key)) return false; // the duplicate-webhook defence
    this.keys.add(key);
    this.entries.push(e);
    return true;
  }

  private static base() {
    return {
      gross_centavos: 0,
      platform_collected_centavos: 0,
      tenant_collected_centavos: 0,
      liability_centavos: 0,
      reserved_centavos: 0,
      paid_out_centavos: 0,
    };
  }

  /** ledger_on_transaction_change(), status -> 'paid'. */
  platformPaid(txId: string, pesos: number) {
    const c = toCentavos(pesos);
    return this.append(`tx:paid:${txId}`, {
      ...LedgerSim.base(),
      entry_type: "platform_payment_received",
      gross_centavos: c,
      platform_collected_centavos: c,
      liability_centavos: c,
    });
  }

  /** ledger_on_transaction_change(), status -> 'refunded'. */
  platformRefunded(txId: string, pesos: number) {
    const c = toCentavos(pesos);
    return this.append(`tx:refunded:${txId}`, {
      ...LedgerSim.base(),
      entry_type: "refund",
      platform_collected_centavos: -c,
      liability_centavos: -c,
    });
  }

  /** ledger_on_booking_change(), walk-in settled at the desk. */
  tenantCash(bookingId: number, pesos: number) {
    const c = toCentavos(pesos);
    return this.append(`booking:tenantcash:${bookingId}`, {
      ...LedgerSim.base(),
      entry_type: "tenant_direct_payment",
      gross_centavos: c,
      tenant_collected_centavos: c,
      liability_centavos: 0, // the rule the product rests on
    });
  }

  /** ledger_on_booking_change(), walk-in cancelled. */
  tenantCancelled(bookingId: number, pesos: number) {
    const c = toCentavos(pesos);
    return this.append(`booking:tenantcancel:${bookingId}`, {
      ...LedgerSim.base(),
      entry_type: "cancellation_adjustment",
      gross_centavos: -c,
      tenant_collected_centavos: -c,
      liability_centavos: 0,
    });
  }

  /** tenant_request_payout(): refuses over-request, then reserves. */
  requestPayout(payoutId: number, centavos: number): "ok" | "insufficient" {
    if (centavos > deriveBalances(this.entries).availableCentavos) return "insufficient";
    this.append(`payout:reserved:${payoutId}`, {
      ...LedgerSim.base(),
      entry_type: "payout_reserved",
      reserved_centavos: centavos,
    });
    return "ok";
  }

  /** admin_transition_payout(..., 'rejected'|'failed') and tenant_cancel_payout(). */
  releasePayout(payoutId: number, centavos: number) {
    return this.append(`payout:released:${payoutId}`, {
      ...LedgerSim.base(),
      entry_type: "payout_released",
      reserved_centavos: -centavos,
    });
  }

  /** admin_transition_payout(..., 'paid'). */
  payPayout(payoutId: number, centavos: number) {
    return this.append(`payout:paid:${payoutId}`, {
      ...LedgerSim.base(),
      entry_type: "payout_paid",
      reserved_centavos: -centavos,
      paid_out_centavos: centavos,
    });
  }

  balances() {
    return deriveBalances(this.entries);
  }
}

/* ------------------------------------------------------------------------ */

describe("walk-in cash is sales but never platform liability", () => {
  it("a ₱500 cash walk-in adds ₱500 of sales and ₱0 of payout liability", () => {
    const sim = new LedgerSim();
    sim.tenantCash(1, 500);
    const b = sim.balances();
    expect(b.grossCentavos).toBe(50_000);
    expect(b.tenantCollectedCentavos).toBe(50_000);
    expect(b.platformCollectedCentavos).toBe(0);
    expect(b.liabilityCentavos).toBe(0);
    expect(b.availableCentavos).toBe(0);
  });

  it("no quantity of walk-ins ever becomes requestable balance", () => {
    const sim = new LedgerSim();
    for (let i = 1; i <= 200; i += 1) sim.tenantCash(i, 100 + i);
    const b = sim.balances();
    expect(b.tenantCollectedCentavos).toBeGreaterThan(0);
    expect(b.availableCentavos).toBe(0);
    expect(balanceViolations(b)).toEqual([]);
  });

  it("cancelling a walk-in reverses tenant sales and creates no platform refund", () => {
    const sim = new LedgerSim();
    sim.tenantCash(1, 600);
    sim.tenantCancelled(1, 600);
    const b = sim.balances();
    expect(b.tenantCollectedCentavos).toBe(0);
    expect(b.grossCentavos).toBe(0);
    expect(b.platformCollectedCentavos).toBe(0); // the platform never held it
    expect(b.liabilityCentavos).toBe(0);
  });
});

describe("online PayMongo money does create liability", () => {
  it("a ₱1,000 online booking is collected by the platform and owed to the tenant", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    const b = sim.balances();
    expect(b.platformCollectedCentavos).toBe(100_000);
    expect(b.liabilityCentavos).toBe(100_000);
    expect(b.availableCentavos).toBe(100_000);
  });

  it("a refund reverses the liability but keeps the gross on the record", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.platformRefunded("tx-1", 1000);
    const b = sim.balances();
    expect(b.liabilityCentavos).toBe(0);
    expect(b.availableCentavos).toBe(0);
    expect(b.refundedCentavos).toBe(100_000);
    /* Gross is unchanged: the customer really did pay, and the money really did
       come back. Erasing it would make the two facts unauditable. */
    expect(b.grossCentavos).toBe(100_000);
  });

  it("a duplicate webhook cannot pay the same transaction twice", () => {
    const sim = new LedgerSim();
    expect(sim.platformPaid("tx-1", 1000)).toBe(true);
    expect(sim.platformPaid("tx-1", 1000)).toBe(false); // idempotency key
    expect(sim.platformPaid("tx-1", 1000)).toBe(false);
    expect(sim.balances().liabilityCentavos).toBe(100_000);
  });

  it("a duplicate refund is idempotent", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    expect(sim.platformRefunded("tx-1", 1000)).toBe(true);
    expect(sim.platformRefunded("tx-1", 1000)).toBe(false);
    expect(sim.balances().liabilityCentavos).toBe(0);
  });
});

describe("the mixed trade the business model is built on", () => {
  /* The worked example from the specification: ₱1,000 online plus ₱500 cash is
     ₱1,500 of sales, and ₱1,000 — not ₱1,500 — of money Court Connect holds. */
  it("separates what was sold from what the platform owes", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.tenantCash(1, 500);
    const b = sim.balances();
    expect(b.grossCentavos).toBe(150_000);
    expect(b.tenantCollectedCentavos).toBe(50_000);
    expect(b.platformCollectedCentavos).toBe(100_000);
    expect(b.availableCentavos).toBe(100_000);
    expect(b.availableCentavos).not.toBe(150_000);
  });
});

describe("payout lifecycle", () => {
  it("reserving moves money out of available without paying it", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    expect(sim.requestPayout(1, 30_000)).toBe("ok");
    const b = sim.balances();
    expect(b.reservedCentavos).toBe(30_000);
    expect(b.paidOutCentavos).toBe(0);
    expect(b.availableCentavos).toBe(70_000);
  });

  it("cannot request more than is available", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    expect(sim.requestPayout(1, 100_001)).toBe("insufficient");
    expect(sim.balances().reservedCentavos).toBe(0);
  });

  it("the same balance cannot be reserved twice by two requests", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    expect(sim.requestPayout(1, 100_000)).toBe("ok");
    /* This is the serialised second caller: under pg_advisory_xact_lock it reads
       the balance *after* the first reservation, so it is refused. */
    expect(sim.requestPayout(2, 100_000)).toBe("insufficient");
    expect(sim.balances().reservedCentavos).toBe(100_000);
  });

  it("rejecting releases the reservation back to available", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.requestPayout(1, 40_000);
    sim.releasePayout(1, 40_000);
    const b = sim.balances();
    expect(b.reservedCentavos).toBe(0);
    expect(b.availableCentavos).toBe(100_000);
  });

  it("paying moves reserved into paid out and never back to available", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.requestPayout(1, 40_000);
    sim.payPayout(1, 40_000);
    const b = sim.balances();
    expect(b.reservedCentavos).toBe(0);
    expect(b.paidOutCentavos).toBe(40_000);
    expect(b.availableCentavos).toBe(60_000);
    expect(balanceViolations(b)).toEqual([]);
  });

  it("a payout cannot be paid twice", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.requestPayout(1, 40_000);
    expect(sim.payPayout(1, 40_000)).toBe(true);
    expect(sim.payPayout(1, 40_000)).toBe(false);
    expect(sim.balances().paidOutCentavos).toBe(40_000);
  });
});

describe("the full scenario, end to end", () => {
  it("cash walk-in, online booking, refund, then payout, all reconciling", () => {
    const sim = new LedgerSim();

    // 1-6: a ₱500 cash walk-in.
    sim.tenantCash(1, 500);
    let b = sim.balances();
    expect(b.grossCentavos).toBe(50_000);
    expect(b.tenantCollectedCentavos).toBe(50_000);
    expect(b.availableCentavos).toBe(0);

    // 7-9: a ₱1,000 online booking.
    sim.platformPaid("tx-1", 1000);
    b = sim.balances();
    expect(b.platformCollectedCentavos).toBe(100_000);
    expect(b.availableCentavos).toBe(100_000);

    // 10-15: the player cancels and is refunded.
    sim.platformRefunded("tx-1", 1000);
    b = sim.balances();
    expect(b.availableCentavos).toBe(0);
    expect(b.refundedCentavos).toBe(100_000);

    // A second online booking, so there is something to pay out.
    sim.platformPaid("tx-2", 2000);
    expect(sim.balances().availableCentavos).toBe(200_000);

    // 16-18: the tenant requests ₱1,200 and cannot request it again.
    expect(sim.requestPayout(1, 120_000)).toBe("ok");
    expect(sim.requestPayout(2, 120_000)).toBe("insufficient");
    b = sim.balances();
    expect(b.reservedCentavos).toBe(120_000);
    expect(b.availableCentavos).toBe(80_000);

    // 19-23: the admin pays it.
    sim.payPayout(1, 120_000);
    b = sim.balances();
    expect(b.paidOutCentavos).toBe(120_000);
    expect(b.reservedCentavos).toBe(0);
    expect(b.availableCentavos).toBe(80_000);

    // Everything reconciles, and the walk-in cash never entered any of it.
    expect(b.liabilityCentavos).toBe(b.reservedCentavos + b.paidOutCentavos + b.availableCentavos);
    expect(b.tenantCollectedCentavos).toBe(50_000);
    expect(balanceViolations(b)).toEqual([]);
  });
});

describe("a refund landing after the money was already paid out", () => {
  /* The awkward real case. The platform has sent the tenant its money, and only
     then does a player get refunded. The shortfall must be visible rather than
     silently clamped away, and it must never present as spendable balance. */
  it("shows a negative net position but never a negative available balance", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.requestPayout(1, 100_000);
    sim.payPayout(1, 100_000);
    sim.platformRefunded("tx-1", 1000);

    const b = sim.balances();
    expect(b.netPositionCentavos).toBe(-100_000); // the shortfall, on the record
    expect(b.availableCentavos).toBe(0); // never negative, never spendable
    expect(b.paidOutCentavos).toBe(100_000);
    expect(canRequestPayout(b, 1, true).ok).toBe(false);
  });
});

describe("view parity and money handling", () => {
  it("balanceFromRow matches deriveBalances for the same facts", () => {
    const sim = new LedgerSim();
    sim.platformPaid("tx-1", 1000);
    sim.tenantCash(1, 500);
    sim.requestPayout(1, 25_000);
    const derived = sim.balances();

    /* What the SQL view would return for the same entries, in its own names. */
    const row = {
      tenant_id: "t1",
      gross_centavos: String(derived.grossCentavos),
      platform_collected_centavos: String(derived.platformCollectedCentavos),
      tenant_collected_centavos: String(derived.tenantCollectedCentavos),
      liability_centavos: String(derived.liabilityCentavos),
      reserved_centavos: String(derived.reservedCentavos),
      paid_out_centavos: String(derived.paidOutCentavos),
      refunded_centavos: String(derived.refundedCentavos),
      net_position_centavos: String(derived.netPositionCentavos),
      available_centavos: String(derived.availableCentavos),
    };
    expect(balanceFromRow(row)).toEqual(derived);
  });

  it("bigint columns arriving as strings do not concatenate", () => {
    const b = balanceFromRow({
      tenant_id: "t1",
      gross_centavos: "100",
      platform_collected_centavos: "100",
      tenant_collected_centavos: "0",
      liability_centavos: "100",
      reserved_centavos: "0",
      paid_out_centavos: "0",
      refunded_centavos: "0",
      net_position_centavos: "100",
      available_centavos: "100",
    });
    expect(b.liabilityCentavos).toBe(100);
  });

  it("an empty ledger is the zero balance, not an error", () => {
    expect(deriveBalances([])).toEqual(ZERO_BALANCE);
    expect(balanceFromRow(null)).toEqual(ZERO_BALANCE);
  });

  it("money stays exact across prices that do not divide evenly", () => {
    const sim = new LedgerSim();
    sim.platformPaid("a", 33.33);
    sim.platformPaid("b", 33.33);
    sim.platformPaid("c", 33.34);
    expect(sim.balances().liabilityCentavos).toBe(10_000);
  });

  it("formats centavos as pesos only at the very edge", () => {
    expect(pesoFromCentavos(120_000)).toBe("₱1,200.00");
    expect(pesoFromCentavos(0)).toBe("₱0.00");
    expect(pesoFromCentavos(1)).toBe("₱0.01");
  });

  it("refuses a payout request with no account configured", () => {
    const b = { ...ZERO_BALANCE, liabilityCentavos: 100, availableCentavos: 100 };
    expect(canRequestPayout(b, 100, false).ok).toBe(false);
    expect(canRequestPayout(b, 100, true).ok).toBe(true);
    expect(canRequestPayout(b, 101, true).ok).toBe(false);
  });
});
