/** The rules a tenant's team is governed by, in one place.
 *
 *  Two of them are safety rules and are enforced in the database as well as here:
 *  the last admin cannot be removed or demoted, and an invitation can only be
 *  accepted by the person it was sent to. This module exists so the *wording* and
 *  the *decision* are shared by the Team screen and its tests — the authority is
 *  SQL, and a check that lives only in a form is a check that can be skipped. */

/** Fixed, and ranked: `venue_allows()` orders them admin > manager > staff and the
 *  row-level policies read it, so these are what the database permits and not only
 *  what the screen offers. `src/lib/permissions.ts` mirrors the same ranking for
 *  the UI. */
export const MEMBER_ROLES = ["admin", "manager", "staff"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** `invited` until the person themselves accepts. Nothing an admin can do moves a
 *  membership out of it. */
export const MEMBER_STATUSES = ["invited", "active", "inactive"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const ROLE_LABELS: Record<MemberRole, string> = {
  admin: "Admin",
  manager: "Manager",
  staff: "Staff",
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  admin: "Full access, and can manage the team.",
  manager: "Runs the day to day — venues, courts, bookings.",
  staff: "Handles bookings and customers.",
};

export const STATUS_LABELS: Record<MemberStatus, string> = {
  invited: "Invited",
  active: "Active",
  inactive: "Removed",
};

/** Ten an hour, per admin. High enough that setting up a real team never touches
 *  it, low enough that the invite form cannot be used to walk through a list of
 *  addresses discovering which are registered — the one thing this endpoint
 *  unavoidably reveals. */
export const INVITE_RATE_LIMIT_PER_HOUR = 10;

/** What the database found when asked about an email. Only the middle one is a
 *  yes; the other two are the same answer to the admin, deliberately, so the form
 *  cannot be used to tell a player account apart from an unregistered one. */
export type InviteEligibility = "invitable" | "is_player" | "has_tenant";

/** The one sentence an admin sees. `is_player` and `has_tenant` share it: which of
 *  the two it was is not the admin's business, and saying would turn this form
 *  into a lookup tool for other people's accounts. */
export function describeEligibility(outcome: InviteEligibility): string | null {
  if (outcome === "invitable") return null;
  return "That email is already registered — use a different one for this member.";
}

/** Just enough of a member to reason about the rules below. */
export type TeamMemberLike = {
  userId: string;
  role: MemberRole;
  status: MemberStatus;
};

/** Admins who can actually act. An invited admin has not accepted yet and a removed
 *  one has no access, so neither can be the one holding the door open. */
export function activeAdmins(members: readonly TeamMemberLike[]): TeamMemberLike[] {
  return members.filter((m) => m.role === "admin" && m.status === "active");
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Whether this member may be removed. The rule is about the *last* admin rather
 *  than about self-removal: an account locked out of its own workspace is the same
 *  accident whether the last admin removed themselves or was removed by a peer,
 *  and there is nobody left to undo it either way. */
export function canRemoveMember(
  members: readonly TeamMemberLike[],
  targetUserId: string,
): GuardResult {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { ok: false, reason: "That member is not part of this team." };
  if (target.status === "inactive")
    return { ok: false, reason: "That member has already been removed." };
  const admins = activeAdmins(members);
  if (target.role === "admin" && target.status === "active" && admins.length <= 1) {
    return {
      ok: false,
      reason: "This is the only admin. Make someone else an admin first.",
    };
  }
  return { ok: true };
}

/** Whether this member's role may change. Demoting the last admin locks the team
 *  out exactly as removing them would, so it is refused for the same reason. */
export function canChangeRole(
  members: readonly TeamMemberLike[],
  targetUserId: string,
  nextRole: MemberRole,
): GuardResult {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { ok: false, reason: "That member is not part of this team." };
  if (target.role === nextRole) return { ok: false, reason: "That is already their role." };
  const admins = activeAdmins(members);
  if (
    target.role === "admin" &&
    target.status === "active" &&
    nextRole !== "admin" &&
    admins.length <= 1
  ) {
    return {
      ok: false,
      reason: "This is the only admin. Make someone else an admin first.",
    };
  }
  return { ok: true };
}

/** Whether the Team screen should offer this person the admin controls at all.
 *  A convenience for the UI; every one of those controls is refused again in SQL. */
export function canManageTeam(viewer: TeamMemberLike | null | undefined): boolean {
  return viewer?.role === "admin" && viewer.status === "active";
}
