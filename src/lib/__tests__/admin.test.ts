/**
 * Admin identity resolution.
 *
 * These cover the client half only, and the thing they are really asserting is that
 * the client half is not where authority lives: every path that is not an explicit
 * `true` from the database resolves to "not an admin". The server half — RLS, the
 * missing write grant on user_roles, the super-admin check inside
 * grant_courthub_admin — cannot be exercised here and is verified against the
 * database after the migration is applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const getUser = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    auth: { getUser: () => getUser() },
  },
}));

const { fetchAdminIdentity } = await import("@/lib/admin");

const SESSION = { data: { user: { id: "u-1", email: "admin@courthub.ph" } } };

beforeEach(() => {
  rpc.mockReset();
  getUser.mockReset();
});

/** Answer the two role predicates independently. */
function roles(isAdmin: unknown, isSuper: unknown) {
  rpc.mockImplementation((name: string) =>
    Promise.resolve({
      data: name === "is_courthub_super_admin" ? isSuper : isAdmin,
      error: null,
    }),
  );
}

describe("who counts as an admin", () => {
  it("is nobody when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    await expect(fetchAdminIdentity()).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is nobody when the database says no", async () => {
    getUser.mockResolvedValue(SESSION);
    roles(false, false);
    await expect(fetchAdminIdentity()).resolves.toBeNull();
  });

  it("asks the database rather than reading anything the client holds", async () => {
    getUser.mockResolvedValue(SESSION);
    roles(true, false);
    const id = await fetchAdminIdentity();
    expect(id).toMatchObject({ userId: "u-1", isAdmin: true, isSuperAdmin: false });
    const called = rpc.mock.calls.map((c) => c[0]).sort();
    expect(called).toEqual(["is_courthub_admin", "is_courthub_super_admin"]);
    /* No argument is sent at all — there is nothing for a caller to tamper with. */
    expect(rpc.mock.calls.every((c) => c[1] === undefined)).toBe(true);
  });

  it("treats anything that is not a literal true as a no", async () => {
    getUser.mockResolvedValue(SESSION);
    for (const value of [null, undefined, "true", 1, {}, [], "admin"]) {
      roles(value, value);
      await expect(fetchAdminIdentity()).resolves.toBeNull();
    }
  });

  it("does not grant super admin on a plain admin answer", async () => {
    getUser.mockResolvedValue(SESSION);
    /* A truthy-but-not-true super answer must not be promoted either. */
    roles(true, "yes");
    const id = await fetchAdminIdentity();
    expect(id?.isAdmin).toBe(true);
    expect(id?.isSuperAdmin).toBe(false);
  });

  it("fails closed when the check itself errors", async () => {
    getUser.mockResolvedValue(SESSION);
    rpc.mockImplementation((name: string) =>
      name === "is_courthub_admin"
        ? Promise.resolve({ data: null, error: { message: "permission denied" } })
        : Promise.resolve({ data: false, error: null }),
    );
    /* An error must never read as access. The route guard catches and treats it as
       not-an-admin; here it must at least not resolve to an identity. */
    await expect(fetchAdminIdentity()).rejects.toBeTruthy();
  });

  it("never reads a role out of the user object it was handed", async () => {
    /* A tenant who edits their own session metadata still gets nothing: the answer
       comes from user_roles, and the metadata is not consulted. */
    getUser.mockResolvedValue({
      data: { user: { id: "u-2", email: "player@x.ph", user_metadata: { role: "super_admin" } } },
    });
    roles(false, false);
    await expect(fetchAdminIdentity()).resolves.toBeNull();
  });
});
