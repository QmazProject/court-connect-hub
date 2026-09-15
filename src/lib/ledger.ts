/** The tenant financial ledger, as the screens see it.
 *
 *  The authority for every number here is `public.tenant_ledger_entries` and the
 *  `tenant_balances` view built on it. This module exists so the client can hold
 *  the same arithmetic the database holds — for display, and so the rules can be
 *  tested without a database — and `deriveBalances` below is deliberately a
 *  line-for-line mirror of that view. If the two ever disagree, the view is right.
 *
 *  The rule the whole marketplace rests on:
 *
 *    Money a tenant collected itself is never money the platform owes it.
 *
 *  A walk-in paid in cash at the desk contributes to `grossCentavos` and to
 *  `tenantCollectedCentavos`, and contributes exactly zero to
 *  `liabilityCentavos` — which is the only figure a payout can be drawn from.
 */

export const LEDGER_ENTRY_TYPES = [
  "platform_payment_received",
  "tenant_direct_payment",
  "refund",
  "partial_refund",
  "cancellation_adjustment",
  "payout_liability_created",
  "payout_liability_reversed",
  "payout_reserved",
  "payout_released",
  "payout_paid",
  "adjustment_credit",
  "adjustment_debit",
  "legacy_opening_balance",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export type LedgerEntry = {
  id?: number;
  entry_type: LedgerEntryType | string;
  gross_centavos: number;
  platform_collected_centavos: number;
  tenant_collected_centavos: number;
  liability_centavos: number;
  reserved_centavos: number;
  paid_out_centavos: number;
  created_at?: string;
  booking_id?: number | null;
  payout_id?: number | null;
  reference?: string | null;
};

export type TenantBalance = {
  /** Booking value the marketplace generated, whoever collected it. */
  grossCentavos: number;
  /** Cash that actually reached Court Connect's PayMongo account. */
  platformCollectedCentavos: number;
  /** Cash the venue took directly, at the desk. */
  tenantCollectedCentavos: number;
  /** What Court Connect owes this tenant in total, before reservations. */
  liabilityCentavos: number;
  /** Of that, attached to an open payout request and not requestable again. */
  reservedCentavos: number;
  /** Of that, already sent. */
  paidOutCentavos: number;
  /** Platform money returned to players. */
  refundedCentavos: number;
  /** liability − reserved − paid out, unfloored. Negative means a shortfall. */
  netPositionCentavos: number;
  /** The same figure floored at zero: what a tenant may actually request. */
  availableCentavos: number;
};

export const ZERO_BALANCE: TenantBalance = {
  grossCentavos: 0,
  platformCollectedCentavos: 0,
  tenantCollectedCentavos: 0,
  liabilityCentavos: 0,
  reservedCentavos: 0,
  paidOutCentavos: 0,
  refundedCentavos: 0,
  netPositionCentavos: 0,
  availableCentavos: 0,
};

/** Mirror of `public.tenant_balances`. See the module note: the view wins. */
export function deriveBalances(entries: readonly LedgerEntry[]): TenantBalance {
  let gross = 0;
  let platform = 0;
  let tenant = 0;
  let liability = 0;
  let reserved = 0;
  let paidOut = 0;
  let refunded = 0;

  for (const e of entries) {
    gross += e.gross_centavos || 0;
    platform += e.platform_collected_centavos || 0;
    tenant += e.tenant_collected_centavos || 0;
    liability += e.liability_centavos || 0;
    reserved += e.reserved_centavos || 0;
    paidOut += e.paid_out_centavos || 0;
    if (e.entry_type === "refund" || e.entry_type === "partial_refund") {
      refunded += -(e.liability_centavos || 0);
    }
  }

  const net = liability - reserved - paidOut;
  return {
    grossCentavos: gross,
    platformCollectedCentavos: platform,
    tenantCollectedCentavos: tenant,
    liabilityCentavos: liability,
    reservedCentavos: reserved,
    paidOutCentavos: paidOut,
    refundedCentavos: refunded,
    netPositionCentavos: net,
    availableCentavos: Math.max(net, 0),
  };
}

/** The shape `tenant_balances` returns over PostgREST, in the view's own names. */
export type TenantBalanceRow = {
  tenant_id: string;
  tenant_name?: string | null;
  tenant_slug?: string | null;
  gross_centavos: number | string;
  platform_collected_centavos: number | string;
  tenant_collected_centavos: number | string;
  liability_centavos: number | string;
  reserved_centavos: number | string;
  paid_out_centavos: number | string;
  refunded_centavos: number | string;
  net_position_centavos: number | string;
  available_centavos: number | string;
};

/** bigint arrives from PostgREST as a string often enough that parsing it
 *  defensively is cheaper than the bug where a balance silently concatenates. */
const n = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);

export function balanceFromRow(row: TenantBalanceRow | null | undefined): TenantBalance {
  if (!row) return ZERO_BALANCE;
  return {
    grossCentavos: n(row.gross_centavos),
    platformCollectedCentavos: n(row.platform_collected_centavos),
    tenantCollectedCentavos: n(row.tenant_collected_centavos),
    liabilityCentavos: n(row.liability_centavos),
    reservedCentavos: n(row.reserved_centavos),
    paidOutCentavos: n(row.paid_out_centavos),
    refundedCentavos: n(row.refunded_centavos),
    netPositionCentavos: n(row.net_position_centavos),
    availableCentavos: n(row.available_centavos),
  };
}

/* ---------------------------------------------------------------- money -- */

/** Centavos to a peso string. Money is held as integers everywhere above this
 *  line; this is the only place it becomes a decimal, and it happens at the very
 *  edge, for a human to read. */
export function pesoFromCentavos(centavos: number): string {
  const value = (Number(centavos) || 0) / 100;
  return `₱${value.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function toCentavos(pesos: number | string | null | undefined): number {
  return Math.round((Number(pesos) || 0) * 100);
}

/* ----------------------------------------------------------- invariants -- */

/** The balance invariants, checked as data rather than trusted as prose.
 *  Returns the violations, so a screen or a test can name what is wrong instead
 *  of only knowing that something is. */
export function balanceViolations(b: TenantBalance): string[] {
  const out: string[] = [];
  if (b.availableCentavos < 0) out.push("available balance is negative");
  if (b.reservedCentavos < 0) out.push("reserved balance is negative");
  if (b.paidOutCentavos < 0) out.push("paid-out balance is negative");
  if (b.reservedCentavos + b.paidOutCentavos > b.liabilityCentavos) {
    out.push("reserved plus paid out exceeds total liability");
  }
  if (b.tenantCollectedCentavos > 0 && b.liabilityCentavos < 0) {
    out.push("tenant-collected cash appears to have created platform liability");
  }
  return out;
}

/** Whether a requested amount may be reserved. The database re-decides this
 *  under an advisory lock in `tenant_request_payout()`; this is for the screen,
 *  so the tenant is told before submitting rather than after. */
export function canRequestPayout(
  b: TenantBalance,
  amountCentavos: number,
  hasAccount: boolean,
): { ok: boolean; reason?: string } {
  if (!hasAccount) return { ok: false, reason: "Add a payout account first." };
  if (b.availableCentavos <= 0) return { ok: false, reason: "No balance is available yet." };
  if (!Number.isFinite(amountCentavos) || amountCentavos <= 0) {
    return { ok: false, reason: "Enter an amount above zero." };
  }
  if (amountCentavos > b.availableCentavos) {
    return {
      ok: false,
      reason: `That is more than the ${pesoFromCentavos(b.availableCentavos)} available.`,
    };
  }
  return { ok: true };
}
