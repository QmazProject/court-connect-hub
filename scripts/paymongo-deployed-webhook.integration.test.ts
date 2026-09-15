/**
 * PayMongo TEST — deployed webhook delivery verification.
 *
 * The companion to paymongo-test-verify: that file proves the handler by
 * feeding it signed events itself. This file proves the DEPLOYMENT: it submits
 * real sandbox transfers and then only WAITS, asserting that PayMongo's own
 * `transfer.outward.*` delivery reached the Vercel-hosted webhook and that the
 * deployed handler settled the payout in the shared database. Nothing here
 * calls the webhook route for the settlement; the event ids it expects are
 * PayMongo's (`evt_…`), never ones it made up.
 *
 * What it still runs locally: the submission (the same committed server
 * function the deployed app runs — the Google-only admin sign-in makes driving
 * the deployed UI from a script impractical), the tenant's Finance read, and
 * the duplicate/stale re-deliveries, which are signed with the endpoint secret
 * and POSTed to the DEPLOYED URL using PayMongo's own event id.
 *
 * Safety rails: `sk_test_…` only; simulator destinations only; the empty
 * verification tenant only; the business tenant's balances asserted unchanged;
 * throwaway users deleted; ledger netted to zero.
 *
 * Run:  npx vitest run --config scripts/vitest.integration.config.ts scripts/paymongo-deployed-webhook
 */
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";

const DEPLOYED_WEBHOOK = "https://court-connect-hub.vercel.app/api/public/paymongo/webhook";

const ENV = await vi.hoisted(async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = readFileSync(join(process.cwd(), ".env"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
  }
  for (const k of [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PAYMONGO_SECRET_KEY",
    "PAYMONGO_WEBHOOK_SECRET",
  ]) {
    if (!env[k]) throw new Error(`.env is missing ${k}`);
    process.env[k] = env[k];
  }
  if (!env.PAYMONGO_SECRET_KEY.startsWith("sk_test_"))
    throw new Error("REFUSING TO RUN: not a test key");
  if (typeof globalThis.WebSocket === "undefined") {
    const ws = await import("ws");
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws.default ?? ws.WebSocket;
  }
  return env;
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validator: ((d: unknown) => unknown) | null = null;
    const b = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => {
        validator = v;
        return b;
      },
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (args: { data?: unknown; context: unknown }) =>
          h({ data: validator ? validator(args.data) : args.data, context: args.context }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

type Fn<R = unknown> = (args: { data?: unknown; context: unknown }) => Promise<R>;
const fns = (await import("@/lib/payouts.functions")) as unknown as Record<string, Fn>;
const pm = await import("@/lib/paymongo.server");

const admin = createClient<Database>(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const userClient = (jwt: string) =>
  createClient<Database>(ENV.SUPABASE_URL, ENV.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

type User = { id: string; jwt: string; client: SupabaseClient<Database> };
const TS = Date.now();
async function makeUser(role: string): Promise<User> {
  const email = `cch-deployverify-${role}-${TS}@example.com`;
  const password = `Verify-${TS}-${Math.random().toString(36).slice(2)}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${role}): ${error?.message}`);
  const anon = createClient<Database>(ENV.SUPABASE_URL, ENV.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: s, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr || !s.session) throw new Error(`signIn(${role}): ${sErr?.message}`);
  return {
    id: data.user.id,
    jwt: s.session.access_token,
    client: userClient(s.session.access_token),
  };
}
const ctx = (u: User) => ({ supabase: u.client, userId: u.id, claims: { sub: u.id } });

type Bal = {
  liability_centavos: number;
  reserved_centavos: number;
  paid_out_centavos: number;
  available_centavos: number;
};
async function balance(tenantId: string): Promise<Bal> {
  const { data, error } = await admin
    .from("tenant_balances")
    .select("liability_centavos, reserved_centavos, paid_out_centavos, available_centavos")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  return data as Bal;
}
const payout = async (id: number) =>
  (await admin.from("tenant_payouts").select("*").eq("id", id).single()).data!;
const attempts = async (id: number) =>
  (await admin.from("tenant_payout_attempts").select("*").eq("payout_id", id).order("attempt_no"))
    .data ?? [];
const ledgerFor = async (id: number) =>
  (
    await admin
      .from("tenant_ledger_entries")
      .select("id, entry_type, reserved_centavos, paid_out_centavos, idempotency_key, reference")
      .eq("payout_id", id)
      .order("id")
  ).data ?? [];
const eventsFor = async (id: number) =>
  (
    await admin
      .from("payout_provider_events")
      .select("event_id, event_type, outcome, provider_transfer_id, received_at")
      .eq("payout_id", id)
      .order("id")
  ).data ?? [];
const auditFor = async (id: number) =>
  (
    await admin
      .from("admin_audit_log")
      .select("action, created_at")
      .eq("target_type", "payout")
      .eq("target_id", String(id))
      .order("id")
  ).data ?? [];
const notesFor = async (userId: string, since: string) =>
  (
    await admin
      .from("notifications")
      .select("type, title, body")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at")
  ).data ?? [];

/** Wait for PayMongo's own delivery to be recorded by the deployed handler. */
async function waitForProviderEvent(payoutId: number, type: string, maxMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const ev = (await eventsFor(payoutId)).filter(
      (e) => e.event_type === type && e.event_id.startsWith("evt_"),
    );
    if (ev.length > 0) return ev;
    if (Date.now() - t0 > maxMs) return ev;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** A re-delivery signed with the endpoint secret, POSTed to the DEPLOYED URL,
 *  carrying PayMongo's own event id so it is a true duplicate. */
async function redeliver(
  eventId: string,
  type: string,
  transferId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    data: {
      id: eventId,
      type: "event",
      attributes: {
        type,
        livemode: false,
        data: {
          id: `wallet_tr_redeliver_${TS}`,
          type: "wallet_transaction",
          attributes: { transfer_id: transferId, status, livemode: false, ...extra },
        },
      },
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", ENV.PAYMONGO_WEBHOOK_SECRET)
    .update(`${ts}.${body}`)
    .digest("hex");
  const res = await fetch(DEPLOYED_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "paymongo-signature": `t=${ts},te=${sig}` },
    body,
  });
  return res.status;
}

const st = {
  tenantId: "",
  businessId: "",
  businessBefore: null as Bal | null,
  admin: null as User | null,
  tenantAdmin: null as User | null,
  seedKey: `verify:deployed-webhook:seed:${TS}`,
  payoutA: 0,
  transferA: "",
  payoutB: 0,
  transferB: "",
  report: {} as Record<string, unknown>,
};
const startedAt = new Date().toISOString();

beforeAll(async () => {
  const { data: tenants } = await admin.from("tenants").select("id, slug");
  st.tenantId = tenants!.find((t) => t.slug === "t-a62fe6f0")!.id;
  st.businessId = tenants!.find((t) => t.slug === "clav22-restobar")!.id;
  st.businessBefore = await balance(st.businessId);
  st.admin = await makeUser("admin");
  st.tenantAdmin = await makeUser("tenantadmin");
  const r1 = await admin
    .from("user_roles")
    .insert({ user_id: st.admin.id, role: "admin", note: `deploy verify ${TS}` });
  if (r1.error) throw r1.error;
  const r2 = await admin
    .from("tenant_members")
    .insert({
      tenant_id: st.tenantId,
      user_id: st.tenantAdmin.id,
      role: "admin",
      status: "active",
    });
  if (r2.error) throw r2.error;
  const seed = await admin.from("tenant_ledger_entries").insert({
    tenant_id: st.tenantId,
    entry_type: "adjustment_credit",
    liability_centavos: 3000,
    source: "verification",
    idempotency_key: st.seedKey,
    metadata: { purpose: "deployed webhook verification", run: TS },
  });
  if (seed.error) throw seed.error;
});

afterAll(async () => {
  try {
    const b = await balance(st.tenantId);
    if (b.available_centavos > 0) {
      await admin
        .from("tenant_ledger_entries")
        .insert({
          tenant_id: st.tenantId,
          entry_type: "adjustment_debit",
          liability_centavos: -b.available_centavos,
          source: "verification",
          idempotency_key: `verify:deployed-webhook:unseed:${TS}`,
          metadata: { reverses: st.seedKey, run: TS },
        });
    }
    const ids = [st.admin, st.tenantAdmin].filter(Boolean).map((u) => u!.id);
    await admin.from("tenant_members").delete().in("user_id", ids);
    await admin.from("user_roles").delete().in("user_id", ids);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  } finally {
    // eslint-disable-next-line no-console
    console.log("\nDEPLOYED WEBHOOK REPORT\n" + JSON.stringify(st.report, null, 2));
  }
});

describe("deployed success path", () => {
  it("submits a ₱20 sandbox-success payout and records the transfer id", async () => {
    const ta = st.tenantAdmin!;
    expect(
      (
        await ta.client.rpc("tenant_save_payout_account", {
          _account_type: "gcash",
          _account_name: "Simulator Success",
          _account_number: "999999990001",
        })
      ).error,
    ).toBeNull();
    const req = await ta.client.rpc("tenant_request_payout", { _amount_centavos: 2000 });
    expect(req.error).toBeNull();
    st.payoutA = Number((Array.isArray(req.data) ? req.data[0] : req.data)?.payout_id);
    const res = (await fns.adminSubmitPayouts({
      data: { provider: "paymongo", items: [{ payoutId: st.payoutA }] },
      context: ctx(st.admin!),
    })) as Array<{ ok: boolean; status: string; transferId?: string | null; error?: string }>;
    expect(res[0].ok, res[0].error).toBe(true);
    expect(res[0].status).toBe("submitted");
    st.transferA = res[0].transferId!;
    st.report.submitA = res[0];
    expect((await payout(st.payoutA)).status).toBe("processing");
  });

  it("PayMongo delivers transfer.outward.successful to the deployed webhook and the deployed handler pays the payout exactly once", async () => {
    const before = await balance(st.tenantId);
    const ev = await waitForProviderEvent(st.payoutA, "transfer.outward.successful");
    st.report.deliveryA = ev;
    expect(
      ev.length,
      "no PayMongo-delivered success event recorded by the deployed handler",
    ).toBeGreaterThan(0);
    expect(ev[0].outcome).toBe("paid");
    expect(ev[0].provider_transfer_id).toBe(st.transferA);

    const p = await payout(st.payoutA);
    expect(p.status).toBe("paid");
    expect(p.provider_transfer_id).toBe(st.transferA);
    expect(p.transfer_reference).toBeTruthy();
    expect(p.paid_amount_centavos).toBe(2000);
    expect(p.completed_at).toBeTruthy();
    expect((await attempts(st.payoutA))[0].status).toBe("succeeded");
    const led = await ledgerFor(st.payoutA);
    expect(led.filter((e) => e.entry_type === "payout_paid")).toHaveLength(1);
    const after = await balance(st.tenantId);
    expect(after.reserved_centavos).toBe(before.reserved_centavos - 2000);
    expect(after.paid_out_centavos).toBe(before.paid_out_centavos + 2000);
    expect(after.liability_centavos).toBe(before.liability_centavos);
    expect(after.available_centavos).toBe(before.available_centavos);
    expect((await auditFor(st.payoutA)).map((a) => a.action)).toContain(
      "payout.provider_succeeded",
    );
    expect(
      (await notesFor(st.tenantAdmin!.id, startedAt)).some((n) => n.type === "payout_paid"),
    ).toBe(true);
    st.report.paidA = {
      payout: {
        status: p.status,
        ref: p.transfer_reference,
        transfer: p.provider_transfer_id,
        completed_at: p.completed_at,
      },
      ledger: led,
      balanceAfter: after,
    };
  });

  it("the tenant's Finance read shows it", async () => {
    const rows = (await fns.listPayouts({ context: ctx(st.tenantAdmin!) })) as Array<
      Record<string, unknown>
    >;
    const row = rows.find((r) => r.id === st.payoutA)!;
    expect(row.provider).toBe("paymongo");
    expect(row.status).toBe("paid");
    expect(row.provider_transfer_id).toBe(st.transferA);
    expect(
      (row.destination_snapshot as { account_number_masked: string }).account_number_masked,
    ).toBe("••••••••0001");
  });

  it("re-delivering PayMongo's own event to the deployed webhook is idempotent; a stale failure is ignored", async () => {
    const ev = (await eventsFor(st.payoutA)).find((e) => e.outcome === "paid")!;
    const before = await balance(st.tenantId);
    expect(
      await redeliver(ev.event_id, "transfer.outward.successful", st.transferA, "succeeded"),
    ).toBe(200);
    expect(
      await redeliver(`evt_stale_${TS}`, "transfer.outward.failed", st.transferA, "failed", {
        provider_error: "stale",
        provider_error_code: "stale_test",
      }),
    ).toBe(200);
    const evs = await eventsFor(st.payoutA);
    expect(evs.filter((e) => e.event_id === ev.event_id)).toHaveLength(1);
    expect(evs.find((e) => e.event_id === `evt_stale_${TS}`)?.outcome).toBe(
      "ignored_already_succeeded",
    );
    expect((await payout(st.payoutA)).status).toBe("paid");
    expect(
      (await ledgerFor(st.payoutA)).filter((e) => e.entry_type === "payout_paid"),
    ).toHaveLength(1);
    expect(await balance(st.tenantId)).toEqual(before);
    st.report.idempotencyA = evs;
  });
});

describe("deployed failure path", () => {
  it("submits a ₱10 sandbox-failure payout", async () => {
    const ta = st.tenantAdmin!;
    expect(
      (
        await ta.client.rpc("tenant_save_payout_account", {
          _account_type: "gcash",
          _account_name: "Simulator Failure",
          _account_number: "999999990002",
        })
      ).error,
    ).toBeNull();
    const req = await ta.client.rpc("tenant_request_payout", { _amount_centavos: 1000 });
    expect(req.error).toBeNull();
    st.payoutB = Number((Array.isArray(req.data) ? req.data[0] : req.data)?.payout_id);
    const res = (await fns.adminSubmitPayouts({
      data: { provider: "paymongo", items: [{ payoutId: st.payoutB }] },
      context: ctx(st.admin!),
    })) as Array<{ ok: boolean; status: string; transferId?: string | null; error?: string }>;
    expect(res[0].ok, res[0].error).toBe(true);
    st.transferB = res[0].transferId!;
    st.report.submitB = res[0];
  });

  it("PayMongo delivers transfer.outward.failed to the deployed webhook; the deployed handler fails the payout and releases once", async () => {
    const before = await balance(st.tenantId);
    const ev = await waitForProviderEvent(st.payoutB, "transfer.outward.failed");
    st.report.deliveryB = ev;
    expect(
      ev.length,
      "no PayMongo-delivered failure event recorded by the deployed handler",
    ).toBeGreaterThan(0);
    expect(ev[0].outcome).toBe("failed");
    const p = await payout(st.payoutB);
    expect(p.status).toBe("failed");
    expect(p.provider_error_code).toBeTruthy();
    expect(p.paid_amount_centavos).toBeNull();
    const led = await ledgerFor(st.payoutB);
    expect(led.filter((e) => e.entry_type === "payout_released")).toHaveLength(1);
    expect(led.some((e) => e.entry_type === "payout_paid")).toBe(false);
    const after = await balance(st.tenantId);
    expect(after.reserved_centavos).toBe(before.reserved_centavos - 1000);
    expect(after.available_centavos).toBe(before.available_centavos + 1000);
    expect(after.paid_out_centavos).toBe(before.paid_out_centavos);
    expect(after.liability_centavos).toBe(before.liability_centavos);
    expect((await auditFor(st.payoutB)).map((a) => a.action)).toContain("payout.provider_failed");
    expect(
      (await notesFor(st.tenantAdmin!.id, startedAt)).some((n) => n.type === "payout_failed"),
    ).toBe(true);
    expect((await notesFor(st.admin!.id, startedAt)).some((n) => n.type === "payout_failed")).toBe(
      true,
    );

    /* duplicate delivery of PayMongo's own failure event */
    expect(
      await redeliver(ev[0].event_id, "transfer.outward.failed", st.transferB, "failed", {
        provider_error_code: p.provider_error_code,
      }),
    ).toBe(200);
    expect(
      (await ledgerFor(st.payoutB)).filter((e) => e.entry_type === "payout_released"),
    ).toHaveLength(1);
    expect(await balance(st.tenantId)).toEqual(after);
    st.report.failedB = {
      payout: { status: p.status, code: p.provider_error_code, msg: p.provider_error_message },
      ledger: led,
      balanceAfter: after,
      events: await eventsFor(st.payoutB),
    };
  });

  it("the business tenant is untouched", async () => {
    expect(await balance(st.businessId)).toEqual(st.businessBefore);
  });
});
