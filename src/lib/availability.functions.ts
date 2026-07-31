import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const rangeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const courtSchema = rangeSchema.extend({ courtId: z.number().int().positive() });
const venueSchema = rangeSchema.extend({ venueId: z.number().int().positive() });

export type CourtAvailabilityRow = {
  hour_start: string;
  remaining: number;
  blocked_by_other_sport: boolean;
  held_for_payment: boolean;
};

export type VenueDayBookingRow = {
  court_id: number;
  start_time: string;
  end_time: string;
};

function publicAvailabilityClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public configuration is unavailable.");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Public availability read. The underlying SECURITY DEFINER RPCs are no longer
 * callable by anon/authenticated roles. Returned data is anonymous (no player
 * identity or payment information), so it must not require a service-role key.
 */
export const getCourtAvailability = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => courtSchema.parse(data))
  .handler(async ({ data }): Promise<CourtAvailabilityRow[]> => {
    const { data: rows, error } = await publicAvailabilityClient().rpc("get_court_availability", {
      _court_id: data.courtId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as CourtAvailabilityRow[];
  });

export const getVenueDayBookings = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => venueSchema.parse(data))
  .handler(async ({ data }): Promise<VenueDayBookingRow[]> => {
    const { data: rows, error } = await publicAvailabilityClient().rpc("get_venue_day_bookings", {
      _venue_id: data.venueId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as VenueDayBookingRow[];
  });
