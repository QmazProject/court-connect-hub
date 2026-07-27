import { supabase } from "@/integrations/supabase/client";
import { groupBookingSessions, type HourlyBooking } from "@/lib/booking-groups";
import { effectiveHours, openHoursForDate, type HoursMap } from "@/lib/operating-hours";
import type { HoursConflict } from "@/components/HoursConflictDialog";

type Row = HourlyBooking & {
  courts: {
    name: string;
    venue_id: number;
    inherit_venue_hours: boolean | null;
    operating_hours: unknown;
  } | null;
};

const localDateISO = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Upcoming confirmed bookings that would sit outside a proposed schedule.
 * `scope` is either the venue's new hours (affects every inheriting court)
 * or a single court's new hours.
 */
export async function findHoursConflicts(opts: {
  venueId: number;
  newVenueHours?: HoursMap;
  courtId?: number;
  newCourtHours?: HoursMap;
  courtInherits?: boolean;
}): Promise<HoursConflict[]> {
  const nowIso = new Date().toISOString();
  let q = supabase
    .from("bookings")
    .select("id, court_id, user_id, start_time, end_time, status, payment_status, courts!inner(name, venue_id, inherit_venue_hours, operating_hours)")
    .eq("status", "confirmed")
    .gte("start_time", nowIso)
    .eq("courts.venue_id", opts.venueId)
    .order("start_time", { ascending: true })
    .limit(500);
  if (opts.courtId) q = q.eq("court_id", opts.courtId);

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data as unknown as Row[]) ?? [];
  if (rows.length === 0) return [];

  const outside = rows.filter((r) => {
    const court = r.courts;
    if (!court) return false;
    let hours: HoursMap;
    if (opts.courtId) {
      hours = opts.courtInherits && opts.newVenueHours ? opts.newVenueHours : (opts.newCourtHours as HoursMap);
    } else if (court.inherit_venue_hours !== false && opts.newVenueHours) {
      hours = opts.newVenueHours;
    } else {
      hours = effectiveHours(
        { inherit_venue_hours: court.inherit_venue_hours, operating_hours: court.operating_hours },
        opts.newVenueHours ?? {},
      );
    }
    const open = openHoursForDate(hours, localDateISO(r.start_time));
    return !open.has(new Date(r.start_time).getHours());
  });
  if (outside.length === 0) return [];

  const uids = Array.from(new Set(outside.map((r) => r.user_id!).filter(Boolean)));
  const { data: profiles } = uids.length
    ? await supabase.from("profiles").select("id, full_name").in("id", uids)
    : { data: [] as { id: string; full_name: string | null }[] };
  const nameMap = new Map((profiles ?? []).map((p) => [p.id, p.full_name || "Player"]));

  return groupBookingSessions(outside).map((s) => ({
    bookingIds: s.ids,
    startTime: s.start_time,
    endTime: s.end_time,
    courtName: s.first.courts?.name ?? `Court #${s.first.court_id}`,
    playerName: nameMap.get(s.first.user_id ?? "") ?? "Player",
    paid: s.items.some((i) => i.payment_status === "paid"),
  }));
}
