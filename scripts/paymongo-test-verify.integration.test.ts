/**
 * PayMongo TEST disbursement — live verification.
 *
 * This is not a unit test. It runs the REAL server-function handlers
 * (`adminSubmitPayouts`, `adminRecordManualPayout`, `listPayouts`, …), the REAL
 * PayMongo client against the TEST API, the REAL Supabase project, and the REAL
 * webhook route handler fed a signed request — exactly what PayMongo would
 * send, built from the transfer PayMongo actually created. Only two things are
 * replaced: the TanStack server-function wrapper (so a handler is a plain
 * function) and the auth middleware (so the caller's Supabase client is one we
 * built from a throwaway user's JWT).
 *
 * Safety rails, checked before anything runs:
 *   - the PayMongo key must be `sk_test_…`; a live key aborts the file
 *   - every transfer goes to PayMongo's documented simulator numbers
 *     (999999990001 succeeds, 999999990002 fails with test_failed_number)
 *   - all writes go to the empty verification tenant; the business tenant's
 *     balances are snapshotted before and asserted unchanged after
 *   - throwaway users, memberships, roles and the uploaded proof are deleted;
 *     ledger rows are append-only and are netted to zero instead
 *
 * Run:  npx vitest run --config scripts/vitest.integration.config.ts
 */
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";

/* ---------------------------------------------------------------- env ---- */

const ENV = await vi.hoisted(async () => {
  /* Hoisted above the imports, so the fs helpers are imported here, not above. */
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
  if (!env.PAYMONGO_SECRET_KEY.startsWith("sk_test_")) {
    throw new Error("REFUSING TO RUN: PAYMONGO_SECRET_KEY is not a test key");
  }
  /* supabase-js constructs a realtime client eagerly and Node 20 has no global
     WebSocket. Nothing here subscribes to anything; the `ws` package that vite
     already depends on satisfies the constructor. */
  if (typeof globalThis.WebSocket === "undefined") {
    const ws = await import("ws");
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws.default ?? ws.WebSocket;
  }
  return env;
});

/* ------------------------------------------------------------- mocks ---- */

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
const webhookMod = (await import("@/routes/api/public/paymongo.webhook")) as unknown as {
  Route: {
    options?: { server?: { handlers?: { POST?: (a: { request: Request }) => Promise<Response> } } };
  };
};

/* ---------------------------------------------------------- helpers ---- */

const URL_ = ENV.SUPABASE_URL;
const PK = ENV.SUPABASE_PUBLISHABLE_KEY;
const SR = ENV.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient<Database>(URL_, SR, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function userClient(jwt: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, PK, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const TS = Date.now();
const TEST_TENANT_SLUG = "t-a62fe6f0"; // the empty verification tenant
const BUSINESS_TENANT_SLUG = "clav22-restobar"; // must be untouched

type User = { id: string; email: string; jwt: string; client: SupabaseClient<Database> };

async function makeUser(role: string): Promise<User> {
  const email = `cch-verify-${role}-${TS}@example.com`;
  const password = `Verify-${TS}-${Math.random().toString(36).slice(2)}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${role}): ${error?.message}`);
  const anon = createClient<Database>(URL_, PK, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: s, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr || !s.session) throw new Error(`signIn(${role}): ${sErr?.message}`);
  return {
    id: data.user.id,
    email,
    jwt: s.session.access_token,
    client: userClient(s.session.access_token),
  };
}

function ctx(u: User) {
  return { supabase: u.client, userId: u.id, claims: { sub: u.id } };
}

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

async function payout(id: number) {
  const { data, error } = await admin.from("tenant_payouts").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}
async function attempts(payoutId: number) {
  const { data, error } = await admin
    .from("tenant_payout_attempts")
    .select("*")
    .eq("payout_id", payoutId)
    .order("attempt_no");
  if (error) throw error;
  return data;
}
async function ledgerFor(payoutId: number) {
  const { data, error } = await admin
    .from("tenant_ledger_entries")
    .select("id, entry_type, reserved_centavos, paid_out_centavos, idempotency_key, reference")
    .eq("payout_id", payoutId)
    .order("id");
  if (error) throw error;
  return data;
}
async function providerEvents(payoutId: number) {
  const { data, error } = await admin
    .from("payout_provider_events")
    .select("event_id, event_type, outcome, provider_transfer_id")
    .eq("payout_id", payoutId)
    .order("id");
  if (error) throw error;
  return data;
}
async function auditFor(payoutId: number) {
  const { data, error } = await admin
    .from("admin_audit_log")
    .select("action, actor_id, metadata, created_at")
    .eq("target_type", "payout")
    .eq("target_id", String(payoutId))
    .order("id");
  if (error) throw error;
  return data;
}
async function notificationsFor(userId: string, sinceISO: string) {
  const { data, error } = await admin
    .from("notifications")
    .select("type, title, body, link, created_at")
    .eq("user_id", userId)
    .gte("created_at", sinceISO)
    .order("created_at");
  if (error) throw error;
  return data;
}

async function pollTransfer(id: string, maxMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const t = await pm.retrieveTransfer(id);
    if (t.status !== "pending" || Date.now() - t0 > maxMs) return t;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** A webhook request exactly as PayMongo signs one: `t=<ts>,te=<hmac>` over
 *  `${ts}.${rawBody}` with the endpoint secret. The body follows PayMongo's
 *  documented transfer event sample, filled from the real transfer. */
function signedWebhook(
  eventId: string,
  type: "transfer.outward.successful" | "transfer.outward.failed",
  t: {
    id: string;
    status: string;
    reference_number?: string | null;
    amount: number;
    provider_error?: string | null;
    provider_error_code?: string | null;
  },
  opts: { badSignature?: boolean } = {},
): Request {
  const body = JSON.stringify({
    data: {
      id: eventId,
      type: "event",
      attributes: {
        type,
        livemode: false,
        data: {
          id: `wallet_tr_${eventId}`,
          type: "wallet_transaction",
          attributes: {
            transfer_id: t.id,
            status: t.status,
            reference_number: t.reference_number ?? null,
            amount: t.amount,
            currency: "PHP",
            livemode: false,
            provider: "instapay",
            provider_error: t.provider_error ?? null,
            provider_error_code: t.provider_error_code ?? null,
            receiver: {
              bank_account_name: "Simulator",
              bank_account_number: "999999990000",
              bank_code: "GXCHPHM2XXX",
            },
            sender: { account_number: "hidden" },
            created_at: Math.floor(Date.now() / 1000),
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.badSignature ? "wrong-secret" : ENV.PAYMONGO_WEBHOOK_SECRET)
    .update(`${ts}.${body}`)
    .digest("hex");
  return new Request("http://localhost/api/public/paymongo/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "paymongo-signature": `t=${ts},te=${sig}` },
    body,
  });
}

const webhookPOST = webhookMod.Route.options?.server?.handlers?.POST;

/* ---------------------------------------------------------- the run ---- */

const state: {
  tenantId: string;
  businessTenantId: string;
  businessBefore: Bal | null;
  admin: User | null;
  tenantAdmin: User | null;
  staff: User | null;
  player: User | null;
  seedKey: string;
  payoutA: number;
  transferA: string;
  payoutB: number;
  transferB: string;
  transferB2: string;
  payoutC: number;
  proofPath: string;
  report: Record<string, unknown>;
} = {
  tenantId: "",
  businessTenantId: "",
  businessBefore: null,
  admin: null,
  tenantAdmin: null,
  staff: null,
  player: null,
  seedKey: `verify:paymongo-test:seed:${TS}`,
  payoutA: 0,
  transferA: "",
  payoutB: 0,
  transferB: "",
  transferB2: "",
  payoutC: 0,
  proofPath: "",
  report: {},
};
const startedAt = new Date().toISOString();

beforeAll(async () => {
  const { data: tenants, error } = await admin.from("tenants").select("id, slug");
  if (error) throw error;
  const test = tenants?.find((t) => t.slug === TEST_TENANT_SLUG);
  const biz = tenants?.find((t) => t.slug === BUSINESS_TENANT_SLUG);
  if (!test || !biz) throw new Error("expected tenants not found");
  state.tenantId = test.id;
  state.businessTenantId = biz.id;
  state.businessBefore = await balance(biz.id);

  state.admin = await makeUser("admin");
  state.tenantAdmin = await makeUser("tenantadmin");
  state.staff = await makeUser("staff");
  state.player = await makeUser("player");

  const r1 = await admin
    .from("user_roles")
    .insert({ user_id: state.admin.id, role: "admin", note: `verify ${TS}` });
  if (r1.error) throw r1.error;
  const r2 = await admin.from("tenant_members").insert([
    { tenant_id: test.id, user_id: state.tenantAdmin.id, role: "admin", status: "active" },
    { tenant_id: test.id, user_id: state.staff.id, role: "staff", status: "active" },
  ]);
  if (r2.error) throw r2.error;

  /* ₱150 of liability for the verification tenant, netted back to zero in afterAll. */
  const seed = await admin.from("tenant_ledger_entries").insert({
    tenant_id: test.id,
    entry_type: "adjustment_credit",
    liability_centavos: 15000,
    source: "verification",
    idempotency_key: state.seedKey,
    metadata: { purpose: "paymongo test disbursement verification", run: TS },
  });
  if (seed.error) throw seed.error;
});

afterAll(async () => {
  try {
    /* Net the ledger to zero: whatever is still available was seeded here. */
    const b = await balance(state.tenantId);
    if (b.available_centavos > 0) {
      await admin.from("tenant_ledger_entries").insert({
        tenant_id: state.tenantId,
        entry_type: "adjustment_debit",
        liability_centavos: -b.available_centavos,
        source: "verification",
        idempotency_key: `verify:paymongo-test:unseed:${TS}`,
        metadata: { reverses: state.seedKey, run: TS },
      });
    }
    if (state.proofPath) await admin.storage.from("payout-proofs").remove([state.proofPath]);
    const ids = [state.admin, state.tenantAdmin, state.staff, state.player]
      .filter(Boolean)
      .map((u) => u!.id);
    await admin.from("tenant_members").delete().in("user_id", ids);
    await admin.from("user_roles").delete().in("user_id", ids);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  } finally {
    // eslint-disable-next-line no-console
    console.log("\nVERIFICATION REPORT\n" + JSON.stringify(state.report, null, 2));
  }
});

describe("1. test wallet", () => {
  it("is detected by Court Connect with a source account, in test mode", async () => {
    const cfg = (await fns.adminGetDisbursementConfig({ context: ctx(state.admin!) })) as {
      mode: string;
      wallet: {
        id: string;
        status: string;
        account_number_masked: string | null;
        available_centavos: number | null;
      } | null;
      walletError: string | null;
    };
    state.report.wallet = cfg;
    expect(cfg.mode).toBe("test");
    expect(cfg.walletError).toBeNull();
    expect(cfg.wallet?.status).toBe("activated");
    expect(cfg.wallet?.account_number_masked).toMatch(/\d{4}$/);
    expect(cfg.wallet?.available_centavos ?? 0).toBeGreaterThan(0);
  });
});

describe("2. webhook configuration at PayMongo", () => {
  it("has a test-mode endpoint subscribed to both outward transfer events, with the payment events kept", async () => {
    const r = await fetch("https://api.paymongo.com/v1/webhooks", {
      headers: {
        Authorization: "Basic " + Buffer.from(`${ENV.PAYMONGO_SECRET_KEY}:`).toString("base64"),
      },
    });
    const j = (await r.json()) as {
      data: Array<{
        id: string;
        attributes: { status: string; livemode: boolean; url: string; events: string[] };
      }>;
    };
    const hooks = j.data.map((h) => ({ id: h.id, ...h.attributes }));
    state.report.webhooks = hooks;
    const ours = hooks.find(
      (h) => h.events.includes("transfer.outward.successful") && h.status === "enabled",
    );
    expect(ours).toBeDefined();
    expect(ours!.livemode).toBe(false);
    expect(ours!.events).toEqual(
      expect.arrayContaining([
        "transfer.outward.successful",
        "transfer.outward.failed",
        "checkout_session.payment.paid",
        "payment.failed",
        "payment.paid",
        "payment.refund.updated",
        "payment.refunded",
        "payout.deposited",
        "payout.returned",
      ]),
    );
  });

  it("the handler rejects an unsigned or badly signed delivery", async () => {
    expect(webhookPOST).toBeTypeOf("function");
    const res = await webhookPOST!({
      request: signedWebhook(
        `evt_bad_${TS}`,
        "transfer.outward.successful",
        { id: "tr_none", status: "succeeded", amount: 1 },
        { badSignature: true },
      ),
    });
    expect(res.status).toBe(401);
  });
});

describe("3. success path", () => {
  it("tenant requests a payout to the simulator's success number and it lands in Requested", async () => {
    const ta = state.tenantAdmin!;
    const acct = await ta.client.rpc("tenant_save_payout_account", {
      _account_type: "gcash",
      _account_name: "Simulator Success",
      _account_number: "999999990001",
    });
    expect(acct.error).toBeNull();
    const req = await ta.client.rpc("tenant_request_payout", { _amount_centavos: 10000 });
    expect(req.error).toBeNull();
    state.payoutA = Number((Array.isArray(req.data) ? req.data[0] : req.data)?.payout_id);
    expect(state.payoutA).toBeGreaterThan(0);

    const queue = (await fns.adminListDisbursementQueue({ context: ctx(state.admin!) })) as {
      payouts: Array<{ id: number; status: string; tenants?: { slug?: string } }>;
    };
    const row = queue.payouts.find((p) => p.id === state.payoutA);
    expect(row?.status).toBe("requested");
    expect(row?.tenants?.slug).toBe(TEST_TENANT_SLUG);
    const b = await balance(state.tenantId);
    expect(b.reserved_centavos).toBe(10000);
    expect(b.available_centavos).toBe(5000);
  });

  it("Send via PayMongo (TEST) submits a real sandbox transfer and stores the transfer id — not paid yet", async () => {
    const res = (await fns.adminSubmitPayouts({
      data: { provider: "paymongo", items: [{ payoutId: state.payoutA }] },
      context: ctx(state.admin!),
    })) as Array<{ ok: boolean; status: string; transferId?: string | null; error?: string }>;
    state.report.submitA = res[0];
    expect(res[0].ok, res[0].error).toBe(true);
    expect(["submitted", "settled_succeeded"]).toContain(res[0].status);
    expect(res[0].transferId).toMatch(/^tr_/);
    state.transferA = res[0].transferId!;

    const p = await payout(state.payoutA);
    expect(p.provider).toBe("paymongo");
    expect(p.provider_transfer_id).toBe(state.transferA);
    const [a] = await attempts(state.payoutA);
    expect(a.provider_transfer_id).toBe(state.transferA);
    expect(a.livemode).toBe(false);
    if (res[0].status === "submitted") {
      expect(p.status).toBe("processing");
      expect(a.status).toBe("pending");
      expect((await ledgerFor(state.payoutA)).some((e) => e.entry_type === "payout_paid")).toBe(
        false,
      );
    }
  });

  it("submitting the same payout again is refused while the transfer is in flight", async () => {
    const res = (await fns.adminSubmitPayouts({
      data: { provider: "paymongo", items: [{ payoutId: state.payoutA }] },
      context: ctx(state.admin!),
    })) as Array<{ ok: boolean; status: string; error?: string }>;
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toMatch(/in flight|already|final/i);
    expect((await attempts(state.payoutA)).length).toBe(1);
  });

  it("PayMongo settles the sandbox transfer as succeeded", async () => {
    const t = await pollTransfer(state.transferA);
    state.report.transferA = {
      id: t.id,
      status: t.status,
      reference_number: t.reference_number,
      provider_reference_number: t.provider_reference_number,
      fee: t.fee,
    };
    expect(t.status).toBe("succeeded");
  });

  it("the signed transfer.outward.successful webhook pays the payout exactly once, with ledger, audit and notification", async () => {
    const t = await pm.retrieveTransfer(state.transferA);
    const before = await balance(state.tenantId);
    const res = await webhookPOST!({
      request: signedWebhook(`evt_ok_${TS}`, "transfer.outward.successful", t),
    });
    expect(res.status).toBe(200);

    const p = await payout(state.payoutA);
    expect(p.status).toBe("paid");
    expect(p.completed_at).not.toBeNull();
    expect(p.paid_amount_centavos).toBe(10000);
    expect(p.transfer_reference).toBeTruthy();
    expect(p.provider_status).toBe("succeeded");

    const [a] = await attempts(state.payoutA);
    expect(a.status).toBe("succeeded");

    const led = await ledgerFor(state.payoutA);
    expect(led.filter((e) => e.entry_type === "payout_paid")).toHaveLength(1);
    const after = await balance(state.tenantId);
    expect(after.reserved_centavos).toBe(before.reserved_centavos - 10000);
    expect(after.paid_out_centavos).toBe(before.paid_out_centavos + 10000);
    expect(after.available_centavos).toBe(before.available_centavos);

    const ev = await providerEvents(state.payoutA);
    expect(ev.map((e) => e.outcome)).toEqual(["paid"]);
    const audit = await auditFor(state.payoutA);
    expect(audit.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        "payout.attempt_created",
        "payout.transfer_submitted",
        "payout.provider_succeeded",
      ]),
    );
    const notes = await notificationsFor(state.tenantAdmin!.id, startedAt);
    expect(notes.some((n) => n.type === "payout_paid")).toBe(true);
    state.report.successA = {
      payout: p.status,
      ledger: led,
      events: ev,
      audit: audit.map((x) => x.action),
      balanceAfter: after,
    };
  });

  it("duplicate success, a second success event, and a stale failure all leave the paid payout alone", async () => {
    const t = await pm.retrieveTransfer(state.transferA);
    const before = await balance(state.tenantId);
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_ok_${TS}`, "transfer.outward.successful", t),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_ok2_${TS}`, "transfer.outward.successful", t),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_stale_fail_${TS}`, "transfer.outward.failed", {
            ...t,
            status: "failed",
            provider_error: "stale",
            provider_error_code: "stale_test",
          }),
        })
      ).status,
    ).toBe(200);
    const p = await payout(state.payoutA);
    expect(p.status).toBe("paid");
    const led = await ledgerFor(state.payoutA);
    expect(led.filter((e) => e.entry_type === "payout_paid")).toHaveLength(1);
    expect(led.filter((e) => e.entry_type === "payout_released")).toHaveLength(0);
    expect(await balance(state.tenantId)).toEqual(before);
    const ev = await providerEvents(state.payoutA);
    expect(ev.map((e) => e.outcome)).toEqual([
      "paid",
      "ignored_already_succeeded",
      "ignored_already_succeeded",
    ]);
    state.report.idempotencyA = ev;
  });

  it("the tenant's Finance read shows the disbursement with provider, reference, masked destination and paid time", async () => {
    const rows = (await fns.listPayouts({ context: ctx(state.tenantAdmin!) })) as Array<
      Record<string, unknown>
    >;
    const row = rows.find((r) => r.id === state.payoutA)!;
    expect(row.provider).toBe("paymongo");
    expect(row.status).toBe("paid");
    expect(row.provider_transfer_id).toBe(state.transferA);
    expect(row.completed_at).toBeTruthy();
    expect(
      (row.destination_snapshot as { account_number_masked: string }).account_number_masked,
    ).toBe("••••••••0001");
    const bal = (await fns.getTenantBalance({ context: ctx(state.tenantAdmin!) })) as {
      paidOutCentavos: number;
      reservedCentavos: number;
    };
    expect(bal.paidOutCentavos).toBeGreaterThanOrEqual(10000);
    state.report.tenantFinanceA = { row, bal };
  });
});

describe("4. failure path", () => {
  it("a payout to the simulator's failure number is submitted; only one of two concurrent sends wins", async () => {
    const ta = state.tenantAdmin!;
    expect(
      (
        await ta.client.rpc("tenant_save_payout_account", {
          _account_type: "gcash",
          _account_name: "Simulator Failure",
          _account_number: "999999990002",
        })
      ).error,
    ).toBeNull();
    const req = await ta.client.rpc("tenant_request_payout", { _amount_centavos: 5000 });
    expect(req.error).toBeNull();
    state.payoutB = Number((Array.isArray(req.data) ? req.data[0] : req.data)?.payout_id);

    const [r1, r2] = (await Promise.all([
      fns.adminSubmitPayouts({
        data: { provider: "paymongo", items: [{ payoutId: state.payoutB }] },
        context: ctx(state.admin!),
      }),
      fns.adminSubmitPayouts({
        data: { provider: "paymongo", items: [{ payoutId: state.payoutB }] },
        context: ctx(state.admin!),
      }),
    ])) as Array<
      Array<{ ok: boolean; status: string; transferId?: string | null; error?: string }>
    >;
    const wins = [r1[0], r2[0]].filter((r) => r.ok);
    state.report.doubleSubmitB = [r1[0], r2[0]];
    expect(wins).toHaveLength(1);
    state.transferB = wins[0].transferId!;
    expect((await attempts(state.payoutB)).filter((a) => a.provider_transfer_id).length).toBe(1);
  });

  it("PayMongo settles it as failed with a provider error code", async () => {
    const t = await pollTransfer(state.transferB);
    state.report.transferB = {
      id: t.id,
      status: t.status,
      provider_error: t.provider_error,
      provider_error_code: t.provider_error_code,
    };
    expect(t.status).toBe("failed");
  });

  it("the signed transfer.outward.failed webhook fails the payout, releases the reservation once, keeps liability, audits and notifies", async () => {
    const t = await pm.retrieveTransfer(state.transferB);
    const before = await balance(state.tenantId);
    const failed = {
      ...t,
      provider_error: t.provider_error ?? "test_failed_number",
      provider_error_code: t.provider_error_code ?? "test_failed_number",
    };
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_fail_${TS}`, "transfer.outward.failed", failed),
        })
      ).status,
    ).toBe(200);

    const p = await payout(state.payoutB);
    expect(p.status).toBe("failed");
    expect(p.provider_error_code).toBeTruthy();
    expect(p.paid_amount_centavos).toBeNull();
    const [a] = await attempts(state.payoutB);
    expect(a.status).toBe("failed");
    expect(a.error_code).toBeTruthy();

    const led = await ledgerFor(state.payoutB);
    expect(led.filter((e) => e.entry_type === "payout_released")).toHaveLength(1);
    expect(led.some((e) => e.entry_type === "payout_paid")).toBe(false);
    const after = await balance(state.tenantId);
    expect(after.reserved_centavos).toBe(before.reserved_centavos - 5000);
    expect(after.available_centavos).toBe(before.available_centavos + 5000);
    expect(after.liability_centavos).toBe(before.liability_centavos);

    /* duplicate failure: nothing released twice */
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_fail_${TS}`, "transfer.outward.failed", failed),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_fail2_${TS}`, "transfer.outward.failed", failed),
        })
      ).status,
    ).toBe(200);
    expect(
      (await ledgerFor(state.payoutB)).filter((e) => e.entry_type === "payout_released"),
    ).toHaveLength(1);
    expect(await balance(state.tenantId)).toEqual(after);

    const ev = await providerEvents(state.payoutB);
    expect(ev.map((e) => e.outcome)).toEqual(["failed", "ignored_already_failed"]);
    const audit = await auditFor(state.payoutB);
    expect(audit.map((x) => x.action)).toContain("payout.provider_failed");
    const tenantNotes = await notificationsFor(state.tenantAdmin!.id, startedAt);
    expect(tenantNotes.some((n) => n.type === "payout_failed")).toBe(true);
    const adminNotes = await notificationsFor(state.admin!.id, startedAt);
    expect(adminNotes.some((n) => n.type === "payout_failed")).toBe(true);
    state.report.failureB = {
      payout: { status: p.status, code: p.provider_error_code, msg: p.provider_error_message },
      ledger: led,
      events: ev,
      audit: audit.map((x) => x.action),
      balanceAfter: after,
    };
  });

  it("a retry after the failure is a second, traceable attempt that re-reserves the money", async () => {
    const res = (await fns.adminSubmitPayouts({
      data: { provider: "paymongo", items: [{ payoutId: state.payoutB }] },
      context: ctx(state.admin!),
    })) as Array<{ ok: boolean; transferId?: string | null; error?: string }>;
    expect(res[0].ok, res[0].error).toBe(true);
    state.transferB2 = res[0].transferId!;
    const at = await attempts(state.payoutB);
    expect(at.map((a) => a.attempt_no)).toEqual([1, 2]);
    expect(at[0].status).toBe("failed");
    expect(at[1].provider_transfer_id).toBe(state.transferB2);
    const led = await ledgerFor(state.payoutB);
    expect(led.some((e) => e.idempotency_key === `payout:reserved:${state.payoutB}:a2`)).toBe(true);
    expect((await balance(state.tenantId)).reserved_centavos).toBe(5000);

    const t = await pollTransfer(state.transferB2);
    expect(t.status).toBe("failed");
    const failed = {
      ...t,
      provider_error: t.provider_error ?? "test_failed_number",
      provider_error_code: t.provider_error_code ?? "test_failed_number",
    };
    expect(
      (
        await webhookPOST!({
          request: signedWebhook(`evt_fail_retry_${TS}`, "transfer.outward.failed", failed),
        })
      ).status,
    ).toBe(200);
    const led2 = await ledgerFor(state.payoutB);
    expect(led2.some((e) => e.idempotency_key === `payout:released:${state.payoutB}:a2`)).toBe(
      true,
    );
    expect((await balance(state.tenantId)).reserved_centavos).toBe(0);
    state.report.retryB = {
      attempts: (await attempts(state.payoutB)).map((a) => ({
        n: a.attempt_no,
        status: a.status,
        transfer: a.provider_transfer_id,
        error: a.error_code,
      })),
      ledger: led2,
    };
  });
});

describe("5. manual fallback", () => {
  it("an admin can upload a disbursement proof and record a manual payout; the tenant sees the reference and proof", async () => {
    const ta = state.tenantAdmin!;
    const req = await ta.client.rpc("tenant_request_payout", { _amount_centavos: 3000 });
    expect(req.error).toBeNull();
    state.payoutC = Number((Array.isArray(req.data) ? req.data[0] : req.data)?.payout_id);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    state.proofPath = `${state.tenantId}/disbursements/${state.payoutC}-${TS}.png`;
    const up = await state
      .admin!.client.storage.from("payout-proofs")
      .upload(state.proofPath, png, { contentType: "image/png" });
    expect(up.error).toBeNull();

    const before = await balance(state.tenantId);
    const r = (await fns.adminRecordManualPayout({
      data: {
        payoutId: state.payoutC,
        method: "GCash",
        reference: `VERIFY-MANUAL-${TS}`,
        paidAmountCentavos: 3000,
        proofPath: state.proofPath,
        notes: "live verification",
      },
      context: ctx(state.admin!),
    })) as { attemptId: number };
    expect(r.attemptId).toBeGreaterThan(0);

    const p = await payout(state.payoutC);
    expect(p.status).toBe("paid");
    expect(p.provider).toBe("manual");
    expect(p.transfer_reference).toBe(`VERIFY-MANUAL-${TS}`);
    expect(p.proof_path).toBe(state.proofPath);
    expect(p.completed_by).toBe(state.admin!.id);
    expect(p.completed_at).toBeTruthy();
    const after = await balance(state.tenantId);
    expect(after.paid_out_centavos).toBe(before.paid_out_centavos + 3000);
    expect(after.reserved_centavos).toBe(before.reserved_centavos - 3000);
    expect((await auditFor(state.payoutC)).map((x) => x.action)).toContain("payout.manual_paid");
    expect(
      (await notificationsFor(ta.id, startedAt)).filter((n) => n.type === "payout_paid").length,
    ).toBeGreaterThanOrEqual(2);

    const rows = (await fns.listPayouts({ context: ctx(ta) })) as Array<Record<string, unknown>>;
    const row = rows.find((x) => x.id === state.payoutC)!;
    expect(row.proof_path).toBe(state.proofPath);
    const signed = await ta.client.storage
      .from("payout-proofs")
      .createSignedUrl(state.proofPath, 60);
    expect(signed.error).toBeNull();
    state.report.manualC = {
      status: p.status,
      reference: p.transfer_reference,
      proof: p.proof_path,
      completed_by: p.completed_by,
    };
  });
});

describe("6. security", () => {
  it("a player and tenant staff cannot open a provider attempt; a tenant admin cannot run the admin submit", async () => {
    for (const u of [state.player!, state.staff!, state.tenantAdmin!]) {
      const r = await u.client.rpc("admin_begin_payout_attempt", {
        _payout_id: state.payoutA,
        _provider: "manual",
      });
      expect(r.error?.message).toMatch(/platform admin/i);
    }
    await expect(
      fns.adminSubmitPayouts({
        data: { provider: "paymongo", items: [{ payoutId: state.payoutA }] },
        context: ctx(state.tenantAdmin!),
      }),
    ).rejects.toThrow(/platform admin/i);
    await expect(fns.adminGetDisbursementConfig({ context: ctx(state.player!) })).rejects.toThrow(
      /platform admin/i,
    );
  });

  it("tenant isolation: the verification tenant's admin sees only its own payouts, attempts and balances; a player sees none", async () => {
    const ta = state.tenantAdmin!;
    const mine = await ta.client.from("tenant_payouts").select("id, tenant_id");
    expect(mine.error).toBeNull();
    expect(mine.data!.length).toBeGreaterThan(0);
    expect(mine.data!.every((r) => r.tenant_id === state.tenantId)).toBe(true);
    const att = await ta.client.from("tenant_payout_attempts").select("tenant_id");
    expect(att.data!.every((r) => r.tenant_id === state.tenantId)).toBe(true);
    const overview = (await fns.adminListTenantOverview({ context: ctx(ta) })) as Array<{
      tenant_id: string;
    }>;
    expect(overview.map((o) => o.tenant_id)).toEqual([state.tenantId]);
    const ev = await ta.client.from("payout_provider_events").select("id");
    expect(ev.data ?? []).toHaveLength(0);

    const pl = state.player!;
    expect((await pl.client.from("tenant_payouts").select("id")).data).toHaveLength(0);
    expect((await pl.client.from("tenant_balances").select("tenant_id")).data).toHaveLength(0);
    expect((await pl.client.from("tenant_payout_attempts").select("id")).data).toHaveLength(0);
  });

  it("another tenant's proof cannot be signed by an outsider, and the platform admin sees every tenant", async () => {
    const { data: other } = await admin
      .from("tenant_payouts")
      .select("proof_path")
      .eq("tenant_id", state.businessTenantId)
      .not("proof_path", "is", null)
      .limit(1)
      .maybeSingle();
    if (other?.proof_path) {
      const a = await state
        .tenantAdmin!.client.storage.from("payout-proofs")
        .createSignedUrl(other.proof_path, 60);
      expect(a.error).not.toBeNull();
      const b = await state
        .player!.client.storage.from("payout-proofs")
        .createSignedUrl(other.proof_path, 60);
      expect(b.error).not.toBeNull();
      const c = await state
        .admin!.client.storage.from("payout-proofs")
        .createSignedUrl(other.proof_path, 60);
      expect(c.error).toBeNull();
    }
    const all = (await fns.adminListTenantOverview({ context: ctx(state.admin!) })) as Array<{
      tenant_id: string;
    }>;
    expect(all.map((o) => o.tenant_id).sort()).toEqual(
      [state.tenantId, state.businessTenantId].sort(),
    );
  });

  it("the business tenant's balances are exactly what they were before this run", async () => {
    expect(await balance(state.businessTenantId)).toEqual(state.businessBefore);
  });
});
