/** Outbound payout providers, as pure rules.
 *
 *  Everything here is decidable without a network or a database, so it can be
 *  tested as arithmetic: which PayMongo rail an amount takes, how a saved
 *  destination maps onto PayMongo's receiving-institution list, what the
 *  transfer request body is, what a `transfer.outward.*` webhook says, and
 *  whether a tenant on a payout schedule is due.
 *
 *  What is NOT here: the API call (paymongo.server.ts), the state transitions
 *  (SECURITY DEFINER functions in the database), and any secret.
 *
 *  Sources for the PayMongo shapes, read before this was written:
 *    https://docs.paymongo.com/docs/money-movement-moving-money-with-api
 *    https://docs.paymongo.com/reference/create-batch-transfer
 *    https://docs.paymongo.com/reference/transfer-resource
 *    https://docs.paymongo.com/reference/get-receiving-institutions
 *    https://docs.paymongo.com/docs/money-movement-disbursements
 */
import type { PayoutDestinationSnapshot, PayoutFrequency } from "@/lib/payouts";

/* ------------------------------------------------------------- providers -- */

export const PAYOUT_PROVIDERS = ["manual", "paymongo"] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];

export const PAYOUT_PROVIDER_LABEL: Record<PayoutProvider, string> = {
  manual: "Manual transfer",
  paymongo: "PayMongo",
};

/** Attempt statuses. Mirrors `tenant_payout_attempts_status_check`. */
export const ATTEMPT_STATUSES = [
  "created",
  "submitting",
  "pending",
  "succeeded",
  "failed",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_STATUS_LABEL: Record<AttemptStatus, string> = {
  created: "Awaiting transfer",
  submitting: "Submitting…",
  pending: "Submitted to PayMongo · Processing",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function isAttemptOpen(status: AttemptStatus | string): boolean {
  return status === "created" || status === "submitting" || status === "pending";
}

/* ---------------------------------------------------------------- rails -- */

/** PayMongo `provider` values on a transfer. `paymongo` is wallet-to-wallet
 *  inside PayMongo; the two others are the BSP domestic rails. */
export type PaymongoRail = "instapay" | "pesonet";

/** InstaPay's per-transaction ceiling is ₱50,000; above it the transfer goes by
 *  PESONet. The number is a rule of the rail, not of PayMongo. */
export const INSTAPAY_MAX_CENTAVOS = 50_000 * 100;

export function railForAmount(amountCentavos: number): PaymongoRail {
  return amountCentavos > INSTAPAY_MAX_CENTAVOS ? "pesonet" : "instapay";
}

/** Reconciliation guidance from PayMongo: InstaPay settles within about 20
 *  minutes; PESONet within a banking day. After that a pending attempt is
 *  worth reconciling rather than waiting on. */
export function pendingLooksStuck(
  rail: string | null | undefined,
  submittedAt: string | Date,
  now = new Date(),
): boolean {
  const t =
    typeof submittedAt === "string" ? new Date(submittedAt).getTime() : submittedAt.getTime();
  const ageMs = now.getTime() - t;
  const limit = rail === "pesonet" ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
  return ageMs > limit;
}

/* ------------------------------------------------- receiving institutions -- */

/** One row of `GET /v1/wallets/receiving_institutions?provider=…`. The BIC is
 *  the `provider_code`. */
export type ReceivingInstitution = {
  id: string;
  name: string;
  provider: PaymongoRail | string;
  bic: string;
};

/** A destination as the server needs it to build a transfer: the FULL account
 *  number (read from the account row the snapshot points at, never from the
 *  masked snapshot), the holder name, and the type the tenant saved. */
export type DestinationInput = {
  accountType: string;
  accountName: string;
  accountNumber: string | null;
  bankName: string | null;
  /** A BIC an admin already mapped from PayMongo's list, if any. */
  savedBic: string | null;
};

export type DestinationMapping =
  | {
      ok: true;
      bic: string;
      institutionName: string;
      accountNumber: string;
      accountName: string;
      /** How the BIC was found: a saved admin mapping, or a name match. */
      matchedBy: "saved" | "name";
    }
  | {
      ok: false;
      reason: string;
      /** Institutions whose name resembles the saved bank, for the admin to pick from. */
      candidates: ReceivingInstitution[];
    };

/** Compact form of an institution name for matching: lower-case, corporate
 *  suffixes and articles dropped, then all spacing removed — so "Union Bank"
 *  and "UnionBank" compare equal, and "UnionBank" is correctly AMBIGUOUS
 *  between "UNION BANK OF THE PHILIPPINES" and "UNIONBANK DIGITAL". The word
 *  "bank" is deliberately kept: dropping it turns distinct names into one. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|corp|corporation|co|ltd|the|of|and)\b/g, " ")
    .replace(/\s+/g, "");

/** Name patterns for the two e-wallets a tenant can pick by type rather than by
 *  name. These are used only to FIND the institution in PayMongo's list; the
 *  BIC always comes from the list, never from here. */
const EWALLET_PATTERNS: Record<string, RegExp> = {
  gcash: /g-?xchange|gcash/i,
  maya: /\bmaya\b|paymaya/i,
};

/** Map a saved destination onto PayMongo's receiving-institution list.
 *
 *  Order of trust: a BIC an admin already chose from the list (verified to
 *  still be in the list); then, for gcash/maya, the one institution whose name
 *  matches the wallet; then, for a bank, a unique name match on the tenant's
 *  saved bank name. Anything short of a unique match is refused with the
 *  nearest candidates, so the admin picks — nothing is ever guessed. */
export function mapDestination(
  dest: DestinationInput,
  institutions: ReceivingInstitution[],
): DestinationMapping {
  const number = (dest.accountNumber ?? "").replace(/[\s-]/g, "");
  if (!number) {
    return { ok: false, reason: "The saved destination has no account number.", candidates: [] };
  }
  const accountName = dest.accountName.trim();
  if (!accountName) {
    return {
      ok: false,
      reason: "The saved destination has no account holder name.",
      candidates: [],
    };
  }

  if (dest.savedBic) {
    const found = institutions.find((i) => i.bic === dest.savedBic);
    if (found) {
      return {
        ok: true,
        bic: found.bic,
        institutionName: found.name,
        accountNumber: number,
        accountName,
        matchedBy: "saved",
      };
    }
    return {
      ok: false,
      reason: `The mapped institution ${dest.savedBic} is no longer in PayMongo's list; map it again.`,
      candidates: [],
    };
  }

  const type = dest.accountType;
  if (type in EWALLET_PATTERNS) {
    const matches = institutions.filter((i) => EWALLET_PATTERNS[type].test(i.name));
    if (matches.length === 1) {
      const m = matches[0];
      return {
        ok: true,
        bic: m.bic,
        institutionName: m.name,
        accountNumber: number,
        accountName,
        matchedBy: "name",
      };
    }
    return {
      ok: false,
      reason:
        matches.length === 0
          ? `PayMongo's receiving institutions do not list ${type} on this rail.`
          : `More than one PayMongo institution matches ${type}; choose one.`,
      candidates: matches,
    };
  }

  if (type === "bank") {
    const want = norm(dest.bankName ?? "");
    if (!want) {
      return { ok: false, reason: "The saved bank destination has no bank name.", candidates: [] };
    }
    const exact = institutions.filter((i) => norm(i.name) === want);
    if (exact.length === 1) {
      const m = exact[0];
      return {
        ok: true,
        bic: m.bic,
        institutionName: m.name,
        accountNumber: number,
        accountName,
        matchedBy: "name",
      };
    }
    const loose = institutions.filter((i) => {
      const n = norm(i.name);
      return n.includes(want) || want.includes(n);
    });
    if (exact.length === 0 && loose.length === 1) {
      const m = loose[0];
      return {
        ok: true,
        bic: m.bic,
        institutionName: m.name,
        accountNumber: number,
        accountName,
        matchedBy: "name",
      };
    }
    return {
      ok: false,
      reason:
        loose.length === 0
          ? `No PayMongo receiving institution matches "${dest.bankName}". Map it to one from the list.`
          : `"${dest.bankName}" matches ${loose.length} PayMongo institutions. Choose which.`,
      candidates: loose.slice(0, 12),
    };
  }

  return {
    ok: false,
    reason: `A "${type}" destination cannot be sent through PayMongo. Use a manual transfer.`,
    candidates: [],
  };
}

/* ------------------------------------------------------ transfer request -- */

/** The wallet's own account, from `GET /v2/wallets` → `data[].account`. Used
 *  as `source_account` on every transfer; PayMongo's own BIC is documented as
 *  `PAEYPHM2XXX`. */
export const PAYMONGO_WALLET_BIC = "PAEYPHM2XXX";

export type SourceAccount = { number: string; name: string; bic: string };

export type TransferRequest = {
  provider: PaymongoRail;
  amount: number;
  currency: "PHP";
  purpose: string;
  description: string;
  reference_number: string;
  source_account: SourceAccount;
  destination_account: { number: string; name: string; bic: string };
  metadata: Record<string, string>;
};

/** Our reference on the transfer. PayMongo normalises this to alphanumerics
 *  and spaces, so it is kept to those. It carries the payout and attempt ids,
 *  which is how a webhook that arrives without a transfer id can still be
 *  matched. */
export function transferReference(payoutId: number, attemptNo: number): string {
  return `CCH P${payoutId} A${attemptNo}`;
}

/** PayMongo echoes the reference back normalised — the test environment
 *  returned `CCH-P7-A1` for `CCH P7 A1` — so two references are compared on
 *  their alphanumerics only. */
export function referenceMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const norm = (v: string | null | undefined) =>
    (v ?? "").replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

export function buildTransferRequest(args: {
  payoutId: number;
  attemptId: number;
  attemptNo: number;
  tenantId: string;
  amountCentavos: number;
  source: SourceAccount;
  destination: { bic: string; accountNumber: string; accountName: string };
  tenantName?: string | null;
}): TransferRequest {
  if (!Number.isInteger(args.amountCentavos) || args.amountCentavos <= 0) {
    throw new Error("Transfer amount must be a positive whole number of centavos");
  }
  return {
    provider: railForAmount(args.amountCentavos),
    amount: args.amountCentavos,
    currency: "PHP",
    purpose: "Disbursement",
    description: `Court Connect payout #${args.payoutId}${args.tenantName ? ` · ${args.tenantName}` : ""}`,
    reference_number: transferReference(args.payoutId, args.attemptNo),
    source_account: args.source,
    destination_account: {
      number: args.destination.accountNumber,
      name: args.destination.accountName,
      bic: args.destination.bic,
    },
    metadata: {
      payout_id: String(args.payoutId),
      attempt_id: String(args.attemptId),
      attempt_no: String(args.attemptNo),
      tenant_id: args.tenantId,
    },
  };
}

/* ------------------------------------------------------- webhook payload -- */

export const TRANSFER_EVENT_TYPES = [
  "transfer.outward.successful",
  "transfer.outward.failed",
] as const;
export type TransferEventType = (typeof TRANSFER_EVENT_TYPES)[number];

export function isTransferEvent(type: string | undefined | null): type is TransferEventType {
  return (TRANSFER_EVENT_TYPES as readonly string[]).includes(type ?? "");
}

/** What the settlement function needs from a `transfer.outward.*` event.
 *
 *  The resource inside the event is a `wallet_transaction`
 *  (`data.attributes.data`, id `wallet_tr_…`) whose attributes carry
 *  `transfer_id` (`tr_…`), `status`, `reference_number`, `provider_error`,
 *  `provider_error_code`, `amount`, `livemode`. */
export type ParsedTransferEvent = {
  eventId: string;
  eventType: TransferEventType;
  outcome: "succeeded" | "failed";
  transferId: string | null;
  walletTransactionId: string | null;
  referenceNumber: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  amount: number | null;
  livemode: boolean | null;
};

export function parseTransferEvent(payload: unknown): ParsedTransferEvent | null {
  const root = (payload ?? {}) as { data?: { id?: unknown; attributes?: Record<string, unknown> } };
  const ev = root.data;
  const attrs = ev?.attributes ?? {};
  const type = typeof attrs.type === "string" ? attrs.type : "";
  if (!isTransferEvent(type)) return null;
  const eventId = typeof ev?.id === "string" ? ev.id : "";
  if (!eventId) return null;

  const resource = (attrs.data ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const r = resource.attributes ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const status = str(r.status);

  /* The event name is authoritative for the outcome; the resource status is
     recorded beside it. A "successful" event with a non-succeeded status is
     treated as NOT a success — the stricter reading. */
  const outcome: "succeeded" | "failed" =
    type === "transfer.outward.successful" && (status === null || status === "succeeded")
      ? "succeeded"
      : "failed";

  return {
    eventId,
    eventType: type,
    outcome,
    transferId: str(r.transfer_id),
    walletTransactionId: str(resource.id),
    referenceNumber: str(r.reference_number),
    providerStatus: status,
    errorCode: str(r.provider_error_code),
    errorMessage: str(r.provider_error),
    amount: typeof r.amount === "number" ? r.amount : null,
    livemode: typeof r.livemode === "boolean" ? r.livemode : null,
  };
}

/** Strip a provider payload down to what is useful to keep. No secrets are in
 *  a webhook body, but the sender block and full account numbers are not ours
 *  to store twice. */
export function sanitizeProviderPayload(payload: unknown): Record<string, unknown> {
  const root = (payload ?? {}) as { data?: { id?: unknown; attributes?: Record<string, unknown> } };
  const attrs = root.data?.attributes ?? {};
  const resource = (attrs.data ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const r = { ...(resource.attributes ?? {}) } as Record<string, unknown>;
  delete r.sender;
  if (r.receiver && typeof r.receiver === "object") {
    const rec = { ...(r.receiver as Record<string, unknown>) };
    if (typeof rec.bank_account_number === "string") {
      rec.bank_account_number = rec.bank_account_number.replace(/.(?=.{4})/g, "•");
    }
    r.receiver = rec;
  }
  return {
    event_id: root.data?.id ?? null,
    event_type: attrs.type ?? null,
    resource_id: resource.id ?? null,
    resource: r,
  };
}

/* --------------------------------------------------------- recurring due -- */

export type RecurringInput = {
  frequency: PayoutFrequency | string | null | undefined;
  /** When the tenant last had a payout marked paid, if ever. */
  lastPaidAt: string | Date | null;
  /** When the schedule was set — the anchor when nothing has been paid yet. */
  scheduleSetAt: string | Date | null;
  availableCentavos: number;
  /** A request already open holds the money; a due tenant with one is not due. */
  hasOpenPayout: boolean;
  hasPayoutAccount: boolean;
  now?: Date;
};

export type RecurringStatus = {
  due: boolean;
  nextDueAt: Date | null;
  /** Why it is or is not due, in words the queue can show. */
  reason: string;
};

const DAY = 24 * 60 * 60 * 1000;

function toDate(v: string | Date | null): Date | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The next scheduled date strictly after `anchor`.
 *    weekly        — anchor + 7 days
 *    twice_monthly — the next 1st or 16th
 *    monthly       — the 1st of the next month
 *    manual        — never */
export function nextDueDate(frequency: string | null | undefined, anchor: Date): Date | null {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  switch (frequency) {
    case "weekly":
      return new Date(anchor.getTime() + 7 * DAY);
    case "twice_monthly":
      if (d < 16) return new Date(Date.UTC(y, m, 16));
      return new Date(Date.UTC(y, m + 1, 1));
    case "monthly":
      return new Date(Date.UTC(y, m + 1, 1));
    default:
      return null;
  }
}

export function recurringStatus(input: RecurringInput): RecurringStatus {
  const now = input.now ?? new Date();
  const freq = input.frequency ?? "manual";
  if (freq === "manual") {
    return { due: false, nextDueAt: null, reason: "Manual — pays out on request only." };
  }
  const anchor = toDate(input.lastPaidAt) ?? toDate(input.scheduleSetAt);
  if (!anchor) {
    return { due: false, nextDueAt: null, reason: "No schedule start date recorded." };
  }
  const next = nextDueDate(freq, anchor);
  if (!next) {
    return { due: false, nextDueAt: null, reason: `Unknown frequency "${freq}".` };
  }
  if (now < next) {
    return { due: false, nextDueAt: next, reason: "Not yet due." };
  }
  if (input.hasOpenPayout) {
    return { due: false, nextDueAt: next, reason: "A payout is already in progress." };
  }
  if (input.availableCentavos <= 0) {
    return { due: false, nextDueAt: next, reason: "Nothing available to pay out." };
  }
  if (!input.hasPayoutAccount) {
    return { due: false, nextDueAt: next, reason: "Due, but no payout account is set." };
  }
  return { due: true, nextDueAt: next, reason: "Due now." };
}
