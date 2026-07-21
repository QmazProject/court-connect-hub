import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, MapPin, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const searchSchema = z.object({
  sport: z.string().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: Landing,
});

type CourtRow = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  sports: { name: string; slug: string } | null;
  venues: { name: string; address: string } | null;
};

type Sport = { id: number; name: string; slug: string };

const SPORT_ICONS: Record<string, string> = {
  basketball: "🏀",
  tennis: "🎾",
  badminton: "🏸",
  football: "⚽",
  soccer: "⚽",
  volleyball: "🏐",
  pickleball: "🥎",
  "table-tennis": "🏓",
  squash: "🎯",
};

function Landing() {
  const { sport } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const { data: sports } = useQuery({
    queryKey: ["sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("id, name, slug").order("name");
      if (error) throw error;
      return data as Sport[];
    },
  });

  const { data: courts, isLoading } = useQuery({
    queryKey: ["courts", "public", sport ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, venue_id, sports!inner(name, slug), venues(id, name, address)")
        .order("id", { ascending: false })
        .limit(200);
      if (sport) q = q.eq("sports.slug", sport);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as (CourtRow & { venue_id: number; venues: { id: number; name: string; address: string } | null })[];
    },
    enabled: !!sport,
  });


  // Venue search (always available on landing)
  const [venueQuery, setVenueQuery] = useState("");
  const [venueFocus, setVenueFocus] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterSport, setFilterSport] = useState<string>("");
  const [filterCity, setFilterCity] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [nearby, setNearby] = useState<{ lat: number; lng: number } | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setVenueFocus(false);
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const hasFilters = !!(filterSport || filterCity.trim() || minPrice || maxPrice);
  const searchActive = venueQuery.trim().length > 0 || hasFilters || !!nearby;

  const { data: venueMatches } = useQuery({
    queryKey: [
      "venue-search",
      venueQuery.trim().toLowerCase(),
      filterSport,
      filterCity.trim().toLowerCase(),
      minPrice,
      maxPrice,
      nearby ? `${nearby.lat.toFixed(3)},${nearby.lng.toFixed(3)}` : "",
    ],
    queryFn: async () => {
      const term = venueQuery.trim();
      let q = supabase
        .from("venues")
        .select("id, name, address, latitude, longitude, courts!inner(id, hourly_rate, sports!inner(slug, name))")
        .order("name")
        .limit(50);
      if (term) q = q.ilike("name", `%${term}%`);
      if (filterCity.trim()) q = q.ilike("address", `%${filterCity.trim()}%`);
      if (filterSport) q = q.eq("courts.sports.slug", filterSport);
      if (minPrice) q = q.gte("courts.hourly_rate", Number(minPrice));
      if (maxPrice) q = q.lte("courts.hourly_rate", Number(maxPrice));
      const { data, error } = await q;
      if (error) throw error;
      type Row = { id: number; name: string; address: string; latitude: number | null; longitude: number | null; courts: { id: number; hourly_rate: number; sports: { slug: string; name: string } | null }[] };
      let rows = (data as unknown as Row[]) ?? [];
      if (nearby) {
        rows = rows
          .filter((r) => r.latitude != null && r.longitude != null)
          .map((r) => ({ ...r, _d: haversineKm(nearby, { lat: r.latitude as number, lng: r.longitude as number }) }))
          .sort((a: any, b: any) => a._d - b._d) as any;
      }
      return rows.slice(0, 24).map((r) => {
        const rates = r.courts?.map((c) => Number(c.hourly_rate)) ?? [];
        const sportSet = new Map<string, string>();
        r.courts?.forEach((c) => c.sports && sportSet.set(c.sports.slug, c.sports.name));
        const dist = nearby && r.latitude != null && r.longitude != null
          ? haversineKm(nearby, { lat: r.latitude as number, lng: r.longitude as number })
          : null;
        return {
          id: r.id,
          name: r.name,
          address: r.address,
          courtCount: r.courts?.length ?? 0,
          minRate: rates.length ? Math.min(...rates) : null,
          sports: Array.from(sportSet.values()),
          distanceKm: dist,
        };
      });
    },
    enabled: searchActive,
  });


  const requestNearby = () => {
    if (!("geolocation" in navigator)) {
      setNearbyError("Location not supported on this device.");
      return;
    }
    setNearbyLoading(true);
    setNearbyError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setNearby({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setNearbyLoading(false);
        setVenueFocus(true);
      },
      (err) => {
        setNearbyError(err.message || "Please allow location access.");
        setNearbyLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // All existing venues (shown below the sport picker)
  const { data: allVenues, isLoading: venuesLoading } = useQuery({
    queryKey: ["venues", "all-landing"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address, courts(id, hourly_rate, sports(slug, name))")
        .order("name")
        .limit(100);
      if (error) throw error;
      type Row = {
        id: number;
        name: string;
        address: string;
        courts: { id: number; hourly_rate: number; sports: { slug: string; name: string } | null }[];
      };
      return (data as unknown as Row[]).map((v) => {
        const rates = v.courts?.map((c) => Number(c.hourly_rate)) ?? [];
        const sportSet = new Map<string, string>();
        v.courts?.forEach((c) => c.sports && sportSet.set(c.sports.slug, c.sports.name));
        return {
          id: v.id,
          name: v.name,
          address: v.address,
          courtCount: v.courts?.length ?? 0,
          minRate: rates.length ? Math.min(...rates) : null,
          sports: Array.from(sportSet.values()),
        };
      });
    },
    enabled: !sport,
  });


  // Sport picker view
  if (!sport) {
    return (
      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="court-pattern absolute inset-0 opacity-[0.08]" aria-hidden />
          <div className="relative mx-auto max-w-5xl px-6 py-20 text-center md:py-28">
            <div className="flex flex-col items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_theme(colors.primary)]" />
                Premium Sports Hub
              </span>
              <h2 className="font-display text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
                <span className="bg-gradient-to-r from-primary via-primary to-foreground bg-clip-text text-transparent">
                  Dedicated Court
                </span>{" "}
                <span className="text-foreground">Facility</span>
              </h2>
              <p className="mx-auto max-w-2xl text-base text-muted-foreground md:text-lg">
                Book premium courts in seconds — real-time availability, transparent pricing, zero hassle.
              </p>
            </div>


            <div ref={searchRef} className="relative mx-auto mt-6 max-w-xl">
              <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 sm:px-5 sm:py-3">
                <Search className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <input
                  type="text"
                  value={venueQuery}
                  onChange={(e) => setVenueQuery(e.target.value)}
                  onFocus={() => setVenueFocus(true)}
                  placeholder="Tap to find a venue you want"
                  className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  aria-label="Filters"
                  onClick={() => { setFilterOpen((v) => !v); setVenueFocus(true); }}
                  className={
                    "edge-glow flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition " +
                    (hasFilters || filterOpen
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary hover:text-primary")
                  }
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={requestNearby}
                  className={
                    "edge-glow flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                    (nearby
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary hover:text-primary")
                  }
                >
                  <MapPin className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{nearbyLoading ? "Locating…" : "Nearby"}</span>
                </button>
              </div>

              {filterOpen && (
                <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-2xl border border-border bg-card p-4 text-left shadow-lg">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Filters</div>
                    <button
                      type="button"
                      onClick={() => { setFilterSport(""); setFilterCity(""); setMinPrice(""); setMaxPrice(""); }}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold text-muted-foreground">Sport</span>
                      <select
                        value={filterSport}
                        onChange={(e) => setFilterSport(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      >
                        <option value="">Any sport</option>
                        {(sports ?? []).map((s) => (
                          <option key={s.id} value={s.slug}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted-foreground">City / Province</span>
                      <input
                        type="text"
                        value={filterCity}
                        onChange={(e) => setFilterCity(e.target.value)}
                        placeholder="e.g. Cebu, Makati"
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted-foreground">Min price (₱/hr)</span>
                      <input
                        type="number"
                        min={0}
                        value={minPrice}
                        onChange={(e) => setMinPrice(e.target.value)}
                        placeholder="0"
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted-foreground">Max price (₱/hr)</span>
                      <input
                        type="number"
                        min={0}
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(e.target.value)}
                        placeholder="Any"
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setFilterOpen(false)}
                      className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}

              {nearbyError && (
                <div className="mt-2 flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <span>{nearbyError}</span>
                  <button onClick={() => setNearbyError(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
                </div>
              )}

            </div>

            {/* Unified venue list: search/filter/nearby results OR all existing venues */}
            <div className="mx-auto mt-8 max-w-5xl text-left">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl font-bold tracking-tight md:text-2xl">
                    {searchActive ? "Search results" : "Existing venues"}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground md:text-sm">
                    {searchActive
                      ? nearby
                        ? "Sorted by distance from you."
                        : "Matching your search and filters."
                      : "Browse every court facility on CourtHub."}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {searchActive && (
                    <button
                      type="button"
                      onClick={() => {
                        setVenueQuery("");
                        setFilterSport("");
                        setFilterCity("");
                        setMinPrice("");
                        setMaxPrice("");
                        setNearby(null);
                      }}
                      className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground hover:border-primary hover:text-primary"
                    >
                      Reset
                    </button>
                  )}
                  {(searchActive ? venueMatches : allVenues) && (
                    <span className="hidden rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground sm:inline-block">
                      {(searchActive ? venueMatches! : allVenues!).length}{" "}
                      {(searchActive ? venueMatches! : allVenues!).length === 1 ? "venue" : "venues"}
                    </span>
                  )}
                </div>
              </div>

              {(searchActive ? false : venuesLoading) ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted" />
                  ))}
                </div>
              ) : (() => {
                const list = searchActive ? venueMatches : allVenues;
                if (!list || list.length === 0) {
                  return (
                    <div className="rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center text-sm text-muted-foreground">
                      {searchActive ? "No venues match your search." : "No venues have been created yet."}
                    </div>
                  );
                }
                return (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((v: any) => (
                      <Link
                        key={v.id}
                        to="/venues/$venueId"
                        params={{ venueId: String(v.id) }}
                        search={{}}
                        className="group flex flex-col rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-display text-lg font-semibold group-hover:text-primary">
                              {v.name}
                            </div>
                            <div className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span className="line-clamp-2">{v.address}</span>
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                            {v.courtCount} {v.courtCount === 1 ? "court" : "courts"}
                          </span>
                        </div>

                        {v.sports?.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {v.sports.slice(0, 4).map((s: string) => (
                              <span key={s} className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                {s}
                              </span>
                            ))}
                            {v.sports.length > 4 && (
                              <span className="text-[11px] text-muted-foreground">+{v.sports.length - 4}</span>
                            )}
                          </div>
                        )}

                        <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
                          {v.distanceKm != null ? (
                            <span className="text-xs font-medium text-primary">{v.distanceKm.toFixed(1)} km away</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Tap to view courts</span>
                          )}
                          {v.minRate != null ? (
                            <span className="text-sm font-semibold text-primary">
                              From ₱{v.minRate.toFixed(0)}/hr
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">No courts yet</span>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="mt-14 inline-flex items-center rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-foreground">
              Play more · Manage less
            </div>
            <h1 className="mt-5 text-5xl font-bold leading-[1.05] md:text-6xl">
              What are you <span className="text-primary">playing today?</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
              Pick a sport to see courts available near you.
            </p>

            <div className="mt-12 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {(sports ?? []).map((s) => (
                <button
                  key={s.id}
                  onClick={() => navigate({ search: { sport: s.slug } })}
                  className="group flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-8 shadow-sm transition hover:-translate-y-1 hover:border-primary hover:shadow-lg"
                >
                  <span className="text-5xl transition group-hover:scale-110">
                    {SPORT_ICONS[s.slug] ?? "🏟️"}
                  </span>
                  <span className="text-lg font-semibold">{s.name}</span>
                </button>
              ))}
              {!sports && Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted" />
              ))}
            </div>


            <div className="mt-12 flex flex-wrap justify-center gap-3">

              <Link
                to="/auth"
                search={{ mode: "signup", as: "player" }}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                Join as a player
              </Link>
              <Link
                to="/auth"
                search={{ mode: "signup", as: "tenant" }}
                className="rounded-lg border border-border bg-card px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-secondary"
              >
                List your venue
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  // Filtered courts view
  const activeSport = sports?.find((s) => s.slug === sport);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <button
        onClick={() => navigate({ search: {} })}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Choose a different sport
      </button>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-4xl">{SPORT_ICONS[sport] ?? "🏟️"}</span>
            <h1 className="text-3xl font-bold">{activeSport?.name ?? "Courts"}</h1>
          </div>
          <p className="mt-1 text-muted-foreground">Available courts for {activeSport?.name.toLowerCase() ?? sport}.</p>
        </div>
        {sports && sports.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {sports.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate({ search: { sport: s.slug } })}
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                  (s.slug === sport
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:border-primary")
                }
              >
                {SPORT_ICONS[s.slug] ?? "•"} {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : courts && courts.length > 0 ? (
        (() => {
          const grouped = new Map<number, { venue: { id: number; name: string; address: string }; courts: typeof courts }>();
          for (const c of courts) {
            if (!c.venues) continue;
            const v = c.venues;
            const g = grouped.get(v.id) ?? { venue: v, courts: [] as typeof courts };
            g.courts.push(c);
            grouped.set(v.id, g);
          }
          const venues = Array.from(grouped.values());
          return (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {venues.map(({ venue, courts: vCourts }) => {
                const minRate = Math.min(...vCourts.map((c) => Number(c.hourly_rate)));
                const indoor = vCourts.some((c) => c.is_indoor);
                const outdoor = vCourts.some((c) => !c.is_indoor);
                return (
                  <Link
                    key={venue.id}
                    to="/venues/$venueId"
                    params={{ venueId: String(venue.id) }}
                    search={{ sport }}
                    className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:shadow-md"
                  >
                    <div className="court-pattern h-32" />
                    <div className="p-5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="rounded-full bg-primary/15 px-2 py-1 font-semibold text-primary">
                          {vCourts.length} {vCourts.length === 1 ? "court" : "courts"}
                        </span>
                        <span className="text-muted-foreground">
                          {indoor && outdoor ? "Indoor & Outdoor" : indoor ? "Indoor" : "Outdoor"}
                        </span>
                      </div>
                      <h3 className="mt-3 text-lg font-semibold">{venue.name}</h3>
                      <p className="text-sm text-muted-foreground">{venue.address}</p>
                      <div className="mt-4 flex items-baseline justify-between">
                        <div>
                          <span className="text-xs text-muted-foreground">From </span>
                          <span className="text-2xl font-bold text-primary">₱{minRate.toFixed(0)}</span>
                          <span className="text-sm text-muted-foreground"> / hour</span>
                        </div>
                        <span className="text-xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">View courts →</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })()

      ) : (
        <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">No {activeSport?.name.toLowerCase() ?? ""} courts listed yet.</p>
          <button
            onClick={() => navigate({ search: {} })}
            className="mt-4 text-sm font-semibold text-primary hover:underline"
          >
            ← Try another sport
          </button>
        </div>
      )}
    </main>
  );
}
