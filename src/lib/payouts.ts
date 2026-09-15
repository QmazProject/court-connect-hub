/** Payout requests and their lifecycle, as the screens see it.
 *
 *  The database is the authority for every transition — `tenant_request_payout`,
 *  `tenant_cancel_payout` and `admin_transition_payout` each re-decide
 *  permission, legality and amount under a lock. What lives here is the shared
 *  vocabulary: which statuses exist, which are terminal, what each one means to
 *  a person, and how an account number is shown without being disclosed.
 */
import { pesoFromCentavos } from "@/lib/ledger";

export const PAYOUT_STATUSES = [
  "requested",
  "under_review",
  "approved",
  "processing",
  "paid",
  "rejected",
  "failed",
  "cancelled",
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Once a payout is here, nothing may move it. Mirrors both the
 *  `tenant_payouts_guard_transitions` trigger and the status check inside
 *  `admin_transition_payout`. */
export const TERMINAL_STATUSES: readonly PayoutStatus[] = ["paid", "rejected", "cancelled"];

export function isTerminal(status: PayoutStatus | string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Statuses whose money is still reserved — neither available to request again,
 *  nor yet sent. This is what "Pending payout" means on the dashboard. */
export const RESERVING_STATUSES: readonly PayoutStatus[] = [
  "requested",
  "under_review",
  "approved",
  "processing",
];

export function isReserving(status: PayoutStatus | string): boolean {
  return (RESERVING_STATUSES as readonly string[]).includes(status);
}

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  requested: "Requested",
  under_review: "Under review",
  approved: "Approved",
  processing: "Processing",
  paid: "Paid",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Which tone the existing badge vocabulary should use. Kept as semantic names
 *  rather than colours so the design system stays the one place colour lives. */
export const PAYOUT_STATUS_TONE: Record<PayoutStatus, "neutral" | "info" | "success" | "danger"> = {
  requested: "neutral",
  under_review: "info",
  approved: "info",
  processing: "info",
  paid: "success",
  rejected: "danger",
  failed: "danger",
  cancelled: "neutral",
};

/** A tenant may withdraw its own request only while an admin has not started
 *  moving money. Mirrors `tenant_cancel_payout`. */
export function tenantCanCancel(status: PayoutStatus | string): boolean {
  return status === "requested" || status === "under_review";
}

/** The transitions an admin may make from a given status. Mirrors
 *  `admin_transition_payout`; the database refuses anything not listed here. */
export function adminTransitionsFrom(status: PayoutStatus | string): PayoutStatus[] {
  if (isTerminal(status)) return [];
  switch (status) {
    case "requested":
      return ["under_review", "approved", "rejected"];
    case "under_review":
      return ["approved", "rejected"];
    case "approved":
      return ["processing", "rejected"];
    case "processing":
      return ["paid", "failed"];
    case "failed":
      return ["processing", "rejected"];
    default:
      return [];
  }
}

export const PAYOUT_ACCOUNT_TYPES = [
  { value: "gcash", label: "GCash" },
  { value: "maya", label: "Maya" },
  { value: "bank", label: "Bank account" },
  { value: "other_ewallet", label: "Other e-wallet" },
  { value: "other", label: "Other" },
] as const;

export type PayoutAccountType = (typeof PAYOUT_ACCOUNT_TYPES)[number]["value"];

export const PAYOUT_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "twice_monthly", label: "Twice monthly" },
  { value: "monthly", label: "Monthly" },
  { value: "manual", label: "Manual / on request" },
] as const;

export type PayoutFrequency = (typeof PAYOUT_FREQUENCIES)[number]["value"];

export type PayoutDestinationSnapshot = {
  account_id?: number;
  account_type?: string;
  account_name?: string;
  account_number_masked?: string | null;
  bank_name?: string | null;
  captured_at?: string;
};

/** Mirrors `public.mask_account_number`. Shown in lists and stored in the
 *  destination snapshot: enough for a tenant to recognise their own account,
 *  never enough for anyone else to use it. */
export function maskAccountNumber(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(s.length - 4) + s.slice(-4);
}

/** A one-line description of where a payout went, for a history row. */
export function describeDestination(snap: PayoutDestinationSnapshot | null | undefined): string {
  if (!snap) return "—";
  const type =
    PAYOUT_ACCOUNT_TYPES.find((t) => t.value === snap.account_type)?.label ??
    snap.account_type ??
    "Account";
  const tail = snap.account_number_masked ? ` ${snap.account_number_masked}` : "";
  const bank = snap.bank_name ? ` · ${snap.bank_name}` : "";
  return `${type}${bank}${tail}`;
}

export type PayoutAccountDraft = {
  accountType: PayoutAccountType;
  accountName: string;
  accountNumber: string;
  bankName: string;
};

/** Client-side checks that mirror the table's CHECK constraints. They grant
 *  nothing: `tenant_save_payout_account` re-applies all of it, and the database
 *  refuses a bank destination with no bank name whatever this returns. */
export function validatePayoutAccount(d: PayoutAccountDraft): string[] {
  const errors: string[] = [];
  if (!d.accountName.trim()) errors.push("Enter the account holder's name.");
  if (d.accountType === "bank") {
    if (!d.bankName.trim()) errors.push("Enter the bank name.");
    if (!d.accountNumber.trim()) errors.push("Enter the bank account number.");
  }
  if (d.accountType === "gcash" || d.accountType === "maya") {
    const digits = d.accountNumber.replace(/\D/g, "");
    if (!digits) errors.push("Enter the mobile number.");
    else if (digits.length < 10) errors.push("That mobile number looks too short.");
  }
  return errors;
}

/** What a tenant should read on the payout screen, in one sentence, so the
 *  difference between "sold" and "owed" cannot be misread. */
export function payoutSummaryLine(availableCentavos: number, reservedCentavos: number): string {
  if (reservedCentavos > 0) {
    return `${pesoFromCentavos(availableCentavos)} available · ${pesoFromCentavos(
      reservedCentavos,
    )} already requested`;
  }
  return `${pesoFromCentavos(availableCentavos)} available for payout`;
}
