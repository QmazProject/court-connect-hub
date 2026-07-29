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

          const { data: finalization, error: finalizationErr } = await supabaseAdmin.rpc("finalize_paid_checkout", {
            _session_id: sessionId,
            _payment_id: paymentId ?? "unknown",
            _method: method,
          });
          if (finalizationErr) {
            console.error("[paymongo webhook] checkout finalization failed", finalizationErr);
            return new Response("DB error", { status: 500 });
          }
          const result = Array.isArray(finalization) ? finalization[0] : finalization;

          if (result?.refund_required) {
            const bookingIds = result.booking_ids ?? [];
            try {
              const { data: transactions, error: txErr } = await supabaseAdmin
                .from("transactions")
                .select("id, amount, raw")
                .eq("provider_ref", sessionId)
                .eq("status", "paid");
              if (txErr) throw txErr;
              const totalCentavos = Math.round((transactions ?? []).reduce((sum, tx) => sum + Number(tx.amount), 0) * 100);
              if (!paymentId || totalCentavos <= 0) throw new Error("Payment reference or refund amount is missing");
              const { refundPayment } = await import("@/lib/paymongo.server");
              await refundPayment({ paymentId, amountCentavos: totalCentavos, reason: "requested_by_customer" });
              await supabaseAdmin.from("transactions").update({ status: "refunded", refunded_at: new Date().toISOString() }).eq("provider_ref", sessionId);
              await supabaseAdmin.from("bookings").update({ payment_status: "refunded", refund_status: "refunded" }).in("id", bookingIds);
            } catch (refundErr) {
              console.error("[paymongo webhook] automatic refund failed", refundErr);
              // The finalizer already left the booking expired/cancelled with
              // payment_status='paid' and refund_status='pending' for staff.
            }
          }
        } else if (
          eventType === "checkout_session.payment.failed" ||
          eventType === "payment.failed"
        ) {
          const { data: failedTransactions, error: failedTxErr } = await supabaseAdmin
            .from("transactions")
            .select("booking_id")
            .eq("provider_ref", sessionId);
          if (failedTxErr) {
            console.error("[paymongo webhook] failed-payment lookup failed", failedTxErr);
            return new Response("DB error", { status: 500 });
          }
          await supabaseAdmin
            .from("transactions")
            .update({ status: "failed" })
            .eq("provider_ref", sessionId);
          const bookingIds = Array.from(new Set((failedTransactions ?? []).map((tx) => tx.booking_id)));
          if (bookingIds.length > 0) {
            await supabaseAdmin
              .from("bookings")
              .update({ payment_status: "failed" })
              .in("id", bookingIds)
              .eq("status", "pending");
          }
        }

        return new Response("ok");
      },
    },
  },
});
