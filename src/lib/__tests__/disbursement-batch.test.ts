/**
 * Batch submission is a loop over independent disbursements.
 *
 * `adminSubmitPayouts` is driven here with the TanStack server-function
 * wrapper, the auth middleware, the Supabase admin client and the PayMongo
 * client all replaced, so what runs is the orchestration itself: which RPC is
 * called when, in what order relative to the provider call, and — the point —
 * that one item's failure leaves its siblings' state untouched.
 *
 * The database functions the RPCs stand for are covered by the migration
 * tests and by live verification; this pins the server's side of the contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* --- server-function wrapper: call the handler directly ------------------- */
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validator: ((d: unknown) => unknown) | null = null;
    const builder = {
      middleware: () => builder,
      inputValidator: (v: (d: unknown) => unknown) => {
        validator = v;
        return builder;
      },
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (args: { data?: unknown; context: unknown }) =>
          h({ data: validator ? validator(args.data) : args.data, context: args.context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

/* --- PayMongo: programmable per test -------------------------------------- */
class PaymongoRequestError extends Error {
  status: number;
  code: string | null;
  detail: string;
  constructor(status: number, code: string | null, detail: string) {
    super(`PayMongo error ${status}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
const pm = {
  listWallets: vi.fn(),
  listReceivingInstitutions: vi.fn(),
  createOutwardTransfer: vi.fn(),
  retrieveTransfer: vi.fn(),
  paymongoMode: () => "test" as const,
  PaymongoRequestError,
};
vi.mock("@/lib/paymongo.server", () => pm);

const settle = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: (...a: unknown[]) => settle(...a) },
}));

const { adminSubmitPayouts } = await import("@/lib/payouts.functions");
/* With createServerFn mocked above, the export IS the handler: it takes the
   data and the context directly. The real type describes the client-side
   fetcher, so it is widened here rather than pretending otherwise. */
type SubmitResult = import("@/lib/payouts.functions").SubmitResult;
const submit = adminSubmitPayouts as unknown as (args: {
  data: unknown;
  context: unknown;
}) => Promise<SubmitResult[]>;

/* --- a tiny Supabase double ----------------------------------------------- */
type Row = Record<string, unknown>;
function makeSupabase(opts: {
  payouts: Row[];
  accounts: Row[];
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => { data?: unknown; error?: { message: string } | null };
}) {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name === "is_courthub_admin") return Promise.resolve({ data: true, error: null });
    return Promise.resolve({ error: null, ...opts.rpc(name, args) });
  });
  const from = (table: string) => {
    const rows =
      table === "tenant_payouts"
        ? opts.payouts
        : table === "tenant_payout_accounts"
          ? opts.accounts
          : [];
    let filtered = rows;
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        filtered = filtered.filter((r) => r[col] === v);
        return q;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
    };
    return q;
  };
  return { rpc, from };
}

const WALLET = [
  {
    id: "w",
    status: "activated",
    is_default: true,
    livemode: false,
    account: { account_number: "0001", account_name: "CC" },
  },
];
const INSTITUTIONS = [
  {
    id: "1",
    attributes: {
      name: "G-XCHANGE, INC. (GCASH)",
      provider: "instapay",
      provider_code: "GXCHPHM2XXX",
    },
  },
];

const payout = (id: number, accountId = id) => ({
  id,
  tenant_id: `tenant-${id}`,
  amount_centavos: 10_000 * id,
  status: "requested",
  destination_snapshot: { account_id: accountId },
  tenants: { name: `Tenant ${id}` },
});
const account = (id: number) => ({
  id,
  account_type: "gcash",
  account_name: "Owner",
  account_number: "09171234567",
  bank_name: null,
  paymongo_bic: null,
});

/** Records every RPC as {name, args} and answers begin/submitted/failed. */
function recordingRpc(log: Array<{ name: string; args: Record<string, unknown> }>) {
  let attemptSeq = 100;
  return (name: string, args: Record<string, unknown>) => {
    log.push({ name, args });
    if (name === "admin_begin_payout_attempt") {
      attemptSeq += 1;
      return { data: [{ attempt_id: attemptSeq, attempt_no: 1, amount_centavos: 0 }] };
    }
    if (name === "admin_request_recurring_payout") return { data: [{ payout_id: 900 }] };
    return { data: null };
  };
}

beforeEach(() => {
  pm.listWallets.mockReset().mockResolvedValue(WALLET);
  pm.listReceivingInstitutions.mockReset().mockResolvedValue(INSTITUTIONS);
  pm.createOutwardTransfer.mockReset();
  settle.mockReset();
});

describe("three selected payouts are three independent attempts", () => {
  it("opens one attempt, makes one provider call and records one submission per payout", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1), payout(2), payout(3)],
      accounts: [account(1), account(2), account(3)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockImplementation(
      async (body: { metadata: { payout_id: string } }) => ({
        batchId: `batch_${body.metadata.payout_id}`,
        transfer: {
          id: `tr_${body.metadata.payout_id}`,
          status: "pending",
          provider: "instapay",
          amount: 1,
          currency: "PHP",
          livemode: false,
        },
      }),
    );

    const results = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }, { payoutId: 2 }, { payoutId: 3 }] },
      context: { supabase, userId: "admin-1" },
    });

    expect(results.map((r) => r.status)).toEqual(["submitted", "submitted", "submitted"]);
    expect(results.map((r) => r.transferId)).toEqual(["tr_1", "tr_2", "tr_3"]);
    expect(pm.createOutwardTransfer).toHaveBeenCalledTimes(3);
    expect(log.filter((l) => l.name === "admin_begin_payout_attempt")).toHaveLength(3);
    expect(log.filter((l) => l.name === "admin_mark_payout_attempt_submitted")).toHaveLength(3);
    /* Nothing was marked paid: acceptance is not payment. */
    expect(settle).not.toHaveBeenCalled();
    expect(log.some((l) => l.name === "admin_transition_payout")).toBe(false);
  });

  it("the attempt is opened BEFORE the provider is called, and the submission recorded AFTER", async () => {
    const order: string[] = [];
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: (name) => {
        order.push(name);
        if (name === "admin_begin_payout_attempt")
          return { data: [{ attempt_id: 5, attempt_no: 1 }] };
        return { data: null };
      },
    });
    pm.createOutwardTransfer.mockImplementation(async () => {
      order.push("paymongo");
      return {
        batchId: "b",
        transfer: {
          id: "tr_1",
          status: "pending",
          provider: "instapay",
          amount: 1,
          currency: "PHP",
        },
      };
    });
    await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }] },
      context: { supabase, userId: "a" },
    });
    expect(order).toEqual([
      "admin_begin_payout_attempt",
      "paymongo",
      "admin_mark_payout_attempt_submitted",
    ]);
  });
});

describe("one failure does not corrupt its siblings", () => {
  it("a PayMongo refusal fails only that attempt; the others are submitted", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1), payout(2), payout(3)],
      accounts: [account(1), account(2), account(3)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockImplementation(
      async (body: { metadata: { payout_id: string } }) => {
        if (body.metadata.payout_id === "2")
          throw new PaymongoRequestError(
            400,
            "insufficient_balance",
            "Wallet balance is insufficient.",
          );
        return {
          batchId: "b",
          transfer: {
            id: `tr_${body.metadata.payout_id}`,
            status: "pending",
            provider: "instapay",
            amount: 1,
            currency: "PHP",
          },
        };
      },
    );

    const results = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }, { payoutId: 2 }, { payoutId: 3 }] },
      context: { supabase, userId: "a" },
    });

    expect(results.map((r) => [r.payoutId, r.ok, r.status])).toEqual([
      [1, true, "submitted"],
      [2, false, "failed"],
      [3, true, "submitted"],
    ]);
    expect(results[1].error).toMatch(/insufficient_balance/);
    const failed = log.filter((l) => l.name === "admin_mark_payout_attempt_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].args._error_code).toBe("insufficient_balance");
    expect(log.filter((l) => l.name === "admin_mark_payout_attempt_submitted")).toHaveLength(2);
  });

  it("a destination that cannot be mapped is blocked BEFORE any attempt is opened", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1), payout(2)],
      accounts: [account(1), { ...account(2), account_type: "bank", bank_name: "Bank of Nowhere" }],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockResolvedValue({
      batchId: "b",
      transfer: { id: "tr_1", status: "pending", provider: "instapay", amount: 1, currency: "PHP" },
    });

    const results = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }, { payoutId: 2 }] },
      context: { supabase, userId: "a" },
    });

    expect(results[0].status).toBe("submitted");
    expect(results[1].status).toBe("blocked");
    expect(results[1].needsMapping?.accountId).toBe(2);
    /* Payout 2 was never touched: no attempt, no provider call for it. */
    expect(
      log.filter((l) => l.name === "admin_begin_payout_attempt").map((l) => l.args._payout_id),
    ).toEqual([1]);
    expect(pm.createOutwardTransfer).toHaveBeenCalledTimes(1);
  });

  it("no answer from PayMongo marks nothing: the attempt stays submitting for reconciliation", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockRejectedValue(new Error("socket hang up"));

    const [r] = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }] },
      context: { supabase, userId: "a" },
    });

    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/Reconcile attempt/);
    expect(log.some((l) => l.name === "admin_mark_payout_attempt_failed")).toBe(false);
    expect(log.some((l) => l.name === "admin_mark_payout_attempt_submitted")).toBe(false);
  });

  it("a database refusal on one payout is reported for that payout and the loop continues", async () => {
    const supabase = makeSupabase({
      payouts: [payout(1), payout(2)],
      accounts: [account(1), account(2)],
      rpc: (name, args) => {
        if (name === "admin_begin_payout_attempt" && args._payout_id === 1)
          return { error: { message: "Payout 1 already has a transfer in flight" } };
        if (name === "admin_begin_payout_attempt")
          return { data: [{ attempt_id: 7, attempt_no: 1 }] };
        return { data: null };
      },
    });
    pm.createOutwardTransfer.mockResolvedValue({
      batchId: "b",
      transfer: { id: "tr_2", status: "pending", provider: "instapay", amount: 1, currency: "PHP" },
    });
    const results = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }, { payoutId: 2 }] },
      context: { supabase, userId: "a" },
    });
    expect(results[0]).toMatchObject({ ok: false, status: "failed" });
    expect(results[0].error).toMatch(/in flight/);
    expect(results[1]).toMatchObject({ ok: true, status: "submitted", transferId: "tr_2" });
  });
});

describe("the provider's own answer is not treated as payment", () => {
  it("a pending transfer is 'submitted'; nothing settles until the webhook", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockResolvedValue({
      batchId: "b",
      transfer: { id: "tr_1", status: "pending", provider: "instapay", amount: 1, currency: "PHP" },
    });
    const [r] = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }] },
      context: { supabase, userId: "a" },
    });
    expect(r.status).toBe("submitted");
    expect(settle).not.toHaveBeenCalled();
  });

  it("an immediately terminal answer is settled through the same idempotent RPC the webhook uses", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockResolvedValue({
      batchId: "b",
      transfer: {
        id: "tr_1",
        status: "succeeded",
        provider: "instapay",
        amount: 1,
        currency: "PHP",
      },
    });
    settle.mockResolvedValue({ data: "paid", error: null });
    const [r] = await submit({
      data: { provider: "paymongo", items: [{ payoutId: 1 }] },
      context: { supabase, userId: "a" },
    });
    expect(r.status).toBe("settled_succeeded");
    expect(settle).toHaveBeenCalledWith(
      "payout_provider_settle",
      expect.objectContaining({
        _provider_transfer_id: "tr_1",
        _outcome: "succeeded",
        _event_id: "sync:tr_1:succeeded",
      }),
    );
  });
});

describe("manual and recurring", () => {
  it("manual opens a manual attempt and calls no provider", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: recordingRpc(log),
    });
    const [r] = await submit({
      data: { provider: "manual", items: [{ payoutId: 1 }] },
      context: { supabase, userId: "a" },
    });
    expect(r.status).toBe("awaiting_manual");
    expect(log.map((l) => l.name)).toEqual(["admin_begin_payout_attempt"]);
    expect(log[0].args._provider).toBe("manual");
    expect(pm.listWallets).not.toHaveBeenCalled();
  });

  it("a recurring-due tenant is reserved through admin_request_recurring_payout first, then submitted", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = makeSupabase({
      payouts: [{ ...payout(900), amount_centavos: 55_00 }],
      accounts: [account(900)],
      rpc: recordingRpc(log),
    });
    pm.createOutwardTransfer.mockResolvedValue({
      batchId: "b",
      transfer: {
        id: "tr_900",
        status: "pending",
        provider: "instapay",
        amount: 5500,
        currency: "PHP",
      },
    });
    const [r] = await submit({
      data: {
        provider: "paymongo",
        items: [{ tenantId: "2b8f4c1e-9d3a-4b6e-8f1a-0c2d3e4f5a6b", amountCentavos: 5500 }],
      },
      context: { supabase, userId: "a" },
    });
    expect(r.payoutId).toBe(900);
    expect(r.status).toBe("submitted");
    expect(log.map((l) => l.name)).toEqual([
      "admin_request_recurring_payout",
      "admin_begin_payout_attempt",
      "admin_mark_payout_attempt_submitted",
    ]);
  });
});

describe("authority", () => {
  it("refuses a caller the database does not call an admin before doing anything", async () => {
    const supabase = makeSupabase({
      payouts: [payout(1)],
      accounts: [account(1)],
      rpc: () => ({ data: null }),
    });
    supabase.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "is_courthub_admin" ? { data: false, error: null } : { data: null, error: null },
      ),
    );
    await expect(
      submit({
        data: { provider: "paymongo", items: [{ payoutId: 1 }] },
        context: { supabase, userId: "player" },
      }),
    ).rejects.toThrow(/platform admin/);
    expect(pm.listWallets).not.toHaveBeenCalled();
    expect(pm.createOutwardTransfer).not.toHaveBeenCalled();
  });
});
