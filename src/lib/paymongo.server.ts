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
    data: { id: string; attributes: { checkout_url: string; status: string; payments?: unknown[] } };
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
  return pmFetch<{ data: { id: string; attributes: { status: string } } }>(
    "/refunds",
    {
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
    },
  );
}
