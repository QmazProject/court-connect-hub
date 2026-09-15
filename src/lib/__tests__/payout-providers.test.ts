/**
 * The PayMongo provider's pure rules: rail selection, destination mapping
 * against PayMongo's receiving-institution list, the transfer request body,
 * and reading a `transfer.outward.*` webhook.
 *
 * None of these may guess. A BIC comes from the institution list or the
 * mapping is refused; an event's outcome comes from its type and status or
 * the event is not a success.
 */
import { describe, expect, it } from "vitest";
import {
  INSTAPAY_MAX_CENTAVOS,
  PAYMONGO_WALLET_BIC,
  buildTransferRequest,
  isTransferEvent,
  mapDestination,
  parseTransferEvent,
  pendingLooksStuck,
  railForAmount,
  referenceMatches,
  sanitizeProviderPayload,
  transferReference,
  type ReceivingInstitution,
} from "../payout-providers";

const INSTITUTIONS: ReceivingInstitution[] = [
  { id: "1", name: "G-XCHANGE, INC. (GCASH)", provider: "instapay", bic: "GXCHPHM2XXX" },
  { id: "2", name: "PAYMAYA PHILIPPINES, INC.", provider: "instapay", bic: "PAPHPHM1XXX" },
  { id: "3", name: "BDO UNIBANK, INC.", provider: "instapay", bic: "BNORPHMM" },
  { id: "4", name: "BANK OF THE PHILIPPINE ISLANDS", provider: "instapay", bic: "BOPIPHMM" },
  { id: "5", name: "UNION BANK OF THE PHILIPPINES", provider: "instapay", bic: "UBPHPHMM" },
  { id: "6", name: "UNIONBANK DIGITAL", provider: "instapay", bic: "UBPDPHMM" },
];

describe("rail selection", () => {
  it("uses InstaPay up to ₱50,000 and PESONet above it", () => {
    expect(railForAmount(100)).toBe("instapay");
    expect(railForAmount(INSTAPAY_MAX_CENTAVOS)).toBe("instapay");
    expect(railForAmount(INSTAPAY_MAX_CENTAVOS + 1)).toBe("pesonet");
  });
});

describe("destination mapping", () => {
  const gcash = {
    accountType: "gcash",
    accountName: "Juan Dela Cruz",
    accountNumber: "0917 123 4567",
    bankName: null,
    savedBic: null,
  };

  it("maps GCash by finding the one matching institution; the BIC is the list's, not ours", () => {
    const m = mapDestination(gcash, INSTITUTIONS);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.bic).toBe("GXCHPHM2XXX");
      expect(m.accountNumber).toBe("09171234567");
      expect(m.matchedBy).toBe("name");
    }
  });

  it("maps Maya the same way", () => {
    const m = mapDestination({ ...gcash, accountType: "maya" }, INSTITUTIONS);
    expect(m.ok && m.bic).toBe("PAPHPHM1XXX");
  });

  it("prefers a BIC an admin already chose, and verifies it is still listed", () => {
    const m = mapDestination({ ...gcash, savedBic: "GXCHPHM2XXX" }, INSTITUTIONS);
    expect(m.ok && m.matchedBy).toBe("saved");
    const gone = mapDestination({ ...gcash, savedBic: "NOPE" }, INSTITUTIONS);
    expect(gone.ok).toBe(false);
  });

  it("maps a bank by a unique name match", () => {
    const m = mapDestination(
      {
        accountType: "bank",
        accountName: "Court Co",
        accountNumber: "1234567890",
        bankName: "BDO Unibank",
        savedBic: null,
      },
      INSTITUTIONS,
    );
    expect(m.ok && m.bic).toBe("BNORPHMM");
  });

  it("refuses an ambiguous bank name and offers the candidates rather than picking one", () => {
    const m = mapDestination(
      {
        accountType: "bank",
        accountName: "Court Co",
        accountNumber: "1234567890",
        bankName: "UnionBank",
        savedBic: null,
      },
      INSTITUTIONS,
    );
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.candidates.length).toBeGreaterThanOrEqual(2);
      expect(m.reason).toMatch(/choose/i);
    }
  });

  it("refuses an unknown bank with no candidates", () => {
    const m = mapDestination(
      {
        accountType: "bank",
        accountName: "Court Co",
        accountNumber: "1234567890",
        bankName: "Bank of Nowhere",
        savedBic: null,
      },
      INSTITUTIONS,
    );
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.candidates).toEqual([]);
  });

  it("refuses a destination with no number, and a type PayMongo cannot reach", () => {
    expect(mapDestination({ ...gcash, accountNumber: "" }, INSTITUTIONS).ok).toBe(false);
    expect(mapDestination({ ...gcash, accountType: "other" }, INSTITUTIONS).ok).toBe(false);
  });

  it("refuses when the wallet is not on the list at all", () => {
    const m = mapDestination(
      gcash,
      INSTITUTIONS.filter((i) => !/gcash/i.test(i.name)),
    );
    expect(m.ok).toBe(false);
  });
});

describe("the transfer request", () => {
  const source = { number: "0000000001", name: "Court Connect", bic: PAYMONGO_WALLET_BIC };

  it("is the documented batch-transfer shape, amount in centavos, PHP, with our reference and ids", () => {
    const body = buildTransferRequest({
      payoutId: 42,
      attemptId: 7,
      attemptNo: 2,
      tenantId: "t-1",
      amountCentavos: 125_000,
      source,
      destination: { bic: "GXCHPHM2XXX", accountNumber: "09171234567", accountName: "Juan" },
      tenantName: "Ace Courts",
    });
    expect(body).toMatchObject({
      provider: "instapay",
      amount: 125_000,
      currency: "PHP",
      reference_number: "CCH P42 A2",
      source_account: source,
      destination_account: { number: "09171234567", name: "Juan", bic: "GXCHPHM2XXX" },
      metadata: { payout_id: "42", attempt_id: "7", attempt_no: "2", tenant_id: "t-1" },
    });
    expect(body.description).toContain("#42");
  });

  it("switches to PESONet above the InstaPay ceiling", () => {
    const body = buildTransferRequest({
      payoutId: 1,
      attemptId: 1,
      attemptNo: 1,
      tenantId: "t",
      amountCentavos: 6_000_000,
      source,
      destination: { bic: "BNORPHMM", accountNumber: "1", accountName: "A" },
    });
    expect(body.provider).toBe("pesonet");
  });

  it("refuses a non-positive or fractional amount", () => {
    const args = {
      payoutId: 1,
      attemptId: 1,
      attemptNo: 1,
      tenantId: "t",
      source,
      destination: { bic: "B", accountNumber: "1", accountName: "A" },
    };
    expect(() => buildTransferRequest({ ...args, amountCentavos: 0 })).toThrow();
    expect(() => buildTransferRequest({ ...args, amountCentavos: 10.5 })).toThrow();
  });

  it("the reference is alphanumeric and spaces only, as PayMongo normalises it", () => {
    expect(transferReference(9, 3)).toMatch(/^[A-Za-z0-9 ]+$/);
  });

  it("matches the reference however PayMongo re-spells it (the test API returned CCH-P7-A1)", () => {
    expect(referenceMatches("CCH-P7-A1", transferReference(7, 1))).toBe(true);
    expect(referenceMatches("cch p7 a1", transferReference(7, 1))).toBe(true);
    expect(referenceMatches("CCH-P7-A2", transferReference(7, 1))).toBe(false);
    expect(referenceMatches(null, transferReference(7, 1))).toBe(false);
  });
});

describe("reading a transfer webhook", () => {
  const event = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
    data: {
      id: "evt_1",
      type: "event",
      attributes: {
        type,
        livemode: false,
        data: {
          id: "wallet_tr_abc",
          type: "wallet_transaction",
          attributes: {
            transfer_id: "tr_xyz",
            status,
            reference_number: "CCH P42 A1",
            amount: 125000,
            livemode: false,
            provider_error: null,
            provider_error_code: null,
            sender: { secret: "never stored" },
            receiver: { bank_account_number: "09171234567", bank_name: "GCASH" },
            ...extra,
          },
        },
      },
    },
  });

  it("recognises only the two outward transfer events", () => {
    expect(isTransferEvent("transfer.outward.successful")).toBe(true);
    expect(isTransferEvent("transfer.outward.failed")).toBe(true);
    expect(isTransferEvent("payout.deposited")).toBe(false);
    expect(isTransferEvent("checkout_session.payment.paid")).toBe(false);
    expect(
      parseTransferEvent({ data: { id: "evt", attributes: { type: "payout.deposited" } } }),
    ).toBeNull();
  });

  it("a successful event with a succeeded status is a success, carrying the transfer id and reference", () => {
    const ev = parseTransferEvent(event("transfer.outward.successful", "succeeded"));
    expect(ev).toMatchObject({
      eventId: "evt_1",
      outcome: "succeeded",
      transferId: "tr_xyz",
      walletTransactionId: "wallet_tr_abc",
      referenceNumber: "CCH P42 A1",
      livemode: false,
      amount: 125000,
    });
  });

  it("a failed event carries the provider's error code and message", () => {
    const ev = parseTransferEvent(
      event("transfer.outward.failed", "failed", {
        provider_error: "Account not found",
        provider_error_code: "INVALID_ACCOUNT",
      }),
    );
    expect(ev).toMatchObject({
      outcome: "failed",
      errorCode: "INVALID_ACCOUNT",
      errorMessage: "Account not found",
    });
  });

  it("a 'successful' event whose resource is not succeeded is NOT treated as a success", () => {
    const ev = parseTransferEvent(event("transfer.outward.successful", "failed"));
    expect(ev?.outcome).toBe("failed");
  });

  it("an event without an id cannot be deduplicated and is refused", () => {
    const e = event("transfer.outward.successful", "succeeded");
    (e.data as { id?: string }).id = "";
    expect(parseTransferEvent(e)).toBeNull();
  });

  it("the stored payload drops the sender block and masks the receiver's account number", () => {
    const kept = sanitizeProviderPayload(event("transfer.outward.successful", "succeeded"));
    const r = kept.resource as Record<string, unknown>;
    expect(r.sender).toBeUndefined();
    expect((r.receiver as Record<string, unknown>).bank_account_number).toBe("•••••••4567");
    expect(kept.event_type).toBe("transfer.outward.successful");
  });
});

describe("a pending attempt that has waited too long", () => {
  it("InstaPay after 30 minutes, PESONet after a banking day", () => {
    const t0 = new Date("2026-09-15T00:00:00Z");
    expect(pendingLooksStuck("instapay", t0, new Date("2026-09-15T00:20:00Z"))).toBe(false);
    expect(pendingLooksStuck("instapay", t0, new Date("2026-09-15T00:31:00Z"))).toBe(true);
    expect(pendingLooksStuck("pesonet", t0, new Date("2026-09-15T12:00:00Z"))).toBe(false);
    expect(pendingLooksStuck("pesonet", t0, new Date("2026-09-16T00:01:00Z"))).toBe(true);
  });
});
