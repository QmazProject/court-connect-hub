import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { PLAYER_CANCEL_CUTOFF_MS } from "@/lib/booking-actions";

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
      .select("id, name, hourly_rate, rate_rules, capacity, venue_id, venues(name, payment_mode, refund_cutoff_hours, timezone)")
      .eq("id", data.courtId)
      .maybeSingle();
    if (courtErr || !court) throw new Error("Court not found");
    const venue = (court as unknown as { venues: { name: string; payment_mode: string; refund_cutoff_hours: number; timezone: string | null } | null }).venues;
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

    // The whole discounted price, always. A venue either takes it online or takes
    // nothing online — there is no partial collection any more.
    const discountedTotal = Math.max(0, fullAmount - discountAmount);
    const centavos = Math.round(discountedTotal * 100);
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
    /* Each row carries what its own hour is worth, in proportion to the rates that
       priced it, and the rows add up to `centavos` exactly — the amount PayMongo was
       asked for. The old rule divided the total evenly, which lost a centavo on
       ₱1,000 over three hours and misreported every hour whenever the rates differed.
       `bookingIds` came back from the insert in the order the hours were sent, so
       index i is hour i. */
    const { allocateCheckoutCents } = await import("./checkout-allocation");
    const allocation = allocateCheckoutCents(
      centavos,
      unitPrices.map((p) => Math.round(p * 100)),
    );
    const txRows = bookingIds.map((bid, idx) => ({
      booking_id: bid,
      venue_id: court.venue_id,
      user_id: userId,
      amount: (allocation[idx] ?? 0) / 100,
      currency: "PHP",
      method: data.method,
      provider: "paymongo",
      provider_ref: session.data.id,
      /* CourtHub's own reference for this checkout, the one already sent to PayMongo
         as `reference_number`. The column and its unique index on
         (reference_number, booking_id) have existed since 20260729123000 and were
         never written to, so a checkout could only ever be identified by the
         gateway's session id. Stored now so that identity is ours rather than the
         payment provider's. Historical rows stay null and are not backfilled. */
      reference_number: reference,
      raw: { payment_kind: "full" },
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
      .select("id, court_id, user_id, start_time, end_time, status, payment_status, created_at, unit_price, courts(name, hourly_rate, venue_id, venues(name, payment_mode))")
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
      courts: { name: string; hourly_rate: number; venue_id: number; venues: { name: string; payment_mode: string } };
    };
    const venue = first.courts.venues;
    if (!venue || venue.payment_mode === "none") throw new Error("This venue is not accepting online payments");

    const totalHours = bookings.length;
    const fullAmount = bookings.reduce(
      (sum, b) => sum + Number((b as unknown as { unit_price: number | null }).unit_price ?? first.courts.hourly_rate),
      0,
    );
    const centavos = Math.round(fullAmount * 100);
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
    /* Same allocation as a first attempt. `bookingIds` is sorted here while the
       booking rows arrived in whatever order the query returned, so the price is
       looked up per id rather than by position — lining them up by index would have
       paired hours with other hours' prices. */
    const unitCentsById = new Map(
      bookings.map((b) => {
        const row = b as unknown as { id: number; unit_price: number | null };
        return [
          row.id,
          Math.round(Number(row.unit_price ?? first.courts.hourly_rate) * 100),
        ] as const;
      }),
    );
    const { allocateCheckoutCents } = await import("./checkout-allocation");
    const allocation = allocateCheckoutCents(
      centavos,
      bookingIds.map((bid) => unitCentsById.get(bid) ?? 0),
    );
    const txRows = bookingIds.map((bid, idx) => ({
      booking_id: bid,
      venue_id: first.courts.venue_id,
      user_id: userId,
      amount: (allocation[idx] ?? 0) / 100,
      currency: "PHP",
      method: data.method,
      provider: "paymongo",
      provider_ref: session.data.id,
      /* A retry is a new checkout and gets its own reference, exactly as it gets its
         own session id. The two attempts stay separate rows and separate groups. */
      reference_number: reference,
      raw: { payment_kind: "full" },
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

// Cancel unpaid pending bookings (used when player abandons or cancels checkout).
export const cancelPendingBookings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CancelInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cancelled, error } = await supabase
      .from("bookings")
      // `cancelled_by` matters downstream: the player workspace separates "cancelled by
      // you" from "cancelled by the venue" and from an expired hold, and without this
      // stamp a player's own cancellation is indistinguishable from a timeout.
      .update({ status: "cancelled", payment_status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: userId, cancel_reason: "Payment cancelled by player" })
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

const PlayerCancelInput = z.object({
  bookingIds: z.array(z.number().int().positive()).min(1).max(24),
});

/**
 * A player calling off their own booking, paid or not.
 *
 * This lives on the server for two reasons, and both of them used to be wrong when the
 * player workspace wrote to `bookings` straight from the browser.
 *
 * The cutoff is a rule, not a hint. A disabled button is a courtesy to the person
 * looking at it and no obstacle at all to anyone else, so the one-minute check is made
 * here, against the server's clock, on the rows as they actually are. A client that
 * lies about the time, or simply has a slow one, gets the same answer.
 *
 * And the money columns are not the player's to write. Postgres RLS filters rows, not
 * columns: a policy that lets someone update their own booking lets them update every
 * column of it, `payment_status` included. Routing the write through here — ownership
 * checked, then a fixed set of columns written with the service key — is what stops a
 * player marking their own booking refunded.
 *
 * A paid booking is left `payment_status = 'paid'` with `refund_status = 'pending'`:
 * the venue still holds the money, and it still owes it. Nothing here calls PayMongo.
 * Deciding what actually comes back is the venue's, under its own refund policy, and
 * it settles it from the dashboard.
 */
export const cancelBookingAsPlayer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PlayerCancelInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    /* Read through the caller's own client, so RLS decides what they may see, and the
       ownership check below is belt and braces on top of it. */
    const { data: rows, error } = await supabase
      .from("bookings")
      .select("id, user_id, status, payment_status, start_time, end_time")
      .in("id", data.bookingIds);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) throw new Error("Booking not found");
    if (rows.some((r) => r.user_id !== userId)) throw new Error("Not your booking");

    const now = Date.now();
    const live = rows.filter((r) => r.status !== "cancelled" && r.status !== "expired");
    if (live.length === 0) throw new Error("This booking is already cancelled.");

    /* The session starts when its earliest hour does. A player cancels the whole
       session or none of it, so the cutoff is judged against that one moment rather
       than per row — otherwise a 6–9pm booking would go on offering to cancel its last
       hour at five past six. */
    const startsAt = Math.min(...live.map((r) => new Date(r.start_time).getTime()));
    const endsAt = Math.max(...live.map((r) => new Date(r.end_time).getTime()));

    if (endsAt <= now) {
      throw new Error("This booking has already finished, so there is nothing to cancel.");
    }
    if (startsAt - now <= PLAYER_CANCEL_CUTOFF_MS) {
      throw new Error(
        "This booking starts in less than a minute and can no longer be cancelled. Message the venue if you need help.",
      );
    }

    const ids = live.map((r) => r.id);
    const paidIds = live.filter((r) => r.payment_status === "paid").map((r) => r.id);
    const unpaidIds = ids.filter((id) => !paidIds.includes(id));
    const cancelledAt = new Date().toISOString();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    /* One statement per outcome rather than one per row: the deferred notification
       trigger keys on the status change, so a per-row loop would fire it repeatedly and
       describe a three-hour cancellation as one hour. The refund path in
       `refunds.functions.ts` batches for exactly the same reason. */
    if (unpaidIds.length > 0) {
      const { error: unpaidErr } = await supabaseAdmin
        .from("bookings")
        .update({
          status: "cancelled",
          payment_status: "cancelled",
          cancelled_at: cancelledAt,
          cancelled_by: userId,
          cancel_reason: "Cancelled by player",
        })
        .in("id", unpaidIds);
      if (unpaidErr) throw new Error(unpaidErr.message);

      /* The abandoned checkout row goes with it. `cancelPendingBookings` — the path this
         replaced for unpaid sessions — did this, and dropping it would leave a `pending`
         transaction behind with no live booking, which the tenant ledger would go on
         showing as a payment still being waited on. Narrowed to `pending` so a row that
         somehow settled in the meantime is never overwritten. */
      await supabaseAdmin
        .from("transactions")
        .update({ status: "cancelled" })
        .in("booking_id", unpaidIds)
        .eq("status", "pending");
    }

    if (paidIds.length > 0) {
      /* Two columns doing two different jobs. `status: 'cancelled'` is what takes the
         booking out of the tenant's net sales — `effectiveTxState` keys on the booking's
         own status, so this is the write that fixes a cancelled booking still reading as
         `paid`. `refund_status: 'pending'` is what puts it on the venue's list of refunds
         to settle. `payment_status` stays `paid`, because the money genuinely has not
         moved yet and saying otherwise would claim a refund that has not happened. */
      const { error: paidErr } = await supabaseAdmin
        .from("bookings")
        .update({
          status: "cancelled",
          refund_status: "pending",
          cancelled_at: cancelledAt,
          cancelled_by: userId,
          cancel_reason: "Cancelled by player",
        })
        .in("id", paidIds);
      if (paidErr) throw new Error(paidErr.message);
    }

    return { ok: true, cancelled: ids.length, refundPending: paidIds.length };
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

/**
 * A player refunding their own paid booking.
 *
 * This is a *finalised* refund and nothing less: it calls PayMongo, and only once
 * the money has actually been returned does it write either record. Cancelling a
 * booking is a different act and deliberately does not come through here — the
 * cancel path marks the booking cancelled and leaves the money where it is,
 * because a cancellation is not a refund and the venue's policy decides what
 * happens next.
 *
 * Not currently reached from any screen. Left correct and complete so that wiring
 * it up is a UI decision rather than a correctness one.
 */
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

    /* The money is back, so both records say so — and they say the same thing.
       Every other finalised refund path in the system ends in exactly this state:
       the booking refunded, and the one payment row behind it refunded too.

       Scoped to this booking's own payment row by id. A three-hour checkout shares
       one `provider_ref`, and refunding the middle hour must leave the other two
       paid; updating by checkout would give back two hours nobody asked about.

       Guarded on `status = 'paid'` so calling this twice is harmless: the second
       call matches nothing and cannot overwrite the first refund's timestamp. */
    const settledAt = new Date().toISOString();
    await supabaseAdmin
      .from("transactions")
      .update({ status: "refunded", refunded_at: settledAt })
      .eq("id", tx.id)
      .eq("status", "paid");

    /* The booking's refund bookkeeping, which this path used to leave half-written:
       it set `payment_status` and nothing else, so a refund made here looked
       different from one settled by an admin. `refund_status` is what the player's
       own screens read, and what tells the tenant the refund is finished rather
       than pending. */
    await supabaseAdmin
      .from("bookings")
      .update({
        status: "cancelled",
        payment_status: "refunded",
        refund_status: "refunded",
        refund_method: "paymongo",
        refund_settled_at: settledAt,
      })
      .eq("id", booking.id);

    return { ok: true };
  });
