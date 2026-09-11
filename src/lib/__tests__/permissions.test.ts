import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilitiesFor, requiredRoleLabel, type Capability } from "../permissions";

const has = (role: Parameters<typeof capabilitiesFor>[0], c: Capability, active = true) =>
  capabilitiesFor(role, active).has(c);

describe("capabilitiesFor — the approved matrix", () => {
  it("admin has everything", () => {
    expect(capabilitiesFor("admin", true).size).toBe(CAPABILITIES.length);
  });

  it("manager: operational management, no admin-only controls", () => {
    for (const c of [
      "venue.edit",
      "court.edit",
      "court.blocks",
      "court.groups",
      "vouchers.manage",
      "transactions.view",
      "audit.view",
      "finance.view",
      "bookings.cancelRefund",
      "settings.venue",
    ] as const) {
      expect(has("manager", c)).toBe(true);
    }
    for (const c of [
      "team.manage",
      "business.edit",
      "venue.create",
      "venue.delete",
      "court.delete",
      "refunds.settle",
    ] as const) {
      expect(has("manager", c)).toBe(false);
    }
  });

  it("staff: nothing structural, financial, or destructive", () => {
    expect(capabilitiesFor("staff", true).size).toBe(0);
  });

  /* The Stage 4 rule an invitation must not open a door before it is accepted. */
  it("invited or inactive membership has no capabilities regardless of role", () => {
    expect(has("admin", "team.manage", false)).toBe(false);
    expect(capabilitiesFor("admin", false).size).toBe(0);
    expect(capabilitiesFor("manager", false).size).toBe(0);
  });

  it("player / unknown role has none", () => {
    expect(capabilitiesFor(null, true).size).toBe(0);
    expect(capabilitiesFor(undefined, true).size).toBe(0);
  });

  it("refund settlement and venue/court deletion are admin-only", () => {
    for (const c of ["refunds.settle", "venue.delete", "court.delete"] as const) {
      expect(has("admin", c)).toBe(true);
      expect(has("manager", c)).toBe(false);
      expect(has("staff", c)).toBe(false);
      expect(requiredRoleLabel(c)).toBe("Admin");
    }
  });

  it("names the role a control needs", () => {
    expect(requiredRoleLabel("transactions.view")).toBe("Manager");
    expect(requiredRoleLabel("team.manage")).toBe("Admin");
  });
});
