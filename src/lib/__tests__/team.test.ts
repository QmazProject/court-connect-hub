import { describe, expect, it } from "vitest";
import {
  activeAdmins,
  canChangeRole,
  canManageTeam,
  canRemoveMember,
  describeEligibility,
  INVITE_RATE_LIMIT_PER_HOUR,
  type TeamMemberLike,
} from "../team";

const m = (
  userId: string,
  role: TeamMemberLike["role"],
  status: TeamMemberLike["status"] = "active",
): TeamMemberLike => ({ userId, role, status });

describe("describeEligibility", () => {
  it("says nothing when the email may be invited", () => {
    expect(describeEligibility("invitable")).toBeNull();
  });

  /* The whole point: a player account and an unregistered address must be
     indistinguishable to the admin, or this form becomes a lookup tool. */
  it("gives one identical message for both refusals", () => {
    const player = describeEligibility("is_player");
    const taken = describeEligibility("has_tenant");
    expect(player).toBe(taken);
    expect(player).toMatch(/already registered/i);
  });

  it("never mentions players, tenants or other businesses", () => {
    for (const outcome of ["is_player", "has_tenant"] as const) {
      const text = describeEligibility(outcome) ?? "";
      expect(text).not.toMatch(/player|tenant|business|workspace/i);
    }
  });
});

describe("activeAdmins", () => {
  it("counts only admins who have accepted and not been removed", () => {
    const team = [
      m("a", "admin"),
      m("b", "admin", "invited"),
      m("c", "admin", "inactive"),
      m("d", "manager"),
    ];
    expect(activeAdmins(team).map((x) => x.userId)).toEqual(["a"]);
  });
});

describe("canRemoveMember", () => {
  const team = [m("owner", "admin"), m("sarah", "manager"), m("mike", "staff")];

  it("allows removing a non-admin", () => {
    expect(canRemoveMember(team, "sarah").ok).toBe(true);
  });

  it("refuses the only admin", () => {
    const result = canRemoveMember(team, "owner");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only admin/i);
  });

  it("allows removing an admin once another active admin exists", () => {
    expect(canRemoveMember([...team, m("second", "admin")], "owner").ok).toBe(true);
  });

  /* An invited admin has not accepted, so they cannot be the one keeping the
     workspace reachable. */
  it("does not count an invited admin as cover", () => {
    expect(canRemoveMember([...team, m("pending", "admin", "invited")], "owner").ok).toBe(false);
  });

  it("does not count a removed admin as cover", () => {
    expect(canRemoveMember([...team, m("gone", "admin", "inactive")], "owner").ok).toBe(false);
  });

  it("refuses an unknown member and an already-removed one", () => {
    expect(canRemoveMember(team, "nobody").ok).toBe(false);
    expect(canRemoveMember([...team, m("gone", "staff", "inactive")], "gone").ok).toBe(false);
  });
});

describe("canChangeRole", () => {
  const team = [m("owner", "admin"), m("sarah", "manager")];

  it("allows promoting and demoting ordinary members", () => {
    expect(canChangeRole(team, "sarah", "admin").ok).toBe(true);
    expect(canChangeRole(team, "sarah", "staff").ok).toBe(true);
  });

  /* Demoting the last admin locks everyone out just as removing them would. */
  it("refuses demoting the only admin", () => {
    const result = canChangeRole(team, "owner", "manager");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only admin/i);
  });

  it("allows demoting an admin once a second active admin exists", () => {
    expect(canChangeRole([...team, m("second", "admin")], "owner", "manager").ok).toBe(true);
  });

  it("refuses a no-op change", () => {
    expect(canChangeRole(team, "owner", "admin").ok).toBe(false);
  });
});

describe("canManageTeam", () => {
  it("is true only for an active admin", () => {
    expect(canManageTeam(m("a", "admin"))).toBe(true);
    expect(canManageTeam(m("a", "admin", "invited"))).toBe(false);
    expect(canManageTeam(m("a", "manager"))).toBe(false);
    expect(canManageTeam(null)).toBe(false);
  });
});

describe("invite rate limit", () => {
  it("is ten an hour", () => {
    expect(INVITE_RATE_LIMIT_PER_HOUR).toBe(10);
  });
});
