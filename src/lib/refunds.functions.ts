import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CancelInput = z.object({
  bookingIds: z.array(z.number().int().positive()).min(1).max(100),
  reason: z.string().trim().max(500).optional(),
  // auto   -> refund through PayMongo back to the original payment method
  // manual -> venue settles the refund itself; we only flag it as pending
  // none   -> nothing was paid, nothing to refund
  refundMode: z.enum(["auto", "manual", "none"]),
});

/**
 * Venue-staff cancellation. The RPC enforces that the caller is staff of the
 * venue, flips the bookings to cancelled (never deletes them) and notifies the
 * player. Automatic refunds are then pushed back to the original PayMongo
 * payment — we never ask a player for a GCash or card number.
 */
export const cancelBookingsWithRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => CancelInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: cancelledCount, error } = await supabase.rpc("staff_cancel_bookings", {
      _booking_ids: data.bookingIds,
      _reason: data.reason ?? "",
      _refund_mode: data.refundMode,
    });
    if (error) throw new Error(error.message);

    let refunded = 0;
    const failures: string[] = [];

    if (data.refundMode === "auto") {
      const { data: txs, error: txErr } = await supabase
        .from("transactions")
        .select("id, booking_id, amount, status, raw")
        .in("booking_id", data.bookingIds)
        .eq("status", "paid");
      if (txErr) throw new Error(txErr.message);

      if ((txs ?? []).length > 0) {
        const { refundPayment } = await import("./paymongo.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        /* Collected rather than written per iteration. The PayMongo call and the
           transaction row — the money record — stay exactly as they were, one at a
           time, in order. Only the `bookings` status write is batched, and only
           after the loop.

           Why: each `.update()` is its own round trip and therefore its own
           transaction, so the deferred notification trigger fired once per hourly
           row. The first row to commit won the dedupe key and described a
           three-hour refund as one hour. Updating the successful rows in a single
           statement means the trigger sees the whole refunded set at once and
           reports the real span and total. This mirrors what the webhook refund
           path already does (`.in("id", bookingIds)`), so the two paths now behave
           identically instead of one being subtly wrong. */
        const refundedBookingIds: number[] = [];
        const failedBookingIds: number[] = [];

        for (const t of txs ?? []) {
          const paymentId = (t.raw as { payment_id?: string } | null)?.payment_id;
          if (!paymentId) {
            failures.push(
              `Booking #${t.booking_id}: no payment reference on file — settle manually.`,
            );
            failedBookingIds.push(t.booking_id);
            continue;
          }
          try {
            await refundPayment({
              paymentId,
              amountCentavos: Math.round(Number(t.amount) * 100),
              reason: "requested_by_customer",
            });
            await supabaseAdmin
              .from("transactions")
              .update({ status: "refunded", refunded_at: new Date().toISOString() })
              .eq("id", t.id);
            refundedBookingIds.push(t.booking_id);
            refunded += 1;
          } catch (e) {
            console.error("refund failed", t.booking_id, e);
            failures.push(`Booking #${t.booking_id}: ${(e as Error).message}`);
            failedBookingIds.push(t.booking_id);
          }
        }

        if (refundedBookingIds.length > 0) {
          await supabaseAdmin
            .from("bookings")
            .update({ refund_status: "refunded", payment_status: "refunded" })
            .in("id", refundedBookingIds);
        }

        /* Previously a failed refund left no trace on the booking — the reason was
           returned to the caller and then lost, and `venue_refund_failed` could
           never fire because nothing ever wrote that state. Recording it is what
           makes a stuck refund visible to the venue afterwards. The provider's
           message is deliberately NOT stored here: it goes to the log above, and
           the venue is shown a plain-language notification instead. */
        if (failedBookingIds.length > 0) {
          await supabaseAdmin
            .from("bookings")
            .update({ refund_status: "failed" })
            .in("id", failedBookingIds);
        }
      }
    }

    return { cancelled: Number(cancelledCount) || 0, refunded, failures };
  });
