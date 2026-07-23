import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

// PayMongo webhook signature format:
//   Paymongo-Signature: t=<timestamp>,te=<test_sig>,li=<live_sig>
// Signature payload: `${t}.${rawBody}` — HMAC-SHA256 with the webhook secret.
export const Route = createFileRoute("/api/public/paymongo/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const sigHeader = request.headers.get("paymongo-signature") ?? "";
        const secret = process.env.PAYMONGO_WEBHOOK_SECRET;

        if (!secret) {
          console.error("[paymongo webhook] PAYMONGO_WEBHOOK_SECRET is not configured");
          return new Response("Webhook secret not configured", { status: 500 });
        }

        // parse signature header
        const parts = Object.fromEntries(
          sigHeader.split(",").map((p) => {
            const [k, v] = p.split("=");
            return [k?.trim(), (v ?? "").trim()];
          }),
        );
        const t = parts["t"];
        const testSig = parts["te"];
        const liveSig = parts["li"];
        if (!t || (!testSig && !liveSig)) {
          return new Response("Invalid signature header", { status: 401 });
        }

        const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
        const candidate = testSig || liveSig || "";
        let valid = false;
        try {
          const a = Buffer.from(candidate);
          const b = Buffer.from(expected);
          valid = a.length === b.length && timingSafeEqual(a, b);
        } catch {
          valid = false;
        }
        if (!valid) return new Response("Invalid signature", { status: 401 });

        let payload: {
          data?: {
            attributes?: {
              type?: string;
              data?: {
                id?: string;
                attributes?: {
                  status?: string;
                  payments?: Array<{ id: string; attributes: { status: string; amount: number; source?: { type?: string } } }>;
                };
              };
            };
          };
        };
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const eventType = payload.data?.attributes?.type ?? "";
        const sessionId = payload.data?.attributes?.data?.id;
        const sessionAttrs = payload.data?.attributes?.data?.attributes;

        if (!sessionId) return new Response("ok");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (eventType === "checkout_session.payment.paid") {
          const payment = sessionAttrs?.payments?.[0];
          const paymentId = payment?.id;
          const method = payment?.attributes.source?.type ?? "unknown";

          const nowIso = new Date().toISOString();
          const { data: txs, error: txErr } = await supabaseAdmin
            .from("transactions")
            .update({
              status: "paid",
              paid_at: nowIso,
              method,
              raw: { payment_id: paymentId, event: eventType },
            })
            .eq("provider_ref", sessionId)
            .select("booking_id");

          if (txErr) {
            console.error("[paymongo webhook] tx update failed", txErr);
            return new Response("DB error", { status: 500 });
          }

          const bookingIds = Array.from(new Set((txs ?? []).map((r) => r.booking_id)));
          // Promote each pending booking to confirmed one-by-one so slot-conflict
          // trigger errors don't roll back the whole batch. If a slot was taken
          // meanwhile, mark that booking cancelled + payment_status='paid' so
          // it can be refunded manually.
          for (const bid of bookingIds) {
            const { error: upErr } = await supabaseAdmin
              .from("bookings")
              .update({ status: "confirmed", payment_status: "paid" })
              .eq("id", bid);
            if (upErr) {
              console.error("[paymongo webhook] booking confirm failed, marking as conflict", bid, upErr);
              await supabaseAdmin
                .from("bookings")
                .update({ status: "cancelled", payment_status: "paid" })
                .eq("id", bid);
            }
          }
        } else if (
          eventType === "checkout_session.payment.failed" ||
          eventType === "payment.failed"
        ) {
          await supabaseAdmin
            .from("transactions")
            .update({ status: "failed" })
            .eq("provider_ref", sessionId);
        }

        return new Response("ok");
      },
    },
  },
});
