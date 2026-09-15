/** Server functions for tenant finance: balances, payout account, payout
 *  requests, and the admin disbursement transitions.
 *
 *  Every one of these is a thin forwarder. The authorisation, the balance
 *  arithmetic and the locking all live in SECURITY DEFINER functions in the
 *  database, because those are the only places that can be trusted: a server
 *  function is still code a request reaches, and the rule that two payout
 *  requests cannot reserve the same peso has to hold against two requests
 *  arriving at the same instant on different instances.
 *
 *  So nothing here computes a balance, and nothing here decides whether a
 *  transition is allowed. It validates shapes and forwards.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { balanceFromRow, type TenantBalance, type TenantBalanceRow } from "@/lib/ledger";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  mapDestination,
  railForAmount,
  recurringStatus,
  buildTransferRequest,
  isAttemptOpen,
  transferReference,
  referenceMatches,
  PAYMONGO_WALLET_BIC,
  type PayoutProvider,
  type ReceivingInstitution,
  type RecurringStatus,
} from "@/lib/payout-providers";

/* ------------------------------------------------------------- balances -- */

export const getTenantBalance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TenantBalance> => {
    const { supabase } = context;
    /* No tenant filter here on purpose: `tenant_balances` is a security_invoker
       view over an RLS-protected table, so this returns the caller's own row and
       nothing else. Filtering by a tenant id supplied from the client would be
       the weaker check, not the stronger one. */
    const { data, error } = await supabase.from("tenant_balances").select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return balanceFromRow(data as TenantBalanceRow | null);
  });

export const getTenantLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(1000).default(50),
        /** ISO instants. Both optional: absent means "since the beginning". */
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    /* RLS scopes this to the caller's own tenant, so there is no tenant filter
       here and none should be added: one supplied by the client would be the
       weaker check. */
    let q = supabase
      .from("tenant_ledger_entries")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.from) q = q.gte("created_at", data.from);
    if (data.to) q = q.lt("created_at", data.to);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/* ------------------------------------------------------- payout account -- */

const AccountInput = z.object({
  accountType: z.enum(["gcash", "maya", "bank", "other_ewallet", "other"]),
  accountName: z.string().trim().min(1).max(120),
  accountNumber: z.string().trim().max(64).optional(),
  bankName: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(500).optional(),
  proofPath: z.string().trim().max(400).optional(),
});

export const savePayoutAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AccountInput.parse(d))
  .handler(async ({ data, context }): Promise<{ accountId: number }> => {
    const { supabase } = context;
    const { data: id, error } = await supabase.rpc("tenant_save_payout_account", {
      _account_type: data.accountType,
      _account_name: data.accountName,
      _account_number: data.accountNumber ?? null,
      _bank_name: data.bankName ?? null,
      _instructions: data.instructions ?? null,
      _proof_path: data.proofPath ?? null,
    });
    if (error) throw new Error(error.message);
    return { accountId: Number(id) };
  });

export const getPayoutAccount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    /* RLS on this table requires is_tenant_admin(), so a manager or a member of
       staff signed into the same workspace gets no row rather than a redacted
       one. That is the intended answer: they should not know the number exists. */
    const { data, error } = await supabase
      .from("tenant_payout_accounts")
      .select("*")
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

/** A signed, short-lived URL for the QR or proof image. The object lives in a
 *  private bucket, so there is no public URL to leak and a copied link expires. */
export const getPayoutProofUrl = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ path: z.string().min(1).max(400) }).parse(d))
  .handler(async ({ data, context }): Promise<{ url: string | null }> => {
    const { supabase } = context;
    const { data: signed, error } = await supabase.storage
      .from("payout-proofs")
      .createSignedUrl(data.path, 60);
    if (error) return { url: null };
    return { url: signed?.signedUrl ?? null };
  });

/* ------------------------------------------------------ payout requests -- */

export const requestPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ amountCentavos: z.number().int().positive() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase.rpc("tenant_request_payout", {
      _amount_centavos: data.amountCentavos,
    });
    if (error) {
      /* The database refuses an over-request under its advisory lock. Surfacing
         its wording rather than a generic failure matters here: the tenant needs
         to know the balance moved, not that "something went wrong". */
      throw new Error(error.message || "Could not request the payout.");
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      payoutId: Number(row?.payout_id),
      reservedCentavos: Number(row?.reserved_centavos),
      remainingAvailableCentavos: Number(row?.remaining_available_centavos),
    };
  });

export const cancelPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ payoutId: z.number().int().positive() }).parse(d))
  .handler(async ({ data, context }): Promise<{ status: string }> => {
    const { supabase } = context;
    const { data: status, error } = await supabase.rpc("tenant_cancel_payout", {
      _payout_id: data.payoutId,
    });
    if (error) throw new Error(error.message);
    return { status: String(status) };
  });

export const listPayouts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("tenant_payouts")
      .select("*")
      .order("requested_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/* ------------------------------------------------- admin disbursements -- */

export const adminListPayouts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ status: z.string().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    /* RLS already restricts this to platform admins. An ordinary tenant admin
       calling it sees only their own rows, which is the correct answer rather
       than an error. */
    let q = supabase
      .from("tenant_payouts")
      .select("*, tenants(name, slug)")
      .order("requested_at", { ascending: false })
      .limit(200);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

const TransitionInput = z.object({
  payoutId: z.number().int().positive(),
  toStatus: z.enum(["under_review", "approved", "processing", "paid", "rejected", "failed"]),
  transferReference: z.string().trim().max(120).optional(),
  transferMethod: z.string().trim().max(60).optional(),
  proofPath: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const adminTransitionPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => TransitionInput.parse(d))
  .handler(async ({ data, context }): Promise<{ status: string }> => {
    const { supabase } = context;
    const { data: status, error } = await supabase.rpc("admin_transition_payout", {
      _payout_id: data.payoutId,
      _to_status: data.toStatus,
      _transfer_reference: data.transferReference ?? null,
      _transfer_method: data.transferMethod ?? null,
      _proof_path: data.proofPath ?? null,
      _notes: data.notes ?? null,
      _reason: data.reason ?? null,
    });
    if (error) throw new Error(error.message);
    return { status: String(status) };
  });

export const adminListTenantBalances = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("tenant_balances")
      .select("*")
      .order("liability_centavos", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as TenantBalanceRow[];
  });

/* ------------------------------------------- admin: one tenant in detail -- */

/** Everything the admin tenant page shows, fetched together.
 *
 *  One function rather than six, so the tabs cannot drift into asking slightly
 *  different questions about the same business. Every figure still comes from
 *  `tenant_balances` — the same view the tenant's own Finance screen reads — so
 *  an admin and a tenant can never be shown different balances.
 */
export const adminGetTenantDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const tid = data.tenantId;

    /* RLS does the authorising. A tenant admin asking about their own business
       gets it; anyone else gets empty rows rather than an error, which is the
       correct answer to "does this tenant exist?" from someone not entitled to
       know. */
    const [tenant, balance, payouts, account, accountEvents, ledger, venues] = await Promise.all([
      supabase.from("tenants").select("id, name, slug, created_at").eq("id", tid).maybeSingle(),
      supabase.from("tenant_balances").select("*").eq("tenant_id", tid).maybeSingle(),
      supabase
        .from("tenant_payouts")
        .select("*")
        .eq("tenant_id", tid)
        .order("requested_at", { ascending: false })
        .limit(50),
      supabase
        .from("tenant_payout_accounts")
        .select("*")
        .eq("tenant_id", tid)
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("tenant_payout_account_events")
        .select("*")
        .eq("tenant_id", tid)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("tenant_ledger_entries")
        .select("*")
        .eq("tenant_id", tid)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("venues").select("id, name, is_active").eq("tenant_id", tid).order("name"),
    ]);

    return {
      tenant: tenant.data ?? null,
      balance: balanceFromRow(balance.data as TenantBalanceRow | null),
      payouts: payouts.data ?? [],
      account: account.data ?? null,
      accountEvents: accountEvents.data ?? [],
      ledger: ledger.data ?? [],
      venues: venues.data ?? [],
    };
  });

/** Payout lifecycle events for one payout, for the audit tab. */
export const adminGetPayoutEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("tenant_payout_events")
      .select("*")
      .eq("tenant_id", data.tenantId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/* ------------------------------------------- admin: the tenants overview -- */

/** Every server function below re-checks the caller is a platform admin
 *  through the database, not through anything the request claims. The RPCs
 *  do it themselves; the read-only PayMongo calls (wallet, institutions) have
 *  no RPC in front of them, so they ask first. */
async function assertCourthubAdmin(supabase: {
  rpc: (
    fn: "is_courthub_admin",
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): Promise<void> {
  const { data, error } = await supabase.rpc("is_courthub_admin");
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("Only a platform admin may do this");
}

export type TenantOverviewRow = TenantBalanceRow & {
  venue_count: number;
  frequency: string;
  schedule_set_at: string | null;
  last_paid_at: string | null;
  has_account: boolean;
  account_type: string | null;
  account_id: number | null;
  paymongo_bic: string | null;
  open_payout: { id: number; status: string; amount_centavos: number; request_type: string } | null;
  recurring: Omit<RecurringStatus, "nextDueAt"> & { nextDueAt: string | null };
};

/** Everything the Tenants page and the recurring-due queue need, in one read.
 *  Balances still come only from `tenant_balances`; the rest is joined here in
 *  memory from tables the admin is allowed to read, and the due computation is
 *  the pure `recurringStatus`. */
async function loadTenantOverview(
  supabase: SupabaseClient<Database>,
): Promise<TenantOverviewRow[]> {
  const [balances, prefs, venues, open, paid, accounts] = await Promise.all([
    supabase.from("tenant_balances").select("*").order("liability_centavos", { ascending: false }),
    supabase.from("tenant_payout_preferences").select("tenant_id, frequency, updated_at"),
    supabase.from("venues").select("tenant_id"),
    supabase
      .from("tenant_payouts")
      .select("id, tenant_id, status, amount_centavos, request_type")
      .in("status", ["requested", "under_review", "approved", "processing"]),
    supabase
      .from("tenant_payouts")
      .select("tenant_id, completed_at")
      .eq("status", "paid")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(2000),
    supabase
      .from("tenant_payout_accounts")
      .select("id, tenant_id, account_type, paymongo_bic")
      .eq("is_active", true),
  ]);
  for (const r of [balances, prefs, open, paid, accounts]) {
    if (r.error) throw new Error(r.error.message);
  }
  /* Venues may be unreadable to an admin under a stricter policy; a count of
     zero is the honest fallback, an error would hide the whole page. */
  const venueCount = new Map<string, number>();
  for (const v of (venues.data ?? []) as Array<{ tenant_id: string | null }>) {
    if (!v.tenant_id) continue;
    venueCount.set(v.tenant_id, (venueCount.get(v.tenant_id) ?? 0) + 1);
  }
  const pref = new Map<string, { frequency: string; updated_at: string }>();
  for (const p of (prefs.data ?? []) as Array<{
    tenant_id: string;
    frequency: string;
    updated_at: string;
  }>) {
    pref.set(p.tenant_id, p);
  }
  const openBy = new Map<string, TenantOverviewRow["open_payout"]>();
  for (const p of (open.data ?? []) as Array<
    NonNullable<TenantOverviewRow["open_payout"]> & { tenant_id: string }
  >) {
    if (!openBy.has(p.tenant_id))
      openBy.set(p.tenant_id, {
        id: p.id,
        status: p.status,
        amount_centavos: p.amount_centavos,
        request_type: p.request_type,
      });
  }
  const lastPaid = new Map<string, string>();
  for (const p of (paid.data ?? []) as Array<{ tenant_id: string; completed_at: string }>) {
    if (!lastPaid.has(p.tenant_id)) lastPaid.set(p.tenant_id, p.completed_at);
  }
  const acct = new Map<string, { id: number; account_type: string; paymongo_bic: string | null }>();
  for (const a of (accounts.data ?? []) as Array<{
    id: number;
    tenant_id: string;
    account_type: string;
    paymongo_bic: string | null;
  }>) {
    acct.set(a.tenant_id, a);
  }
  const now = new Date();
  return ((balances.data ?? []) as TenantBalanceRow[]).map((b) => {
    const p = pref.get(b.tenant_id);
    const a = acct.get(b.tenant_id);
    const bal = balanceFromRow(b);
    const rec = recurringStatus({
      frequency: p?.frequency ?? "manual",
      lastPaidAt: lastPaid.get(b.tenant_id) ?? null,
      scheduleSetAt: p?.updated_at ?? null,
      availableCentavos: bal.availableCentavos,
      hasOpenPayout: openBy.has(b.tenant_id),
      hasPayoutAccount: !!a,
      now,
    });
    return {
      ...b,
      venue_count: venueCount.get(b.tenant_id) ?? 0,
      frequency: p?.frequency ?? "manual",
      schedule_set_at: p?.updated_at ?? null,
      last_paid_at: lastPaid.get(b.tenant_id) ?? null,
      has_account: !!a,
      account_type: a?.account_type ?? null,
      account_id: a?.id ?? null,
      paymongo_bic: a?.paymongo_bic ?? null,
      open_payout: openBy.get(b.tenant_id) ?? null,
      recurring: { ...rec, nextDueAt: rec.nextDueAt ? rec.nextDueAt.toISOString() : null },
    };
  });
}

export const adminListTenantOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadTenantOverview(context.supabase));

/* ------------------------------------------ admin: the disbursement queue -- */

export type PayoutAttemptRow = {
  id: number;
  payout_id: number;
  tenant_id: string;
  attempt_no: number;
  provider: string;
  status: string;
  amount_centavos: number;
  provider_transfer_id: string | null;
  provider_batch_id: string | null;
  provider_reference_number: string | null;
  provider_status: string | null;
  provider_rail: string | null;
  destination_bic: string | null;
  livemode: boolean | null;
  error_code: string | null;
  error_message: string | null;
  provider_metadata: Json;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  completed_at: string | null;
};

export const adminListDisbursementQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const [payouts, overview] = await Promise.all([
      supabase
        .from("tenant_payouts")
        .select("*, tenants(name, slug)")
        .order("requested_at", { ascending: false })
        .limit(400),
      loadTenantOverview(supabase),
    ]);
    if (payouts.error) throw new Error(payouts.error.message);
    const rows = payouts.data ?? [];
    const ids = rows.map((r) => r.id);
    let attempts: PayoutAttemptRow[] = [];
    if (ids.length > 0) {
      const a = await supabase
        .from("tenant_payout_attempts")
        .select("*")
        .in("payout_id", ids)
        .order("created_at", { ascending: false });
      if (a.error) throw new Error(a.error.message);
      attempts = (a.data ?? []) as PayoutAttemptRow[];
    }
    const byPayout = new Map<number, PayoutAttemptRow[]>();
    for (const a of attempts) {
      const list = byPayout.get(a.payout_id) ?? [];
      list.push(a);
      byPayout.set(a.payout_id, list);
    }
    const overviewBy = new Map(overview.map((o) => [o.tenant_id, o]));
    return {
      payouts: rows.map((r) => {
        const list = byPayout.get(r.id) ?? [];
        const o = overviewBy.get(r.tenant_id);
        return {
          ...r,
          attempts: list,
          open_attempt: list.find((a) => isAttemptOpen(a.status)) ?? null,
          available_centavos: o ? balanceFromRow(o).availableCentavos : null,
          frequency: o?.frequency ?? "manual",
          paymongo_bic: o?.paymongo_bic ?? null,
        };
      }),
      recurringDue: overview.filter((o) => o.recurring.due),
    };
  });

/** Which mode the PayMongo key is in, and the wallet a transfer would draw
 *  from. The key itself never leaves the server; only its mode does. */
export const adminGetDisbursementConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCourthubAdmin(context.supabase);
    const configured = !!process.env.PAYMONGO_SECRET_KEY;
    if (!configured) {
      return {
        mode: "unconfigured" as const,
        wallet: null,
        walletError: "PAYMONGO_SECRET_KEY is not set",
      };
    }
    const { paymongoMode, listWallets, PaymongoRequestError } =
      await import("@/lib/paymongo.server");
    const mode = paymongoMode();
    try {
      const wallets = await listWallets();
      const w =
        wallets.find((x) => x.status === "activated" && x.is_default) ??
        wallets.find((x) => x.status === "activated") ??
        null;
      return {
        mode,
        wallet: w
          ? {
              id: w.id,
              livemode: w.livemode,
              status: w.status,
              account_name: w.account?.account_name ?? null,
              account_number_masked: w.account?.account_number
                ? w.account.account_number.replace(/.(?=.{4})/g, "•")
                : null,
              available_centavos: w.balance?.available ?? null,
              pending_centavos: w.balance?.pending ?? null,
            }
          : null,
        /* Said precisely, because this is the reason the Send button is off.
           Webhook subscriptions and the tenant's payout schedule have nothing
           to do with it: a transfer needs a source wallet, and PayMongo
           provisions one only once Money Movement is enabled for the account
           and its Statement of Acceptance is signed in the dashboard. */
        walletError: w
          ? null
          : wallets.length
            ? `PayMongo wallet ${wallets[0].id} is ${wallets[0].status}; sign the Statement of Acceptance in the PayMongo dashboard to activate it`
            : "This PayMongo account has no Money Movement wallet (GET /v2/wallets/ returned none). Ask PayMongo to enable Money Movement / Wallet for this account, then activate the wallet in the dashboard",
      };
    } catch (e) {
      const msg =
        e instanceof PaymongoRequestError
          ? `${e.code ?? e.status}: ${e.detail}`
          : (e as Error).message;
      return { mode, wallet: null, walletError: msg };
    }
  });

export const adminListReceivingInstitutions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rail: z.enum(["instapay", "pesonet"]) }).parse(d))
  .handler(async ({ data, context }): Promise<ReceivingInstitution[]> => {
    await assertCourthubAdmin(context.supabase);
    const { listReceivingInstitutions } = await import("@/lib/paymongo.server");
    const rows = await listReceivingInstitutions(data.rail);
    return rows.map((r) => ({
      id: r.id,
      name: r.attributes.name,
      provider: r.attributes.provider,
      bic: r.attributes.provider_code,
    }));
  });

/** Record which PayMongo institution a tenant's destination maps to. The BIC
 *  must be one PayMongo listed for that rail — it is verified against the
 *  list here and stored with the institution's own name. */
export const adminMapPayoutAccountBic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        accountId: z.number().int().positive(),
        bic: z.string().trim().min(3).max(20),
        rail: z.enum(["instapay", "pesonet"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCourthubAdmin(context.supabase);
    const { listReceivingInstitutions } = await import("@/lib/paymongo.server");
    const rows = await listReceivingInstitutions(data.rail);
    const found = rows.find((r) => r.attributes.provider_code === data.bic);
    if (!found)
      throw new Error(`${data.bic} is not a receiving institution PayMongo lists for ${data.rail}`);
    const { error } = await context.supabase.rpc("admin_set_payout_account_bic", {
      _account_id: data.accountId,
      _bic: found.attributes.provider_code,
      _institution_name: found.attributes.name,
    });
    if (error) throw new Error(error.message);
    return { bic: found.attributes.provider_code, name: found.attributes.name };
  });

/* --------------------------------------------- admin: submitting payouts -- */

const SubmitInput = z.object({
  provider: z.enum(["manual", "paymongo"]),
  items: z
    .array(
      z.union([
        z.object({ payoutId: z.number().int().positive() }),
        /* A recurring-due tenant: no payout row exists yet. It is created and
           reserved here, through the same reservation logic a request uses. */
        z.object({ tenantId: z.string().uuid(), amountCentavos: z.number().int().positive() }),
      ]),
    )
    .min(1)
    .max(50),
});

export type SubmitResult = {
  key: string;
  payoutId: number | null;
  ok: boolean;
  /** awaiting_manual | submitted | settled_succeeded | settled_failed | failed | blocked | unknown */
  status: string;
  attemptId?: number;
  transferId?: string | null;
  providerStatus?: string | null;
  error?: string;
  needsMapping?: {
    accountId: number | null;
    rail: "instapay" | "pesonet";
    reason: string;
    candidates: ReceivingInstitution[];
  };
};

/** Batch submission. Each item is its own disbursement, its own attempt row
 *  and its own provider call; a failure on one leaves the others exactly as
 *  they are. Nothing here is a transaction across payouts, on purpose.
 *
 *  Order per item: create the recurring payout if needed → PRE-FLIGHT (wallet,
 *  destination mapping) so a mapping problem blocks cleanly without touching
 *  the payout → `admin_begin_payout_attempt` (locks, re-reserves, opens the
 *  attempt as `submitting`) → API call → `admin_mark_payout_attempt_submitted`
 *  on 201, `admin_mark_payout_attempt_failed` on a refusal. A network failure
 *  after the call was sent marks nothing: the attempt stays `submitting` and
 *  the row says so, because the transfer may exist at PayMongo. */
export const adminSubmitPayouts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SubmitInput.parse(d))
  .handler(async ({ data, context }): Promise<SubmitResult[]> => {
    const { supabase } = context;
    await assertCourthubAdmin(supabase);
    const provider = data.provider as PayoutProvider;
    const results: SubmitResult[] = [];

    /* Resolved once per batch; every transfer draws from the same wallet. */
    let source: { number: string; name: string; bic: string } | null = null;
    let sourceError: string | null = null;
    const pm = provider === "paymongo" ? await import("@/lib/paymongo.server") : null;
    if (pm) {
      try {
        const wallets = await pm.listWallets();
        const w =
          wallets.find((x) => x.status === "activated" && x.is_default) ??
          wallets.find((x) => x.status === "activated");
        if (!w?.account?.account_number) sourceError = "No activated PayMongo wallet to send from";
        else
          source = {
            number: w.account.account_number,
            name: w.account.account_name,
            bic: PAYMONGO_WALLET_BIC,
          };
      } catch (e) {
        sourceError = (e as Error).message;
      }
    }

    for (const item of data.items) {
      const key = "payoutId" in item ? `p:${item.payoutId}` : `t:${item.tenantId}`;
      let payoutId: number | null = "payoutId" in item ? item.payoutId : null;
      try {
        if (payoutId == null && "tenantId" in item) {
          const { data: rows, error } = await supabase.rpc("admin_request_recurring_payout", {
            _tenant_id: item.tenantId,
            _amount_centavos: item.amountCentavos,
          });
          if (error) throw new Error(error.message);
          const row = Array.isArray(rows) ? rows[0] : rows;
          payoutId = Number(row?.payout_id);
          if (!payoutId) throw new Error("Could not create the recurring payout");
        }

        if (provider === "manual") {
          const { data: a, error } = await supabase.rpc("admin_begin_payout_attempt", {
            _payout_id: payoutId!,
            _provider: "manual",
          });
          if (error) throw new Error(error.message);
          const att = Array.isArray(a) ? a[0] : a;
          results.push({
            key,
            payoutId,
            ok: true,
            status: "awaiting_manual",
            attemptId: Number(att?.attempt_id),
          });
          continue;
        }

        /* ---- PayMongo pre-flight: nothing below changes the payout. ---- */
        if (!pm || !source) throw new Error(sourceError ?? "PayMongo is not configured");

        const { data: p, error: pErr } = await supabase
          .from("tenant_payouts")
          .select("id, tenant_id, amount_centavos, status, destination_snapshot, tenants(name)")
          .eq("id", payoutId!)
          .maybeSingle();
        if (pErr) throw new Error(pErr.message);
        if (!p) throw new Error("Payout not found");
        const snap = (p.destination_snapshot ?? {}) as { account_id?: number };
        const accountId = snap.account_id ?? null;
        if (!accountId) throw new Error("The payout's destination snapshot names no account");

        /* The FULL number is read from the account row the snapshot points at.
           Accounts are superseded, never edited, so this is the same account
           the snapshot froze. */
        const { data: acct, error: aErr } = await supabase
          .from("tenant_payout_accounts")
          .select("id, account_type, account_name, account_number, bank_name, paymongo_bic")
          .eq("id", accountId)
          .maybeSingle();
        if (aErr) throw new Error(aErr.message);
        if (!acct) throw new Error("The payout's destination account is not readable");

        const rail = railForAmount(p.amount_centavos);
        const institutions = (await pm.listReceivingInstitutions(rail)).map((r) => ({
          id: r.id,
          name: r.attributes.name,
          provider: r.attributes.provider,
          bic: r.attributes.provider_code,
        }));
        const mapping = mapDestination(
          {
            accountType: acct.account_type,
            accountName: acct.account_name,
            accountNumber: acct.account_number,
            bankName: acct.bank_name,
            savedBic: acct.paymongo_bic,
          },
          institutions,
        );
        if (!mapping.ok) {
          results.push({
            key,
            payoutId,
            ok: false,
            status: "blocked",
            error: mapping.reason,
            needsMapping: {
              accountId,
              rail,
              reason: mapping.reason,
              candidates: mapping.candidates,
            },
          });
          continue;
        }

        /* ---- From here the payout is `processing` with an open attempt. ---- */
        const { data: a, error: bErr } = await supabase.rpc("admin_begin_payout_attempt", {
          _payout_id: payoutId!,
          _provider: "paymongo",
        });
        if (bErr) throw new Error(bErr.message);
        const att = Array.isArray(a) ? a[0] : a;
        const attemptId = Number(att?.attempt_id);
        const attemptNo = Number(att?.attempt_no);

        const body = buildTransferRequest({
          payoutId: payoutId!,
          attemptId,
          attemptNo,
          tenantId: p.tenant_id,
          amountCentavos: p.amount_centavos,
          source,
          destination: {
            bic: mapping.bic,
            accountNumber: mapping.accountNumber,
            accountName: mapping.accountName,
          },
          tenantName: (p as { tenants?: { name?: string | null } | null }).tenants?.name ?? null,
        });

        let created: Awaited<ReturnType<typeof pm.createOutwardTransfer>>;
        try {
          created = await pm.createOutwardTransfer(body);
        } catch (e) {
          if (e instanceof pm.PaymongoRequestError) {
            /* PayMongo refused it. Nothing left the wallet; release the money. */
            const { error: fErr } = await supabase.rpc("admin_mark_payout_attempt_failed", {
              _attempt_id: attemptId,
              _error_code: e.code ?? `http_${e.status}`,
              _error_message: e.detail.slice(0, 500),
              _metadata: { http_status: e.status, rail, bic: mapping.bic },
            });
            if (fErr)
              throw new Error(
                `${e.message}; and recording the failure also failed: ${fErr.message}`,
              );
            results.push({
              key,
              payoutId,
              ok: false,
              status: "failed",
              attemptId,
              error: `${e.code ?? e.status}: ${e.detail}`,
            });
            continue;
          }
          /* No answer at all. The transfer may or may not exist. Leave the
             attempt `submitting` so nobody sends it again until it is reconciled. */
          results.push({
            key,
            payoutId,
            ok: false,
            status: "unknown",
            attemptId,
            error: `No response from PayMongo (${(e as Error).message}). Reconcile attempt #${attemptId} with reference "${transferReference(payoutId!, attemptNo)}" before retrying.`,
          });
          continue;
        }

        const t = created.transfer;
        const { error: sErr } = await supabase.rpc("admin_mark_payout_attempt_submitted", {
          _attempt_id: attemptId,
          _provider_transfer_id: t.id,
          _provider_batch_id: created.batchId,
          _provider_reference_number: t.provider_reference_number ?? t.reference_number ?? null,
          _provider_status: t.status,
          _provider_rail: rail,
          _destination_bic: mapping.bic,
          _livemode: t.livemode ?? null,
          _metadata: {
            fee: t.fee ?? null,
            institution: mapping.institutionName,
            matched_by: mapping.matchedBy,
            our_reference: body.reference_number,
          },
        });
        if (sErr) {
          /* The transfer exists at PayMongo and we could not record it. This is
             the one state that must be loud: the id is in the error for reconcile. */
          results.push({
            key,
            payoutId,
            ok: false,
            status: "unknown",
            attemptId,
            transferId: t.id,
            error: `PayMongo created ${t.id} but recording it failed: ${sErr.message}. Reconcile attempt #${attemptId} with that id.`,
          });
          continue;
        }

        /* Accepting the request is not payment. But if the response already
           carries a terminal status, settle it through the same idempotent path
           the webhook uses, so a later webhook is a harmless duplicate. */
        let status = "submitted";
        if (t.status === "succeeded" || t.status === "failed") {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: outcome, error: oErr } = await supabaseAdmin.rpc("payout_provider_settle", {
            _provider: "paymongo",
            _event_id: `sync:${t.id}:${t.status}`,
            _event_type: `transfer.outward.${t.status === "succeeded" ? "successful" : "failed"}`,
            _provider_transfer_id: t.id,
            _provider_reference_number: t.provider_reference_number ?? t.reference_number ?? null,
            _outcome: t.status,
            _provider_status: t.status,
            _error_code: t.provider_error_code ?? null,
            _error_message: t.provider_error ?? null,
            _livemode: t.livemode ?? null,
            _payload: {
              source: "create_response",
              transfer: { id: t.id, status: t.status, fee: t.fee ?? null },
            },
          });
          if (oErr) throw new Error(oErr.message);
          status = `settled_${t.status}`;
          void outcome;
        }
        results.push({
          key,
          payoutId,
          ok: true,
          status,
          attemptId,
          transferId: t.id,
          providerStatus: t.status,
        });
      } catch (e) {
        results.push({ key, payoutId, ok: false, status: "failed", error: (e as Error).message });
      }
    }
    return results;
  });

/* ------------------------------------------------ admin: manual transfer -- */

export const adminRecordManualPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        payoutId: z.number().int().positive(),
        method: z.string().trim().min(1).max(60),
        reference: z.string().trim().min(1).max(120),
        paidAmountCentavos: z.number().int().positive(),
        proofPath: z.string().trim().min(1).max(400),
        notes: z.string().trim().max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ attemptId: number }> => {
    const { data: id, error } = await context.supabase.rpc("admin_record_manual_payout", {
      _payout_id: data.payoutId,
      _transfer_method: data.method,
      _transfer_reference: data.reference,
      _paid_amount_centavos: data.paidAmountCentavos,
      _proof_path: data.proofPath,
      _notes: data.notes ?? null,
    });
    if (error) throw new Error(error.message);
    return { attemptId: Number(id) };
  });

/* --------------------------------------------------- admin: reconcile -- */

/** The privileged recovery path for a PayMongo attempt whose webhook never
 *  came, or that never got its transfer id recorded. It asks PayMongo what it
 *  says NOW (`GET /v2/transfers/{id}`), proves the transfer belongs to this
 *  attempt (metadata or our reference), records the id if missing, and settles
 *  through the same idempotent `payout_provider_settle` the webhook uses. An
 *  admin cannot supply an outcome — only PayMongo can. */
export const adminReconcilePayoutAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        attemptId: z.number().int().positive(),
        transferId: z
          .string()
          .trim()
          .regex(/^tr_[A-Za-z0-9]+$/)
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCourthubAdmin(supabase);
    const { data: a, error } = await supabase
      .from("tenant_payout_attempts")
      .select("*")
      .eq("id", data.attemptId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!a) throw new Error("Attempt not found");
    if (a.provider !== "paymongo")
      throw new Error("Only a PayMongo attempt can be reconciled with PayMongo");

    const transferId = a.provider_transfer_id ?? data.transferId;
    if (!transferId)
      throw new Error(
        "This attempt has no transfer id; paste the tr_ id from the PayMongo dashboard",
      );

    const pm = await import("@/lib/paymongo.server");
    const t = await pm.retrieveTransfer(transferId);

    const ours = transferReference(a.payout_id, a.attempt_no);
    const claimed =
      t.metadata?.attempt_id === String(a.id) || referenceMatches(t.reference_number, ours);
    if (!claimed) {
      throw new Error(
        `Transfer ${t.id} does not belong to attempt #${a.id} (expected reference "${ours}")`,
      );
    }

    if (!a.provider_transfer_id) {
      const { error: sErr } = await supabase.rpc("admin_mark_payout_attempt_submitted", {
        _attempt_id: a.id,
        _provider_transfer_id: t.id,
        _provider_batch_id: t.batch_transfer_id ?? null,
        _provider_reference_number: t.provider_reference_number ?? t.reference_number ?? null,
        _provider_status: t.status,
        _provider_rail: t.provider ?? null,
        _destination_bic: t.destination_account?.bic ?? null,
        _livemode: t.livemode ?? null,
        _metadata: { reconciled: true, fee: t.fee ?? null },
      });
      if (sErr) throw new Error(sErr.message);
    }

    if (t.status !== "succeeded" && t.status !== "failed") {
      return { transferId: t.id, providerStatus: t.status, outcome: "still_pending" };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: outcome, error: oErr } = await supabaseAdmin.rpc("payout_provider_settle", {
      _provider: "paymongo",
      _event_id: `reconcile:${t.id}:${t.status}:${String(t.updated_at ?? "")}`,
      _event_type: `transfer.outward.${t.status === "succeeded" ? "successful" : "failed"}`,
      _provider_transfer_id: t.id,
      _provider_reference_number: t.provider_reference_number ?? t.reference_number ?? null,
      _outcome: t.status,
      _provider_status: t.status,
      _error_code: t.provider_error_code ?? null,
      _error_message: t.provider_error ?? null,
      _livemode: t.livemode ?? null,
      _payload: {
        source: "reconcile",
        reconciled_by: context.userId,
        transfer: { id: t.id, status: t.status, fee: t.fee ?? null },
      },
    });
    if (oErr) throw new Error(oErr.message);
    return { transferId: t.id, providerStatus: t.status, outcome: String(outcome) };
  });

/** Attempts and provider events for one payout, for the drawer. */
export const adminGetPayoutAttempts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ payoutId: z.number().int().positive() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const [attempts, events] = await Promise.all([
      supabase
        .from("tenant_payout_attempts")
        .select("*")
        .eq("payout_id", data.payoutId)
        .order("attempt_no", { ascending: false }),
      supabase
        .from("payout_provider_events")
        .select(
          "id, provider, event_id, event_type, provider_transfer_id, outcome, livemode, received_at",
        )
        .eq("payout_id", data.payoutId)
        .order("received_at", { ascending: false }),
    ]);
    if (attempts.error) throw new Error(attempts.error.message);
    return {
      attempts: (attempts.data ?? []) as PayoutAttemptRow[],
      events: events.data ?? [],
    };
  });
