/**
 * The payout lifecycle and the payout destination.
 *
 * The database decides every transition (`admin_transition_payout`,
 * `tenant_cancel_payout`) and refuses anything these helpers would also refuse.
 * This file pins the shared vocabulary so the screens cannot offer an action the
 * database will reject, and pins the two security-shaped rules that are easy to
 * get wrong by accident: masking, and the immutability of a destination snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  PAYOUT_STATUSES,
  PAYOUT_STATUS_LABEL,
  adminTransitionsFrom,
  describeDestination,
  isReserving,
  isTerminal,
  maskAccountNumber,
  payoutSummaryLine,
  tenantCanCancel,
  validatePayoutAccount,
  type PayoutDestinationSnapshot,
} from "../payouts";

describe("terminal states are terminal", () => {
  it("paid, rejected and cancelled admit no further transition", () => {
    for (const s of ["paid", "rejected", "cancelled"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(adminTransitionsFrom(s)).toEqual([]);
    }
  });

  it("a paid payout can never be paid again", () => {
    expect(adminTransitionsFrom("paid")).not.toContain("paid");
  });

  it("failed is NOT terminal, because a failed transfer is normally retried", () => {
    expect(isTerminal("failed")).toBe(false);
    expect(adminTransitionsFrom("failed")).toContain("processing");
  });

  it("every status has a human label", () => {
    for (const s of PAYOUT_STATUSES) {
      expect(PAYOUT_STATUS_LABEL[s]).toBeTruthy();
    }
  });
});

describe("which statuses hold money", () => {
  it("an open request reserves the balance", () => {
    for (const s of ["requested", "under_review", "approved", "processing"] as const) {
      expect(isReserving(s)).toBe(true);
    }
  });

  it("a settled or abandoned payout reserves nothing", () => {
    for (const s of ["paid", "rejected", "cancelled", "failed"] as const) {
      expect(isReserving(s)).toBe(false);
    }
  });
});

describe("who may cancel, and when", () => {
  it("a tenant may withdraw a request an admin has not started", () => {
    expect(tenantCanCancel("requested")).toBe(true);
    expect(tenantCanCancel("under_review")).toBe(true);
  });

  it("a tenant may not cancel once money is being moved", () => {
    for (const s of ["approved", "processing", "paid", "failed"] as const) {
      expect(tenantCanCancel(s)).toBe(false);
    }
  });
});

describe("the admin transition graph matches the database", () => {
  it("a new request can be reviewed, approved or rejected — not paid directly", () => {
    const next = adminTransitionsFrom("requested");
    expect(next).toContain("approved");
    expect(next).toContain("rejected");
    expect(next).not.toContain("paid");
  });

  it("only a payout being processed can be marked paid", () => {
    expect(adminTransitionsFrom("processing")).toContain("paid");
    expect(adminTransitionsFrom("approved")).not.toContain("paid");
  });

  it("no transition leads out of a terminal state", () => {
    for (const s of PAYOUT_STATUSES) {
      for (const to of adminTransitionsFrom(s)) {
        expect(isTerminal(s)).toBe(false);
        expect(PAYOUT_STATUSES).toContain(to);
      }
    }
  });
});

describe("account numbers are masked, not disclosed", () => {
  it("keeps only the last four digits", () => {
    expect(maskAccountNumber("09171234567")).toBe("•••••••4567");
    expect(maskAccountNumber("1234567890123456")).toBe("••••••••••••3456");
  });

  it("never reveals a short value at all", () => {
    expect(maskAccountNumber("123")).toBe("•••");
    expect(maskAccountNumber("4821")).toBe("••••");
  });

  it("handles absent values without printing 'null'", () => {
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber("")).toBeNull();
    expect(maskAccountNumber("   ")).toBeNull();
  });

  it("a masked number is never the full number", () => {
    const raw = "09171234567";
    const masked = maskAccountNumber(raw)!;
    expect(masked).not.toBe(raw);
    expect(masked.length).toBe(raw.length);
  });
});

describe("the destination snapshot is what history is read from", () => {
  const snapshot: PayoutDestinationSnapshot = {
    account_id: 7,
    account_type: "gcash",
    account_name: "Juan Dela Cruz",
    account_number_masked: "•••••••4567",
    captured_at: "2026-09-14T10:00:00Z",
  };

  it("describes where the money went from the snapshot alone", () => {
    expect(describeDestination(snapshot)).toBe("GCash •••••••4567");
  });

  it("a later change to the tenant's account cannot rewrite a past payout", () => {
    /* The tenant switches to a bank account. The historical payout still reads
       from its own frozen snapshot object, so its description is unchanged —
       which is the behaviour the immutability trigger enforces in the database. */
    const before = describeDestination(snapshot);
    const nowOnFile: PayoutDestinationSnapshot = {
      account_type: "bank",
      account_name: "Juan Dela Cruz",
      bank_name: "BPI",
      account_number_masked: "••••9999",
    };
    expect(describeDestination(nowOnFile)).not.toBe(before);
    expect(describeDestination(snapshot)).toBe(before);
  });

  it("names the bank when the destination is a bank account", () => {
    expect(
      describeDestination({
        account_type: "bank",
        bank_name: "BPI",
        account_number_masked: "••••9999",
      }),
    ).toBe("Bank account · BPI ••••9999");
  });

  it("survives a missing snapshot rather than crashing a history row", () => {
    expect(describeDestination(null)).toBe("—");
    expect(describeDestination(undefined)).toBe("—");
  });
});

describe("payout account validation mirrors the CHECK constraints", () => {
  it("a bank destination needs a bank name and a number", () => {
    const errors = validatePayoutAccount({
      accountType: "bank",
      accountName: "Juan Dela Cruz",
      accountNumber: "",
      bankName: "",
    });
    expect(errors).toContain("Enter the bank name.");
    expect(errors).toContain("Enter the bank account number.");
  });

  it("an e-wallet needs a plausible mobile number", () => {
    expect(
      validatePayoutAccount({
        accountType: "gcash",
        accountName: "Juan",
        accountNumber: "0917",
        bankName: "",
      }),
    ).toContain("That mobile number looks too short.");
  });

  it("accepts a complete GCash destination", () => {
    expect(
      validatePayoutAccount({
        accountType: "gcash",
        accountName: "Juan Dela Cruz",
        accountNumber: "0917 123 4567",
        bankName: "",
      }),
    ).toEqual([]);
  });

  it("always requires an account holder name", () => {
    expect(
      validatePayoutAccount({
        accountType: "other",
        accountName: "   ",
        accountNumber: "",
        bankName: "",
      }),
    ).toContain("Enter the account holder's name.");
  });
});

describe("the sentence a tenant reads", () => {
  it("separates what is available from what is already requested", () => {
    expect(payoutSummaryLine(2_500_000, 450_000)).toBe(
      "₱25,000.00 available · ₱4,500.00 already requested",
    );
  });

  it("says only what is available when nothing is pending", () => {
    expect(payoutSummaryLine(2_500_000, 0)).toBe("₱25,000.00 available for payout");
  });
});
