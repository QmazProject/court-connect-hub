import { describe, expect, it } from "vitest";
import {
  classifyOAuthReturn,
  isWellFormedSlug,
  slugsMatch,
  TENANT_LOGIN_PENDING_SLUG_KEY,
  WORKSPACE_SIGN_IN_FAILED,
} from "../tenant-login";

describe("WORKSPACE_SIGN_IN_FAILED", () => {
  it("is the exact approved sentence", () => {
    expect(WORKSPACE_SIGN_IN_FAILED).toBe("These credentials don't work for this workspace.");
  });

  /* The whole point of one message: it must not hint at which failure occurred. */
  it("names no cause, role, or membership state", () => {
    expect(WORKSPACE_SIGN_IN_FAILED).not.toMatch(
      /password|email|account|player|tenant|admin|manager|staff|member|invite|inactive|exist|another|business/i,
    );
  });
});

describe("isWellFormedSlug", () => {
  it("accepts generated slugs and placeholders", () => {
    for (const s of ["qmaz-holdings-inc", "abc-sports", "abc-sports-2", "t-a7f3c2e1", "cebu"]) {
      expect(isWellFormedSlug(s)).toBe(true);
    }
  });

  it("refuses anything that is not a slug", () => {
    for (const s of [
      "",
      "   ",
      "UPPER",
      "has space",
      "trailing-",
      "-leading",
      "double--hyphen",
      "../etc",
      "a/b",
      "sql'injection",
      null,
      undefined,
      "x".repeat(81),
    ]) {
      expect(isWellFormedSlug(s as string)).toBe(false);
    }
  });
});

describe("slugsMatch", () => {
  it("ignores case and padding, matching the SQL lower(btrim(…))", () => {
    expect(slugsMatch("abc-sports", "ABC-Sports")).toBe(true);
    expect(slugsMatch("  abc-sports ", "abc-sports")).toBe(true);
  });

  it("keeps different slugs apart, and treats empty as matching nothing", () => {
    expect(slugsMatch("abc-sports", "abc-sports-2")).toBe(false);
    expect(slugsMatch("", "")).toBe(false);
    expect(slugsMatch(null, null)).toBe(false);
  });
});

describe("classifyOAuthReturn", () => {
  it("verifies when the stash matches the URL", () => {
    expect(classifyOAuthReturn("abc-sports", "abc-sports")).toEqual({
      kind: "verify",
      slug: "abc-sports",
    });
  });

  it("treats no stash as an ordinary visit, not an attempt", () => {
    expect(classifyOAuthReturn("abc-sports", null)).toEqual({ kind: "none" });
    expect(classifyOAuthReturn("abc-sports", "")).toEqual({ kind: "none" });
  });

  /* Editing the URL between leaving for Google and coming back is the attack this
     exists to refuse. The answer is neither slug — it is a refusal. */
  it("fails closed when the URL was changed during the round trip", () => {
    expect(classifyOAuthReturn("other-tenant", "abc-sports")).toEqual({ kind: "mismatch" });
    expect(classifyOAuthReturn("", "abc-sports")).toEqual({ kind: "mismatch" });
  });

  it("never returns the URL's slug as the one to verify", () => {
    const result = classifyOAuthReturn("attacker-tenant", "abc-sports");
    expect(result.kind).toBe("mismatch");
    if (result.kind === "verify") expect(result.slug).not.toBe("attacker-tenant");
  });

  it("uses its own storage key, not the landing page's OAuth keys", () => {
    expect(TENANT_LOGIN_PENDING_SLUG_KEY).toBe("courthub_tenant_login_pending_slug");
    expect(TENANT_LOGIN_PENDING_SLUG_KEY).not.toMatch(/pending_role|pending_business|signin_side/);
  });
});

import { tenantLoginPath, tenantLoginUrl } from "../tenant-login";

describe("tenantLoginUrl", () => {
  it("builds the link from the current origin and the real slug", () => {
    expect(tenantLoginUrl("https://court-connect-hub.vercel.app", "qmaz-holdings-inc")).toBe(
      "https://court-connect-hub.vercel.app/tenant/qmaz-holdings-inc/login",
    );
  });

  /* A custom domain, a preview deployment and a laptop each get their own link with
     nothing hard-coded. */
  it("follows whatever origin the app is served from", () => {
    for (const origin of [
      "https://courthub.ph",
      "http://localhost:5173",
      "https://pr-42.vercel.app",
    ]) {
      expect(tenantLoginUrl(origin, "abc-sports")).toBe(`${origin}/tenant/abc-sports/login`);
    }
  });

  it("tolerates a trailing slash on the origin without doubling it", () => {
    expect(tenantLoginUrl("https://courthub.ph/", "abc-sports")).toBe(
      "https://courthub.ph/tenant/abc-sports/login",
    );
  });

  it("works for a placeholder slug, so an unnamed workspace still has a link", () => {
    expect(tenantLoginUrl("https://courthub.ph", "t-a7f3c2e1")).toBe(
      "https://courthub.ph/tenant/t-a7f3c2e1/login",
    );
  });

  /* Never a half-built URL: `/tenant//login` looks real and goes nowhere. */
  it("returns null rather than a broken link", () => {
    for (const slug of [null, undefined, "", "   ", "Not A Slug", "has space", "../etc"]) {
      expect(tenantLoginUrl("https://courthub.ph", slug as string)).toBeNull();
    }
    expect(tenantLoginUrl("", "abc-sports")).toBeNull();
  });

  it("agrees with the route path the page is registered at", () => {
    expect(tenantLoginPath("abc-sports")).toBe("/tenant/abc-sports/login");
    expect(tenantLoginUrl("https://x.dev", "abc-sports")).toBe(
      `https://x.dev${tenantLoginPath("abc-sports")}`,
    );
  });
});

import {
  routeAfterGeneralSignIn,
  WORKSPACE_ACTIVATED_MESSAGE,
  WORKSPACE_ELSEWHERE_MESSAGE,
} from "../tenant-login";

describe("routeAfterGeneralSignIn", () => {
  it("leaves players alone whatever their membership column says", () => {
    for (const status of ["active", "invited", "inactive", null, undefined] as const) {
      expect(routeAfterGeneralSignIn(false, status)).toEqual({ kind: "player" });
    }
  });

  /* The only case the general page turns away. */
  it("turns away an active member", () => {
    expect(routeAfterGeneralSignIn(true, "active")).toEqual({ kind: "workspace" });
  });

  /* Founder safety: no membership yet means the workspace has not been created, and
     the dashboard is where ensure_tenant_workspace() runs. */
  it("lets a founder with no membership through to bootstrap", () => {
    expect(routeAfterGeneralSignIn(true, null)).toEqual({ kind: "bootstrap" });
    expect(routeAfterGeneralSignIn(true, undefined)).toEqual({ kind: "bootstrap" });
  });

  /* Stranding check: an invited member sent to their workspace page would be refused
     there by the active-only rule, with no way left to accept. */
  it("sends invited and removed members to the dashboard, never to the workspace page", () => {
    expect(routeAfterGeneralSignIn(true, "invited")).toEqual({ kind: "accept" });
    expect(routeAfterGeneralSignIn(true, "inactive")).toEqual({ kind: "accept" });
  });

  it("only ever turns away on an active membership", () => {
    const turned = (["active", "invited", "inactive", null, undefined] as const).filter(
      (s) => routeAfterGeneralSignIn(true, s).kind === "workspace",
    );
    expect(turned).toEqual(["active"]);
  });
});

describe("general-login messages", () => {
  it("say enough and no more", () => {
    expect(WORKSPACE_ELSEWHERE_MESSAGE).toMatch(/workspace sign-in page/i);
    /* No role, no member state, no other business. */
    expect(WORKSPACE_ELSEWHERE_MESSAGE).not.toMatch(
      /admin|manager|staff|invited|inactive|member|role/i,
    );
    expect(WORKSPACE_ACTIVATED_MESSAGE).toMatch(/active/i);
  });
});

import { resolveMyWorkspace, type WorkspaceReader } from "../tenant-login";

/** A stand-in for the Supabase client that records what was asked for, so a test can
 *  assert the reads are scoped to the caller rather than taking it on trust. */
function fakeClient(
  rows: Record<string, unknown>,
  seen: { table: string; column: string; value: string }[] = [],
): WorkspaceReader {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: string) => {
          seen.push({ table, column, value });
          return { maybeSingle: async () => ({ data: rows[table] ?? null }) };
        },
      }),
    }),
  };
}

describe("resolveMyWorkspace", () => {
  it("reads the membership by the caller's own user id, and the tenant by that row's id", async () => {
    const seen: { table: string; column: string; value: string }[] = [];
    const client = fakeClient(
      {
        tenant_members: { tenant_id: "t-1", status: "active" },
        tenants: { slug: "qmaz-holdings-inc", name: "QMAZ Holdings Inc" },
      },
      seen,
    );
    await expect(resolveMyWorkspace(client, "u-1")).resolves.toEqual({
      status: "active",
      slug: "qmaz-holdings-inc",
      name: "QMAZ Holdings Inc",
    });
    /* The tenant is looked up by the id found on the caller's own row. Nothing here
       accepts a tenant id from anywhere else. */
    expect(seen).toEqual([
      { table: "tenant_members", column: "user_id", value: "u-1" },
      { table: "tenants", column: "id", value: "t-1" },
    ]);
  });

  it("reports invited without treating it as active", async () => {
    const client = fakeClient({
      tenant_members: { tenant_id: "t-1", status: "invited" },
      tenants: { slug: "abc-sports", name: "ABC Sports" },
    });
    await expect(resolveMyWorkspace(client, "u-1")).resolves.toMatchObject({ status: "invited" });
  });

  it("is null for an account with no membership, which is every player and a new founder", async () => {
    await expect(resolveMyWorkspace(fakeClient({}), "u-1")).resolves.toBeNull();
  });

  it("is null when the tenant row cannot be read, rather than inventing a slug", async () => {
    const client = fakeClient({ tenant_members: { tenant_id: "t-1", status: "active" } });
    await expect(resolveMyWorkspace(client, "u-1")).resolves.toBeNull();
  });

  it("is null when the tenant has no slug", async () => {
    const client = fakeClient({
      tenant_members: { tenant_id: "t-1", status: "active" },
      tenants: { slug: "", name: "No Address Yet" },
    });
    await expect(resolveMyWorkspace(client, "u-1")).resolves.toBeNull();
  });
});

describe("the whole decision, end to end", () => {
  /* The two halves are only correct together: what the membership says, and what the
     landing page then does about it. */
  const decide = async (rows: Record<string, unknown>, isTenant: boolean) => {
    const w = await resolveMyWorkspace(fakeClient(rows), "u-1");
    return {
      route: routeAfterGeneralSignIn(isTenant, w?.status).kind,
      url: tenantLoginUrl("https://court-connect-hub.vercel.app", w?.slug),
      name: w?.name ?? null,
    };
  };

  it("turns an active member away with their own business name and address", async () => {
    await expect(
      decide(
        {
          tenant_members: { tenant_id: "t-1", status: "active" },
          tenants: { slug: "qmaz-holdings-inc", name: "QMAZ Holdings Inc" },
        },
        true,
      ),
    ).resolves.toEqual({
      route: "workspace",
      url: "https://court-connect-hub.vercel.app/tenant/qmaz-holdings-inc/login",
      name: "QMAZ Holdings Inc",
    });
  });

  it("lets an invited member through to the dashboard instead of stranding them", async () => {
    const r = await decide(
      {
        tenant_members: { tenant_id: "t-1", status: "invited" },
        tenants: { slug: "abc-sports", name: "ABC Sports" },
      },
      true,
    );
    expect(r.route).toBe("accept");
  });

  it("lets a founder with no workspace through, so bootstrap can run", async () => {
    expect((await decide({}, true)).route).toBe("bootstrap");
  });

  it("leaves a player alone even if a membership row somehow exists", async () => {
    const r = await decide(
      {
        tenant_members: { tenant_id: "t-1", status: "active" },
        tenants: { slug: "abc-sports", name: "ABC Sports" },
      },
      false,
    );
    expect(r.route).toBe("player");
  });

  it("never hands one business another's address", async () => {
    const a = await decide(
      {
        tenant_members: { tenant_id: "t-a", status: "active" },
        tenants: { slug: "tenant-a", name: "Tenant A" },
      },
      true,
    );
    const b = await decide(
      {
        tenant_members: { tenant_id: "t-b", status: "active" },
        tenants: { slug: "tenant-b", name: "Tenant B" },
      },
      true,
    );
    expect(a.url).toContain("/tenant/tenant-a/login");
    expect(b.url).toContain("/tenant/tenant-b/login");
    expect(a.url).not.toEqual(b.url);
  });
});
