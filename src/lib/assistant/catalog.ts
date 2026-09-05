/**
 * The one read the assistant answers from.
 *
 * Venues and their courts arrive in a single query and are held briefly, because a
 * conversation asks five questions about the same handful of venues and re-fetching
 * per message would be the only expensive thing about this feature. Availability is
 * deliberately *not* cached here — a free slot goes stale in seconds, so it is read
 * live per question in the resolvers.
 */

import { supabase } from "@/integrations/supabase/client";
import { maxRate, minRate, normalizeRules, type RateRule } from "@/lib/court-pricing";
import { effectiveHours, normalizeHours, type HoursMap } from "@/lib/operating-hours";
import { DEFAULT_TIMEZONE } from "@/lib/tz";

export type FeeItem = { label: string; amount: number };

export type CatalogCourt = {
  id: number;
  venueId: number;
  name: string;
  sport: string;
  sportSlug: string;
  hourlyRate: number;
  rules: RateRule[];
  /** Already resolved against the venue when the court inherits. */
  hours: HoursMap;
  isIndoor: boolean;
  comingSoon: boolean;
  surface: string | null;
  capacity: number;
  playerCapacity: number | null;
  amenities: string[];
  voucherEnabled: boolean;
  /** Manager-imposed closures, keyed by weekday and by exact date. */
  blockedHours: Record<string, number[]>;
  blockedDates: Record<string, number[]>;
  /** Cheapest and dearest hour across the open week, for "from ₱X" answers. */
  minRate: number;
  maxRate: number;
};

export type CatalogVenue = {
  id: number;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  timezone: string;
  hours: HoursMap;
  hoursText: string | null;
  amenities: string[];
  facilityServices: string[];
  foodBeverages: string[];
  fees: FeeItem[];
  feesNotes: string | null;
  paymentMode: string;
  refundCutoffHours: number;
  cancellationNotes: string | null;
  rules: string | null;
  description: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  mapEmoji: string | null;
  courts: CatalogCourt[];
};

export type Catalog = {
  venues: CatalogVenue[];
  byVenue: Map<number, CatalogVenue>;
  byCourt: Map<number, { court: CatalogCourt; venue: CatalogVenue }>;
  sports: { name: string; slug: string }[];
  /** Every distinct amenity string any venue or court actually lists. The searchable
   *  amenity vocabulary is this, not a constant in the source. */
  amenityValues: string[];
};

const SELECT =
  "id, name, address, latitude, longitude, timezone, operating_hours, operating_hours_text, " +
  "amenities, facility_services, food_beverages, fees, fees_notes, payment_mode, " +
  "refund_cutoff_hours, cancellation_notes, rules, description, contact_phone, contact_email, map_emoji, " +
  "courts(id, name, hourly_rate, rate_rules, operating_hours, inherit_venue_hours, is_indoor, " +
  "coming_soon, surface_type, capacity, player_capacity, amenities, is_active, voucher_enabled, " +
  "blocked_hours, blocked_dates, sports(name, slug))";

type RawCourt = {
  id: number;
  name: string;
  hourly_rate: number;
  rate_rules: unknown;
  operating_hours: unknown;
  inherit_venue_hours: boolean | null;
  is_indoor: boolean | null;
  coming_soon: boolean | null;
  surface_type: string | null;
  capacity: number | null;
  player_capacity: number | null;
  amenities: string[] | null;
  is_active: boolean | null;
  voucher_enabled: boolean | null;
  blocked_hours: unknown;
  blocked_dates: unknown;
  sports: { name: string; slug: string } | null;
};

type RawVenue = {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  operating_hours: unknown;
  operating_hours_text: string | null;
  amenities: string[] | null;
  facility_services: string[] | null;
  food_beverages: string[] | null;
  fees: unknown;
  fees_notes: string | null;
  payment_mode: string | null;
  refund_cutoff_hours: number | null;
  cancellation_notes: string | null;
  rules: string | null;
  description: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  map_emoji: string | null;
  courts: RawCourt[] | null;
};

/** `{ "mon": [6,7], "2026-08-30": [19] }` — anything else in the column is ignored. */
function asHourMap(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map(Number).filter((n) => Number.isFinite(n));
  }
  return out;
}

function shape(rows: RawVenue[]): Catalog {
  const venues: CatalogVenue[] = [];
  const sports = new Map<string, string>();

  for (const r of rows) {
    const venueHours = normalizeHours(r.operating_hours);
    const venue: CatalogVenue = {
      id: r.id,
      name: r.name,
      address: r.address ?? "",
      lat: r.latitude == null ? null : Number(r.latitude),
      lng: r.longitude == null ? null : Number(r.longitude),
      timezone: r.timezone || DEFAULT_TIMEZONE,
      hours: venueHours,
      hoursText: r.operating_hours_text,
      amenities: r.amenities ?? [],
      facilityServices: r.facility_services ?? [],
      foodBeverages: r.food_beverages ?? [],
      fees: Array.isArray(r.fees) ? (r.fees as FeeItem[]) : [],
      feesNotes: r.fees_notes,
      paymentMode: r.payment_mode ?? "none",
      refundCutoffHours: Number(r.refund_cutoff_hours ?? 0),
      cancellationNotes: r.cancellation_notes,
      rules: r.rules,
      description: r.description,
      contactPhone: r.contact_phone,
      contactEmail: r.contact_email,
      mapEmoji: r.map_emoji,
      courts: [],
    };

    for (const c of r.courts ?? []) {
      if (c.is_active === false) continue;
      const rules = normalizeRules(c.rate_rules);
      const hours = effectiveHours(
        { inherit_venue_hours: c.inherit_venue_hours, operating_hours: c.operating_hours },
        r.operating_hours,
      );
      const base = Number(c.hourly_rate) || 0;
      if (c.sports) sports.set(c.sports.slug, c.sports.name);
      venue.courts.push({
        id: c.id,
        venueId: r.id,
        name: c.name,
        sport: c.sports?.name ?? "",
        sportSlug: c.sports?.slug ?? "",
        hourlyRate: base,
        rules,
        hours,
        isIndoor: c.is_indoor === true,
        comingSoon: c.coming_soon === true,
        surface: c.surface_type,
        capacity: Number(c.capacity ?? 1),
        playerCapacity: c.player_capacity == null ? null : Number(c.player_capacity),
        amenities: c.amenities ?? [],
        voucherEnabled: c.voucher_enabled === true,
        blockedHours: asHourMap(c.blocked_hours),
        blockedDates: asHourMap(c.blocked_dates),
        minRate: minRate(base, rules, hours),
        maxRate: maxRate(base, rules, hours),
      });
    }
    venues.push(venue);
  }

  const byVenue = new Map(venues.map((v) => [v.id, v]));
  const byCourt = new Map<number, { court: CatalogCourt; venue: CatalogVenue }>();
  for (const v of venues) for (const c of v.courts) byCourt.set(c.id, { court: c, venue: v });

  const amenities = new Set<string>();
  for (const v of venues) {
    for (const a of [...v.amenities, ...v.facilityServices, ...v.foodBeverages]) {
      if (a && a.trim()) amenities.add(a.trim());
    }
    for (const c of v.courts)
      for (const a of c.amenities) if (a && a.trim()) amenities.add(a.trim());
  }

  return {
    venues,
    byVenue,
    byCourt,
    sports: [...sports].map(([slug, name]) => ({ slug, name })),
    amenityValues: [...amenities],
  };
}

const TTL_MS = 60_000;
let cache: { key: string; at: number; value: Promise<Catalog> } | null = null;

/**
 * Drop the cached catalogue in this browser.
 *
 * The TTL is a floor, not a policy: after a manager saves a venue or a court, the
 * browser that made the change should not spend up to a minute telling its own user
 * that the change has not happened. Other sessions still catch up on the TTL, which
 * is fine for metadata — availability was never cached at all.
 */
export function invalidateAssistantCatalog(): void {
  cache = null;
}

/**
 * @param venueIds Restricts the catalog to these venues — how a tenant's assistant
 *   is kept to venues they are staff on. Omitted for players, who see every active
 *   venue, exactly as /explore already shows them.
 */
export function loadCatalog(venueIds?: number[]): Promise<Catalog> {
  const key = venueIds
    ? venueIds
        .slice()
        .sort((a, b) => a - b)
        .join(",")
    : "all";
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.value;

  const value = (async () => {
    let q = supabase.from("venues").select(SELECT).eq("is_active", true).order("name").limit(500);
    if (venueIds) {
      if (venueIds.length === 0) return shape([]);
      q = q.in("id", venueIds);
    }
    const { data, error } = await q;
    if (error) throw error;
    return shape((data ?? []) as unknown as RawVenue[]);
  })();

  cache = { key, at: now, value };
  /* A failed load must not be served for the next minute. */
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

/** Venue ids the signed-in manager is staff on — the tenant assistant's whole world. */
export async function staffVenueIds(userId: string): Promise<number[]> {
  const { data, error } = await supabase.from("staff").select("venue_id").eq("user_id", userId);
  if (error) throw error;
  return Array.from(new Set((data ?? []).map((r) => r.venue_id)));
}

/**
 * Keep the assistant's catalogue honest about changes this browser just made.
 *
 * Rather than adding an invalidation call to every mutation — six for venues alone,
 * and one forgotten call is a manager being told their own new court does not exist
 * — this listens once to the mutation cache. Any successful write may have touched
 * something the assistant reads, and dropping a 60-second metadata cache costs one
 * query on the next question.
 *
 * Only this browser is affected. Others still catch up on the TTL, which is right
 * for metadata; availability was never cached at all.
 */
export function registerAssistantCacheInvalidation(client: {
  getMutationCache: () => {
    subscribe: (
      cb: (event: { type: string; mutation?: { state: { status: string } } }) => void,
    ) => () => void;
  };
}): () => void {
  return client.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.mutation?.state.status === "success") {
      invalidateAssistantCatalog();
    }
  });
}
