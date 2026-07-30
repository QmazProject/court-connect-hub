import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { normalizeRules, minRate, hasVariablePricing } from "@/lib/court-pricing";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, MapPin, X, ChevronUp, ChevronDown, ArrowLeft, Crosshair, Menu, CalendarCheck2, ShieldCheck, Map, BellRing, ReceiptText, UsersRound, Sparkles, ChevronRight, Play, Building2, Mail, Phone, Instagram, Facebook, Clock3, Star, Trophy, Handshake, Accessibility, Wifi, X as CloseIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { VenueMap, type MapVenue } from "@/components/VenueMap";
import { MapPicker } from "@/components/MapPicker";

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
  explore: z.boolean().optional().catch(false),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: HomeRoute,
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

function HomeRoute() {
  const { explore, sport } = Route.useSearch();
  return explore ? <VenueExplorer sport={sport} /> : <LandingPage />;
}

export function VenueExplorer({ sport }: { sport?: string }) {
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
  const [nationwide, setNationwide] = useState<boolean>(false);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [locationMode, setLocationMode] = useState<"gps" | "manual" | null>(null);

  // Selection + mobile sheet
  const [activeVenueId, setActiveVenueId] = useState<number | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const heroChipsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = heroChipsRef.current;
    if (!el) return;
    const scroller = document.querySelector("main") as HTMLElement | null;
    const io = new IntersectionObserver(
      ([entry]) => setHeaderCollapsed(!entry.isIntersecting),
      { root: scroller ?? null, threshold: 0, rootMargin: "0px 0px -8px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
        ? "courts!inner(id, name, hourly_rate, rate_rules, map_emoji, sports!inner(slug, name))"
        : "courts(id, name, hourly_rate, rate_rules, map_emoji, sports(slug, name))";
      let q = supabase
        .from("venues")
        .select(`id, name, address, latitude, longitude, map_emoji, ${courtsSelect}`)
        .eq("is_active", true)
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
        courts: { id: number; name: string; hourly_rate: number; rate_rules?: unknown; map_emoji: string | null; sports: { slug: string; name: string } | null }[];
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
      return (data as unknown as Row[]).map<MapVenue & { sports: string[] }>((v) => {
        const rates = v.courts?.map((c) => minRate(Number(c.hourly_rate), normalizeRules(c.rate_rules))) ?? [];
        const sportSet = new Map<string, string>();
        v.courts?.forEach((c) => c.sports && sportSet.set(c.sports.slug, c.sports.name));
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
            hourly_rate: minRate(Number(c.hourly_rate), normalizeRules(c.rate_rules)),
            variableRate: hasVariablePricing(Number(c.hourly_rate), normalizeRules(c.rate_rules)),
            mapEmoji: c.map_emoji ?? v.map_emoji ?? sportDefault(c.sports?.slug) ?? null,
          })),
          sports: Array.from(sportSet.values()),
        };
      });
    },
  });

  const { list: sortedVenues, empty: nearbyEmpty, nearestSuggestion } = useMemo(() => {
    if (!venues) return { list: [], empty: false, nearestSuggestion: [] as MapVenue[] };
    if (!nearby) return { list: venues, empty: false, nearestSuggestion: [] };

    const withDistance = venues
      .map((v) => ({
        ...v,
        distanceKm:
          v.latitude != null && v.longitude != null
            ? haversineKm(nearby, { lat: v.latitude as number, lng: v.longitude as number })
            : null,
      }))
      .filter((v) => v.distanceKm != null)
      .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

    if (nationwide) {
      return { list: withDistance, empty: false, nearestSuggestion: [] };
    }

    const inRadius = withDistance.filter((v) => (v.distanceKm ?? 0) <= radiusKm);
    return { list: inRadius, empty: inRadius.length === 0, nearestSuggestion: withDistance.slice(0, 5) };
  }, [venues, nearby, radiusKm, nationwide]);

  const [showNearestPeek, setShowNearestPeek] = useState(false);
  useEffect(() => { if (!nearbyEmpty) setShowNearestPeek(false); }, [nearbyEmpty]);

  const requestNearby = () => {
    if (!("geolocation" in navigator)) { setNearbyError("Location not supported on this device."); return; }
    setNearbyLoading(true);
    setNearbyError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setNearby({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocationMode("gps"); setNearbyLoading(false); },
      (err) => { setNearbyError(err.message || "Please allow location access."); setNearbyLoading(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const saveManualLocation = (lat: number, lng: number) => {
    setNearby({ lat, lng });
    setLocationMode("manual");
    setManualPickerOpen(false);
  };

  const resetAll = () => {
    setVenueQuery(""); setFilterSport(""); setFilterCity(""); setMinPrice(""); setMaxPrice("");
    setNearby(null); setNationwide(false); setActiveVenueId(null); setLocationMode(null);
    if (sport) navigate({ search: {} });
  };

  const displayVenues = showNearestPeek && nearbyEmpty ? nearestSuggestion : sortedVenues;
  const activeVenue = activeVenueId != null ? displayVenues.find((v) => v.id === activeVenueId) : null;

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
          <div ref={heroChipsRef} className="mt-5 flex flex-wrap gap-2">
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
      <div className="sticky top-0 z-[900] border-b border-border bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/70">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-3 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-background px-3 py-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <Search className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <input
                type="text"
                value={venueQuery}
                onChange={(e) => setVenueQuery(e.target.value)}
                placeholder="Search venues, or use Nearby / Pin manually…"
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
                (nearby && locationMode === "gps"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
              }
            >
              <MapPin className="h-4 w-4" />
              <span className="hidden sm:inline">{nearbyLoading ? "Locating…" : "Nearby"}</span>
            </button>
            <button
              type="button"
              onClick={() => setManualPickerOpen(true)}
              className={
                "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition " +
                (nearby && locationMode === "manual"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
              }
              title="Pin your location manually — search a place or paste coordinates"
            >
              <Crosshair className="h-4 w-4" />
              <span className="hidden sm:inline">Pin manually</span>
            </button>
          </div>

          {headerCollapsed && (
            <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 sm:-mx-6 sm:px-6 nice-scroll">
              <button
                type="button"
                onClick={() => setFilterSport("")}
                className={
                  "shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition " +
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
                      "flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition " +
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
          )}


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
            <div className="flex flex-col gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                  <MapPin className="h-3.5 w-3.5" />
                  {nationwide ? "Nationwide · sorted by distance" : `Within ${radiusKm} km`}
                  <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {locationMode === "manual" ? "Manual pin" : "GPS"}
                  </span>
                  {locationMode === "manual" && (
                    <button
                      type="button"
                      onClick={() => setManualPickerOpen(true)}
                      className="text-[11px] font-semibold text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {!nationwide && (
                  <>
                    <input
                      type="range"
                      min={1}
                      max={100}
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
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={radiusKm}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n > 0) setRadiusKm(Math.min(500, Math.max(1, Math.round(n))));
                        }}
                        className="w-14 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-semibold text-foreground outline-none focus:border-primary"
                        aria-label="Custom radius in kilometers"
                      />
                      <span className="text-[11px] text-muted-foreground">km</span>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setNationwide((v) => !v)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition " +
                    (nationwide
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary")
                  }
                >
                  🌏 Nationwide
                </button>
                <span className="text-[11px] text-muted-foreground">
                  {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"}
                </span>
                <button
                  type="button"
                  onClick={() => { setNearby(null); setNationwide(false); setShowNearestPeek(false); setLocationMode(null); }}
                  className="ml-auto text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                >
                  Clear location
                </button>
              </div>

              {!nationwide && nearbyEmpty && radiusKm >= 25 && nearestSuggestion.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <span className="font-semibold">No venues within {radiusKm} km.</span>
                  <span>Try a wider search:</span>
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    {[50, 100, 200].filter((km) => km > radiusKm).map((km) => (
                      <button
                        key={km}
                        type="button"
                        onClick={() => setRadiusKm(km)}
                        className="rounded-full border border-amber-500/50 bg-white/60 px-2 py-0.5 font-semibold text-amber-900 hover:bg-white dark:bg-transparent dark:text-amber-100"
                      >
                        Expand to {km}km
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setShowNearestPeek((v) => !v)}
                      className="rounded-full border border-amber-500/50 bg-white/60 px-2 py-0.5 font-semibold text-amber-900 hover:bg-white dark:bg-transparent dark:text-amber-100"
                    >
                      {showNearestPeek ? "Hide nearest" : "Show 5 nearest"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNationwide(true)}
                      className="rounded-full border border-primary bg-primary px-2 py-0.5 font-semibold text-primary-foreground hover:opacity-90"
                    >
                      Show nationwide
                    </button>
                  </div>
                </div>
              )}
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
            venues={displayVenues}
            activeVenueId={activeVenueId}
            onSelectVenue={setActiveVenueId}
            onOpenVenue={(id) => navigate({ to: "/venues/$venueId", params: { venueId: String(id) }, search: {} })}
            onOpenCourt={(id) => navigate({ to: "/courts/$courtId", params: { courtId: String(id) }, search: {} })}
            nearby={nearby}
            radiusKm={nearby && !nationwide ? radiusKm : null}
            radiusHasMatches={!nearbyEmpty}
          />


          {isFetching && (
            <div className="absolute right-3 top-3 z-[500] rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground shadow-md">
              Updating…
            </div>
          )}
        </div>

        {/* Right sidebar (desktop / tablet) */}
        <aside className="hidden w-[380px] shrink-0 border-l border-border bg-background md:flex md:flex-col">
          <VenueList
            venues={displayVenues}
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
              venues={displayVenues}
              activeVenueId={activeVenueId}
              onSelectVenue={(id) => { setActiveVenueId(id); if (id != null) setSheetExpanded(false); }}
              activeVenue={activeVenue}
              listRef={listRef}
            />
          </div>
        </div>
      </div>

      <MapPicker
        open={manualPickerOpen}
        initialLat={nearby?.lat ?? null}
        initialLng={nearby?.lng ?? null}
        onClose={() => setManualPickerOpen(false)}
        onSave={saveManualLocation}
        title="Pin your location"
      />
    </div>
  );
}

const landingNav = ["Home", "Features", "Venues", "Highlights", "How It Works", "About", "Contact"] as const;
const heroImages = [
  "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1518065896235-a4c93e088e7a?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1592656094267-764a45160876?auto=format&fit=crop&w=1800&q=85",
];

function LandingPage() {
  const navigate = useNavigate({ from: "/" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<(typeof landingNav)[number]>("Home");
  const [heroIndex, setHeroIndex] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [headerSolid, setHeaderSolid] = useState(false);

  const featuredQ = useQuery({
    queryKey: ["landing-featured-venues"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address, images, map_emoji, courts(name, hourly_rate, sports(name))")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(3);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    const timer = window.setInterval(() => setHeroIndex((index) => (index + 1) % heroImages.length), 6000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const scroller = document.querySelector("main") as HTMLElement | null;
    const update = () => setHeaderSolid((scroller?.scrollTop ?? window.scrollY) > 24);
    update();
    scroller?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    return () => { scroller?.removeEventListener("scroll", update); window.removeEventListener("scroll", update); };
  }, []);

  useEffect(() => {
    const sections = landingNav.map((name) => document.getElementById(name.toLowerCase().replaceAll(" ", "-"))).filter(Boolean) as HTMLElement[];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActiveSection((visible.target as HTMLElement).dataset.nav as (typeof landingNav)[number]);
      },
      { rootMargin: "-35% 0px -55% 0px", threshold: [0.01, 0.2, 0.5] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const scrollTo = (name: (typeof landingNav)[number]) => {
    document.getElementById(name.toLowerCase().replaceAll(" ", "-"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    setMenuOpen(false);
  };

  const openExplorer = () => {
    setMenuOpen(false);
    navigate({ to: "/explore", search: {} });
  };

  const featureCards = [
    [CalendarCheck2, "Real-time availability", "See open courts instantly and reserve the time that fits your day."],
    [Sparkles, "Easy booking", "A clear, guided booking flow from venue discovery to confirmation."],
    [ShieldCheck, "Secure payments", "Protected online checkout with reliable booking records."],
    [Map, "Venue discovery", "Find courts around the Philippines or search close to a pinned location."],
    [BellRing, "Live booking status", "Keep track of your reservations and payment progress in one place."],
    [ReceiptText, "Digital confirmation", "Get a booking reference as soon as your reservation is confirmed."],
    [UsersRound, "Court groups", "Smart shared-facility handling for courts that play together."],
    [Trophy, "Community ready", "A better home for open play, local events, and growing sports communities."],
    [Accessibility, "Made for every device", "Discover and book on desktop, tablet, or right from your phone."],
  ];
  const gallery = [
    "https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1000&q=80",
    "https://images.unsplash.com/photo-1504450758481-7338eba7524a?auto=format&fit=crop&w=1000&q=80",
    "https://images.unsplash.com/photo-1518604666860-9ed391f76460?auto=format&fit=crop&w=1000&q=80",
    "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1000&q=80",
    "https://images.unsplash.com/photo-1566577739112-5180d4bf9390?auto=format&fit=crop&w=1000&q=80",
    "https://images.unsplash.com/photo-1521412644187-c49fa049e84d?auto=format&fit=crop&w=1000&q=80",
  ];

  return (
    <div className="bg-[#f6f8f7] text-[#102521]">
      <header className="fixed inset-x-0 top-0 z-[1200] px-3 pt-3 sm:px-6">
        <div className={`mx-auto flex max-w-7xl items-center justify-between rounded-2xl px-4 py-3 text-white transition duration-300 ${headerSolid ? "border border-white/20 bg-[#09231f]/90 shadow-xl shadow-[#09231f]/20 backdrop-blur-xl" : "border border-transparent bg-transparent"}`}>
          <button onClick={() => scrollTo("Home")} className="flex items-center gap-2 font-display text-lg font-bold tracking-tight" aria-label="CourtHub home">
            <img src="/CHicon.png" alt="" className="h-8 w-8 rounded-full bg-white object-contain" /> CourtHub
          </button>
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Landing navigation">
            {landingNav.map((name) => <button key={name} onClick={name === "Venues" ? openExplorer : () => scrollTo(name)} className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${activeSection === name ? "bg-[#b8f05a] text-[#102521]" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>{name}</button>)}
          </nav>
          <div className="flex items-center gap-2">
            <a href="/auth" className="hidden rounded-full px-3 py-2 text-sm font-semibold text-white/85 hover:text-white sm:inline-flex">Sign in</a>
            <Link to="/explore" search={{}} className="inline-flex items-center gap-1 rounded-full bg-[#b8f05a] px-3.5 py-2 text-sm font-bold text-[#102521] transition hover:bg-[#d3ff87]">Book now <ChevronRight className="h-4 w-4" /></Link>
            <button onClick={() => setMenuOpen((open) => !open)} className="rounded-full p-2 hover:bg-white/10 lg:hidden" aria-label="Toggle navigation" aria-expanded={menuOpen}>{menuOpen ? <CloseIcon className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          </div>
        </div>
        {menuOpen && <nav className="mx-auto mt-2 grid max-w-7xl grid-cols-2 gap-1 rounded-2xl border border-[#102521]/10 bg-white p-2 shadow-xl lg:hidden">{landingNav.map((name) => <button key={name} onClick={name === "Venues" ? openExplorer : () => scrollTo(name)} className="rounded-xl px-3 py-3 text-left text-sm font-semibold hover:bg-[#eaf5d8]">{name}</button>)}<a href="/auth" className="rounded-xl px-3 py-3 text-sm font-semibold hover:bg-[#eaf5d8]">Sign in</a></nav>}
      </header>

      <section id="home" data-nav="Home" className="relative isolate min-h-[700px] overflow-hidden bg-[#09231f] pt-24 text-white sm:min-h-[760px]">
        {heroImages.map((image, index) => <img key={image} src={image} alt="Players enjoying sport" className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-1000 ${index === heroIndex ? "opacity-100" : "opacity-0"}`} fetchPriority={index === 0 ? "high" : "auto"} />)}
        <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(5,25,21,.92)_5%,rgba(5,25,21,.68)_48%,rgba(5,25,21,.24))]" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#09231f] to-transparent" />
        <div className="relative mx-auto flex min-h-[620px] max-w-7xl flex-col justify-end px-5 pb-16 sm:min-h-[680px] sm:px-8 sm:pb-24">
          <div className="max-w-3xl animate-[sport-fade-in-up_.7s_ease-out_both]">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#b8f05a]/50 bg-[#b8f05a]/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.15em] text-[#d9ff9b]"><span className="h-2 w-2 rounded-full bg-[#b8f05a]" /> Dedicated court booking platform</span>
            <h1 className="mt-5 font-display text-5xl font-bold leading-[.95] tracking-[-.055em] sm:text-7xl">Your game starts <span className="text-[#b8f05a]">here.</span></h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/78 sm:text-lg">Find and reserve badminton, basketball, pickleball, volleyball, tennis, football, and more across the Philippines with real-time availability and secure online booking.</p>
            <div className="mt-8 flex flex-wrap gap-3"><Link to="/explore" search={{}} className="inline-flex items-center gap-2 rounded-full bg-[#b8f05a] px-6 py-3.5 font-bold text-[#102521] transition hover:-translate-y-0.5 hover:bg-[#d3ff87]">Book a court <ChevronRight className="h-4 w-4" /></Link><button onClick={openExplorer} className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-6 py-3.5 font-bold backdrop-blur transition hover:bg-white/20"><Play className="h-4 w-4 fill-current" /> Explore venues</button></div>
          </div>
          <div className="mt-12 flex items-center gap-2">{heroImages.map((_, index) => <button key={index} aria-label={`Show slide ${index + 1}`} onClick={() => setHeroIndex(index)} className={`h-1.5 rounded-full transition-all ${index === heroIndex ? "w-10 bg-[#b8f05a]" : "w-4 bg-white/40"}`} />)}</div>
        </div>
      </section>

      <section className="relative z-10 mx-auto -mt-7 grid max-w-6xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/30 bg-white/30 shadow-2xl shadow-[#09231f]/15 sm:grid-cols-5">
        {["50+|Partner venues", "300+|Sports courts", "15k+|Bookings completed", "8k+|Registered players", "99%|Booking success"].map((stat) => { const [value, label] = stat.split("|"); return <div key={label} className="bg-white px-4 py-5 text-center"><div className="font-display text-2xl font-bold text-[#0b3d35] sm:text-3xl">{value}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#52716a]">{label}</div></div>; })}
      </section>

      <section id="features" data-nav="Features" className="mx-auto max-w-7xl px-5 py-20 sm:px-8"><SectionIntro eyebrow="Built around game time" title="Everything between finding a court and stepping onto it." /><div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{featureCards.map(([Icon, title, description]) => <article key={title as string} className="group rounded-2xl border border-[#dce8e2] bg-white p-5 transition duration-300 hover:-translate-y-1 hover:border-[#b8f05a] hover:shadow-xl hover:shadow-[#102521]/8"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eaf5d8] text-[#126152]"><Icon className="h-5 w-5" /></div><h3 className="mt-5 font-display text-xl font-bold">{title as string}</h3><p className="mt-2 text-sm leading-relaxed text-[#5e746e]">{description as string}</p></article>)}</div></section>

      <section id="venues" data-nav="Venues" className="bg-[#e9f2e5] py-20"><div className="mx-auto max-w-7xl px-5 sm:px-8"><SectionIntro eyebrow="Play nearby" title="Featured places to make your next move." action="View all venues" /><div className="mt-10 grid gap-5 md:grid-cols-3">{(featuredQ.data ?? []).map((venue) => { const courts = venue.courts ?? []; const lowest = courts.length ? Math.min(...courts.map((court) => Number(court.hourly_rate))) : null; const sports = Array.from(new Set(courts.map((court) => court.sports?.name).filter(Boolean))).slice(0, 3); return <article key={venue.id} onClick={() => navigate({ to: "/venues/$venueId", params: { venueId: String(venue.id) }, search: {} })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate({ to: "/venues/$venueId", params: { venueId: String(venue.id) }, search: {} }); } }} role="link" tabIndex={0} className="cursor-pointer overflow-hidden rounded-2xl bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-[#12806d]"><div className="relative aspect-[16/10] overflow-hidden bg-[#0b3d35]"><img src={venue.images?.[0] || heroImages[venue.id % heroImages.length]} alt="" className="h-full w-full object-cover transition duration-500 hover:scale-105" loading="lazy" /><span className="absolute left-3 top-3 rounded-full bg-white/90 px-2 py-1 text-xs font-bold text-[#102521]">{venue.map_emoji || "🏟️"} {venue.address}</span></div><div className="p-5"><div className="flex items-start justify-between gap-3"><h3 className="font-display text-xl font-bold">{venue.name}</h3><span className="flex items-center gap-1 text-xs font-bold text-[#bd7816]"><Star className="h-3.5 w-3.5 fill-current" /> New</span></div><div className="mt-3 flex flex-wrap gap-1.5">{sports.map((sport) => <span key={sport} className="rounded-full bg-[#eff5ed] px-2.5 py-1 text-[11px] font-bold text-[#426159]">{sport}</span>)}</div><div className="mt-5 flex items-center justify-between"><span className="text-sm text-[#5e746e]">{lowest != null ? <>from <b className="text-[#0b3d35]">₱{lowest.toFixed(0)}</b> / hour</> : "View availability"}</span><Link to="/venues/$venueId" params={{ venueId: String(venue.id) }} search={{}} onClick={(event) => event.stopPropagation()} className="rounded-full bg-[#0b3d35] px-3 py-2 text-xs font-bold text-white hover:bg-[#126152]">Book now</Link></div></div></article>; })}{!featuredQ.isLoading && (featuredQ.data?.length ?? 0) === 0 && <div className="col-span-full rounded-2xl border border-dashed border-[#aac2b8] p-10 text-center text-[#5e746e]">Venues will appear here as they join CourtHub.</div>}</div><div className="mt-8 text-center"><Link to="/explore" search={{}} className="inline-flex items-center gap-2 rounded-full border border-[#0b3d35] px-5 py-3 text-sm font-bold text-[#0b3d35] hover:bg-[#0b3d35] hover:text-white">Browse every venue <ChevronRight className="h-4 w-4" /></Link></div></div></section>

      <section id="highlights" data-nav="Highlights" className="mx-auto max-w-7xl px-5 py-20 sm:px-8"><SectionIntro eyebrow="The CourtHub community" title="More than a booking. A reason to show up." /><div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4">{gallery.map((image, index) => <button key={image} onClick={() => setLightbox(image)} className={`group relative overflow-hidden rounded-2xl bg-[#0b3d35] ${index === 0 || index === 3 ? "row-span-2 aspect-[4/5]" : "aspect-square"}`}><img src={image} alt={`CourtHub community highlight ${index + 1}`} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-110 group-hover:opacity-80" /><span className="absolute inset-x-3 bottom-3 translate-y-8 rounded-full bg-white/90 px-3 py-1.5 text-left text-xs font-bold text-[#0b3d35] opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">View highlight</span></button>)}</div></section>

      <section id="how-it-works" data-nav="How It Works" className="bg-[#0b3d35] py-20 text-white"><div className="mx-auto max-w-7xl px-5 sm:px-8"><p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">How it works</p><h2 className="mt-3 max-w-xl font-display text-4xl font-bold tracking-tight sm:text-5xl">From search to game time in four simple moves.</h2><div className="mt-12 grid gap-5 md:grid-cols-4">{[[Building2,"Choose a venue","Browse trusted facilities that fit your sport and location."],[CalendarCheck2,"Select court & time","See availability, pick your court, then lock in your slot."],[ShieldCheck,"Complete payment","Pay securely online where the venue offers online checkout."],[Trophy,"Enjoy your game","Receive your confirmation and get ready to play."]].map(([Icon,title,copy], index) => <div key={title as string} className="relative rounded-2xl border border-white/15 bg-white/5 p-5"><span className="font-display text-5xl font-bold text-[#b8f05a]/35">0{index + 1}</span><Icon className="mt-8 h-6 w-6 text-[#b8f05a]" /><h3 className="mt-4 font-display text-xl font-bold">{title as string}</h3><p className="mt-2 text-sm leading-relaxed text-white/65">{copy as string}</p></div>)}</div></div></section>

      <section id="about" data-nav="About" className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1.1fr_.9fr]"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-[#12806d]">About CourtHub</p><h2 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">More access to sport starts with a better way to book.</h2><p className="mt-6 max-w-2xl text-base leading-relaxed text-[#5e746e]">CourtHub connects players with quality sports venues across the Philippines. We are building the trusted place to discover a court, understand availability, and make a reservation without the back-and-forth.</p><p className="mt-4 max-w-2xl text-base leading-relaxed text-[#5e746e]">Our mission is to make sports more accessible for everyone through simpler court reservations and stronger local sports communities.</p></div><div className="grid grid-cols-2 gap-3">{[[Handshake,"Community"],[Sparkles,"Innovation"],[ShieldCheck,"Trust"],[Wifi,"Accessibility"],[Trophy,"Sportsmanship"],[Clock3,"Reliability"]].map(([Icon,label]) => <div key={label as string} className="rounded-2xl bg-[#eaf5d8] p-5"><Icon className="h-5 w-5 text-[#12806d]" /><p className="mt-7 font-display font-bold">{label as string}</p></div>)}</div></section>

      <section id="contact" data-nav="Contact" className="bg-[#e9f2e5] py-20"><div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-2"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-[#12806d]">Contact</p><h2 className="mt-3 font-display text-4xl font-bold tracking-tight">Let’s get more people playing.</h2><p className="mt-4 max-w-md text-[#5e746e]">Questions about booking, venues, or becoming a CourtHub partner? Our team is ready to help.</p><div className="mt-8 space-y-4 text-sm"><a href="mailto:hello@courthub.ph" className="flex items-center gap-3 font-semibold hover:text-[#12806d]"><Mail className="h-5 w-5 text-[#12806d]" /> hello@courthub.ph</a><div className="flex items-center gap-3 font-semibold"><Phone className="h-5 w-5 text-[#12806d]" /> +63 000 000 0000</div><div className="flex items-center gap-3 font-semibold"><Clock3 className="h-5 w-5 text-[#12806d]" /> Monday to Friday, 9:00 AM - 6:00 PM</div><div className="flex gap-2 pt-2"><a href="#contact" aria-label="Facebook" className="rounded-full bg-white p-2.5 text-[#0b3d35]"><Facebook className="h-4 w-4" /></a><a href="#contact" aria-label="Instagram" className="rounded-full bg-white p-2.5 text-[#0b3d35]"><Instagram className="h-4 w-4" /></a></div></div></div><form className="rounded-3xl bg-white p-5 shadow-sm sm:p-7" onSubmit={(event) => { event.preventDefault(); }}><div className="grid gap-4 sm:grid-cols-2"><LandingInput label="Name" placeholder="Your name" /><LandingInput label="Email" placeholder="you@example.com" type="email" /></div><LandingInput label="Subject" placeholder="How can we help?" /><label className="mt-4 block text-sm font-bold">Message<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#d8e4df] bg-[#fbfcfb] px-3 py-2.5 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50" placeholder="Tell us a little more" required /></label><button className="mt-5 rounded-full bg-[#0b3d35] px-5 py-3 text-sm font-bold text-white hover:bg-[#126152]">Send message</button></form></div></section>

      <section className="relative isolate overflow-hidden bg-[#09231f] px-5 py-20 text-center text-white sm:px-8"><img src={heroImages[2]} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-25" loading="lazy" /><div className="absolute inset-0 -z-10 bg-[#09231f]/75" /><p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">Ready when you are</p><h2 className="mt-3 font-display text-5xl font-bold tracking-tight">Ready to play?</h2><p className="mx-auto mt-4 max-w-lg text-white/70">Reserve your next court in minutes with CourtHub.</p><div className="mt-7 flex justify-center gap-3"><Link to="/explore" search={{}} className="rounded-full bg-[#b8f05a] px-5 py-3 font-bold text-[#102521]">Book now</Link><Link to="/explore" search={{}} className="rounded-full border border-white/30 px-5 py-3 font-bold hover:bg-white/10">Browse venues</Link></div></section>

      <footer className="bg-[#061a17] px-5 py-10 text-white/65 sm:px-8"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-7 md:flex-row"><div><div className="font-display text-xl font-bold text-white">CourtHub</div><p className="mt-2 max-w-xs text-sm">A better starting point for every game.</p></div><div className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm sm:grid-cols-3"><Link to="/explore" search={{}} className="hover:text-[#b8f05a]">Explore venues</Link><a href="#contact" className="hover:text-[#b8f05a]">Support</a><a href="#about" className="hover:text-[#b8f05a]">Become a venue partner</a><a href="#contact" className="hover:text-[#b8f05a]">Privacy</a><a href="#contact" className="hover:text-[#b8f05a]">Terms</a><a href="#contact" className="hover:text-[#b8f05a]">FAQ</a></div></div><div className="mx-auto mt-10 max-w-7xl border-t border-white/10 pt-5 text-xs">© {new Date().getFullYear()} CourtHub. All rights reserved.</div></footer>
      {lightbox && <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/85 p-5" role="dialog" aria-modal="true" aria-label="Highlight preview" onClick={() => setLightbox(null)}><button className="absolute right-5 top-5 rounded-full bg-white/15 p-2 text-white" aria-label="Close preview"><CloseIcon /></button><img src={lightbox} alt="CourtHub community highlight" className="max-h-[85vh] max-w-full rounded-2xl object-contain" /></div>}
    </div>
  );
}

function SectionIntro({ eyebrow, title, action }: { eyebrow: string; title: string; action?: string }) {
  return <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.2em] text-[#12806d]">{eyebrow}</p><h2 className="mt-2 max-w-2xl font-display text-4xl font-bold tracking-tight sm:text-5xl">{title}</h2></div>{action && <Link to="/explore" search={{}} className="inline-flex items-center gap-1 text-sm font-bold text-[#0b3d35] hover:text-[#12806d]">{action} <ChevronRight className="h-4 w-4" /></Link>}</div>;
}

function LandingInput({ label, placeholder, type = "text" }: { label: string; placeholder: string; type?: string }) {
  return <label className="mt-4 block text-sm font-bold">{label}<input type={type} placeholder={placeholder} className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-[#fbfcfb] px-3 py-2.5 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50" required /></label>;
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
  const [listScrolled, setListScrolled] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => setListScrolled(el.scrollTop > 40);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [listRef]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={
          "overflow-hidden border-b border-border transition-all duration-200 " +
          (listScrolled ? "max-h-0 border-b-0 py-0 opacity-0" : "max-h-24 px-4 py-3 opacity-100")
        }
      >
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
                    <div className="text-xs text-muted-foreground">{(c as { variableRate?: boolean }).variableRate ? "from " : ""}₱{c.hourly_rate.toFixed(0)} / hour</div>
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
