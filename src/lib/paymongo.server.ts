// Server-only helpers for PayMongo (test & live).
// NOTE: This file is imported only from paymongo.functions.ts (server fn handlers)
// and the webhook route. Never import from client code.

const PAYMONGO_API = "https://api.paymongo.com/v1";

export type PaymongoMethod = "gcash" | "paymaya" | "grab_pay" | "qrph" | "card";

function auth() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error("PAYMONGO_SECRET_KEY is not configured");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

export function paymongoMode(): "test" | "live" {
  const key = process.env.PAYMONGO_SECRET_KEY ?? "";
  return key.startsWith("sk_live_") ? "live" : "test";
}

export async function pmFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${PAYMONGO_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: auth(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[PayMongo ${init.method ?? "GET"} ${path}] ${res.status}: ${text}`);
    throw new Error(`PayMongo error ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function createCheckoutSession(args: {
  amountCentavos: number;
  description: string;
  referenceNumber: string;
  lineItemName: string;
  methods: PaymongoMethod[];
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}) {
  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        description: args.description,
        reference_number: args.referenceNumber,
        line_items: [
          {
            currency: "PHP",
            amount: args.amountCentavos,
            name: args.lineItemName,
            quantity: 1,
          },
        ],
        payment_method_types: args.methods,
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        metadata: args.metadata ?? {},
      },
    },
  };
  return pmFetch<{
    data: {
      id: string;
      attributes: { checkout_url: string; status: string; payments?: unknown[] };
    };
  }>("/checkout_sessions", { method: "POST", body });
}

export async function retrieveCheckoutSession(id: string) {
  return pmFetch<{
    data: {
      id: string;
      attributes: {
        checkout_url: string;
        status: string;
        payments?: Array<{ id: string; attributes: { status: string; amount: number } }>;
      };
    };
  }>(`/checkout_sessions/${id}`);
}

export async function refundPayment(args: {
  paymentId: string;
  amountCentavos: number;
  reason?: string;
}) {
  return pmFetch<{ data: { id: string; attributes: { status: string } } }>("/refunds", {
    method: "POST",
    body: {
      data: {
        attributes: {
          amount: args.amountCentavos,
          payment_id: args.paymentId,
          reason: args.reason ?? "requested_by_customer",
        },
      },
    },
  });
}

/* ------------------------------------------------------- Money Movement -- */
/* Outbound transfers live on the v2 API. Documented at
 *   https://docs.paymongo.com/docs/money-movement-moving-money-with-api
 *   https://docs.paymongo.com/reference/create-batch-transfer
 *   https://docs.paymongo.com/reference/get-transfer
 *   https://docs.paymongo.com/reference/list-all-wallet-accounts
 *   https://docs.paymongo.com/reference/get-receiving-institutions
 * Same Basic auth as v1, same secret key. Nothing here decides whether a
 * payout may be sent; that is `admin_begin_payout_attempt` in the database,
 * which must have succeeded before any of these is called for a payout. */

const PAYMONGO_API_V2 = "https://api.paymongo.com/v2";

export type PaymongoErrorInfo = { status: number; code: string | null; detail: string };

export class PaymongoRequestError extends Error {
  status: number;
  code: string | null;
  detail: string;
  constructor(info: PaymongoErrorInfo) {
    super(`PayMongo error ${info.status}: ${info.code ?? ""} ${info.detail}`.trim());
    this.status = info.status;
    this.code = info.code;
    this.detail = info.detail;
  }
}

/** Like pmFetch, but against v2 and with the error body parsed into a code
 *  the attempt row can store. PayMongo errors are `{ errors: [{ code, detail }] }`. */
export async function pmFetchV2<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${PAYMONGO_API_V2}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: auth(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[PayMongo ${init.method ?? "GET"} v2${path}] ${res.status}: ${text}`);
    let code: string | null = null;
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ code?: string; detail?: string }> };
      const first = parsed.errors?.[0];
      if (first) {
        code = first.code ?? null;
        detail = first.detail ?? text;
      }
    } catch {
      /* not JSON; keep the raw text as the detail */
    }
    throw new PaymongoRequestError({ status: res.status, code, detail });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type PaymongoWallet = {
  id: string;
  livemode: boolean;
  is_default: boolean;
  status: string;
  balance?: { available: number; pending: number };
  account?: {
    provider: string;
    account_name: string;
    account_number: string;
    currency: string;
  };
};

/** `GET /v1/wallets/{id}`: the legacy shape of one wallet. Observed against the
 *  test environment on 2026-09-15: this is where `account_name`,
 *  `account_number` and `available_balance` actually come back — the v2 list
 *  returned neither `account` nor `balance` for the same wallet even with
 *  `fields=account,balance`. Used only to fill in what v2 leaves out. */
export async function retrieveWalletV1(id: string): Promise<{
  account_name?: string;
  account_number?: string;
  available_balance?: number;
} | null> {
  try {
    const r = await pmFetch<{
      data: {
        id: string;
        attributes: { account_name?: string; account_number?: string; available_balance?: number };
      };
    }>(`/wallets/${encodeURIComponent(id)}`);
    return r.data?.attributes ?? null;
  } catch {
    return null;
  }
}

/** `GET /v2/wallets/?fields=account&fields=balance`. The source account for a
 *  transfer is the wallet's own `account`; a merchant normally has one
 *  activated default wallet. Where v2 omits the account (seen on a test
 *  wallet), the v1 retrieve fills it, so the caller always sees one shape. */
export async function listWallets(): Promise<PaymongoWallet[]> {
  /* Trailing slash on purpose: `/v2/wallets` answers 301 to `/v2/wallets/`. */
  const r = await pmFetchV2<{ data: PaymongoWallet[] }>(
    "/wallets/?fields=account&fields=balance&fields=limits",
  );
  const wallets = r.data ?? [];
  for (const w of wallets) {
    if (w.account?.account_number) continue;
    const v1 = await retrieveWalletV1(w.id);
    if (v1?.account_number) {
      w.account = {
        provider: "paymongo",
        account_name: v1.account_name ?? "",
        account_number: v1.account_number,
        currency: "PHP",
      };
    }
    if (!w.balance && typeof v1?.available_balance === "number") {
      w.balance = { available: v1.available_balance, pending: 0 };
    }
  }
  return wallets;
}

export type PaymongoReceivingInstitution = {
  id: string;
  type: string;
  attributes: { name: string; provider: string; provider_code: string; type?: unknown };
};

/** `GET /v1/wallets/receiving_institutions?provider=instapay|pesonet`. Which
 *  banks and e-wallets a rail reaches, with the BIC (`provider_code`) a
 *  transfer needs. Cached per rail for an hour in this process: the list
 *  changes rarely and is needed on every mapping. */
const institutionCache = new Map<string, { at: number; rows: PaymongoReceivingInstitution[] }>();
const INSTITUTION_TTL_MS = 60 * 60 * 1000;

export async function listReceivingInstitutions(
  rail: "instapay" | "pesonet",
): Promise<PaymongoReceivingInstitution[]> {
  const hit = institutionCache.get(rail);
  if (hit && Date.now() - hit.at < INSTITUTION_TTL_MS) return hit.rows;
  const r = await pmFetch<{ data: PaymongoReceivingInstitution[] }>(
    `/wallets/receiving_institutions?provider=${rail}`,
  );
  const rows = r.data ?? [];
  institutionCache.set(rail, { at: Date.now(), rows });
  return rows;
}

export type PaymongoTransfer = {
  id: string;
  livemode?: boolean;
  status: "pending" | "succeeded" | "failed" | string;
  provider: string;
  amount: number;
  fee?: number | string;
  currency: string;
  reference_number?: string | null;
  provider_reference_number?: string | null;
  batch_transfer_id?: string | null;
  destination_account?: { number?: string; name?: string; bic?: string; bank_name?: string };
  provider_error?: string | null;
  provider_error_code?: string | null;
  metadata?: Record<string, string>;
  created_at?: string | number;
  updated_at?: string | number;
};

/** `POST /v2/batch_transfers` with ONE transfer. Even a single transfer goes
 *  through the batch endpoint. The caller passes the body built by
 *  `buildTransferRequest`; nothing about the amount or destination is decided
 *  here. Returns the transfer inside the batch. */
export async function createOutwardTransfer(transfer: unknown): Promise<{
  batchId: string;
  transfer: PaymongoTransfer;
}> {
  const r = await pmFetchV2<{ data: { id: string; transfers: PaymongoTransfer[] } }>(
    "/batch_transfers",
    { method: "POST", body: { transfers: [transfer] } },
  );
  const t = r.data?.transfers?.[0];
  if (!t?.id) throw new Error("PayMongo accepted the batch but returned no transfer");
  return { batchId: r.data.id, transfer: t };
}

/** `GET /v2/transfers/{id}`. The reconciliation read: what PayMongo says
 *  about a transfer now, for an attempt whose webhook never arrived. */
export async function retrieveTransfer(id: string): Promise<PaymongoTransfer> {
  const r = await pmFetchV2<{ data: PaymongoTransfer }>(`/transfers/${encodeURIComponent(id)}`);
  return r.data;
}
