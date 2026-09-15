/**
 * What the disbursement migration and code promise about who may do what.
 *
 * There is no local Postgres here, so the database half is verified against
 * the live project after the migration is applied. What CAN be pinned without
 * one is the text of the migration — which policies exist, whom functions are
 * granted to, which uniqueness the schema enforces — and the shape of the
 * code around it: that the secret key is read only on the server, and that
 * the server module is never statically imported by anything that ships to
 * the browser.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "supabase/migrations/20260930000000_admin_tenant_visibility_and_payout_providers.sql"),
  "utf8",
);

/** The text of one CREATE FUNCTION … $$ … $$ block. */
function fn(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "m");
  const m = MIGRATION.match(re);
  if (!m) throw new Error(`function ${name} not found in migration`);
  return m[0];
}

describe("tenant visibility", () => {
  it("grants platform admins a SELECT on public.tenants, and nothing wider", () => {
    const m = MIGRATION.match(/CREATE POLICY "Platform admins read all tenants"[\s\S]*?;/);
    expect(m).not.toBeNull();
    const policy = m![0];
    expect(policy).toMatch(/ON public\.tenants FOR SELECT TO authenticated/);
    expect(policy).toMatch(/USING \(public\.is_courthub_admin\(\)\)/);
    expect(policy).not.toMatch(/true/);
    expect(policy).not.toMatch(/anon/);
  });

  it("adds no INSERT, UPDATE or DELETE policy on tenants", () => {
    expect(MIGRATION).not.toMatch(/ON public\.tenants FOR (INSERT|UPDATE|DELETE)/);
  });

  it("does not drop the existing member policies", () => {
    expect(MIGRATION).not.toMatch(/DROP POLICY IF EXISTS "Members read their tenant"/);
    expect(MIGRATION).not.toMatch(
      /DROP POLICY IF EXISTS "Invited members read the inviting tenant"/,
    );
  });
});

describe("who may move money", () => {
  it.each([
    "admin_request_recurring_payout",
    "admin_begin_payout_attempt",
    "admin_mark_payout_attempt_submitted",
    "admin_mark_payout_attempt_failed",
    "admin_record_manual_payout",
    "admin_set_payout_account_bic",
    "admin_transition_payout",
  ])("%s re-checks is_courthub_admin() inside the function", (name) => {
    expect(fn(name)).toMatch(/IF NOT public\.is_courthub_admin\(\) THEN/);
  });

  it("the settlement function is executable by the service role only", () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.payout_provider_settle\([^)]*\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(MIGRATION).toMatch(
      /GRANT\s+EXECUTE ON FUNCTION public\.payout_provider_settle\([^)]*\)\s+TO service_role;/,
    );
  });

  it("the internal settlement helpers are granted to nobody", () => {
    for (const name of [
      "payout_apply_paid",
      "payout_apply_failed",
      "payout_reserve_internal",
      "payout_reserved_held",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`,
        ),
      );
      expect(MIGRATION).not.toMatch(new RegExp(`GRANT\\s+EXECUTE ON FUNCTION public\\.${name}\\(`));
    }
  });

  it("attempts and provider events have no write policy: writes are definer functions only", () => {
    expect(MIGRATION).not.toMatch(/ON public\.tenant_payout_attempts FOR (INSERT|UPDATE|DELETE)/);
    expect(MIGRATION).not.toMatch(/ON public\.payout_provider_events FOR (INSERT|UPDATE|DELETE)/);
    expect(MIGRATION).toMatch(
      /GRANT SELECT ON public\.tenant_payout_attempts, public\.payout_provider_events TO authenticated;/,
    );
  });

  it("a tenant admin reads only its own attempts; provider payloads are admin-only", () => {
    const a = MIGRATION.match(
      /CREATE POLICY "Tenant admin reads own payout attempts"[\s\S]*?;/,
    )![0];
    expect(a).toMatch(/tenant_id = public\.current_tenant_id\(\) AND public\.is_tenant_admin\(\)/);
    const e = MIGRATION.match(/CREATE POLICY "Platform admins read provider events"[\s\S]*?;/)![0];
    expect(e).toMatch(/USING \(public\.is_courthub_admin\(\)\)/);
    expect(e).not.toMatch(/current_tenant_id/);
  });

  it("a platform admin may upload a proof only under <tenant>/disbursements/, and may not update or delete", () => {
    const p = MIGRATION.match(
      /CREATE POLICY "Platform admin uploads disbursement proof"[\s\S]*?;/,
    )![0];
    expect(p).toMatch(/FOR INSERT TO authenticated/);
    expect(p).toMatch(/public\.is_courthub_admin\(\)/);
    expect(p).toMatch(/\(storage\.foldername\(name\)\)\[2\] = 'disbursements'/);
    expect(MIGRATION).not.toMatch(/Platform admin (updates|replaces|deletes)/);
  });
});

describe("a payout cannot be paid twice", () => {
  it("one open attempt per payout is a partial unique index", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_attempts_one_open\s+ON public\.tenant_payout_attempts \(payout_id\)\s+WHERE status IN \('created', 'submitting', 'pending'\)/,
    );
  });

  it("a provider transfer id maps to one attempt and one payout", () => {
    expect(MIGRATION).toMatch(
      /uq_payout_attempts_provider_transfer_id[\s\S]*?\(provider_transfer_id\)\s+WHERE provider_transfer_id IS NOT NULL/,
    );
    expect(MIGRATION).toMatch(
      /uq_payouts_provider_transfer_id[\s\S]*?\(provider_transfer_id\)\s+WHERE provider_transfer_id IS NOT NULL/,
    );
  });

  it("the ledger's paid key is single-use, and a second use is an error rather than a no-op", () => {
    const paid = fn("payout_apply_paid");
    expect(paid).toMatch(/_idempotency_key => 'payout:paid:' \|\| _p\.id::text/);
    expect(paid).toMatch(/IF _entry IS NULL THEN\s+RAISE EXCEPTION/);
  });

  it("paying requires exactly the reserved amount to be held", () => {
    const paid = fn("payout_apply_paid");
    expect(paid).toMatch(
      /_held := public\.payout_reserved_held\(_payout_id\);\s+IF _held <> _p\.amount_centavos THEN\s+RAISE EXCEPTION/,
    );
  });

  it("beginning an attempt refuses an open attempt and a succeeded one", () => {
    const b = fn("admin_begin_payout_attempt");
    expect(b).toMatch(
      /status IN \('created', 'submitting', 'pending'\);\s+IF _open > 0 THEN\s+RAISE EXCEPTION/,
    );
    expect(b).toMatch(/status = 'succeeded';\s+IF _won > 0 THEN\s+RAISE EXCEPTION/);
    expect(b).toMatch(/FOR UPDATE/);
  });

  it("a retry after a failure re-reserves under the tenant lock, keyed by attempt", () => {
    const b = fn("admin_begin_payout_attempt");
    expect(b).toMatch(/IF _held = 0 THEN\s+PERFORM pg_advisory_xact_lock/);
    expect(b).toMatch(/'payout:reserved:' \|\| _p\.id::text \|\| ':a' \|\| _n::text/);
  });

  it("a failure releases only what is held, keyed by attempt", () => {
    const f = fn("payout_apply_failed");
    expect(f).toMatch(/'payout:released:' \|\| _p\.id::text \|\| ':a' \|\| _a\.attempt_no::text/);
    expect(f).toMatch(/IF _held > 0 THEN\s+PERFORM public\.ledger_append/);
  });
});

describe("webhook settlement is idempotent and never reverses a success", () => {
  const settle = fn("payout_provider_settle");

  it("dedupes on (provider, event_id) before touching anything", () => {
    expect(MIGRATION).toMatch(/UNIQUE \(provider, event_id\)/);
    expect(settle).toMatch(
      /ON CONFLICT \(provider, event_id\) DO NOTHING\s+RETURNING id INTO _ev_id;\s+IF _ev_id IS NULL THEN\s+RETURN 'duplicate_event';/,
    );
  });

  it("locks the attempt and the payout", () => {
    expect(settle.match(/FOR UPDATE/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("a duplicate success and a stale failure after a success are both ignored", () => {
    expect(settle).toMatch(
      /IF _a\.status = 'succeeded' THEN\s+_result := 'ignored_already_succeeded';/,
    );
  });

  it("a duplicate failure is ignored; a success after a recorded failure is flagged, never auto-paid", () => {
    expect(settle).toMatch(
      /ELSIF _a\.status = 'failed' THEN\s+IF _outcome = 'failed' THEN\s+_result := 'ignored_already_failed';\s+ELSE[\s\S]*?_result := 'conflict_needs_review';/,
    );
    const conflictBranch = settle.slice(
      settle.indexOf("'conflict_needs_review'"),
      settle.indexOf("ELSIF _p.status IN"),
    );
    expect(conflictBranch).not.toMatch(/payout_apply_paid/);
  });

  it("an event for an unknown transfer is recorded as unmatched and moves nothing", () => {
    expect(settle).toMatch(/SET outcome = 'unmatched' WHERE id = _ev_id;\s+RETURN 'unmatched';/);
  });

  it("a success pays through the shared path and a failure releases through it", () => {
    expect(settle).toMatch(
      /ELSIF _outcome = 'succeeded' THEN[\s\S]*?PERFORM public\.payout_apply_paid\(/,
    );
    expect(settle).toMatch(/ELSE\s+PERFORM public\.payout_apply_failed\(/);
  });

  it("the manual transition function cannot force a pending PayMongo attempt paid or failed", () => {
    const t = fn("admin_transition_payout");
    expect(t).toMatch(
      /status IN \('submitting', 'pending'\);\s+IF _open\.id IS NOT NULL AND _to_status IN \('paid', 'failed', 'processing', 'rejected'\) THEN\s+RAISE EXCEPTION/,
    );
  });
});

describe("manual transfers", () => {
  const m = fn("admin_record_manual_payout");
  it("require method, reference, proof, and the exact amount", () => {
    expect(m).toMatch(
      /_transfer_method IS NULL[\s\S]*?RAISE EXCEPTION 'The payment method is required'/,
    );
    expect(m).toMatch(
      /_transfer_reference IS NULL[\s\S]*?RAISE EXCEPTION 'A transfer reference is required/,
    );
    expect(m).toMatch(
      /_proof_path IS NULL[\s\S]*?RAISE EXCEPTION 'A proof of transfer is required/,
    );
    expect(m).toMatch(
      /IF _paid_amount_centavos IS DISTINCT FROM _p\.amount_centavos THEN\s+RAISE EXCEPTION/,
    );
  });
  it("refuse while a PayMongo attempt is in flight", () => {
    expect(m).toMatch(/IF _a\.id IS NOT NULL AND _a\.provider <> 'manual' THEN\s+RAISE EXCEPTION/);
  });
});

describe("recurring payouts create nothing on a timer", () => {
  it("there is no cron, no scheduled job, no trigger that inserts a payout", () => {
    expect(MIGRATION).not.toMatch(/cron\./i);
    expect(MIGRATION).not.toMatch(/pg_cron/i);
    /* The only trigger in the migration maintains updated_at on attempts. */
    const triggers = MIGRATION.match(/CREATE TRIGGER[\s\S]*?;/g) ?? [];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatch(/EXECUTE FUNCTION public\.set_updated_at\(\)/);
  });

  it("the admin recurring function reserves through the same internal path a tenant request uses", () => {
    expect(fn("admin_request_recurring_payout")).toMatch(
      /payout_reserve_internal\(_tenant_id, _amount_centavos, _uid, 'recurring'\)/,
    );
    expect(fn("tenant_request_payout")).toMatch(
      /payout_reserve_internal\(_tid, _amount_centavos, _uid, 'request'\)/,
    );
  });

  it("refuses a recurring payout for a tenant with one already open", () => {
    expect(fn("admin_request_recurring_payout")).toMatch(
      /IF _open > 0 THEN\s+RAISE EXCEPTION 'This tenant already has a payout in progress'/,
    );
  });
});

/* ---------------------------------------------------------- the code side -- */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the secret key stays on the server", () => {
  const files = walk(join(ROOT, "src"));

  it("PAYMONGO_SECRET_KEY is read only in server modules and server-function handlers", () => {
    const readers = files.filter((f) => readFileSync(f, "utf8").includes("PAYMONGO_SECRET_KEY"));
    const allowed = readers.every(
      (f) => f.endsWith(".server.ts") || f.endsWith(".functions.ts") || f.includes("__tests__"),
    );
    expect(allowed, `unexpected readers: ${readers.join(", ")}`).toBe(true);
  });

  it("paymongo.server.ts is never statically imported outside server modules and tests", () => {
    const offenders = files.filter((f) => {
      if (f.endsWith(".server.ts") || f.includes("__tests__")) return false;
      const src = readFileSync(f, "utf8");
      return /^\s*import\s[^;]*from\s+["'](@\/lib\/paymongo\.server|\.\/paymongo\.server|\.\.\/paymongo\.server)["']/m.test(
        src,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("no test or live key literal is committed under src", () => {
    const offenders = files.filter((f) => {
      if (f.includes("__tests__")) return false;
      return /sk_(test|live)_[A-Za-z0-9]{8,}/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
