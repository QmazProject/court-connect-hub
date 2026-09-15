/** Taking a walk-in booking.
 *
 *  Deliberately thin. Every decision that matters is made by the database:
 *
 *    who may do this   `venue_allows(venue_id, 'manager')`, checked first inside
 *                      `tenant_create_walkin_booking()`
 *    what it costs     `court_price_for_hours()`, from the tenant's own rate
 *                      rules — no price crosses the wire from the client
 *    whether it fits   the `validate_booking()` trigger, which takes
 *                      `pg_advisory_xact_lock(physical_court_id)` and re-checks
 *                      hours, directional blocks and capacity
 *
 *  So this function validates shapes, converts the venue's wall-clock hours into
 *  the UTC instants the table stores, and forwards. It must not grow a second
 *  availability check: an answer computed here could disagree with the trigger's,
 *  and the trigger's is the one that decides.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { zonedHourToUtc, DEFAULT_TIMEZONE } from "@/lib/tz";

const WalkInInput = z.object({
  courtId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().max(40).optional(),
  customerEmail: z.string().trim().email().max(160).optional(),
  playerCount: z.number().int().min(1).max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(["cash", "gcash", "maya", "bank", "other"]).default("cash"),
  paid: z.boolean().default(true),
  linkUserId: z.string().uuid().optional(),
});

export type WalkInResult = {
  bookingId: number;
  bookingNo: number;
  reference: string;
  total: number;
  startsAt: string;
  endsAt: string;
};

export const createWalkInBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => WalkInInput.parse(data))
  .handler(async ({ data, context }): Promise<WalkInResult> => {
    const { supabase } = context;

    if (data.endHour <= data.startHour) {
      throw new Error("The booking must end after it starts.");
    }

    // The venue's timezone decides which instant "7 PM" is. Reusing the same
    // helper the player-side checkout uses is what keeps a walk-in and an online
    // booking competing for the identical row of hours rather than for two
    // windows that merely look the same on screen.
    const timezone = DEFAULT_TIMEZONE;
    const start = zonedHourToUtc(data.date, data.startHour, timezone);
    const end = zonedHourToUtc(data.date, data.endHour, timezone);

    const { data: rows, error } = await supabase.rpc("tenant_create_walkin_booking", {
      _court_id: data.courtId,
      _start: start.toISOString(),
      _end: end.toISOString(),
      _customer_name: data.customerName,
      _customer_phone: data.customerPhone ?? null,
      _customer_email: data.customerEmail ?? null,
      _player_count: data.playerCount ?? null,
      _notes: data.notes ?? null,
      _payment_method: data.paymentMethod,
      _paid: data.paid,
      _link_user_id: data.linkUserId ?? null,
    });

    if (error) {
      // The trigger's refusals are the interesting ones: they mean somebody else
      // took the slot between the screen drawing it and this insert. Say so
      // plainly so the caller re-reads availability instead of retrying blind.
      const message = error.message ?? "";
      if (/capacity|already booked|blocked|operating hours/i.test(message)) {
        throw new Error(`That slot is no longer available — ${message}`);
      }
      throw new Error(message || "Could not create the walk-in booking.");
    }

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("Could not create the walk-in booking.");

    return {
      bookingId: Number(row.booking_id),
      bookingNo: Number(row.booking_no),
      reference: String(row.reference),
      total: Number(row.total),
      startsAt: String(row.starts_at),
      endsAt: String(row.ends_at),
    };
  });
