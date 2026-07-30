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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.rpc("expire_pending_payment_holds");
    const {
      createCheckoutSession,
      paymongoMode,
    } = await import("./paymongo.server");

    const { data: court, error: courtErr } = await supabase
      .from("courts")
      .select("id, name, hourly_rate, rate_rules, capacity, venue_id, venues(name, payment_mode, downpayment_type, downpayment_value, refund_cutoff_hours, timezone)")
      .eq("id", data.courtId)
      .maybeSingle();
    if (courtErr || !court) throw new Error("Court not found");
    const venue = (court as unknown as { venues: { name: string; payment_mode: string; downpayment_type: string; downpayment_value: number; refund_cutoff_hours: number; timezone: string | null } | null }).venues;
    if (!venue) throw new Error("Venue not found");
    if (venue.payment_mode === "none") throw new Error("This venue is not accepting online payments");

    const totalHours = data.hours.length;

    // Authoritative pricing: resolve each selected hour against the court's rate rules.
    const { normalizeRules, rateForDayHour, DAY_KEYS } = await import("./court-pricing");
    const rules = normalizeRules((court as unknown as { rate_rules: unknown }).rate_rules);
    const dayKey = DAY_KEYS[new Date(`${data.date}T00:00:00Z`).getUTCDay()];
    const unitPrices = data.hours.map((h) => rateForDayHour(Number(court.hourly_rate), rules, dayKey, h));
    const fullAmount = unitPrices.reduce((a, b) => a + b, 0);

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
    const collectAmount = venue.payment_mode === "downpayment"
      ? venue.downpayment_type === "fixed"
        ? Math.min(discountedTotal, Number(venue.downpayment_value))
        : Math.round(discountedTotal * Number(venue.downpayment_value) * 100) / 10_000
      : discountedTotal;
    const centavos = Math.round(collectAmount * 100);
    if (centavos < 2000) throw new Error("Minimum online payment is ₱20.00");

    // Insert bookings as pending + unpaid. Attach voucher/discount to first row.
    // Hours are venue-local: the server runs in UTC, so resolve each hour
    // against the venue timezone before storing the instant.
    const { zonedHourToUtc, DEFAULT_TIMEZONE } = await import("./tz");
    const tz = venue.timezone || DEFAULT_TIMEZONE;
    const rows = data.hours.map((h, idx) => {
      const start = zonedHourToUtc(data.date, h, tz);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      return {
        court_id: data.courtId,
        user_id: userId,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        status: "pending",
        payment_status: "pending",
        unit_price: unitPrices[idx],
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
      raw: { payment_kind: venue.payment_mode === "downpayment" ? "downpayment" : "full" },
      status: "pending",
      mode,
    }));
    const { error: txErr } = await supabaseAdmin.from("transactions").insert(txRows);
    if (txErr) {
      await supabase.from("bookings").update({ status: "cancelled", payment_status: "cancelled", cancel_reason: "Checkout session could not be recorded" }).in("id", bookingIds);
      throw new Error(`Could not create payment reservation: ${txErr.message}`);
    }

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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.rpc("expire_pending_payment_holds");

    const { data: bookings, error: bErr } = await supabase
      .from("bookings")
      .select("id, court_id, user_id, start_time, end_time, status, payment_status, created_at, unit_price, courts(name, hourly_rate, venue_id, venues(name, payment_mode, downpayment_type, downpayment_value))")
      .in("id", data.bookingIds);
    if (bErr || !bookings || bookings.length === 0) throw new Error("Bookings not found");
    if (bookings.length !== data.bookingIds.length) throw new Error("Some bookings could not be loaded");

    for (const b of bookings) {
      if (b.user_id !== userId) throw new Error("Not your booking");
      if (b.payment_status === "paid") throw new Error("Booking already paid");
      if (b.status !== "pending") throw new Error("Your reservation has expired or was cancelled. Create a new booking to continue.");
      if (new Date(b.created_at).getTime() <= Date.now() - 15 * 60_000) throw new Error("Your reservation has expired. Create a new booking to continue.");
    }
    const courtIds = new Set(bookings.map((b) => b.court_id));
    if (courtIds.size > 1) throw new Error("All bookings must be on the same court");

    const first = bookings[0] as unknown as {
      court_id: number;
      courts: { name: string; hourly_rate: number; venue_id: number; venues: { name: string; payment_mode: string; downpayment_type: string; downpayment_value: number } };
    };
    const venue = first.courts.venues;
    if (!venue || venue.payment_mode === "none") throw new Error("This venue is not accepting online payments");

    const totalHours = bookings.length;
    const fullAmount = bookings.reduce(
      (sum, b) => sum + Number((b as unknown as { unit_price: number | null }).unit_price ?? first.courts.hourly_rate),
      0,
    );
    const collectAmount = venue.payment_mode === "downpayment"
      ? venue.downpayment_type === "fixed"
        ? Math.min(fullAmount, Number(venue.downpayment_value))
        : Math.round(fullAmount * Number(venue.downpayment_value) * 100) / 10_000
      : fullAmount;
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

    const { error: pendingErr } = await supabase
      .from("bookings")
      .update({ payment_status: "pending" })
      .in("id", bookingIds)
      .eq("status", "pending");
    if (pendingErr) throw new Error(pendingErr.message);

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
      raw: { payment_kind: venue.payment_mode === "downpayment" ? "downpayment" : "full" },
      status: "pending",
      mode,
    }));
    const { error: txErr } = await supabaseAdmin.from("transactions").insert(txRows);
    if (txErr) throw new Error(`Could not create payment retry: ${txErr.message}`);

    return {
      checkoutUrl: session.data.attributes.checkout_url,
      sessionId: session.data.id,
      reference,
      amount: centavos / 100,
    };
  });

const CancelInput = z.object({ bookingIds: z.array(z.number().int().positive()).min(1).max(24) });

const VenueSettlementInput = z.object({
  bookingIds: z.array(z.number().int().positive()).min(1).max(24),
  amount: z.number().positive(),
  method: z.string().trim().min(1).max(40),
  note: z.string().trim().max(280).optional(),
});

export const recordVenueSettlement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => VenueSettlementInput.parse(data))
  .handler(async ({ data, context }) => {
    const callRpc = context.supabase.rpc as unknown as (name: string, args: Record<string, unknown>) => Promise<{ data: number | null; error: { message: string } | null }>;
    const { data: recorded, error } = await callRpc("record_venue_settlement", {
      _booking_ids: data.bookingIds,
      _amount: data.amount,
      _method: data.method,
      _note: data.note ?? null,
    });
    if (error) throw new Error(error.message);
    return { recorded: Number(recorded ?? 0) };
  });

// Cancel unpaid pending bookings (used when player abandons or cancels checkout).
export const cancelPendingBookings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CancelInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cancelled, error } = await supabase
      .from("bookings")
      .update({ status: "cancelled", payment_status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: "Payment cancelled by player" })
      .in("id", data.bookingIds)
      .eq("user_id", userId)
      .eq("status", "pending")
      .neq("payment_status", "paid")
      .select("id");
    if (error) throw new Error(error.message);
    const ids = (cancelled ?? []).map((booking) => booking.id);
    if (ids.length > 0) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("transactions").update({ status: "cancelled" }).in("booking_id", ids).eq("status", "pending");
    }
    return { ok: true, cancelled: ids.length };
  });

export const getCheckoutStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ reference: z.string().min(1) }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const bookingId = Number(data.reference.split("_")[1]);
    const query = supabase
      .from("transactions")
      .select("id, status, amount, method, booking_id, provider_ref, paid_at");
    const { data: tx } = await (Number.isInteger(bookingId) && bookingId > 0
      ? query.eq("booking_id", bookingId)
      : query.eq("provider_ref", data.reference))
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
