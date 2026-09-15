/** What each tenant role may do in the workspace — the one table the UI reads.
 *
 *  This is a mirror, not an authority. Every row cites the database object that
 *  actually decides: a row-level policy or a SECURITY DEFINER function from Phase 2
 *  and Phase 2.5. The screen uses this to stop offering a control that the database
 *  would refuse anyway; hiding a button here grants nothing and removing one denies
 *  nothing. If a row and its cited policy ever disagree, the policy is right and this
 *  file is wrong. */
import type { MemberRole } from "./team";

export const CAPABILITIES = [
  "team.manage", // invite route + tenant_remove_member / tenant_set_member_role: active admin
  "business.edit", // tenants UPDATE: id = current_tenant_id() AND is_tenant_admin()
  "venue.create", // venues INSERT: is_tenant_admin() AND tenant_id = current_tenant_id()
  "venue.edit", // venues UPDATE (Stage 3): venue_allows(id, 'manager')
  "venue.delete", // venues DELETE (Stage 3): venue_allows(id, 'admin')
  "court.edit", // courts INSERT/UPDATE (Stage 3): 'manager' — covers pricing/rate rules and availability
  "court.delete", // courts DELETE (Stage 3): 'admin'
  "court.blocks", // court_block_rules INSERT/UPDATE/DELETE (Stage 3): 'manager'
  "court.groups", // physical_courts INSERT/UPDATE/DELETE (Stage 3): 'manager'
  "vouchers.manage", // vouchers INSERT/UPDATE/DELETE (Stage 2): 'manager' — viewing is 'staff'
  "transactions.view", // transactions SELECT (Stage 2): 'manager'
  "audit.view", // court_audit_log / venue_audit_log SELECT (Stage 2): 'manager'
  "finance.view", // the dashboard's money reads `transactions` directly (Stage 2): 'manager'
  "bookings.cancelRefund", // staff_cancel_bookings() (Stage 4): 'manager'
  "bookings.walkIn", // tenant_create_walkin_booking(): venue_allows(venue_id, 'manager')
  "refunds.settle", // staff_mark_refund_settled() (Stage 4): 'admin'
  "finance.payoutAccount", // tenant_payout_accounts RLS + tenant_save_payout_account(): is_tenant_admin()
  "finance.requestPayout", // tenant_request_payout() / tenant_cancel_payout(): is_tenant_admin()
  "settings.venue", // payment mode, refund cutoff, booking-number prefix — all venues UPDATE (Stage 3): 'manager'
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The lowest role each capability needs. Ranked the way `venue_allows()` ranks them:
 *  staff < manager < admin. */
const MIN_ROLE: Record<Capability, MemberRole> = {
  "team.manage": "admin",
  "business.edit": "admin",
  "venue.create": "admin",
  "venue.edit": "manager",
  "venue.delete": "admin",
  "court.edit": "manager",
  "court.delete": "admin",
  "court.blocks": "manager",
  "court.groups": "manager",
  "vouchers.manage": "manager",
  "transactions.view": "manager",
  "audit.view": "manager",
  "finance.view": "manager",
  "bookings.cancelRefund": "manager",
  "bookings.walkIn": "manager",
  "refunds.settle": "admin",
  "finance.payoutAccount": "admin",
  "finance.requestPayout": "admin",
  "settings.venue": "manager",
};

const RANK: Record<MemberRole, number> = { staff: 1, manager: 2, admin: 3 };

/** The capabilities of one membership. `active` is the `tenant_members.status` test:
 *  an invitation that has not been accepted, or a removed member, has a role on the
 *  row and no capabilities at all — exactly as `venue_role()` treats them. No role
 *  (a player, or a membership still loading) is the empty set, which is the safe
 *  answer for a screen that has not yet learned who it is showing. */
export function capabilitiesFor(
  role: MemberRole | null | undefined,
  active: boolean,
): ReadonlySet<Capability> {
  if (!role || !active) return new Set();
  const have = RANK[role];
  return new Set(CAPABILITIES.filter((c) => have >= RANK[MIN_ROLE[c]]));
}

/** A short, honest sentence for a control the role cannot use. */
export function requiredRoleLabel(capability: Capability): "Admin" | "Manager" {
  return MIN_ROLE[capability] === "admin" ? "Admin" : "Manager";
}
