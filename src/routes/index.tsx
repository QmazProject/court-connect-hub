import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, MapPin, X, ChevronUp, ChevronDown, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { VenueMap, type MapVenue } from "@/components/VenueMap";

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
  head: () => ({
    meta: [
      { title: "CourtHub — Find & book premium sports courts" },
      { name: "description", content: "Discover courts near you on the map, filter by sport and price, and book in seconds." },
      { property: "og:title", content: "CourtHub — Find & book premium sports courts" },
      { property: "og:description", content: "Map-first court discovery. Filter, browse and book premium venues." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

type Sport = { id: number; name: string; slug: string };

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

  // Filter state
  const [venueQuery, setVenueQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterSport, setFilterSport] = useState<string>(sport ?? "");
  const [filterCity, setFilterCity] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [nearby, setNearby] = useState<{ lat: number; lng: number } | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(5);

  // Selection + mobile sheet
  const [activeVenueId, setActiveVenueId] = useState<number | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);

  // Debounce inputs
  const [dQuery, setDQuery] = useState(venueQuery);
  const [dCity, setDCity] = useState(filterCity);
  const [dMin, setDMin] = useState(minPrice);
  const [dMax, setDMax] = useState(maxPrice);
  useEffect(() => {
    const t = setTimeout(() => {
      setDQuery(venueQuery);
      setDCity(filterCity);
      setDMin(minPrice);
      setDMax(maxPrice);
    }, 250);
    return () => clearTimeout(t);
  }, [venueQuery, filterCity, minPrice, maxPrice]);

  const hasFilters = !!(filterSport || filterCity.trim() || minPrice || maxPrice);

  const { data: venues, isFetching } = useQuery({
    queryKey: [
      "venues-map",
      dQuery.trim().toLowerCase(),
      filterSport,
      dCity.trim().toLowerCase(),
      dMin,
      dMax,
    ],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const term = dQuery.trim();
      const usesCourtFilter = !!(filterSport || dMin || dMax);
      const courtsSelect = usesCourtFilter
        ? "courts!inner(id, name, hourly_rate, map_emoji, sports!inner(slug, name))"
        : "courts(id, name, hourly_rate, map_emoji, sports(slug, name))";
      let q = supabase
        .from("venues")
        .select(`id, name, address, latitude, longitude, map_emoji, ${courtsSelect}`)
        .order("name")
        .limit(100);
      if (term) q = q.ilike("name", `%${term}%`);
      if (dCity.trim()) q = q.ilike("address", `%${dCity.trim()}%`);
      if (filterSport) q = q.eq("courts.sports.slug", filterSport);
      if (dMin) q = q.gte("courts.hourly_rate", Number(dMin));
      if (dMax) q = q.lte("courts.hourly_rate", Number(dMax));

      const { data, error } = await q;
      if (error) throw error;
      type Row = {
        id: number;
        name: string;
        address: string;
        latitude: number | null;
        longitude: number | null;
        map_emoji: string | null;
        courts: { id: number; name: string; hourly_rate: number; map_emoji: string | null; sports: { slug: string; name: string } | null }[];
      };
      const sportDefault = (slug?: string | null) => {
        switch (slug) {
          case "pickleball": return "🥎";
          case "tennis": return "🎾";
          case "basketball": return "🏀";
          case "table-tennis": return "🏓";
          case "badminton": return "🏸";
          case "volleyball": return "🏐";
          case "football":
          case "soccer": return "⚽";
          default: return null;
        }
      };
      return (data as unknown as Row[]).map<MapVenue & { sports: string[]; distanceKm: number | null }>((v) => {
        const rates = v.courts?.map((c) => Number(c.hourly_rate)) ?? [];
        const sportSet = new Map<string, string>();
        v.courts?.forEach((c) => c.sports && sportSet.set(c.sports.slug, c.sports.name));
        const dist = nearby && v.latitude != null && v.longitude != null
          ? haversineKm(nearby, { lat: v.latitude as number, lng: v.longitude as number })
          : null;
        return {
          id: v.id,
          name: v.name,
          address: v.address,
          latitude: v.latitude,
          longitude: v.longitude,
          courtCount: v.courts?.length ?? 0,
          minRate: rates.length ? Math.min(...rates) : null,
          mapEmoji: v.map_emoji ?? null,
          courts: (v.courts ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            hourly_rate: Number(c.hourly_rate),
            mapEmoji: c.map_emoji ?? v.map_emoji ?? sportDefault(c.sports?.slug) ?? null,
          })),
          sports: Array.from(sportSet.values()),
          distanceKm: dist,
        };
      });
    },
  });

  const sortedVenues = useMemo(() => {
    if (!venues) return [];
    if (nearby) {
      const withinRadius = venues.filter(
        (v) => v.distanceKm != null && v.distanceKm <= radiusKm
      );
      return withinRadius.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    }
    return venues;
  }, [venues, nearby, radiusKm]);

  const requestNearby = () => {
    if (!("geolocation" in navigator)) { setNearbyError("Location not supported on this device."); return; }
    setNearbyLoading(true);
    setNearbyError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setNearby({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setNearbyLoading(false); },
      (err) => { setNearbyError(err.message || "Please allow location access."); setNearbyLoading(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const resetAll = () => {
    setVenueQuery(""); setFilterSport(""); setFilterCity(""); setMinPrice(""); setMaxPrice("");
    setNearby(null); setActiveVenueId(null);
    if (sport) navigate({ search: {} });
  };

  const activeVenue = activeVenueId != null ? sortedVenues.find((v) => v.id === activeVenueId) : null;

  // Auto-scroll list to active venue
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeVenueId == null || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-vid="${activeVenueId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeVenueId]);

  return (
    <div className="flex h-full min-h-[640px] flex-col">

      {/* HERO */}
      <section className="border-b border-border bg-gradient-to-b from-primary/10 via-background to-background">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Dedicated Court Facility
          </div>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            What are you playing today?
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Pick a sport to see courts available near you — explore the map, filter by price, and lock in your slot in seconds.
          </p>

          {/* Sport chips */}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setFilterSport("")}
              className={
                "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition sm:text-sm " +
                (!filterSport
                  ? "border-primary bg-primary text-primary-foreground shadow-sm"
                  : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
              }
            >
              All sports
            </button>
            {(sports ?? []).map((s) => {
              const emoji =
                s.slug === "pickleball" ? "🥎"
                : s.slug === "tennis" ? "🎾"
                : s.slug === "basketball" ? "🏀"
                : s.slug === "table-tennis" ? "🏓"
                : s.slug === "badminton" ? "🏸"
                : s.slug === "volleyball" ? "🏐"
                : s.slug === "football" || s.slug === "soccer" ? "⚽"
                : "🏟️";
              const active = filterSport === s.slug;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setFilterSport(active ? "" : s.slug)}
                  className={
                    "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition sm:text-sm " +
                    (active
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
                  }
                >
                  <span aria-hidden>{emoji}</span> {s.name}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* TOP TOOLBAR */}
      <div className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-3 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-background px-3 py-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <Search className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <input
                type="text"
                value={venueQuery}
                onChange={(e) => setVenueQuery(e.target.value)}
                placeholder="Search venues by name…"
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {venueQuery && (
                <button type="button" onClick={() => setVenueQuery("")} className="text-muted-foreground hover:text-foreground" aria-label="Clear">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              className={
                "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition " +
                (hasFilters || filterOpen
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
              }
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Filters</span>
              {hasFilters && <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">•</span>}
            </button>
            <button
              type="button"
              onClick={requestNearby}
              disabled={nearbyLoading}
              className={
                "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition " +
                (nearby
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
              }
            >
              <MapPin className="h-4 w-4" />
              <span className="hidden sm:inline">{nearbyLoading ? "Locating…" : "Nearby"}</span>
            </button>
          </div>

          {filterOpen && (
            <div className="grid gap-2 rounded-2xl border border-border bg-background p-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sport</span>
                <select
                  value={filterSport}
                  onChange={(e) => setFilterSport(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="">Any sport</option>
                  {(sports ?? []).map((s) => (
                    <option key={s.id} value={s.slug}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">City / Province</span>
                <input
                  type="text"
                  value={filterCity}
                  onChange={(e) => setFilterCity(e.target.value)}
                  placeholder="e.g. Cebu, Makati"
                  className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Min ₱/hr</span>
                <input
                  type="number" min={0}
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder="0"
                  className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Max ₱/hr</span>
                <input
                  type="number" min={0}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="Any"
                  className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <div className="col-span-full flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">
                  {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"} match
                </span>
                <button type="button" onClick={resetAll} className="text-xs font-semibold text-primary hover:underline">
                  Clear all
                </button>
              </div>
            </div>
          )}

          {nearby && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <MapPin className="h-3.5 w-3.5" /> Within {radiusKm} km
              </div>
              <input
                type="range"
                min={1}
                max={25}
                step={1}
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                className="h-1.5 flex-1 min-w-[140px] cursor-pointer accent-primary"
                aria-label="Search radius in kilometers"
              />
              <div className="flex items-center gap-1">
                {[2, 5, 10, 25].map((km) => (
                  <button
                    key={km}
                    type="button"
                    onClick={() => setRadiusKm(km)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] font-semibold transition " +
                      (radiusKm === km
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
                    }
                  >
                    {km}km
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"} nearby
              </span>
              <button
                type="button"
                onClick={() => setNearby(null)}
                className="ml-auto text-[11px] font-semibold text-muted-foreground hover:text-foreground"
              >
                Clear location
              </button>
            </div>
          )}

          {nearbyError && (
            <div className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>{nearbyError}</span>
              <button onClick={() => setNearbyError(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
        </div>
      </div>

      {/* MAP + LIST */}
      <div className="relative flex min-h-[620px] flex-1 overflow-hidden pb-4 pl-3 sm:pl-6">
        {/* Map */}
        <div className="relative flex-1 overflow-hidden rounded-l-2xl border border-border">
          <VenueMap
            venues={sortedVenues}
            activeVenueId={activeVenueId}
            onSelectVenue={setActiveVenueId}
            onOpenVenue={(id) => navigate({ to: "/venues/$venueId", params: { venueId: String(id) }, search: {} })}
            onOpenCourt={(id) => navigate({ to: "/courts/$courtId", params: { courtId: String(id) }, search: {} })}
            nearby={nearby}
            radiusKm={nearby ? radiusKm : null}
          />

          {activeVenueId != null && (
            <button
              type="button"
              onClick={() => setActiveVenueId(null)}
              className="absolute left-3 top-3 z-[500] flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold shadow-md hover:border-primary hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> All venues
            </button>
          )}

          {isFetching && (
            <div className="absolute right-3 top-3 z-[500] rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground shadow-md">
              Updating…
            </div>
          )}
        </div>

        {/* Right sidebar (desktop / tablet) */}
        <aside className="hidden w-[380px] shrink-0 border-l border-border bg-background md:flex md:flex-col">
          <VenueList
            venues={sortedVenues}
            activeVenueId={activeVenueId}
            onSelectVenue={setActiveVenueId}
            activeVenue={activeVenue}
            listRef={listRef}
          />
        </aside>

        {/* Mobile bottom sheet */}
        <div
          className={
            "pointer-events-none absolute inset-x-0 bottom-0 z-[600] md:hidden"
          }
        >
          <div
            className={
              "pointer-events-auto flex flex-col rounded-t-3xl border-t border-border bg-background shadow-2xl transition-[height] duration-300 " +
              (sheetExpanded ? "h-[70vh]" : "h-[42vh]")
            }
          >
            <button
              type="button"
              onClick={() => setSheetExpanded((v) => !v)}
              className="flex flex-col items-center gap-1 py-2"
              aria-label={sheetExpanded ? "Collapse list" : "Expand list"}
            >
              <span className="h-1.5 w-10 rounded-full bg-border" />
              <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {sheetExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"}
              </span>
            </button>
            <VenueList
              venues={sortedVenues}
              activeVenueId={activeVenueId}
              onSelectVenue={(id) => { setActiveVenueId(id); if (id != null) setSheetExpanded(false); }}
              activeVenue={activeVenue}
              listRef={listRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function VenueList({
  venues,
  activeVenueId,
  onSelectVenue,
  activeVenue,
  listRef,
}: {
  venues: (MapVenue & { sports?: string[]; distanceKm?: number | null })[];
  activeVenueId: number | null;
  onSelectVenue: (id: number | null) => void;
  activeVenue: (MapVenue & { sports?: string[]; distanceKm?: number | null }) | null | undefined;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const MAX_VISIBLE = 50;
  const visibleVenues = venues.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, venues.length - MAX_VISIBLE);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="font-display text-sm font-bold tracking-tight">
          {activeVenue ? activeVenue.name : "Venues on the map"}
        </div>
        <div className="text-xs text-muted-foreground">
          {activeVenue
            ? `${activeVenue.courtCount} ${activeVenue.courtCount === 1 ? "court" : "courts"} at this location`
            : hiddenCount > 0
              ? `Showing ${visibleVenues.length} of ${venues.length} · refine to see more`
              : `${venues.length} ${venues.length === 1 ? "result" : "results"}`}
        </div>
      </div>

      <div ref={listRef} className="nice-scroll min-h-0 flex-1 overflow-y-auto p-3">

        {activeVenue ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => onSelectVenue(null)}
              className="mb-1 flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to all venues
            </button>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{activeVenue.address}</span>
              </div>
              <Link
                to="/venues/$venueId"
                params={{ venueId: String(activeVenue.id) }}
                search={{}}
                className="mt-3 inline-flex items-center rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open venue page →
              </Link>
            </div>
            <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Courts ({activeVenue.courts.length})
            </div>
            {activeVenue.courts.map((c, i) => (
              <Link
                key={c.id}
                to="/courts/$courtId"
                params={{ courtId: String(c.id) }}
                search={{}}
                className="group flex items-center justify-between rounded-xl border border-border bg-card p-3 transition hover:border-primary hover:shadow-sm"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background text-xs font-bold text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold group-hover:text-primary">{c.name}</div>
                    <div className="text-xs text-muted-foreground">₱{c.hourly_rate.toFixed(0)} / hour</div>
                  </div>
                </div>
                <span className="text-xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">Book →</span>
              </Link>
            ))}
          </div>
        ) : venues.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No venues match your search.
          </div>
        ) : (
          <div className="space-y-2">
            {visibleVenues.map((v) => {
              const pinned = v.latitude != null && v.longitude != null;
              const active = v.id === activeVenueId;
              return (
                <button
                  key={v.id}
                  data-vid={v.id}
                  type="button"
                  onClick={() => pinned && onSelectVenue(v.id)}
                  className={
                    "group flex w-full flex-col gap-2 rounded-2xl border p-3 text-left transition " +
                    (active
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-border bg-card hover:border-primary hover:shadow-sm") +
                    (!pinned ? " opacity-70" : "")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-bold group-hover:text-primary">
                        {v.name}
                      </div>
                      <div className="mt-0.5 flex items-start gap-1 text-[11px] text-muted-foreground">
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="line-clamp-2">{v.address}</span>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                      {v.courtCount}
                    </span>
                  </div>

                  {v.sports && v.sports.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {v.sports.slice(0, 3).map((s) => (
                        <span key={s} className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {s}
                        </span>
                      ))}
                      {v.sports.length > 3 && <span className="text-[10px] text-muted-foreground">+{v.sports.length - 3}</span>}
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-border/60 pt-2">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {v.distanceKm != null ? `${v.distanceKm.toFixed(1)} km away` : !pinned ? "No location pinned" : "Tap to see courts"}
                    </span>
                    {v.minRate != null ? (
                      <span className="text-xs font-bold text-primary">From ₱{v.minRate.toFixed(0)}/hr</span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">No courts</span>
                    )}
                  </div>
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <div className="rounded-xl border border-dashed border-border bg-background/60 p-3 text-center text-[11px] text-muted-foreground">
                +{hiddenCount} more {hiddenCount === 1 ? "venue" : "venues"} — use search or filters to narrow down.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

