import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const StartCheckoutInput = z.object({
  courtId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.array(z.number().int().min(0).max(23)).min(1).max(12),
  method: z.enum(["gcash", "paymaya", "grab_pay", "qrph", "card"]),
  origin: z.string().url(),
  voucherCode: z.string().trim().min(1).max(64).optional(),
});

export const startBookingCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => StartCheckoutInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const {
      createCheckoutSession,
      paymongoMode,
    } = await import("./paymongo.server");

    const { data: court, error: courtErr } = await supabase
      .from("courts")
      .select("id, name, hourly_rate, capacity, venue_id, venues(name, payment_mode, refund_cutoff_hours)")
      .eq("id", data.courtId)
      .maybeSingle();
    if (courtErr || !court) throw new Error("Court not found");
    const venue = (court as unknown as { venues: { name: string; payment_mode: string; refund_cutoff_hours: number } | null }).venues;
    if (!venue) throw new Error("Venue not found");
    if (venue.payment_mode === "none") throw new Error("This venue is not accepting online payments");

    const totalHours = data.hours.length;
    const fullAmount = Number(court.hourly_rate) * totalHours;

    // Voucher preview: authoritative discount computed server-side.
    let voucherId: string | null = null;
    let discountAmount = 0;
    if (data.voucherCode) {
      const { data: vp, error: vErr } = await supabase.rpc("preview_voucher", {
        _code: data.voucherCode,
        _court_id: data.courtId,
        _amount: fullAmount,
      });
      if (vErr) throw new Error(vErr.message);
      const row = Array.isArray(vp) ? vp[0] : vp;
      if (!row || !row.ok) throw new Error(row?.reason || "Invalid voucher");
      voucherId = row.voucher_id as string;
      discountAmount = Number(row.discount) || 0;
    }

    const discountedTotal = Math.max(0, fullAmount - discountAmount);
    const collectAmount =
      venue.payment_mode === "downpayment_50" ? Math.round(discountedTotal * 50) / 100 : discountedTotal;
    const centavos = Math.round(collectAmount * 100);
    if (centavos < 2000) throw new Error("Minimum online payment is ₱20.00");

    // Insert bookings as pending + unpaid. Attach voucher/discount to first row.
    const rows = data.hours.map((h, idx) => {
      const start = new Date(`${data.date}T${String(h).padStart(2, "0")}:00:00`);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      return {
        court_id: data.courtId,
        user_id: userId,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        status: "pending",
        payment_status: "unpaid",
        voucher_id: idx === 0 ? voucherId : null,
        discount_amount: idx === 0 ? Number(discountAmount.toFixed(2)) : 0,
      };
    });
    const { data: inserted, error: insErr } = await supabase
      .from("bookings")
      .insert(rows)
      .select("id");
    if (insErr) throw new Error(insErr.message);
    const bookingIds = (inserted ?? []).map((r) => r.id as number);
    if (bookingIds.length === 0) throw new Error("Failed to create booking");

    const primaryBookingId = bookingIds[0];
    const reference = `bk_${primaryBookingId}_${Date.now().toString(36)}`;
    const successUrl = `${data.origin}/payment/return?ref=${encodeURIComponent(reference)}&status=success`;
    const cancelUrl = `${data.origin}/payment/return?ref=${encodeURIComponent(reference)}&status=cancel`;

    let session;
    try {
      session = await createCheckoutSession({
        amountCentavos: centavos,
        description: `${venue.name} — ${court.name} (${totalHours} hr${totalHours > 1 ? "s" : ""})`,
        referenceNumber: reference,
        lineItemName: `${court.name} · ${totalHours} hour${totalHours > 1 ? "s" : ""}`,
        methods: [data.method],
        successUrl,
        cancelUrl,
        metadata: {
          booking_ids: bookingIds.join(","),
          venue_id: String(court.venue_id),
          court_id: String(data.courtId),
          user_id: userId,
        },
      });
    } catch (e) {
      await supabase.from("bookings").delete().in("id", bookingIds);
      throw e;
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mode = paymongoMode();
    const perBookingCentavos = Math.round(centavos / bookingIds.length);
    const txRows = bookingIds.map((bid) => ({
      booking_id: bid,
      venue_id: court.venue_id,
      user_id: userId,
      amount: perBookingCentavos / 100,
      currency: "PHP",
      method: data.method,
      provider: "paymongo",
      provider_ref: session.data.id,
      status: "pending",
      mode,
    }));
    const { error: txErr } = await supabaseAdmin.from("transactions").insert(txRows);
    if (txErr) console.error("[transactions insert]", txErr);

    return {
      checkoutUrl: session.data.attributes.checkout_url,
      sessionId: session.data.id,
      reference,
      amount: centavos / 100,
    };
  });

const RetryInput = z.object({
  bookingIds: z.array(z.number().int().positive()).min(1).max(12),
  method: z.enum(["gcash", "paymaya", "grab_pay", "qrph", "card"]),
  origin: z.string().url(),
});

// Retry payment for existing pending/unpaid bookings without creating new booking rows.
export const retryBookingPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RetryInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { createCheckoutSession, paymongoMode } = await import("./paymongo.server");

    const { data: bookings, error: bErr } = await supabase
      .from("bookings")
      .select("id, court_id, user_id, start_time, end_time, status, payment_status, courts(name, hourly_rate, venue_id, venues(name, payment_mode))")
      .in("id", data.bookingIds);
    if (bErr || !bookings || bookings.length === 0) throw new Error("Bookings not found");
    if (bookings.length !== data.bookingIds.length) throw new Error("Some bookings could not be loaded");

    for (const b of bookings) {
      if (b.user_id !== userId) throw new Error("Not your booking");
      if (b.payment_status === "paid") throw new Error("Booking already paid");
      if (b.status === "cancelled") throw new Error("Booking is cancelled");
    }
    const courtIds = new Set(bookings.map((b) => b.court_id));
    if (courtIds.size > 1) throw new Error("All bookings must be on the same court");

    const first = bookings[0] as unknown as {
      court_id: number;
      courts: { name: string; hourly_rate: number; venue_id: number; venues: { name: string; payment_mode: string } };
    };
    const venue = first.courts.venues;
    if (!venue || venue.payment_mode === "none") throw new Error("This venue is not accepting online payments");

    const totalHours = bookings.length;
    const fullAmount = Number(first.courts.hourly_rate) * totalHours;
    const collectAmount =
      venue.payment_mode === "downpayment_50" ? Math.round(fullAmount * 50) / 100 : fullAmount;
    const centavos = Math.round(collectAmount * 100);
    if (centavos < 2000) throw new Error("Minimum online payment is ₱20.00");

    const bookingIds = bookings.map((b) => b.id as number).sort((a, b) => a - b);
    const primaryBookingId = bookingIds[0];
    const reference = `bk_${primaryBookingId}_${Date.now().toString(36)}`;
    const successUrl = `${data.origin}/payment/return?ref=${encodeURIComponent(reference)}&status=success`;
    const cancelUrl = `${data.origin}/payment/return?ref=${encodeURIComponent(reference)}&status=cancel`;

    const session = await createCheckoutSession({
      amountCentavos: centavos,
      description: `${venue.name} — ${first.courts.name} (${totalHours} hr${totalHours > 1 ? "s" : ""})`,
      referenceNumber: reference,
      lineItemName: `${first.courts.name} · ${totalHours} hour${totalHours > 1 ? "s" : ""}`,
      methods: [data.method],
      successUrl,
      cancelUrl,
      metadata: {
        booking_ids: bookingIds.join(","),
        venue_id: String(first.courts.venue_id),
        court_id: String(first.court_id),
        user_id: userId,
        retry: "1",
      },
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Void previous pending tx for these bookings.
    await supabaseAdmin
      .from("transactions")
      .update({ status: "cancelled" })
      .in("booking_id", bookingIds)
      .eq("status", "pending");

    const mode = paymongoMode();
    const perBookingCentavos = Math.round(centavos / bookingIds.length);
    const txRows = bookingIds.map((bid) => ({
      booking_id: bid,
      venue_id: first.courts.venue_id,
      user_id: userId,
      amount: perBookingCentavos / 100,
      currency: "PHP",
      method: data.method,
      provider: "paymongo",
      provider_ref: session.data.id,
      status: "pending",
      mode,
    }));
    const { error: txErr } = await supabaseAdmin.from("transactions").insert(txRows);
    if (txErr) console.error("[transactions insert retry]", txErr);

    return {
      checkoutUrl: session.data.attributes.checkout_url,
      sessionId: session.data.id,
      reference,
      amount: centavos / 100,
    };
  });

const CancelInput = z.object({ bookingIds: z.array(z.number().int().positive()).min(1).max(24) });

// Cancel unpaid pending bookings (used when player abandons or cancels checkout).
export const cancelPendingBookings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CancelInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .in("id", data.bookingIds)
      .eq("user_id", userId)
      .neq("payment_status", "paid");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getCheckoutStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ reference: z.string().min(1) }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: tx } = await supabase
      .from("transactions")
      .select("id, status, amount, method, booking_id, provider_ref, paid_at")
      .eq("provider_ref", data.reference.startsWith("bk_") ? data.reference : data.reference)
      .limit(1);
    if (tx && tx.length > 0) {
      return { status: tx[0].status, amount: tx[0].amount, method: tx[0].method };
    }
    return { status: "pending", amount: null as number | null, method: null as string | null };
  });

const RefundInput = z.object({ bookingId: z.number().int().positive() });

export const refundBookingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RefundInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, user_id, start_time, status, payment_status, courts(venues(refund_cutoff_hours))")
      .eq("id", data.bookingId)
      .maybeSingle();
    if (error || !booking) throw new Error("Booking not found");
    if (booking.user_id !== userId) throw new Error("Not your booking");
    if (booking.payment_status !== "paid") throw new Error("Booking is not paid");

    const cutoff = (booking as unknown as { courts: { venues: { refund_cutoff_hours: number } } }).courts.venues.refund_cutoff_hours ?? 24;
    const hoursUntil = (new Date(booking.start_time).getTime() - Date.now()) / 3_600_000;
    if (hoursUntil < cutoff) {
      throw new Error(`Refunds require cancelling at least ${cutoff} hours before start time`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: tx } = await supabaseAdmin
      .from("transactions")
      .select("id, amount, raw, provider_ref")
      .eq("booking_id", booking.id)
      .eq("status", "paid")
      .maybeSingle();
    if (!tx) throw new Error("Paid transaction not found");

    const paymentId = (tx.raw as { payment_id?: string } | null)?.payment_id;
    if (!paymentId) throw new Error("No PayMongo payment id on record");

    const { refundPayment } = await import("./paymongo.server");
    await refundPayment({
      paymentId,
      amountCentavos: Math.round(Number(tx.amount) * 100),
      reason: "requested_by_customer",
    });

    await supabaseAdmin.from("transactions").update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
    }).eq("id", tx.id);
    await supabaseAdmin.from("bookings").update({
      status: "cancelled",
      payment_status: "refunded",
    }).eq("id", booking.id);

    return { ok: true };
  });
