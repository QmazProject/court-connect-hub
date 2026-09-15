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
