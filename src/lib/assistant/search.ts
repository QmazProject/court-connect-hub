/**
 * Broad discovery.
 *
 * One question, one round trip. `search_available_courts` filters the whole eligible
 * catalogue, prices each candidate at the real rate for the hours actually asked
 * about, orders it and returns a page — so the assistant no longer walks venues in
 * the browser, and no longer has to stop at the first handful.
 *
 * The fallback below exists because the migration ships separately from this code.
 * Until it is pushed, discovery still works by the old per-court route; it is capped,
 * it says so, and `degraded` is what the answer uses to say it honestly rather than
 * implying it searched everything.
 */

import { supabase } from "@/integrations/supabase/client";
import { peso } from "@/lib/court-pricing";
import { haversineKm } from "@/lib/geo";
import { zonedDayOfWeek } from "@/lib/tz";
import type { Catalog, CatalogCourt, CatalogVenue } from "./catalog";
import { courtDaySlots, freeHours } from "./slots";

export type DiscoverOrder = "relevance" | "price" | "distance" | "time";

export type DiscoverParams = {
  dateISO: string;
  /** Hours that must ALL be free. Null means "any free block". */
  hours: number[] | null;
  minDuration: number;
  sportSlug: string | null;
  /** Narrowing only — never the authorisation boundary. */
  venueIds: number[] | null;
  tenantScope: boolean;
  origin: { lat: number; lng: number } | null;
  maxKm: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  payment: "online" | "venue" | null;
  amenities: string[] | null;
  order: DiscoverOrder;
  limit: number;
  offset: number;
  now: Date;
};

export type DiscoverRow = {
  courtId: number;
  venueId: number;
  freeHours: number[];
  freeHourCount: number;
  runStart: number;
  runLength: number;
  periodTotal: number;
  periodRate: number;
  distanceKm: number | null;
};

export type DiscoverResult = {
  rows: DiscoverRow[];
  /** Matches across the whole catalogue, not just this page. */
  total: number;
  checkedAt: Date;
  /** The server function was unavailable and the capped client path ran instead. */
  degraded: boolean;
  /** Venues the degraded path managed to look at. */
  scanned?: number;
};

/** How many venues the fallback will walk before it gives up and says so. */
export const FALLBACK_VENUE_CAP = 8;

export function defaultParams(
  over: Partial<DiscoverParams> & { dateISO: string; now: Date },
): DiscoverParams {
  return {
    hours: null,
    minDuration: 1,
    sportSlug: null,
    venueIds: null,
    tenantScope: false,
    origin: null,
    maxKm: null,
    minPrice: null,
    maxPrice: null,
    payment: null,
    amenities: null,
    order: "relevance",
    limit: 5,
    offset: 0,
    ...over,
  };
}

type Rpc = {
  court_id: number;
  venue_id: number;
  free_hours: number[] | null;
  free_hour_count: number;
  run_start: number;
  run_length: number;
  period_total: number | string;
  period_rate: number | string;
  distance_km: number | null;
  total_matches: number | string;
};

/** PostgREST's "the function is not in the schema cache" shapes. */
function isMissingFunction(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("could not find the function") || m.includes("does not exist");
}

export async function discover(params: DiscoverParams, catalog: Catalog): Promise<DiscoverResult> {
  const { data, error } = await supabase.rpc("search_available_courts", {
    _date: params.dateISO,
    _hours: params.hours,
    _min_duration: params.minDuration,
    _sport_slug: params.sportSlug,
    _venue_ids: params.venueIds,
    _tenant_scope: params.tenantScope,
    _lat: params.origin?.lat ?? null,
    _lng: params.origin?.lng ?? null,
    _max_km: params.maxKm,
    _min_price: params.minPrice,
    _max_price: params.maxPrice,
    _payment: params.payment,
    _amenities: params.amenities,
    _order: params.order,
    _now: params.now.toISOString(),
    _limit: params.limit,
    _offset: params.offset,
  });

  if (error) {
    if (isMissingFunction(error)) return fallbackDiscover(params, catalog);
    throw error;
  }

  const rows = (data ?? []) as unknown as Rpc[];
  return {
    rows: rows.map((r) => ({
      courtId: r.court_id,
      venueId: r.venue_id,
      freeHours: r.free_hours ?? [],
      freeHourCount: r.free_hour_count,
      runStart: r.run_start,
      runLength: r.run_length,
      periodTotal: Number(r.period_total),
      periodRate: Number(r.period_rate),
      distanceKm: r.distance_km == null ? null : Number(r.distance_km),
    })),
    total: rows.length > 0 ? Number(rows[0].total_matches) : 0,
    checkedAt: new Date(),
    degraded: false,
  };
}

/* ---------------------------------------------------------------- *
 * Fallback: the pre-migration route, capped and honest about it.
 * ---------------------------------------------------------------- */

function matchesAmenities(venue: CatalogVenue, court: CatalogCourt, wanted: string[]): boolean {
  const have = [
    ...venue.amenities,
    ...venue.facilityServices,
    ...venue.foodBeverages,
    ...court.amenities,
  ].map((a) => a.toLowerCase());
  return wanted.every((w) => have.some((h) => h.includes(w.toLowerCase())));
}

async function fallbackDiscover(params: DiscoverParams, catalog: Catalog): Promise<DiscoverResult> {
  const dow = zonedDayOfWeek(params.dateISO);
  const dayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dow];

  let venues = catalog.venues.filter((v) => {
    const w = v.hours[dayKey];
    if (!w || w === "closed") return false;
    if (params.venueIds && !params.venueIds.includes(v.id)) return false;
    if (params.payment === "online" && (v.paymentMode ?? "none") === "none") return false;
    if (params.payment === "venue" && (v.paymentMode ?? "none") !== "none") return false;
    return true;
  });

  if (params.origin) {
    const o = params.origin;
    venues = venues
      .filter((v) => v.lat != null && v.lng != null)
      .filter(
        (v) => params.maxKm == null || haversineKm(o, { lat: v.lat!, lng: v.lng! }) <= params.maxKm,
      )
      .sort(
        (a, b) =>
          haversineKm(o, { lat: a.lat!, lng: a.lng! }) -
          haversineKm(o, { lat: b.lat!, lng: b.lng! }),
      );
  }

  const scanned = Math.min(venues.length, FALLBACK_VENUE_CAP);
  const rows: DiscoverRow[] = [];

  for (const venue of venues.slice(0, FALLBACK_VENUE_CAP)) {
    const courts = venue.courts.filter(
      (c) =>
        !c.comingSoon &&
        (!params.sportSlug || c.sportSlug === params.sportSlug) &&
        (!params.amenities || matchesAmenities(venue, c, params.amenities)),
    );
    for (const court of courts) {
      const slots = await courtDaySlots(court, venue, params.dateISO, params.now.getTime());
      const free = freeHours(slots);
      const byHour = new Map(free.map((s) => [s.hour, s]));

      let runStart: number | null = null;
      let total = 0;
      const need = params.hours;
      if (need && need.length > 0) {
        if (!need.every((h) => byHour.has(h))) continue;
        runStart = need[0];
        total = need.reduce((s, h) => s + (byHour.get(h)?.rate ?? 0), 0);
      } else {
        const dur = Math.max(1, params.minDuration);
        let best: { start: number; total: number } | null = null;
        for (const s of free) {
          const block = Array.from({ length: dur }, (_, i) => byHour.get(s.hour + i));
          if (block.some((x) => !x)) continue;
          const t = block.reduce((sum, x) => sum + (x?.rate ?? 0), 0);
          if (!best || t < best.total) best = { start: s.hour, total: t };
        }
        if (!best) continue;
        runStart = best.start;
        total = best.total;
      }

      const runLength = need && need.length > 0 ? need.length : Math.max(1, params.minDuration);
      const rate = total / runLength;
      if (params.maxPrice != null && rate > params.maxPrice) continue;
      if (params.minPrice != null && rate < params.minPrice) continue;

      rows.push({
        courtId: court.id,
        venueId: venue.id,
        freeHours: free.map((s) => s.hour),
        freeHourCount: free.length,
        runStart: runStart!,
        runLength,
        periodTotal: total,
        periodRate: rate,
        distanceKm:
          params.origin && venue.lat != null && venue.lng != null
            ? haversineKm(params.origin, { lat: venue.lat, lng: venue.lng })
            : null,
      });
    }
  }

  rows.sort(compareBy(params.order));
  return {
    rows: rows.slice(params.offset, params.offset + params.limit),
    total: rows.length,
    checkedAt: new Date(),
    degraded: true,
    scanned,
  };
}

/** The same precedence the SQL ORDER BY applies, so both paths rank alike. */
export function compareBy(order: DiscoverOrder) {
  return (a: DiscoverRow, b: DiscoverRow): number => {
    const dist = (r: DiscoverRow) =>
      r.distanceKm == null ? Number.POSITIVE_INFINITY : r.distanceKm;
    if (order === "price" && a.periodRate !== b.periodRate) return a.periodRate - b.periodRate;
    if (order === "distance" && dist(a) !== dist(b)) return dist(a) - dist(b);
    if (order === "time" && a.runStart !== b.runStart) return a.runStart - b.runStart;
    if (dist(a) !== dist(b)) return dist(a) - dist(b);
    if (a.periodRate !== b.periodRate) return a.periodRate - b.periodRate;
    if (a.runStart !== b.runStart) return a.runStart - b.runStart;
    return a.courtId - b.courtId;
  };
}

/**
 * Why this row came first — only ever citing the criteria the ordering actually
 * used, so "Why this one?" cannot claim a reason that played no part.
 */
export function rankReason(row: DiscoverRow, order: DiscoverOrder, hours: number[] | null): string {
  const bits: string[] = [];
  if (hours && hours.length > 0)
    bits.push(`free for the whole ${hours.length}-hour block you asked about`);
  else bits.push(`has ${row.freeHourCount} free hour${row.freeHourCount === 1 ? "" : "s"}`);
  if (order === "price") bits.push(`cheapest at ${peso(row.periodRate)}/hr for those hours`);
  else if (order === "distance" && row.distanceKm != null)
    bits.push(`closest at ${row.distanceKm.toFixed(1)} km`);
  else if (order === "time") bits.push(`starts earliest, at ${row.runStart}:00`);
  else {
    if (row.distanceKm != null) bits.push(`${row.distanceKm.toFixed(1)} km away`);
    bits.push(`${peso(row.periodRate)}/hr`);
  }
  return bits.join(", ");
}
