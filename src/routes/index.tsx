import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import {
  normalizeRules,
  minRate,
  maxRate,
  hasVariablePricing,
  distinctRates,
  rateInBounds,
  type RateRule,
  type PriceBounds,
} from "@/lib/court-pricing";
import { RateCard } from "@/components/RateCard";
import {
  normalizeHours,
  describeWindow,
  effectiveHours,
  HOUR_DAY_KEYS,
  type HoursMap,
} from "@/lib/operating-hours";
import { zonedDateISO, zonedDayOfWeek } from "@/lib/tz";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Search,
  SlidersHorizontal,
  MapPin,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ArrowLeft,
  Crosshair,
  Menu,
  CalendarCheck2,
  CalendarDays,
  ShieldCheck,
  Map as MapIcon,
  BellRing,
  ReceiptText,
  UsersRound,
  Sparkles,
  ChevronRight,
  Play,
  Building2,
  Mail,
  Phone,
  Instagram,
  Facebook,
  Clock3,
  Star,
  Trophy,
  Handshake,
  Accessibility,
  Wifi,
  X as CloseIcon,
  User,
  UserPlus,
  PlayCircle,
  LogOut,
  Info,
  Eye,
  LandPlot,
  Maximize2,
  Twitter,
  Music2,
  Heart,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { VenueMap, type MapVenue } from "@/components/VenueMap";
import { MapPicker } from "@/components/MapPicker";
import { PlayerShell, PlayerSearchBar } from "@/components/PlayerShell";
import { LegalReader } from "@/components/LegalDocument";
import { PaymentRally } from "@/components/PaymentRally";
import { PRIVACY, TERMS, LEGAL_VERSION } from "@/lib/legal";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { searchPhPlaces, type PhPlace } from "@/lib/ph-places";

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* Google's four-color "G" mark, inlined rather than fetched — the auth sheet has no other
   dependency on an icon CDN and this keeps the button recognizable at a glance. */
function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.11A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.27A11.99 11.99 0 0 0 0 12c0 1.94.46 3.77 1.27 5.39l4-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.27 6.61l4 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

/* Google is a redirect flow: the role step can't hand signUp() a role the way the email/
   password form does, because the browser leaves for Google and comes back as a fresh page
   load with nothing but a session. The role picked before that redirect is stashed here and
   read back once the session lands — see the "Continue with Google" handlers and the account
   hydration effect below. */
const GOOGLE_PENDING_ROLE_KEY = "courthub_google_pending_role";

function hasGoogleProvider(user: {
  app_metadata?: { provider?: string; providers?: string[] } | null;
}): boolean {
  const providers =
    user.app_metadata?.providers ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
  return providers.includes("google");
}

/* True only for a Google-provider account whose very first sign-in is happening right now
   (created_at and last_sign_in_at land within a few seconds of each other). That's the
   signature of clicking "Continue with Google" from Sign in with no CourtHub account behind
   it yet — Supabase still creates the account on the spot, since that's how OAuth works, but
   nobody has chosen player or venue manager for it. A returning Google user's last_sign_in_at
   is long past their created_at, so this stays false for them. */
function isFreshGoogleAccount(user: {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  created_at: string;
  last_sign_in_at?: string | null;
}): boolean {
  if (!hasGoogleProvider(user)) return false;
  const createdAt = new Date(user.created_at).getTime();
  const lastSignIn = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : createdAt;
  return Math.abs(lastSignIn - createdAt) < 10_000;
}

const searchSchema = z.object({
  sport: z.string().optional(),
  explore: z.boolean().optional().catch(false),
  signin: z.boolean().optional().catch(false),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  /* The root no longer renders anything itself — it forwards to the real path and carries the
     search along, so /?signin=true still opens the sign-in sheet on arrival. ?explore=true was
     the old way of reaching the map, so that goes to /explore rather than through the landing
     page. */
  beforeLoad: ({ search }) => {
    if (search.explore) {
      throw redirect({ to: "/explore", search: { sport: search.sport } });
    }
    throw redirect({
      to: "/landing",
      search: { signin: search.signin, sport: search.sport },
    });
  },
  component: () => null,
  head: () => ({
    meta: [
      { title: "CourtHub — Find & book premium sports courts" },
      {
        name: "description",
        content:
          "Discover courts near you on the map, filter by sport and price, and book in seconds.",
      },
      { property: "og:title", content: "CourtHub — Find & book premium sports courts" },
      {
        property: "og:description",
        content: "Map-first court discovery. Filter, browse and book premium venues.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

type Sport = { id: number; name: string; slug: string };

/** Shown under the Min/Max ₱/hr inputs and as their tooltip. The filter matches a
 *  court's rate *range*, not every hour of it, so say so — otherwise "Max ₱500"
 *  reads as a promise that no hour of the booking can cost more. */
/** Shown one at a time on the blurred backdrop beside the sign-in drawer. The first is the
 *  brand line; the rest keep a long sign-in from staring at the same sentence. Each is
 *  revealed, held, glazed and faded by `handwrite-loop`, and the next one is swapped in on
 *  the animation's own iteration event, so the copy can never drift out of step with it. */
const SIGN_IN_TAGLINES = [
  "Where Every Game Feels Like Home",
  "Find Your Court, Find Your People",
  "Every Great Game Starts Here",
  "The Court Is Calling",
  "Play More, Plan Less",
];

const PRICE_FILTER_HINT =
  "Matches courts with at least one time slot in this price range. A court with time-based pricing counts if any hour falls inside it.";

/** A court as the explore map query builds it — MapVenue's shape plus the
 *  pricing/photo extras the sidebar tiles render. */
type ExploreCourt = MapVenue["courts"][number] & {
  variableRate?: boolean;
  /** Cheapest/dearest ₱/hr this court can charge once `rate_rules` are applied.
   *  Equal to each other for a flat-rate court. The ₱/hr filter matches against
   *  this range, so it agrees with the "from ₱X/hr" the tile shows. */
  rateMin?: number;
  rateMax?: number;
  /** The court's un-ruled `hourly_rate`, kept because `hourly_rate` above holds
   *  `rateMin` for display. The rate card needs the real base to fill the hours
   *  no rule covers. */
  baseRate?: number;
  rateRules?: RateRule[];
  /** The court's effective schedule, so the rate card lists only bookable hours. */
  openHours?: HoursMap | null;
  /** Every distinct ₱/hr this court charges in a week. The ₱/hr filter tests these
   *  real rates, so an included court always has a band to light up. */
  rateValues?: number[];
  images?: string[];
  sportName?: string | null;
};

/** A venue enriched with the fields the sidebar needs beyond the map's own.
 *  `courts` is omitted before re-adding it — an intersection would merge the
 *  two array types instead of replacing, hiding the extra court fields. */
type ExploreVenue = Omit<MapVenue, "courts"> & {
  /** Dearest ₱/hr any of this venue's courts can reach, so the tile can print a
   *  range instead of a "from" price that no longer matches what gets charged. */
  maxRate?: number | null;
  sports?: string[];
  distanceKm?: number | null;
  images?: string[] | null;
  operatingHours?: Record<string, string> | null;
  courts: ExploreCourt[];
};

export function VenueExplorer({ sport, guestMode }: { sport?: string; guestMode?: boolean }) {
  const navigate = useNavigate({ from: "/" });

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const { data: player } = useQuery({
    queryKey: ["auth-player-session"],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return null;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, full_name, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      const metadata = user.user_metadata as { role?: unknown; full_name?: unknown };
      const role = profile?.role === "tenant" || metadata.role === "tenant" ? "tenant" : "player";
      return {
        id: user.id,
        email: user.email ?? "",
        name:
          profile?.full_name ||
          (typeof metadata.full_name === "string" ? metadata.full_name : "") ||
          user.email?.split("@")[0] ||
          "Player",
        avatarUrl: profile?.avatar_url ?? null,
        role,
      };
    },
    staleTime: 1000 * 60 * 10,
  });

  const explorerQueryClient = useQueryClient();
  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange(() => {
      void explorerQueryClient.invalidateQueries({ queryKey: ["auth-player-session"] });
    });
    return () => subscription.subscription.unsubscribe();
  }, [explorerQueryClient]);

  const { data: sports } = useQuery({
    queryKey: ["sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("id, name, slug").order("name");
      if (error) throw error;
      return data as Sport[];
    },
  });

  // Filter state
  // Map/landmark search — picking a result re-centres the map on that place
  // rather than filtering venues by name.
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeResults, setPlaceResults] = useState<PhPlace[]>([]);
  /** Map viewport centre, used to bias place suggestions to what is on screen. */
  const mapCenterRef = useRef<{ lat: number; lng: number } | null>(null);
  /** Mirrors `nearby` so the debounced search can read it without re-subscribing. */
  const nearbyRef = useRef<{ lat: number; lng: number } | null>(null);
  const [placeNote, setPlaceNote] = useState<string | undefined>(undefined);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  /** Full structured record for the place the user picked, kept for downstream use. */
  const [selectedPlace, setSelectedPlace] = useState<PhPlace | null>(null);
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

  // Debounce inputs
  const [dCity, setDCity] = useState(filterCity);
  useEffect(() => {
    const t = setTimeout(() => setDCity(filterCity), 250);
    return () => clearTimeout(t);
  }, [filterCity]);

  useEffect(() => {
    nearbyRef.current = nearby;
  }, [nearby]);

  // Debounced Philippine place lookup. Ranking, normalisation, fallback and
  // Nominatim rate-limiting all live in `searchPhPlaces`.
  useEffect(() => {
    const q = placeQuery.trim();
    if (q.length < 3) {
      setPlaceResults([]);
      setPlaceNote(undefined);
      setPlaceSearching(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPlaceSearching(true);
      try {
        const r = await searchPhPlaces(q, {
          signal: ctrl.signal,
          limit: 10,
          near: nearbyRef.current ?? mapCenterRef.current,
        });
        if (ctrl.signal.aborted) return;
        setPlaceResults(r.results);
        setPlaceNote(r.note);
      } catch {
        // Aborted or offline — keep whatever is on screen.
      } finally {
        if (!ctrl.signal.aborted) setPlaceSearching(false);
      }
    }, 400);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [placeQuery]);

  const hasFilters = !!(filterSport || filterCity.trim() || minPrice || maxPrice);

  const { data: venues, isFetching } = useQuery({
    queryKey: ["venues-map", filterSport, dCity.trim().toLowerCase()],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const usesCourtFilter = !!filterSport;
      const courtsSelect = usesCourtFilter
        ? "courts!inner(id, name, hourly_rate, rate_rules, inherit_venue_hours, operating_hours, map_emoji, images, sports!inner(slug, name))"
        : "courts(id, name, hourly_rate, rate_rules, inherit_venue_hours, operating_hours, map_emoji, images, sports(slug, name))";
      let q = supabase
        .from("venues")
        .select(
          `id, name, address, latitude, longitude, map_emoji, images, operating_hours, ${courtsSelect}`,
        )
        .eq("is_active", true)
        .order("name")
        /* Ordered by name, so the cap truncates the alphabet: at 100 a venue named "Z…" fell
           off the map with nothing to show for it. Raised to 500 to put that far beyond the
           realistic venue count. It is still a ceiling — each venue drags its courts, and each
           court its rate_rules and operating_hours, all of which are priced client-side by
           minRate/maxRate. Past a few hundred venues the honest fix is loading by map
           viewport rather than a bigger number here. */
        .limit(500);
      if (dCity.trim()) q = q.ilike("address", `%${dCity.trim()}%`);
      if (filterSport) q = q.eq("courts.sports.slug", filterSport);
      // No ₱/hr bounds here: Postgres cannot evaluate `rate_rules`, so a
      // time-based court's real price is only known after `minRate`/`maxRate`
      // run. The price filter is applied in `priceFilteredVenues` instead.

      const { data, error } = await q;
      if (error) throw error;
      type Row = {
        id: number;
        name: string;
        address: string;
        latitude: number | null;
        longitude: number | null;
        map_emoji: string | null;
        images: string[] | null;
        operating_hours: Record<string, string> | null;
        courts: {
          id: number;
          name: string;
          hourly_rate: number;
          rate_rules?: unknown;
          inherit_venue_hours?: boolean | null;
          operating_hours?: unknown;
          map_emoji: string | null;
          images: string[] | null;
          sports: { slug: string; name: string } | null;
        }[];
      };
      const sportDefault = (slug?: string | null) => {
        switch (slug) {
          case "pickleball":
            return "🥎";
          case "tennis":
            return "🎾";
          case "basketball":
            return "🏀";
          case "table-tennis":
            return "🏓";
          case "badminton":
            return "🏸";
          case "volleyball":
            return "🏐";
          case "football":
          case "soccer":
            return "⚽";
          default:
            return null;
        }
      };
      return (data as unknown as Row[]).map<ExploreVenue & { sports: string[] }>((v) => {
        // Prices come from bookable hours only, so a base rate that every rule
        // overrides during opening hours never reaches the tiles or the filter.
        const courtHours = (c: Row["courts"][number]) =>
          effectiveHours(
            { inherit_venue_hours: c.inherit_venue_hours, operating_hours: c.operating_hours },
            v.operating_hours,
          );
        const courtRanges =
          v.courts?.map((c) => {
            const rules = normalizeRules(c.rate_rules);
            const base = Number(c.hourly_rate);
            const hrs = courtHours(c);
            return { lo: minRate(base, rules, hrs), hi: maxRate(base, rules, hrs) };
          }) ?? [];
        const sportSet = new Map<string, string>();
        v.courts?.forEach((c) => c.sports && sportSet.set(c.sports.slug, c.sports.name));
        return {
          id: v.id,
          name: v.name,
          address: v.address,
          latitude: v.latitude,
          longitude: v.longitude,
          courtCount: v.courts?.length ?? 0,
          minRate: courtRanges.length ? Math.min(...courtRanges.map((r) => r.lo)) : null,
          maxRate: courtRanges.length ? Math.max(...courtRanges.map((r) => r.hi)) : null,
          mapEmoji: v.map_emoji ?? null,
          images: v.images ?? [],
          operatingHours: v.operating_hours ?? null,
          courts: (v.courts ?? []).map((c) => {
            const base = Number(c.hourly_rate);
            const rules = normalizeRules(c.rate_rules);
            const hrs = courtHours(c);
            const lo = minRate(base, rules, hrs);
            const hi = maxRate(base, rules, hrs);
            return {
              id: c.id,
              name: c.name,
              hourly_rate: lo,
              rateMin: lo,
              rateMax: hi,
              baseRate: base,
              rateRules: rules,
              openHours: hrs,
              rateValues: distinctRates(base, rules, hrs),
              variableRate: hasVariablePricing(base, rules, hrs),
              mapEmoji: c.map_emoji ?? v.map_emoji ?? sportDefault(c.sports?.slug) ?? null,
              // Only the court's own photos — no venue fallback, so a court with
              // nothing uploaded shows its emoji placeholder instead.
              images: c.images ?? [],
              sportName: c.sports?.name ?? null,
            };
          }),
          sports: Array.from(sportSet.values()),
        };
      });
    },
  });

  /** Applies the Min/Max ₱/hr bounds to the *effective* price a court charges —
   *  the same figure its tile prints — rather than the raw `hourly_rate` column.
   *  A court with time-based pricing keeps a range, and matches when that range
   *  overlaps the filter at any hour (₱400–800 is a hit for "Min ₱450"). Venues
   *  survive only if at least one of their courts does, and `courtCount`/`minRate`
   *  are recomputed from the survivors so the card never advertises a price that
   *  was just filtered out. */
  /** The Min/Max ₱/hr as numbers, or null when the filter is off. Parsed once so
   *  the venue list and the rate card's highlighting read the same bounds. */
  const priceBounds = useMemo<PriceBounds | null>(() => {
    const lo = Number(minPrice);
    const hi = Number(maxPrice);
    const min = minPrice.trim() !== "" && Number.isFinite(lo) ? lo : null;
    const max = maxPrice.trim() !== "" && Number.isFinite(hi) ? hi : null;
    return min == null && max == null ? null : { min, max };
  }, [minPrice, maxPrice]);

  const priceFilteredVenues = useMemo(() => {
    if (!venues || !priceBounds) return venues;

    const kept: typeof venues = [];
    for (const v of venues) {
      const courts = v.courts.filter((c) =>
        (c.rateValues ?? [c.hourly_rate]).some((r) => rateInBounds(r, priceBounds)),
      );
      if (!courts.length) continue;
      kept.push({
        ...v,
        courts,
        courtCount: courts.length,
        minRate: Math.min(...courts.map((c) => c.rateMin ?? c.hourly_rate)),
        maxRate: Math.max(...courts.map((c) => c.rateMax ?? c.hourly_rate)),
      });
    }
    return kept;
  }, [venues, priceBounds]);

  const {
    list: sortedVenues,
    empty: nearbyEmpty,
    nearestSuggestion,
  } = useMemo(() => {
    const venues = priceFilteredVenues;
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
    return {
      list: inRadius,
      empty: inRadius.length === 0,
      nearestSuggestion: withDistance.slice(0, 5),
    };
  }, [priceFilteredVenues, nearby, radiusKm, nationwide]);

  const [showNearestPeek, setShowNearestPeek] = useState(false);
  useEffect(() => {
    if (!nearbyEmpty) setShowNearestPeek(false);
  }, [nearbyEmpty]);

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
        setLocationMode("gps");
        setNearbyLoading(false);
      },
      (err) => {
        setNearbyError(err.message || "Please allow location access.");
        setNearbyLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const saveManualLocation = (lat: number, lng: number) => {
    setNearby({ lat, lng });
    setLocationMode("manual");
    setManualPickerOpen(false);
  };

  const resetAll = () => {
    setPlaceQuery("");
    setPlaceResults([]);
    setSelectedPlace(null);
    setFilterSport("");
    setFilterCity("");
    setMinPrice("");
    setMaxPrice("");
    setNearby(null);
    setNationwide(false);
    setActiveVenueId(null);
    setLocationMode(null);
    if (sport) navigate({ search: {} });
  };

  const displayVenues = showNearestPeek && nearbyEmpty ? nearestSuggestion : sortedVenues;
  const activeVenue =
    activeVenueId != null ? displayVenues.find((v) => v.id === activeVenueId) : null;

  /* Shared by the shell and by the search bar in the toolbar below, which is outside
     the shell on this page. */
  const signOutPlayer = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  // Auto-scroll list to active venue
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeVenueId == null || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-vid="${activeVenueId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeVenueId]);

  const exploreContent = (
    <div className="flex h-full flex-col">
      {/* TOP TOOLBAR */}
      <div className="sticky top-0 z-900 border-b-2 border-[#b8f05a]/50 bg-linear-to-br from-[#0f4a40] to-[#09231f]">
        <div className="flex w-full flex-col gap-2.5 px-4 py-3 sm:px-6 md:pr-8 lg:pr-10">
          {/* Title + tagline */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-lg font-extrabold tracking-tight text-[#b8f05a] sm:text-xl">
                What are you playing today?
              </h1>
              <p className="mt-0.5 text-xs font-medium text-white/70 sm:text-sm">
                {guestMode
                  ? "Browse every venue and court. Booking opens once you sign in."
                  : "Explore the map, filter by sport or price, and lock in your slot."}
              </p>
            </div>
            {/* A signed-in player gets the master search and the bell here rather than
                in a bar of their own — this page is a full-height map, and a second
                strip above it cost more than it was worth. */}
            {/* `!guestMode` as well as `player`: /explore/guest keeps showing the guest
                face to someone who signed in while sitting on it (see the note on that
                route), and a personal search bar beside a "Guest mode" badge would be
                the wrong half of that contradiction to resolve here. */}
            {player && player.role !== "tenant" && !guestMode && (
              <PlayerSearchBar
                userId={player.id}
                onSignOut={signOutPlayer}
                tone="dark"
                /* `self-center` against the row's `items-start`: the title beside it is
                   two lines, and a top-aligned field reads as if it slipped. */
                className="hidden self-center md:flex"
              />
            )}
            {guestMode && (
              <div className="flex shrink-0 flex-col items-end gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#b8f05a]/45 bg-[#b8f05a]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[.14em] text-[#d9ff9b]">
                  <Eye className="h-3.5 w-3.5" /> Guest mode
                </span>
                {/* Secondary then primary, sharing a height and radius so they read as a pair.
                    flex-wrap because on a narrow phone this column sits beside the toolbar
                    title and two pills will not fit on one line. */}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Link
                    to="/landing"
                    search={{}}
                    className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.1em] text-white/85 transition hover:-translate-y-0.5 hover:border-[#b8f05a] hover:bg-white/10 hover:text-white"
                  >
                    <ArrowLeft className="h-3 w-3" /> Back to home
                  </Link>
                  <Link
                    to="/landing"
                    search={{ signin: true }}
                    className="inline-flex items-center gap-1 rounded-full bg-[#b8f05a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.1em] text-[#102521] shadow-sm transition hover:-translate-y-0.5 hover:bg-[#d3ff87]"
                  >
                    Sign in to book <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Sport chips */}
          <div className="flex flex-wrap gap-1.5 border-t border-white/10 pt-2.5">
            <button
              type="button"
              onClick={() => setFilterSport("")}
              className={
                "rounded-full border px-3 py-1 text-xs font-semibold transition " +
                (!filterSport
                  ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521] shadow-sm"
                  : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
              }
            >
              All sports
            </button>
            {(sports ?? []).map((s) => {
              const emoji =
                s.slug === "pickleball"
                  ? "🥎"
                  : s.slug === "tennis"
                    ? "🎾"
                    : s.slug === "basketball"
                      ? "🏀"
                      : s.slug === "table-tennis"
                        ? "🏓"
                        : s.slug === "badminton"
                          ? "🏸"
                          : s.slug === "volleyball"
                            ? "🏐"
                            : s.slug === "football" || s.slug === "soccer"
                              ? "⚽"
                              : "🏟️";
              const active = filterSport === s.slug;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setFilterSport(active ? "" : s.slug)}
                  className={
                    "flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition " +
                    (active
                      ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521] shadow-sm"
                      : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
                  }
                >
                  <span aria-hidden>{emoji}</span> {s.name}
                </button>
              );
            })}
          </div>

          {/* Search + action buttons */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <div className="flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-2 transition focus-within:border-[#b8f05a] focus-within:ring-2 focus-within:ring-[#b8f05a]/30">
                <Search className="h-4 w-4 shrink-0 text-[#b8f05a]" aria-hidden />
                <input
                  type="text"
                  value={placeQuery}
                  onChange={(e) => {
                    setPlaceQuery(e.target.value);
                    setPlaceOpen(true);
                  }}
                  onFocus={() => setPlaceOpen(true)}
                  // Delay so a click on a result lands before the list unmounts.
                  onBlur={() => setTimeout(() => setPlaceOpen(false), 150)}
                  placeholder="Search a place or landmark — e.g. Ayala Center Cebu…"
                  className="w-full min-w-0 bg-transparent text-sm text-white outline-none placeholder:text-white/50"
                />
                {placeQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlaceQuery("");
                      setPlaceResults([]);
                    }}
                    className="text-white/60 hover:text-[#b8f05a]"
                    aria-label="Clear"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {placeOpen && placeQuery.trim().length >= 3 && (
                <ul className="absolute left-0 right-0 top-full z-1000 mt-1 max-h-72 overflow-y-auto rounded-2xl border-2 border-[#0f4a40] bg-[#09231f] py-1 shadow-xl ring-1 ring-[#b8f05a]/50">
                  {placeSearching && placeResults.length === 0 && (
                    <li className="px-3 py-2 text-xs text-white/60">Searching…</li>
                  )}
                  {!placeSearching && placeResults.length === 0 && (
                    <li className="px-3 py-2 text-xs text-white/60">
                      {placeNote ?? "No places found."}
                    </li>
                  )}
                  {placeResults.length > 0 && placeNote && (
                    <li className="border-b border-white/10 px-3 py-1.5 text-[10px] italic text-white/50">
                      {placeNote}
                    </li>
                  )}
                  {placeResults.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPlace(r);
                          setNearby({ lat: r.lat, lng: r.lng });
                          setLocationMode("manual");
                          setNationwide(false);
                          setActiveVenueId(null);
                          setPlaceQuery(r.label);
                          setPlaceOpen(false);
                        }}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-[#b8f05a]/15"
                      >
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b8f05a]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate text-xs font-bold text-[#b8f05a]">
                              {r.label}
                            </span>
                            {r.approximate && (
                              <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200">
                                approx
                              </span>
                            )}
                          </span>
                          {r.displaySuffix && (
                            <span className="block truncate text-[11px] text-white/60">
                              {r.displaySuffix.replace(/^,\s*/, "")}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              className={
                "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition " +
                (hasFilters || filterOpen
                  ? "border-[#b8f05a] bg-[#b8f05a]/20 text-[#b8f05a]"
                  : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
              }
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Filters</span>
              {hasFilters && (
                <span className="rounded-full bg-[#b8f05a] px-1.5 text-[10px] font-bold text-[#102521]">
                  •
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={requestNearby}
              disabled={nearbyLoading}
              className={
                "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition " +
                (nearby && locationMode === "gps"
                  ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521]"
                  : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
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
                  ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521]"
                  : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
              }
              title="Pin your location manually — search a place or paste coordinates"
            >
              <Crosshair className="h-4 w-4" />
              <span className="hidden sm:inline">Pin manually</span>
            </button>
          </div>

          {filterOpen && (
            <div className="grid gap-2 rounded-2xl border border-white/15 bg-white/5 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#b8f05a]">
                  Sport
                </span>
                <select
                  value={filterSport}
                  onChange={(e) => setFilterSport(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/20 bg-[#09231f] px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#b8f05a]"
                >
                  <option value="">Any sport</option>
                  {(sports ?? []).map((s) => (
                    <option key={s.id} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#b8f05a]">
                  City / Province
                </span>
                <input
                  type="text"
                  value={filterCity}
                  onChange={(e) => setFilterCity(e.target.value)}
                  placeholder="e.g. Cebu, Makati"
                  className="mt-1 w-full rounded-lg border border-white/20 bg-[#09231f] px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#b8f05a]"
                />
              </label>
              <label className="block" title={PRICE_FILTER_HINT}>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#b8f05a]">
                  Min available ₱/hr
                </span>
                <input
                  type="number"
                  min={0}
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder="0"
                  aria-describedby="price-filter-hint"
                  className="mt-1 w-full rounded-lg border border-white/20 bg-[#09231f] px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#b8f05a]"
                />
              </label>
              <label className="block" title={PRICE_FILTER_HINT}>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#b8f05a]">
                  Max available ₱/hr
                </span>
                <input
                  type="number"
                  min={0}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="Any"
                  aria-describedby="price-filter-hint"
                  className="mt-1 w-full rounded-lg border border-white/20 bg-[#09231f] px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[#b8f05a]"
                />
              </label>
              {/* Spelled out rather than left to the `title` tooltip alone, which
                  touch devices never show. */}
              <p
                id="price-filter-hint"
                className="col-span-full text-[11px] leading-snug text-white/60"
              >
                {PRICE_FILTER_HINT}
              </p>
              <div className="col-span-full flex items-center justify-between pt-1">
                <span className="text-xs text-white/70">
                  {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"} match
                </span>
                <button
                  type="button"
                  onClick={resetAll}
                  className="text-xs font-semibold text-[#b8f05a] hover:underline"
                >
                  Clear all
                </button>
              </div>
            </div>
          )}

          {nearby && (
            <div className="flex flex-col gap-2 rounded-2xl border border-[#b8f05a]/30 bg-[#b8f05a]/10 px-3 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#b8f05a]">
                  <MapPin className="h-3.5 w-3.5" />
                  {nationwide
                    ? "Nationwide · sorted by distance"
                    : selectedPlace
                      ? `Within ${radiusKm} km of ${selectedPlace.label}`
                      : `Within ${radiusKm} km`}
                  <span className="ml-1 rounded-full bg-[#b8f05a]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b8f05a]">
                    {locationMode === "manual" ? "Manual pin" : "GPS"}
                  </span>
                  {locationMode === "manual" && (
                    <button
                      type="button"
                      onClick={() => setManualPickerOpen(true)}
                      className="text-[11px] font-semibold text-[#b8f05a] underline underline-offset-2 hover:opacity-80"
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
                      className="h-1.5 flex-1 min-w-35 cursor-pointer accent-primary"
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
                              ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521]"
                              : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
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
                          if (Number.isFinite(n) && n > 0)
                            setRadiusKm(Math.min(500, Math.max(1, Math.round(n))));
                        }}
                        className="w-14 rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white outline-none focus:border-[#b8f05a]"
                        aria-label="Custom radius in kilometers"
                      />
                      <span className="text-[11px] text-white/70">km</span>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setNationwide((v) => !v)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition " +
                    (nationwide
                      ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521]"
                      : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]")
                  }
                >
                  🌏 Nationwide
                </button>
                <span className="text-[11px] text-white/70">
                  {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setNearby(null);
                    setNationwide(false);
                    setShowNearestPeek(false);
                    setLocationMode(null);
                  }}
                  className="ml-auto text-[11px] font-semibold text-white/70 hover:text-[#b8f05a]"
                >
                  Clear location
                </button>
              </div>

              {!nationwide && nearbyEmpty && radiusKm >= 25 && nearestSuggestion.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <span className="font-semibold">No venues within {radiusKm} km.</span>
                  <span>Try a wider search:</span>
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    {[50, 100, 200]
                      .filter((km) => km > radiusKm)
                      .map((km) => (
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
              <button onClick={() => setNearbyError(null)} aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* MAP + LIST */}
      <div className="relative flex w-full flex-1 min-h-0 flex-col">
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Map */}
          <div className="relative m-3 flex-1 min-h-0 overflow-hidden rounded-2xl border-2 border-[#0f4a40] shadow-sm ring-1 ring-[#b8f05a]/50">
            <VenueMap
              venues={displayVenues}
              activeVenueId={activeVenueId}
              onSelectVenue={setActiveVenueId}
              onOpenVenue={(id) =>
                navigate({ to: "/venues/$venueId", params: { venueId: String(id) }, search: {} })
              }
              onOpenCourt={(id) =>
                navigate({ to: "/courts/$courtId", params: { courtId: String(id) }, search: {} })
              }
              nearby={nearby}
              radiusKm={nearby && !nationwide ? radiusKm : null}
              radiusHasMatches={!nearbyEmpty}
              centerRef={mapCenterRef}
            />

            {isFetching && (
              <div className="absolute right-3 top-3 z-500 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground shadow-md">
                Updating…
              </div>
            )}
          </div>

          {/* Right sidebar (desktop / tablet) */}
          <aside className="my-3 mr-3 hidden w-[38%] min-w-[380px] shrink-0 min-h-0 overflow-hidden rounded-2xl border-2 border-[#0f4a40] bg-[#f6f8f7] shadow-sm ring-1 ring-[#b8f05a]/50 dark:bg-[#0b2b26] md:flex md:flex-col">
            <VenueList
              venues={displayVenues}
              activeVenueId={activeVenueId}
              onSelectVenue={setActiveVenueId}
              activeVenue={activeVenue}
              listRef={listRef}
              priceFilter={priceBounds}
            />
          </aside>

          {/* Mobile bottom sheet */}
          <div className={"pointer-events-none absolute inset-x-0 bottom-0 z-600 md:hidden"}>
            <div
              className={
                "pointer-events-auto flex flex-col rounded-t-3xl border-t border-[#0f4a40]/15 bg-[#f6f8f7] shadow-2xl transition-[height] duration-300 dark:border-white/10 dark:bg-[#0b2b26] " +
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
                  {sheetExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronUp className="h-3 w-3" />
                  )}
                  {sortedVenues.length} {sortedVenues.length === 1 ? "venue" : "venues"}
                </span>
              </button>
              <VenueList
                venues={displayVenues}
                activeVenueId={activeVenueId}
                onSelectVenue={(id) => {
                  setActiveVenueId(id);
                  if (id != null) setSheetExpanded(false);
                }}
                activeVenue={activeVenue}
                listRef={listRef}
                priceFilter={priceBounds}
              />
            </div>
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

  if (player && player.role !== "tenant") {
    return (
      <PlayerShell
        section="explore"
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        userId={player.id}
        fullName={player.name}
        avatarUrl={player.avatarUrl}
        onSignOut={signOutPlayer}
      >
        <div className="h-full w-full flex-1 min-h-0">
          {exploreContent}
        </div>
      </PlayerShell>
    );
  }

  return (
    <div className="h-full w-full flex-1 min-h-0">
      {exploreContent}
    </div>
  );
}

/** Keep this in the order the sections appear down the page. It drives both the desktop
 *  pill nav and the mobile menu, and the scroll spy lights the entry matching whichever
 *  section is on screen — so a mismatch makes the highlight jump backwards as you scroll. */
const landingNav = [
  "Home",
  "Venues",
  "How It Works",
  "Learn Sports",
  "Upcoming Events",
  "Features",
  "Highlights",
  "About",
  "Contact",
] as const;
/** Content for the Learn Sports panel. Editorial copy, not database rows — these are the
 *  rules of each game, which do not change per venue and have no business being fetched. */
/** Dots thrown by the back-to-top burst. Angles are evenly spread with a small per-dot
 *  offset so it does not read as a wheel, distances vary, and every dy carries a +12px
 *  downward bias so the dots fall as they fade — that fall is the difference between a
 *  shower and a ring. Derived from the index, not Math.random, so it is identical every
 *  time it fires and stays reviewable. */
/** Embers that drip off the fuse while it travels. One shared 1.2s loop with offset delays
 *  reads as continuous rain without needing five separate animation utilities. */
const FUSE_EMBERS = [
  { ex: -3, delay: 0 },
  { ex: 1, delay: 0.24 },
  { ex: 4, delay: 0.48 },
  { ex: -1, delay: 0.72 },
  { ex: 3, delay: 0.96 },
];

const SHOWER_DOTS = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 + (i % 3) * 0.22;
  const distance = 20 + ((i * 7) % 16);
  return {
    dx: Math.cos(angle) * distance,
    dy: Math.sin(angle) * distance + 12,
    size: i % 3 === 0 ? 3 : 2,
    delay: (i % 5) * 28,
  };
});

const learnSports = [
  {
    slug: "pickleball",
    /* Pexels 34618472, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/34618472/pexels-photo-34618472.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "Singles or doubles" },
      { label: "Court", value: "20 × 44 ft" },
      { label: "Game", value: "First to 11, win by 2" },
    ],
    name: "Pickleball",
    emoji: "\u{1F94E}",
    blurb:
      "The fastest-growing racket sport in the country. Easy to pick up in an afternoon, hard to put down.",
    rules: [
      "Serve underhand and diagonally, with both feet behind the baseline.",
      "The two-bounce rule: the serve and the return must each bounce before anyone volleys.",
      "Stay out of the non-volley zone \u2014 the kitchen \u2014 when hitting a ball out of the air.",
      "Games run to 11, win by 2. Only the serving side scores.",
    ],
  },
  {
    slug: "basketball",
    /* Pexels 16599399, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/16599399/pexels-photo-16599399.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "5 a side" },
      { label: "Ring height", value: "10 ft / 3.05 m" },
      { label: "Format", value: "Four quarters" },
    ],
    name: "Basketball",
    emoji: "\u{1F3C0}",
    blurb:
      "Five a side, one ring, endless variations. The half-court game is the backbone of local play.",
    rules: [
      "Two points inside the arc, three from beyond it, one from the free-throw line.",
      "Keep your dribble alive \u2014 picking the ball up and restarting is a double dribble.",
      "Move the ball past half-court within eight seconds and shoot within the shot clock.",
      "Five fouls and you are out; team fouls send the other side to the line.",
    ],
  },
  {
    slug: "tennis",
    /* Pexels 28625142, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/28625142/pexels-photo-28625142.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "Singles or doubles" },
      { label: "Points", value: "15 · 30 · 40 · game" },
      { label: "Set", value: "First to 6, win by 2" },
    ],
    name: "Tennis",
    emoji: "\u{1F3BE}",
    blurb:
      "Singles or doubles, the classic court game \u2014 long rallies, sharp angles, and a scoring system all its own.",
    rules: [
      "Serve diagonally into the opposite service box; you get two attempts.",
      "Points climb 15, 30, 40, game \u2014 and deuce needs two clear points to settle.",
      "Six games take a set, but you must lead by two; 6\u20136 goes to a tiebreak.",
      "The ball may bounce once on your side before you return it.",
    ],
  },
  {
    slug: "badminton",
    /* Pexels 19902436, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/19902436/pexels-photo-19902436.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "Singles or doubles" },
      { label: "Game", value: "Rally to 21, win by 2" },
      { label: "Hard cap", value: "30 points" },
    ],
    name: "Badminton",
    emoji: "\u{1F3F8}",
    blurb:
      "The quickest racket sport there is. Deceptive, tactical, and brutal on the calves.",
    rules: [
      "Serve underarm below the waist, diagonally into the service court.",
      "Rally scoring to 21, win by 2, with a hard cap at 30.",
      "The shuttle may only be struck once per side \u2014 no carrying, no double hits.",
      "A shuttle landing on the line is in.",
    ],
  },
  {
    slug: "volleyball",
    /* Pexels 6203559, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/6203559/pexels-photo-6203559.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "6 a side" },
      { label: "Touches", value: "3 per side" },
      { label: "Set", value: "Rally to 25, win by 2" },
    ],
    name: "Volleyball",
    emoji: "\u{1F3D0}",
    blurb:
      "Six a side, three touches, one net. Positioning and communication beat raw power most nights.",
    rules: [
      "Three touches per side at most, and no player may touch it twice in a row.",
      "Rally scoring to 25, win by 2; the deciding set is played to 15.",
      "Win the rally on serve-receive and your team rotates one position clockwise.",
      "Back-row players cannot attack from in front of the attack line.",
    ],
  },
  {
    slug: "table-tennis",
    /* Pexels 38446271, verified 200 before use. Real photography rather than the
       emoji alone — the chips keep the emoji, the panel shows the game. */
    photo: "https://images.pexels.com/photos/38446271/pexels-photo-38446271.jpeg?auto=compress&cs=tinysrgb&w=900&h=560&fit=crop",
    facts: [
      { label: "Players", value: "Singles or doubles" },
      { label: "Game", value: "First to 11, win by 2" },
      { label: "Serve", value: "Alternates every 2 points" },
    ],
    name: "Table Tennis",
    emoji: "\u{1F3D3}",
    blurb:
      "Small table, tiny margins. Spin does most of the work once you know how to read it.",
    rules: [
      "The serve must bounce on your half first, then clear the net onto theirs.",
      "Serves alternate every two points, whoever wins them.",
      "Games run to 11, win by 2.",
      "Let the ball bounce once on your side \u2014 volleying it is a lost point.",
    ],
  },
] as const;

type HeaderMegaMenu = "Venues" | "Upcoming Events" | "Highlights";
const headerMegaMenuItems: Record<
  HeaderMegaMenu,
  {
    eyebrow: string;
    title: string;
    copy: string;
    items: { title: string; copy: string; soon?: boolean }[];
  }
> = {
  /* Venues renders live venue cards instead of `items` — see the mega-menu markup. The copy
     here is the only part still used for this entry. */
  Venues: {
    eyebrow: "Partner venues",
    title: "Places to play, right now",
    copy: "Real courts from venues already on CourtHub — hours, sports, and starting rates, straight from the venue.",
    items: [],
  },
  "Upcoming Events": {
    eyebrow: "Coming soon",
    title: "More ways to get in the game",
    copy: "Partner venues will soon share local activities directly on CourtHub.",
    items: [
      {
        title: "Tournaments",
        copy: "Competition dates, brackets, and venue announcements.",
        soon: true,
      },
      {
        title: "Open play & leagues",
        copy: "Find recurring games and community sessions.",
        soon: true,
      },
      {
        title: "Community events",
        copy: "Local gatherings, clinics, and special game days.",
        soon: true,
      },
    ],
  },
  /* Highlights renders live photo categories from the strip section's own images instead of
     `items` — see the mega-menu markup. The copy here is the only part still used. */
  Highlights: {
    eyebrow: "Community highlights",
    title: "The stories behind the game",
    copy: "Browse the moments, people, and events that make the CourtHub community move.",
    items: [],
  },
};
const heroImages = [
  "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1518065896235-a4c93e088e7a?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1800&q=85",
  "https://images.unsplash.com/photo-1592656094267-764a45160876?auto=format&fit=crop&w=1800&q=85",
];

/** Mounted by /landing. `signin` arrives as a prop rather than via Route.useSearch(), which
 *  would have kept reading the "/" route's search and broken once this moved. `from` still
 *  names /landing so the search updater below types against that route's schema. */
export function LandingPage({ signin, signup }: { signin?: boolean; signup?: boolean }) {
  const navigate = useNavigate({ from: "/landing" });
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<(typeof landingNav)[number]>("Home");
  /* Drives the staggered tile sweep in How It Works. Tracks isIntersecting rather than
     latching true once, so leaving the section and coming back replays it — removing the
     class and re-adding it is what restarts the CSS animation. */
  const howItWorksRef = useRef<HTMLElement | null>(null);
  const [stepsLit, setStepsLit] = useState(false);
  /* Which step tile has been tapped open into its player view. */
  const [openStep, setOpenStep] = useState<number | null>(null);
  const featuresRef = useRef<HTMLElement | null>(null);
  const [featuresLit, setFeaturesLit] = useState(false);
  const whyRef = useRef<HTMLElement | null>(null);
  const [whyLit, setWhyLit] = useState(false);
  const venuesRef = useRef<HTMLElement | null>(null);
  const [venuesLit, setVenuesLit] = useState(false);
  const [activeSport, setActiveSport] = useState<(typeof learnSports)[number]["slug"]>(
    "pickleball",
  );
  const [heroIndex, setHeroIndex] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  /* Which highlight category is open, and where in its three frames. */
  const [highlightOpen, setHighlightOpen] = useState<{ key: string; idx: number } | null>(null);
  /* Pausing is state rather than a pure :hover rule because touch devices have no hover — a
     CSS-only pause would leave the track sliding out from under a finger trying to swipe it.
     The resume side needs the same care: a phone fires touchstart but never mouseleave, so a
     pause that only lifts on mouseleave would freeze the strip permanently after one tap. */
  const [stripPaused, setStripPaused] = useState(false);
  /* The contact form has no backend behind it. Submitting used to preventDefault and do
     nothing at all, which reads as a broken button; this shows an honest notice instead. */
  const [contactNotice, setContactNotice] = useState(false);
  /* The header menu's venue rail. Native scroll rather than an index in state: the arrows just
     nudge scrollLeft, so a trackpad swipe and the buttons drive the same thing and cannot
     disagree about where the rail is. */
  const venueRailRef = useRef<HTMLDivElement | null>(null);
  /* Which category the header Highlights menu is showing. The tabs swap this; the tiles
     under them are that category's photos, and clicking one hands off to the same
     full-screen viewer the strip section opens. */
  const [headerHighlightKey, setHeaderHighlightKey] = useState("tournament");
  /* Which testimonials this visitor has liked. Local to the page — nothing is persisted or
     counted anywhere, so the button reflects their own tap and claims nothing more. */
  const [likedStories, setLikedStories] = useState<Record<string, boolean>>({});
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripResumeTimer = useRef<number | undefined>(undefined);
  /* Names the social network whose "coming soon" notice is showing, cleared on a timer. */
  const [socialSoon, setSocialSoon] = useState<string | null>(null);
  const socialSoonTimer = useRef<number | undefined>(undefined);
  const [headerSolid, setHeaderSolid] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const [headerHovering, setHeaderHovering] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  /* 0 at the top of the page, 1 at the bottom. Drives the ring around the back-to-top
     button, so its arc reads as distance remaining rather than just decoration. */
  const [scrollProgress, setScrollProgress] = useState(0);
  /* Bumped each time the ring closes, and used as the burst element's key so React remounts
     it and the one-shot keyframes replay. Scrolling up and back down fires it again; sitting
     at the bottom does not re-fire, which is what the edge-transition ref guards. */
  const [burstKey, setBurstKey] = useState(0);
  const wasAtBottom = useRef(false);
  const [activeHeaderMenu, setActiveHeaderMenu] = useState<HeaderMegaMenu | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  /* The drawer has to outlive the click that closes it, or it would vanish instead of
     sliding out. `signInClosing` keeps it mounted for the length of the exit animation. */
  const [signInClosing, setSignInClosing] = useState(false);
  const signInCloseTimer = useRef<number | undefined>(undefined);
  const [taglineIndex, setTaglineIndex] = useState(0);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);
  const [authSheetStep, setAuthSheetStep] = useState<
    "signin" | "role" | "signup" | "confirmation" | "forgot" | "forgot-sent"
  >("signin");
  const [signupRole, setSignupRole] = useState<"player" | "tenant" | null>(null);
  /* Nudges the tap-to-switch role banner the first moment it's on screen, since it otherwise
     reads as a static badge rather than a button. See the effect below for its lifecycle. */
  const [showRoleGuide, setShowRoleGuide] = useState(false);
  const [signupName, setSignupName] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  /* Consent to the Terms and the Privacy Policy, which is a sign-up-only gate: creating the
     account is the moment the agreement is entered into, so that is where the tick is
     required.  Signing in afterwards does not ask again — an existing account has already
     agreed, and the sign-in step only offers the two documents to read.  The record of what
     was agreed to lives on the account itself (see terms_version in submitAuth). */
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [legalOpen, setLegalOpen] = useState<"terms" | "privacy" | null>(null);
  const [legalTouched, setLegalTouched] = useState(false);
  const [player, setPlayer] = useState<{ id: string; name: string; email: string } | null>(null);
  const [bookingPromptOpen, setBookingPromptOpen] = useState(false);
  /* Same keep-alive trick the sign-in drawer uses: the dialog has to outlive the click that
     dismisses it, or there is nothing left on screen to animate out. */
  const [bookingPromptClosing, setBookingPromptClosing] = useState(false);
  const bookingPromptTimer = useRef<number | undefined>(undefined);
  /* The venue a signed-out visitor was trying to book when the prompt interrupted them, so
     signing in can drop them on that venue instead of the generic explore page. A ref, not
     state: the post-sign-in redirect lives in an effect whose closure would capture a stale
     value, and this never needs to trigger a render. */
  const pendingVenueRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const hydrateAccount = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (mounted) setPlayer(null);
        return;
      }
      const pendingRole = sessionStorage.getItem(GOOGLE_PENDING_ROLE_KEY);
      // Only ever applied to a Google-authenticated user — otherwise a Google redirect that
      // was started and then abandoned (back button, closed tab) leaves this key sitting in
      // sessionStorage, and it would wrongly get applied to the next unrelated sign-in or
      // email/password signup that happens to land in this same tab afterward.
      if ((pendingRole === "player" || pendingRole === "tenant") && hasGoogleProvider(user)) {
        // Deliberate "Continue with Google" from the role step — apply the role picked
        // before the redirect now that there is a user to attach it to.
        sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
        await supabase.from("profiles").update({ role: pendingRole }).eq("id", user.id);
        await supabase.auth.updateUser({ data: { role: pendingRole } });
      } else if (isFreshGoogleAccount(user)) {
        await supabase.auth.signOut();
        if (mounted) {
          setPlayer(null);
          setAuthSheetStep("signin");
          setSignInError(
            "We couldn't find a CourtHub account for that Google account. Please create one first.",
          );
          setSignInOpen(true);
        }
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, full_name")
        .eq("id", user.id)
        .maybeSingle();
      const metadata = user.user_metadata as { role?: unknown; full_name?: unknown };
      const role = profile?.role === "tenant" || metadata.role === "tenant" ? "tenant" : "player";
      if (role === "tenant") {
        navigate({ to: "/dashboard", replace: true });
        return;
      }
      if (mounted) {
        setPlayer({
          id: user.id,
          email: user.email ?? "",
          name:
            profile?.full_name ||
            (typeof metadata.full_name === "string" ? metadata.full_name : "") ||
            user.email?.split("@")[0] ||
            "Player",
        });
        /* If they were mid-booking on a featured venue when the sign-in prompt caught them,
           resume there so the click that started this is not thrown away. Otherwise the
           landing page belongs to signed-out visitors and a signed-in player's start page
           is Explore, so bounce them there however they arrived. */
        const intendedVenue = pendingVenueRef.current;
        pendingVenueRef.current = null;
        navigate(
          intendedVenue
            ? {
                to: "/venues/$venueId",
                params: { venueId: intendedVenue },
                search: {},
                replace: true,
              }
            : { to: "/explore", search: {}, replace: true },
        );
      }
    };
    void hydrateAccount();
    const { data: subscription } = supabase.auth.onAuthStateChange(() => {
      void hydrateAccount();
      /* VenueExplorer caches the session under this key with a 10-minute staleTime. A visitor
         who browsed /explore/guest first has a cached `null` player; signing in does not
         touch React Query, so /explore would read that stale null and skip the player shell
         until a hard reload. Dropping the entry here means the next mount refetches. */
      void queryClient.invalidateQueries({ queryKey: ["auth-player-session"] });
    });
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [navigate]);

  const featuredQ = useQuery({
    queryKey: ["landing-featured-venues"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        /* operating_hours + rate_rules + inherit_venue_hours are what let this card show the
           tenant's real schedule and a price that agrees with /explore. Without the rules the
           card printed the raw hourly_rate, which drifts from the explore tile whenever a
           venue prices by time of day. */
        .select(
          "id, name, address, images, map_emoji, operating_hours, courts(id, name, hourly_rate, rate_rules, operating_hours, inherit_venue_hours, sports(name))",
        )
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    const timer = window.setInterval(
      () => setHeroIndex((index) => (index + 1) % heroImages.length),
      6000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const scroller = document.querySelector("main") as HTMLElement | null;
    let settleTimer: number | undefined;
    const update = () => {
      const scrollTop = scroller?.scrollTop ?? window.scrollY;
      setHeaderSolid(scrollTop > 24);
      setShowBackToTop(scrollTop > 360);
      const maxScroll = scroller
        ? scroller.scrollHeight - scroller.clientHeight
        : document.documentElement.scrollHeight - window.innerHeight;
      setScrollProgress(maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0);
      setHeaderHidden(false);
      if (settleTimer) window.clearTimeout(settleTimer);
      if (scrollTop > 24 && !headerHovering && !activeHeaderMenu) {
        settleTimer = window.setTimeout(() => setHeaderHidden(true), 1100);
      }
    };
    update();
    scroller?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      scroller?.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, [activeHeaderMenu, headerHovering]);

  useEffect(() => {
    const sections = landingNav
      .map((name) => document.getElementById(name.toLowerCase().replaceAll(" ", "-")))
      .filter(Boolean) as HTMLElement[];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible)
          setActiveSection(
            (visible.target as HTMLElement).dataset.nav as (typeof landingNav)[number],
          );
      },
      { rootMargin: "-35% 0px -55% 0px", threshold: [0.01, 0.2, 0.5] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  /* Scatter vector for one shard of a 4x4 break-up. Derived from the cell's row/column so
     the pieces fly outward from the middle rather than in random directions, and so the
     pattern is identical every time — a Math.random() here would make the animation
     un-reviewable and re-scatter differently on every React re-render. */
  const shardStyle = (i: number, delayBase: number): CSSProperties => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const rot = (i % 2 === 0 ? 1 : -1) * (10 + ((i * 13) % 16));
    return {
      "--dx": `${(col - 1.5) * 46}px`,
      "--dy": `${(row - 1.5) * 46}px`,
      "--rot": `${rot}deg`,
      animationDelay: `${delayBase + col * 18 + row * 26}ms`,
    } as CSSProperties;
  };

  useEffect(() => {
    const el = featuresRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setFeaturesLit(entry.isIntersecting),
      { threshold: 0.12 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = whyRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setWhyLit(entry.isIntersecting), {
      threshold: 0.15,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = venuesRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVenuesLit(entry.isIntersecting),
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = howItWorksRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setStepsLit(entry.isIntersecting),
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollTo = (name: (typeof landingNav)[number]) => {
    document
      .getElementById(name.toLowerCase().replaceAll(" ", "-"))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setMenuOpen(false);
  };

  const pauseStrip = () => {
    if (stripResumeTimer.current) window.clearTimeout(stripResumeTimer.current);
    setStripPaused(true);
  };

  /* delay is for touch: the finger has lifted but the flick is probably still scrolling, and
     restarting the marquee mid-glide fights the user. Hover resumes immediately (delay 0). */
  const resumeStrip = (delay = 0) => {
    if (stripResumeTimer.current) window.clearTimeout(stripResumeTimer.current);
    if (delay <= 0) {
      setStripPaused(false);
      return;
    }
    stripResumeTimer.current = window.setTimeout(() => setStripPaused(false), delay);
  };

  useEffect(
    () => () => {
      if (stripResumeTimer.current) window.clearTimeout(stripResumeTimer.current);
    },
    [],
  );

  const noteSocialSoon = (network: string) => {
    if (socialSoonTimer.current) window.clearTimeout(socialSoonTimer.current);
    setSocialSoon(network);
    socialSoonTimer.current = window.setTimeout(() => setSocialSoon(null), 2400);
  };

  useEffect(
    () => () => {
      if (socialSoonTimer.current) window.clearTimeout(socialSoonTimer.current);
    },
    [],
  );

  const openExplorer = () => {
    setMenuOpen(false);
    navigate({ to: player ? "/explore" : "/explore/guest", search: {} });
  };

  const startBooking = () => {
    if (player) {
      openExplorer();
      return;
    }
    setBookingPromptOpen(true);
  };

  const startVenueBooking = (venueId: string) => {
    if (player) {
      navigate({ to: "/venues/$venueId", params: { venueId }, search: {} });
      return;
    }
    pendingVenueRef.current = venueId;
    setBookingPromptOpen(true);
  };

  /* keepIntent is set by the two buttons that lead into signing in — those are continuing
     the booking, so the remembered venue must survive. Every other exit (backdrop, X, Escape)
     is the visitor abandoning it, and leaving the ref set would teleport them to that venue
     the next time they signed in for some unrelated reason. */
  const closeBookingPrompt = (keepIntent = false) => {
    if (!keepIntent) pendingVenueRef.current = null;
    if (bookingPromptTimer.current) window.clearTimeout(bookingPromptTimer.current);
    setBookingPromptClosing(true);
    bookingPromptTimer.current = window.setTimeout(() => {
      setBookingPromptOpen(false);
      setBookingPromptClosing(false);
    }, 200); // matches modal-pop-out
  };

  useEffect(() => {
    if (!bookingPromptOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeBookingPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bookingPromptOpen]);

  useEffect(
    () => () => {
      if (bookingPromptTimer.current) window.clearTimeout(bookingPromptTimer.current);
    },
    [],
  );

  const openSignIn = () => {
    // Re-opening mid-close cancels the pending unmount, so the panel slides back in
    // from wherever it is rather than snapping shut a beat later.
    if (signInCloseTimer.current) window.clearTimeout(signInCloseTimer.current);
    setSignInClosing(false);
    setMenuOpen(false);
    setSignInError(null);
    setAuthSheetStep("signin");
    setSignInOpen(true);
  };

  const closeSignIn = () => {
    if (signInBusy || signInClosing) return;
    // The Escape listener captures this function and its effect does not re-run on
    // `signInClosing`, so a second Escape mid-close can reach here with a stale guard.
    // Clearing first means the worst case is a restarted timer, never a leaked one.
    if (signInCloseTimer.current) window.clearTimeout(signInCloseTimer.current);
    setSignInClosing(true);
    signInCloseTimer.current = window.setTimeout(() => {
      setSignInOpen(false);
      setSignInClosing(false);
    }, 320); // matches landing-drawer-out below
  };

  useEffect(
    () => () => {
      if (signInCloseTimer.current) window.clearTimeout(signInCloseTimer.current);
    },
    [],
  );

  // /dashboard and the legacy header send unauthenticated visitors here with
  // ?signin=true instead of to a separate sign-in page.  The flag is consumed
  // once so a refresh does not reopen the sheet.
  /* ?signin=true opens the sheet on the sign-in step; ?signup=true opens it on the role
     picker. Both are consumed once and cleared so a refresh does not reopen the sheet. */
  useEffect(() => {
    if (!signup) return;
    setMenuOpen(false);
    setSignInError(null);
    setAuthSheetStep("role");
    setSignInOpen(true);
    navigate({ search: (prev) => ({ ...prev, signup: undefined }), replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signup]);

  useEffect(() => {
    if (!signin) return;
    openSignIn();
    navigate({ search: (prev) => ({ ...prev, signin: undefined }), replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signin]);

  /* Every trip through the signup flow starts from an unticked box, so consent is always
     given for the account being created rather than inherited from an earlier one. */
  useEffect(() => {
    if (authSheetStep === "role" || authSheetStep === "signup") {
      setLegalAccepted(false);
      setLegalTouched(false);
    }
  }, [authSheetStep]);

  /* Shows the role-switch guide bubble for a few seconds each time the signup step is
     entered, then lets it time out on its own; tapping the banner it points at (see below)
     dismisses it immediately instead of waiting out the clock. */
  useEffect(() => {
    if (authSheetStep !== "signup") {
      setShowRoleGuide(false);
      return;
    }
    setShowRoleGuide(true);
    const timer = window.setTimeout(() => setShowRoleGuide(false), 4000);
    return () => window.clearTimeout(timer);
  }, [authSheetStep]);

  /* Rendered in both steps of the auth sheet: beside the consent box at signup, and on their
     own at sign-in where there is nothing to agree to. */
  const legalReadLinks = (
    [
      ["terms", "Read the Terms & Conditions"],
      ["privacy", "Read the Privacy Policy"],
    ] as const
  ).map(([doc, label]) => (
    <button
      key={doc}
      type="button"
      onClick={() => setLegalOpen(doc)}
      className="text-xs font-bold text-[#12806d] underline underline-offset-2 transition hover:text-[#0b3d35]"
    >
      {label}
    </button>
  ));

  /* `role` is the account type picked on the role step for a sign-up, or null when this is
     called from the sign-in step. Google is a redirect — the app unmounts and comes back as
     a fresh session — so the role can't travel as a function argument the way it does through
     submitAuth; it goes into sessionStorage instead and the hydration effect above reads it
     back once the redirect returns. */
  const handleGoogleAuth = async (role: "player" | "tenant" | null) => {
    setSignInError(null);
    if (role) {
      sessionStorage.setItem(GOOGLE_PENDING_ROLE_KEY, role);
    } else {
      sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
      setSignInError(error.message);
    }
  };

  const sendPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSignInError(null);
    setSignInBusy(true);
    // /reset-password reads the recovery session Supabase's own redirect establishes — see
    // that route for the other half of this flow.
    const { error } = await supabase.auth.resetPasswordForEmail(signInEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSignInBusy(false);
    if (error) {
      setSignInError(error.message);
      return;
    }
    setAuthSheetStep("forgot-sent");
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Checked here as well as through the input's `required`, because the box is the whole
    // consent record and a signup must never get past it however it was triggered. Signing
    // in is not gated: that account agreed when it was created.
    if (authSheetStep === "signup" && !legalAccepted) {
      setLegalTouched(true);
      setSignInError(
        "Please read and agree to the Terms & Conditions and the Privacy Policy to continue.",
      );
      return;
    }
    setSignInBusy(true);
    setSignInError(null);
    try {
      if (authSheetStep === "signup") {
        if (!signupRole) throw new Error("Please choose an account type.");
        if (signInPassword.length < 8)
          throw new Error("Use a password with at least 8 characters.");
        const { data, error } = await supabase.auth.signUp({
          email: signInEmail,
          password: signInPassword,
          options: {
            emailRedirectTo: window.location.origin,
            data: {
              full_name: signupName,
              phone: signupPhone,
              role: signupRole,
              /* The authoritative consent record: which version of the documents this
                 account agreed to, and when. The localStorage copy is only a convenience. */
              terms_version: LEGAL_VERSION,
              terms_accepted_at: new Date().toISOString(),
            },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthSheetStep("confirmation");
          return;
        }
        setSignInOpen(false);
        if (signupRole === "tenant") {
          navigate({ to: "/dashboard", replace: true });
        } else if (data.user) {
          setPlayer({
            id: data.user.id,
            email: data.user.email ?? signInEmail,
            name: signupName || data.user.email?.split("@")[0] || "Player",
          });
        }
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error) throw error;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user)
        throw new Error("Sign-in succeeded, but no active session was found. Please try again.");
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, full_name")
        .eq("id", user.id)
        .maybeSingle();
      const metadata = user.user_metadata as { role?: unknown; full_name?: unknown };
      const isTenant = profile?.role === "tenant" || metadata.role === "tenant";
      setSignInOpen(false);
      if (isTenant) {
        navigate({ to: "/dashboard", replace: true });
      } else {
        setPlayer({
          id: user.id,
          email: user.email ?? signInEmail,
          name:
            profile?.full_name ||
            (typeof metadata.full_name === "string" ? metadata.full_name : "") ||
            user.email?.split("@")[0] ||
            "Player",
        });
      }
    } catch (error) {
      setSignInError(
        error instanceof Error ? error.message : "Unable to sign in. Please try again.",
      );
    } finally {
      setSignInBusy(false);
    }
  };

  useEffect(() => {
    if (!signInOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSignIn();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [signInOpen, signInBusy]);

  useEffect(() => {
    const atBottom = scrollProgress > 0.995;
    if (atBottom && !wasAtBottom.current) setBurstKey((key) => key + 1);
    wasAtBottom.current = atBottom;
  }, [scrollProgress]);

  const scrollToTop = () => {
    const scroller = document.querySelector("main") as HTMLElement | null;
    if (scroller) scroller.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const featureCards = [
    [
      CalendarCheck2,
      "Real-time availability",
      "See open courts instantly and reserve the time that fits your day.",
    ],
    [
      Sparkles,
      "Easy booking",
      "A clear, guided booking flow from venue discovery to confirmation.",
    ],
    [ShieldCheck, "Secure payments", "Protected online checkout with reliable booking records."],
    [
      MapIcon,
      "Venue discovery",
      "Find courts around the Philippines or search close to a pinned location.",
    ],
    [
      BellRing,
      "Live booking status",
      "Keep track of your reservations and payment progress in one place.",
    ],
    [
      ReceiptText,
      "Digital confirmation",
      "Get a booking reference as soon as your reservation is confirmed.",
    ],
    [UsersRound, "Court groups", "Smart shared-facility handling for courts that play together."],
    [
      Trophy,
      "Community ready",
      "A better home for open play, local events, and growing sports communities.",
    ],
    [
      Accessibility,
      "Made for every device",
      "Discover and book on desktop, tablet, or right from your phone.",
    ],
  ];
  /* Four sample categories, three frames each — the same taxonomy the Browse highlights menu
     lists, so the strip and that menu describe one thing. Clicking any frame opens its whole
     category rather than the single image, which is what makes the grouping mean something.
     Ten of the twelve ids were already in use in this file; the two new ones were fetched
     and confirmed 200 before being added, since a bad id renders as a dead tile with no
     error anywhere. */
  const highlightCategories = [
    {
      key: "tournament",
      label: "Tournament",
      copy: "Competition highlights and match days",
      images: [
        "https://images.unsplash.com/photo-1518604666860-9ed391f76460?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1592656094267-764a45160876?auto=format&fit=crop&w=1200&q=80",
      ],
    },
    {
      key: "player-action",
      label: "Player action",
      copy: "On-court moments from the community",
      images: [
        "https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1566577739112-5180d4bf9390?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80",
      ],
    },
    {
      key: "community-events",
      label: "Community events",
      copy: "Open play, leagues, and local gatherings",
      images: [
        "https://images.unsplash.com/photo-1504450758481-7338eba7524a?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1521412644187-c49fa049e84d?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1518065896235-a4c93e088e7a?auto=format&fit=crop&w=1200&q=80",
      ],
    },
    {
      key: "happy-customers",
      label: "Happy customers",
      copy: "Player stories and winning smiles",
      images: [
        "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1200&q=80",
        "https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=80",
      ],
    },
  ];

  /* Flattened for the strip: each frame keeps a pointer back to the category it opens. */
  const highlightFrames = highlightCategories.flatMap((category) =>
    category.images.map((src) => ({ src, category })),
  );

  return (
    <div className="bg-[#f6f8f7] text-[#102521]">
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="Back to top"
        className={`fixed bottom-5 right-5 z-1100 flex h-12 w-12 items-center justify-center rounded-full bg-[#0b3d35] text-[#b8f05a] shadow-lg shadow-[#09231f]/25 transition-all duration-300 hover:-translate-y-1 hover:bg-[#126152] focus:outline-none focus:ring-2 focus:ring-[#b8f05a] focus:ring-offset-2 motion-reduce:transition-none sm:bottom-7 sm:right-7 ${showBackToTop ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-5 scale-90 opacity-0"}`}
      >
        {/* Progress ring. The static border this replaces is now the faint track circle, so
            the edge still reads as an outline at 0%. Rotated -90deg so the arc starts at
            twelve o'clock, and stroke-dashoffset is the only thing that changes as you
            scroll — cheap enough to update on every scroll event. */}
        <svg
          viewBox="0 0 48 48"
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
        >
          <circle cx="24" cy="24" r="22" fill="none" stroke="rgb(184 240 90 / 0.2)" strokeWidth="2.5" />
          <circle
            cx="24"
            cy="24"
            r="22"
            fill="none"
            stroke="#b8f05a"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={138.23}
            strokeDashoffset={138.23 * (1 - scrollProgress)}
            className="transition-[stroke-dashoffset] duration-150 ease-out motion-reduce:transition-none"
          />
        </svg>
        {/* The fuse. Rotating a full-size wrapper puts the spark on the arc's leading edge
            without any trigonometry — the dot sits at the ring's twelve o'clock and the
            wrapper carries it round by however far you have scrolled. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{ transform: `rotate(${scrollProgress * 360}deg)` }}
        >
          <span className="absolute left-1/2 top-[2px] h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#d3ff87] shadow-[0_0_8px_1.5px_rgba(184,240,90,0.85)]" />
          {/* Emitter pinned to the spark, spun back by the same angle the wrapper spun forward.
              Without that counter-rotation the embers would fall along the ring's local axis —
              sideways or upward depending on where you are in the scroll — instead of down. */}
          <span
            className="absolute left-1/2 top-[2px] transition-transform duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: `rotate(${-scrollProgress * 360}deg)` }}
          >
            {FUSE_EMBERS.map((ember, i) => (
              <span
                key={i}
                style={
                  {
                    "--ex": `${ember.ex}px`,
                    animationDelay: `${ember.delay}s`,
                  } as CSSProperties
                }
                className="absolute h-[3px] w-[3px] rounded-full bg-[#b8f05a] opacity-0 shadow-[0_0_5px_1px_rgba(184,240,90,0.7)] motion-safe:animate-[fuse-ember_1.2s_linear_infinite]"
              />
            ))}
          </span>
        </span>

        {burstKey > 0 && (
          <span key={burstKey} aria-hidden className="pointer-events-none absolute inset-0">
            {SHOWER_DOTS.map((dot, i) => (
              <span
                key={i}
                style={{ width: dot.size, height: dot.size }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                <span
                  style={
                    {
                      "--dx": `${dot.dx.toFixed(1)}px`,
                      "--dy": `${dot.dy.toFixed(1)}px`,
                      animationDelay: `${dot.delay}ms`,
                    } as CSSProperties
                  }
                  className="absolute inset-0 rounded-full bg-[#d3ff87] opacity-0 shadow-[0_0_6px_1px_rgba(184,240,90,0.8)] motion-safe:animate-[fuse-shower_.75s_ease-out_forwards]"
                />
              </span>
            ))}
          </span>
        )}

        <ChevronUp className="relative h-6 w-6" strokeWidth={2.5} />
      </button>
      <header
        onMouseEnter={() => {
          setHeaderHovering(true);
          setHeaderHidden(false);
        }}
        onMouseLeave={() => {
          setHeaderHovering(false);
          setActiveHeaderMenu(null);
        }}
        /* Slides clear of the top edge when scrolling settles and drops back on the next
           scroll. Transform only: the keyframes this used to run wiped it away with
           clip-path while the class translated it, so two mechanisms fought over the same
           property and the result read as a fade in place rather than a slide. Opacity is
           left alone for the same reason — translating fully past the top edge already
           hides it, and fading on the way would blunt the movement. */
        className={`fixed inset-x-0 top-0 z-1200 px-3 pt-3 transition-transform ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none sm:px-6 ${headerHidden ? "pointer-events-none -translate-y-[calc(100%+1rem)] duration-700" : "translate-y-0 duration-500"}`}
      >
        <div
          className={`mx-auto max-w-7xl overflow-hidden rounded-2xl text-white transition duration-300 ${headerSolid || activeHeaderMenu ? "border border-[#b8f05a] bg-[#09231f]/90 shadow-[0_0_28px_-4px_rgba(184,240,90,0.45)] backdrop-blur-xl" : "border border-transparent bg-transparent"}`}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <button
              onClick={() => scrollTo("Home")}
              className="flex items-center"
              aria-label="CourtHub home"
            >
              {/* The wordmark carries the name, so the button holds no text and the
                  image stays decorative — the aria-label is what gets announced. */}
              <span className="logo-glaze">
                <img
                  src="/courthub-wordmark.png"
                  alt=""
                  width={983}
                  height={240}
                  className="h-8 w-auto object-contain sm:h-9"
                />
              </span>
            </button>
            <nav className="hidden items-center gap-1 lg:flex" aria-label="Landing navigation">
              {landingNav.map((name) => {
                const hasMegaMenu =
                  name === "Venues" || name === "Upcoming Events" || name === "Highlights";
                return (
                  <button
                    key={name}
                    onPointerEnter={() =>
                      setActiveHeaderMenu(hasMegaMenu ? (name as HeaderMegaMenu) : null)
                    }
                    onFocus={() =>
                      setActiveHeaderMenu(hasMegaMenu ? (name as HeaderMegaMenu) : null)
                    }
                    onClick={() => {
                      // The hover panel is a preview, not a replacement for the link. Every
                      // entry scrolls to its own section, mega menu or not; the panel is
                      // closed first so it is not left hanging over the section it just
                      // scrolled to. Hover/focus still open it, which is how it is reached.
                      setActiveHeaderMenu(null);
                      scrollTo(name);
                    }}
                    aria-expanded={hasMegaMenu ? activeHeaderMenu === name : undefined}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${activeSection === name ? "bg-[#b8f05a] text-[#102521]" : "text-white/75 hover:bg-white/10 hover:text-white"}`}
                  >
                    {name}
                  </button>
                );
              })}
            </nav>
            <div className="flex items-center gap-2">
              {player ? (
                <button
                  type="button"
                  onClick={() => navigate({ to: "/dashboard" })}
                  className="hidden rounded-full bg-white/10 p-2 text-white/85 transition hover:bg-white/20 hover:text-white sm:inline-flex"
                  title={player.name}
                  aria-label="Open player workspace"
                >
                  <User className="h-5 w-5" />
                </button>
              ) : (
                /* Outlined rather than filled: "Book now" beside it is the lime primary, and
                   two solid buttons in a row would leave no visual hierarchy between them. */
                <button
                  type="button"
                  onClick={openSignIn}
                  className="hidden items-center rounded-full border border-white/30 px-4 py-2 text-sm font-semibold text-white/90 transition hover:border-[#b8f05a] hover:bg-white/10 hover:text-white sm:inline-flex"
                >
                  Sign in
                </button>
              )}
              <button
                type="button"
                onClick={startBooking}
                className="inline-flex items-center gap-1 rounded-full bg-[#b8f05a] px-3.5 py-2 text-sm font-bold text-[#102521] transition hover:bg-[#d3ff87]"
              >
                Book now <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={() => setMenuOpen((open) => !open)}
                className="rounded-full p-2 hover:bg-white/10 lg:hidden"
                aria-label="Toggle navigation"
                aria-expanded={menuOpen}
              >
                {menuOpen ? <CloseIcon className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>
          {activeHeaderMenu && (
            <div className="hidden border-t border-white/15 px-4 pb-4 pt-3 lg:block">
              <div className="px-2 pb-1 pt-2">
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-[.22em] text-[#b8f05a]">
                      {headerMegaMenuItems[activeHeaderMenu].eyebrow}
                    </p>
                    <h2 className="mt-2 font-display text-2xl font-bold">
                      {headerMegaMenuItems[activeHeaderMenu].title}
                    </h2>
                    <p className="mt-2 max-w-lg text-sm leading-relaxed text-white/65">
                      {headerMegaMenuItems[activeHeaderMenu].copy}
                    </p>
                  </div>
                  {activeHeaderMenu === "Upcoming Events" && (
                    <span className="shrink-0 rounded-full border border-[#b8f05a]/35 bg-[#b8f05a]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#d9ff9b]">
                      Soon
                    </span>
                  )}
                </div>
                {activeHeaderMenu === "Venues" ? (
                  /* Live venue cards, mirroring the explore tile — photo, name, address,
                     sports, starting rate. No Book / View buttons: the whole card is the
                     link, and a menu is for choosing where to go, not for acting. */
                  <div className="relative mt-5">
                    {/* Three tiles visible; the rest scroll. Tile width is a third of the rail
                        minus the two gaps, so exactly three sit in view at any width and the
                        fourth peeks at the edge to signal there is more. */}
                    <div
                      ref={venueRailRef}
                      className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                    {((featuredQ.data ?? []) as unknown as FeaturedVenue[]).slice(0, 24).map((venue) => {
                        const courts = venue.courts ?? [];
                        const ranges = courts.map((court) => {
                          const hrs = effectiveHours(
                            {
                              inherit_venue_hours: court.inherit_venue_hours,
                              operating_hours: court.operating_hours,
                            },
                            venue.operating_hours,
                          );
                          const rules = normalizeRules(court.rate_rules);
                          const base = Number(court.hourly_rate);
                          return { lo: minRate(base, rules, hrs), hi: maxRate(base, rules, hrs) };
                        });
                        const lo = ranges.length ? Math.min(...ranges.map((r) => r.lo)) : null;
                        const hi = ranges.length ? Math.max(...ranges.map((r) => r.hi)) : null;
                        const sports = Array.from(
                          new Set(courts.map((c) => c.sports?.name).filter(Boolean)),
                        ) as string[];
                        const week = normalizeHours(venue.operating_hours);
                        const todayWindow = describeWindow(
                          week[HOUR_DAY_KEYS[zonedDayOfWeek(zonedDateISO())]],
                        );
                        const closed = todayWindow === "Closed";
                        const image = venue.images?.[0];
                        return (
                          /* Same split tile as the explore list: photo on the left half, brand
                             dark-teal panel with lime accents on the right. The two action
                             buttons are the only thing dropped — here the whole tile is the
                             link, since a menu is for choosing where to go. */
                          <Link
                            key={venue.id}
                            /* Straight to the venue's own page. The tile already shows this
                               venue by name, photo and rate, so dropping into the explorer
                               made you find it again; the detail page is what someone
                               clicking a named venue is actually asking for. It is a public
                               route, so this works signed out as well — the "browse them
                               all" links below still route through guest mode. */
                            to="/venues/$venueId"
                            params={{ venueId: String(venue.id) }}
                            search={{}}
                            onClick={() => setActiveHeaderMenu(null)}
                            className="group flex h-36 w-[calc((100%-1.5rem)/3)] shrink-0 snap-start flex-row overflow-hidden rounded-2xl text-left ring-1 ring-white/15 transition-all duration-200 hover:shadow-md hover:ring-2 hover:ring-[#b8f05a]"
                          >
                            <div className="relative h-full w-1/2 shrink-0 overflow-hidden bg-[#0b3d35]">
                              {image ? (
                                <img
                                  src={image}
                                  alt=""
                                  loading="lazy"
                                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-[#b8f05a]/10 to-[#0b3d35] text-3xl">
                                  {venue.map_emoji || "🏟️"}
                                </div>
                              )}
                              <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent" />
                              {/* Hours top-left, court count bottom-right — same placement the
                                  explore tile uses, so the two read identically. */}
                              <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-white/95 py-1 pl-1.5 pr-2 shadow-sm">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${closed ? "bg-neutral-400" : "bg-emerald-500"}`}
                                />
                                <span className="whitespace-nowrap text-[9px] font-bold text-[#102521]">
                                  {closed ? "Closed today" : todayWindow}
                                </span>
                              </div>
                              <div className="absolute bottom-2 right-2">
                                {courts.length > 0 ? (
                                  <div className="flex items-center gap-1.5 rounded-full bg-white/95 py-0.5 pl-0.5 pr-2 shadow-md">
                                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#12806d] text-[10px] font-extrabold text-white">
                                      {courts.length}
                                    </span>
                                    <span className="text-[9px] font-bold text-[#102521]">
                                      {courts.length === 1 ? "court" : "courts"}
                                    </span>
                                  </div>
                                ) : (
                                  <div className="rounded-full bg-black/60 px-2 py-0.5 text-[9px] font-semibold text-white/80 backdrop-blur-sm">
                                    No courts yet
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-1 flex-col gap-1.5 overflow-hidden bg-linear-to-br from-[#0f4a40] to-[#09231f] p-2.5">
                              <div className="truncate rounded-lg bg-[#b8f05a]/15 px-2 py-1 font-display text-[12px] font-bold leading-tight text-[#b8f05a] ring-1 ring-[#b8f05a]/25 transition-colors group-hover:text-[#d3ff87]">
                                {venue.name}
                              </div>
                              <div className="flex items-start gap-1.5 text-[10px] text-white/65">
                                <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-[#b8f05a]" />
                                <span className="line-clamp-1">{venue.address}</span>
                              </div>
                              <div className="flex h-[20px] items-center gap-1 overflow-hidden">
                                {sports.slice(0, 2).map((sport) => (
                                  <span
                                    key={sport}
                                    className="shrink-0 whitespace-nowrap rounded-full bg-[#b8f05a]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#b8f05a] ring-1 ring-[#b8f05a]/25"
                                  >
                                    {sport}
                                  </span>
                                ))}
                                {sports.length > 2 && (
                                  <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-white/70">
                                    +{sports.length - 2}
                                  </span>
                                )}
                              </div>
                              <div className="mt-auto flex min-h-[24px] items-center justify-between gap-1.5 border-t border-white/10 pt-1.5">
                                <span className="truncate text-[10px] font-medium text-white/60">
                                  Available now
                                </span>
                                {lo != null ? (
                                  <span className="shrink-0 whitespace-nowrap rounded-md bg-[#b8f05a]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#b8f05a] ring-1 ring-[#b8f05a]/25">
                                    {hi != null && hi > lo
                                      ? `₱${lo.toFixed(0)}–${hi.toFixed(0)}/hr`
                                      : `₱${lo.toFixed(0)}/hr`}
                                  </span>
                                ) : (
                                  <span className="shrink-0 text-[9px] text-white/40">
                                    No courts
                                  </span>
                                )}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    {/* End card, only when a 25th row came back — i.e. there are genuinely more
                        venues than this rail can show. Signed out it offers the account that
                        unlocks the full list; signed in it just goes to the explorer. */}
                    {(featuredQ.data?.length ?? 0) > 24 && (
                      <Link
                        to={player ? "/explore" : "/landing"}
                        search={player ? {} : { signin: true }}
                        onClick={() => setActiveHeaderMenu(null)}
                        className="group flex h-36 w-[calc((100%-1.5rem)/3)] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#b8f05a]/40 bg-[#b8f05a]/5 p-4 text-center transition hover:border-[#b8f05a] hover:bg-[#b8f05a]/12"
                      >
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#b8f05a] text-[#102521] transition group-hover:scale-110">
                          <ChevronRight className="h-5 w-5" />
                        </span>
                        <span className="font-cabinet text-sm font-bold text-white">
                          {player ? "Browse every venue" : "Sign in to see them all"}
                        </span>
                        <span className="text-[10px] leading-snug text-white/55">
                          {player
                            ? "Open the full map and filters."
                            : "This menu shows the 24 newest. Sign in to search the full map."}
                        </span>
                      </Link>
                    )}

                    {(featuredQ.data?.length ?? 0) === 0 && (
                      <p className="w-full rounded-2xl border border-dashed border-white/15 py-8 text-center text-xs text-white/50">
                        {featuredQ.isLoading
                          ? "Loading venues…"
                          : "Venues will appear here as they join CourtHub."}
                      </p>
                    )}
                    </div>

                    {/* Arrows only once there is a fourth venue to reach. Each press moves one
                        tile plus its gap, computed from the rail so it stays correct at any
                        width instead of a hardcoded pixel step. */}
                    {(featuredQ.data?.length ?? 0) > 3 &&
                      [
                        { dir: -1, Icon: ChevronLeft, side: "-left-3", label: "Previous venues" },
                        { dir: 1, Icon: ChevronRight, side: "-right-3", label: "More venues" },
                      ].map(({ dir, Icon, side, label }) => (
                        <button
                          key={label}
                          type="button"
                          aria-label={label}
                          onClick={() => {
                            const rail = venueRailRef.current;
                            if (!rail) return;
                            rail.scrollBy({ left: dir * (rail.clientWidth / 3 + 12), behavior: "smooth" });
                          }}
                          className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-[#b8f05a]/40 bg-[#09231f] p-2 text-[#b8f05a] shadow-lg transition hover:bg-[#b8f05a] hover:text-[#102521] ${side}`}
                        >
                          <Icon className="h-4 w-4" />
                        </button>
                      ))}
                  </div>
                ) : activeHeaderMenu === "Highlights" ? (
                  /* Same shape as the Venues pane: real content instead of a teaser. The tabs
                     pick a category, the tiles are that category's photos, and clicking one
                     hands off to the full-screen viewer — which is where prev/next, the
                     thumbnails, and the social "view more" links already live. */
                  <div className="mt-5">
                    <div className="flex flex-wrap items-center gap-2">
                      {highlightCategories.map((category) => (
                        <button
                          key={category.key}
                          type="button"
                          onClick={() => setHeaderHighlightKey(category.key)}
                          aria-pressed={headerHighlightKey === category.key}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                            headerHighlightKey === category.key
                              ? "border-[#b8f05a] bg-[#b8f05a] text-[#102521]"
                              : "border-white/20 bg-white/5 text-white/80 hover:border-[#b8f05a] hover:text-[#b8f05a]"
                          }`}
                        >
                          {category.label}
                          <span
                            className={`rounded-full px-1.5 text-[9px] font-extrabold ${
                              headerHighlightKey === category.key
                                ? "bg-[#102521]/15 text-[#102521]"
                                : "bg-white/10 text-white/60"
                            }`}
                          >
                            {category.images.length}
                          </span>
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const category =
                        highlightCategories.find((c) => c.key === headerHighlightKey) ??
                        highlightCategories[0];
                      return (
                        <>
                          <div className="mt-4 grid grid-cols-3 gap-3">
                            {category.images.map((src, i) => (
                              /* Same tile treatment as the venue rail — rounded, ringed, lime
                                 on hover — but full-bleed photo, since the photo is the
                                 content here. */
                              <button
                                key={src}
                                type="button"
                                onClick={() => {
                                  setActiveHeaderMenu(null);
                                  setHighlightOpen({ key: category.key, idx: i });
                                }}
                                aria-label={`View ${category.label.toLowerCase()} photo ${i + 1} full screen`}
                                className="group relative h-36 overflow-hidden rounded-2xl text-left ring-1 ring-white/15 transition-all duration-200 hover:shadow-md hover:ring-2 hover:ring-[#b8f05a]"
                              >
                                <img
                                  src={src}
                                  alt={`${category.label} highlight ${i + 1}`}
                                  loading="lazy"
                                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                />
                                <span className="pointer-events-none absolute inset-0 bg-linear-to-t from-[#061a17]/80 via-transparent to-transparent" />
                                <span className="absolute bottom-2 left-2 rounded-full bg-[#b8f05a] px-2 py-0.5 font-cabinet text-[9px] font-bold uppercase tracking-[.1em] text-[#102521]">
                                  {category.label}
                                </span>
                                <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.1em] text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
                                  <Maximize2 className="h-3 w-3" /> Full view
                                </span>
                              </button>
                            ))}
                          </div>
                          <p className="mt-3 text-[11px] text-white/55">
                            {category.copy}. Open a photo for the full-screen viewer — full sets
                            on Facebook, X, and TikTok are linked from there.
                          </p>
                        </>
                      );
                    })()}
                  </div>
                ) : (
                <div className="mt-6 grid gap-2 sm:grid-cols-3">
                  {headerMegaMenuItems[activeHeaderMenu].items.map((item) => (
                    <div
                      key={item.title}
                      className="block rounded-2xl border border-white/10 bg-white/[0.06] p-4 text-left transition hover:border-[#b8f05a]/50 hover:bg-white/[0.1]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-display text-base font-bold text-white">
                          {item.title}
                        </h3>
                        {item.soon && (
                          <span className="rounded-full bg-[#b8f05a] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-[#102521]">
                            Soon
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-white/60">{item.copy}</p>
                    </div>
                  ))}
                </div>
                )}
              </div>
            </div>
          )}
        </div>
        {menuOpen && (
          <nav className="mx-auto mt-2 grid max-w-7xl grid-cols-2 gap-1 rounded-2xl border border-[#102521]/10 bg-white p-2 shadow-xl lg:hidden">
            {landingNav.map((name) => (
              <button
                key={name}
                onClick={name === "Venues" ? openExplorer : () => scrollTo(name)}
                className="rounded-xl px-3 py-3 text-left text-sm font-semibold hover:bg-[#eaf5d8]"
              >
                {name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => (player ? navigate({ to: "/dashboard" }) : openSignIn())}
              className="truncate rounded-xl px-3 py-3 text-sm font-semibold hover:bg-[#eaf5d8]"
            >
              {player?.name ?? "Sign in"}
            </button>
          </nav>
        )}
      </header>

      {(signInOpen || signInClosing) && (
        <div
          className={`fixed inset-0 z-1300 flex justify-end bg-[#061a17]/60 backdrop-blur-sm ${signInClosing ? "motion-safe:animate-[landing-overlay-out_.3s_ease-in_both]" : "motion-safe:animate-[landing-overlay-in_.2s_ease-out_both]"}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sign-in-title"
          onMouseDown={closeSignIn}
        >
          {/* Fills the blurred area the drawer leaves behind. pointer-events-none so a
              click here still reaches the overlay and closes the sheet, and hidden below
              md, where the drawer is full-width and there is no backdrop to write on. */}
          <div className="pointer-events-none hidden flex-1 items-center justify-center px-10 md:flex">
            <p
              /* The swap rides the animation rather than a timer of its own: `handwrite-loop`
                 ends each cycle at opacity 0, so advancing on its iteration event changes the
                 words at the one moment nothing is visible. The name check matters — the
                 glaze on ::after emits iteration events through here too. */
              onAnimationIteration={(event) => {
                if (event.animationName === "handwrite-loop")
                  setTaglineIndex((index) => (index + 1) % SIGN_IN_TAGLINES.length);
              }}
              className={`tagline-glaze max-w-lg text-center font-cabinet text-5xl font-bold leading-[1.08] tracking-tight text-[#b8f05a] [text-shadow:0_0_36px_rgba(184,240,90,0.35)] lg:text-6xl ${
                signInClosing
                  ? "opacity-0 transition-opacity duration-200"
                  : "motion-safe:animate-[handwrite-loop_9.4s_linear_0.35s_infinite_backwards]"
              }`}
              /* Copied onto ::after, which draws the same words in a moving highlight. */
              data-text={SIGN_IN_TAGLINES[taglineIndex]}
            >
              {SIGN_IN_TAGLINES[taglineIndex]}
            </p>
          </div>
          <aside
            className={`drawer-edge-glow relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-[#f6f8f7] shadow-2xl ${signInClosing ? "motion-safe:animate-[landing-drawer-out_.32s_cubic-bezier(0.4,0,1,1)_both]" : "motion-safe:animate-[landing-drawer-in_.38s_cubic-bezier(0.22,1,0.36,1)_both]"}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* shrink-0 matters here: this header needs overflow-hidden to clip the blur
                blob, and a flex item whose overflow is not visible loses its automatic
                minimum size — so it was the one child free to be squeezed, and the role
                step's tall cards squeezed it until the heading was cut off. Held at its
                natural height, the overflow goes to the aside, which already scrolls. */}
            <div className="relative shrink-0 overflow-hidden bg-[#09231f] px-6 pb-10 pt-6 text-white sm:px-8">
              <div className="absolute -right-14 -top-20 h-52 w-52 rounded-full bg-[#b8f05a]/20 blur-3xl" />
              <div className="relative flex items-center justify-between">
                <span className="logo-glaze">
                  <img
                    src="/courthub-wordmark.png"
                    alt="CourtHub"
                    width={983}
                    height={240}
                    className="h-7 w-auto object-contain"
                  />
                </span>
                <button
                  type="button"
                  onClick={closeSignIn}
                  aria-label="Close sign in"
                  className="rounded-full border border-white/20 p-2 text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
              {/* The role step has two large choice cards below the fold of a phone, so its
                  header runs compact — a shorter drop from the wordmark and a smaller
                  headline. The other steps keep the full-size hero treatment. */}
              <p
                className={`relative text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a] ${authSheetStep === "role" ? "mt-6" : "mt-12"}`}
              >
                {authSheetStep === "signin"
                  ? "Welcome back"
                  : authSheetStep === "forgot" || authSheetStep === "forgot-sent"
                    ? "Account security"
                    : "Join CourtHub"}
              </p>
              <h2
                id="sign-in-title"
                className={`relative mt-2 font-display font-bold tracking-tight ${authSheetStep === "role" ? "text-2xl" : "text-4xl"}`}
              >
                {authSheetStep === "signin"
                  ? "Ready to play?"
                  : authSheetStep === "confirmation" || authSheetStep === "forgot-sent"
                    ? "Check your email"
                    : authSheetStep === "forgot"
                      ? "Forgot your password?"
                      : "Let’s get you playing."}
              </h2>
              <p className="relative mt-3 max-w-sm text-sm leading-relaxed text-white/70">
                {authSheetStep === "signin"
                  ? "Sign in to manage bookings and get back on the court."
                  : authSheetStep === "confirmation"
                    ? "We sent a confirmation link to finish setting up your account."
                    : authSheetStep === "forgot"
                      ? "Enter the email you used to sign up and we’ll send you a link to reset it."
                      : authSheetStep === "forgot-sent"
                        ? "We sent a password reset link to your email."
                        : "Create your account in a few quick steps."}
              </p>
            </div>

            {authSheetStep === "role" && (
              <div className="flex flex-1 flex-col px-6 py-8 sm:px-8">
                <p className="text-sm leading-relaxed text-[#5e746e]">How will you use CourtHub?</p>
                <div className="mt-6 space-y-3">
                  {[
                    ["player", "🎾", "I’m a player", "Browse and book courts near you."],
                    ["tenant", "🏟️", "I manage a venue", "List courts, rates, and availability."],
                  ].map(([role, icon, title, copy]) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setSignupRole(role as "player" | "tenant")}
                      className={`w-full rounded-2xl border-2 p-4 text-left transition ${signupRole === role ? "border-[#12806d] bg-[#eaf5d8]" : "border-[#d8e4df] bg-white hover:border-[#12806d]/40"}`}
                    >
                      {/* Emoji left, role banner top-right. A <button> may only contain
                          phrasing content, so this row is a span with display:flex rather
                          than a div — the banner file is derived from the role key. */}
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-2xl">{icon}</span>
                        {/* Same glass sweep the wordmark carries, masked against this badge
                            rather than the default, so the light follows the badge's own
                            outline and stops at its edge. */}
                        <span
                          className="logo-glaze shrink-0"
                          style={
                            {
                              "--logo-glaze-src": `url(/role-${role}.png)`,
                            } as CSSProperties
                          }
                        >
                          <img
                            src={`/role-${role}.png`}
                            alt=""
                            className="h-6 w-auto object-contain"
                          />
                        </span>
                      </span>
                      <span className="mt-3 block font-display text-lg font-bold text-[#102521]">
                        {title}
                      </span>
                      <span className="mt-1 block text-sm text-[#5e746e]">{copy}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!signupRole}
                  onClick={() => setAuthSheetStep("signup")}
                  className="mt-6 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={() => setAuthSheetStep("signin")}
                  className="mt-5 text-sm font-bold text-[#12806d] hover:underline"
                >
                  Already have an account? Sign in
                </button>
              </div>
            )}

            {authSheetStep === "confirmation" && (
              <div className="flex flex-1 flex-col px-6 py-8 text-center sm:px-8">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eaf5d8] text-2xl">
                  📧
                </div>
                <p className="mt-6 text-sm leading-relaxed text-[#5e746e]">
                  Check <strong className="text-[#102521]">{signInEmail}</strong> and follow the
                  confirmation link to activate your account.
                </p>
                <button
                  type="button"
                  onClick={() => setAuthSheetStep("signin")}
                  className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white hover:bg-[#126152]"
                >
                  Back to sign in
                </button>
              </div>
            )}

            {authSheetStep === "forgot" && (
              <form
                onSubmit={sendPasswordReset}
                className="flex flex-1 flex-col px-6 py-8 sm:px-8"
              >
                <label className="text-sm font-bold text-[#102521]">
                  Email
                  <input
                    type="email"
                    autoComplete="email"
                    value={signInEmail}
                    onChange={(event) => setSignInEmail(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                    placeholder="you@example.com"
                    required
                  />
                </label>
                {signInError && (
                  <p className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    {signInError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={signInBusy}
                  className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:cursor-wait disabled:opacity-60"
                >
                  {signInBusy ? "Sending…" : "Send reset link"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSignInError(null);
                    setAuthSheetStep("signin");
                  }}
                  className="mt-5 text-sm font-bold text-[#12806d] hover:underline"
                >
                  Back to sign in
                </button>
              </form>
            )}

            {authSheetStep === "forgot-sent" && (
              <div className="flex flex-1 flex-col px-6 py-8 text-center sm:px-8">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eaf5d8] text-2xl">
                  📧
                </div>
                <p className="mt-6 text-sm leading-relaxed text-[#5e746e]">
                  If <strong className="text-[#102521]">{signInEmail}</strong> has a CourtHub
                  account, we sent a link to reset its password. Open it on this device to
                  choose a new one.
                </p>
                <button
                  type="button"
                  onClick={() => setAuthSheetStep("signin")}
                  className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white hover:bg-[#126152]"
                >
                  Back to sign in
                </button>
              </div>
            )}

            <form
              onSubmit={submitAuth}
              className={`flex flex-1 flex-col px-6 py-8 sm:px-8 ${authSheetStep === "signin" || authSheetStep === "signup" ? "" : "hidden"}`}
            >
              {/* Sign-up's Google entry point lives below the Create account button instead,
                  one screen forward — it needs a role chosen on the role step first, and
                  this step doesn't know one yet. */}
              {authSheetStep === "signin" && (
                <>
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => handleGoogleAuth(null)}
                      className="flex w-full items-center justify-center gap-2.5 rounded-full border-2 border-[#d8e4df] bg-white px-5 py-3.5 text-sm font-bold text-[#102521] transition hover:border-[#12806d]/40"
                    >
                      <GoogleGlyph className="h-4 w-4" />
                      Continue with Google
                    </button>
                    {/* Hover-only, so it never competes with the role-switch guide bubble for
                        attention — this is a warning to read before tapping, not a nudge
                        toward tapping. */}
                    <div
                      role="tooltip"
                      className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 scale-95 rounded-lg bg-[#0b3d35] px-3 py-2 text-center text-xs font-semibold leading-snug text-white opacity-0 shadow-lg transition duration-150 group-hover:scale-100 group-hover:opacity-100"
                    >
                      Use the same Google account you signed up with — a different one won&rsquo;t
                      be able to continue.
                      <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#0b3d35]" />
                    </div>
                  </div>
                  <div className="my-5 flex items-center gap-3">
                    <span className="h-px flex-1 bg-[#d8e4df]" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8a9c96]">
                      or
                    </span>
                    <span className="h-px flex-1 bg-[#d8e4df]" />
                  </div>
                </>
              )}
              {authSheetStep === "signup" && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-[#102521] capitalize">
                      {signupRole === "tenant" ? "Venue manager account" : "Player account"}
                    </p>
                    {/* The old "Change" link, as a stack of the two role banners. The role
                        you already picked sits in front, large and opaque, matching the
                        account-type label to its left; the other role sits behind, smaller
                        and faded, as a preview of what tapping the stack switches you to.
                        Clicking swaps them, and because only transform/opacity change, the
                        swap animates instead of cutting. type="button" is load-bearing —
                        this lives inside the signup form and would submit it otherwise. The
                        guide bubble below sits outside the button rather than inside it: a
                        <button> may only contain phrasing content, and the bubble isn't
                        that. */}
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setSignupRole(signupRole === "tenant" ? "player" : "tenant");
                          setShowRoleGuide(false);
                        }}
                        aria-label={
                          signupRole === "tenant"
                            ? "Switch to a player account"
                            : "Switch to a venue manager account"
                        }
                        className="relative h-9 w-36"
                      >
                        {(["player", "tenant"] as const).map((bannerRole) => {
                          const inFront = bannerRole === (signupRole ?? "player");
                          return (
                            /* position is set inline, not by Tailwind's `absolute`: .logo-glaze
                               is unlayered CSS and so outranks a utility class, and its
                               `position: relative` would otherwise win and break this stack. */
                            <span
                              key={bannerRole}
                              className={`logo-glaze right-0 top-0 origin-right transition-all duration-300 ease-out motion-reduce:transition-none ${
                                inFront
                                  ? "z-10 translate-y-3 scale-100 opacity-100"
                                  : "z-0 translate-y-0 scale-90 opacity-40"
                              }`}
                              style={
                                {
                                  position: "absolute",
                                  "--logo-glaze-src": `url(/role-${bannerRole}.png)`,
                                } as CSSProperties
                              }
                            >
                              <img
                                src={`/role-${bannerRole}.png`}
                                alt=""
                                className="h-6 w-auto object-contain"
                              />
                            </span>
                          );
                        })}
                      </button>
                      {/* One-time nudge toward the switcher, which otherwise reads as a
                          static badge rather than something tappable. */}
                      {showRoleGuide && (
                        <div
                          role="status"
                          className="bubble-pop pointer-events-none absolute right-2 top-full z-20 mt-2 w-36 rounded-lg bg-[#0b3d35] px-2.5 py-1.5 text-center text-[11px] font-semibold leading-tight text-white shadow-lg"
                        >
                          Tap here to switch between player &amp; venue manager
                          <span className="absolute -top-1 right-6 h-2 w-2 rotate-45 bg-[#0b3d35]" />
                        </div>
                      )}
                    </div>
                  </div>
                  <label className="mt-5 text-sm font-bold text-[#102521]">
                    Full name
                    <input
                      type="text"
                      autoComplete="name"
                      value={signupName}
                      onChange={(event) => setSignupName(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                      placeholder="Your name"
                      required
                    />
                  </label>
                  <label className="mt-5 text-sm font-bold text-[#102521]">
                    Phone <span className="font-normal text-[#5e746e]">(optional)</span>
                    <input
                      type="tel"
                      autoComplete="tel"
                      value={signupPhone}
                      onChange={(event) => setSignupPhone(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                      placeholder="Your phone number"
                    />
                  </label>
                </>
              )}
              <label className="text-sm font-bold text-[#102521]">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={signInEmail}
                  onChange={(event) => setSignInEmail(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                  placeholder="you@example.com"
                  required
                />
              </label>
              <div className="mt-5 flex items-center justify-between gap-3">
                {/* Explicit htmlFor/id rather than the usual wrapping label: "Forgot
                    password?" needs to sit on the same row as the label text, and a button
                    nested inside a label is invalid content — see the consent checkbox
                    below for the same reasoning. */}
                <label htmlFor="signin-password" className="text-sm font-bold text-[#102521]">
                  Password
                </label>
                {authSheetStep === "signin" && (
                  <button
                    type="button"
                    onClick={() => {
                      setSignInError(null);
                      setAuthSheetStep("forgot");
                    }}
                    className="text-xs font-bold text-[#12806d] hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                id="signin-password"
                type="password"
                autoComplete={authSheetStep === "signup" ? "new-password" : "current-password"}
                value={signInPassword}
                onChange={(event) => setSignInPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                placeholder={authSheetStep === "signup" ? "At least 8 characters" : "Your password"}
                required
                minLength={authSheetStep === "signup" ? 8 : 6}
              />
              {/* Both documents open in a reader stacked on top of this sheet rather than in a
                  new route, so nothing typed above is lost. Signing up requires the tick —
                  that is when the agreement is entered into. Signing in does not ask again;
                  the account already agreed, so the documents are simply offered to read. */}
              {authSheetStep === "signup" ? (
                <div
                  className={`mt-6 rounded-2xl border p-4 transition ${
                    legalTouched && !legalAccepted
                      ? "border-red-300 bg-red-50"
                      : "border-[#d8e4df] bg-white"
                  }`}
                >
                  {/* The openers sit outside the <label> deliberately — a button nested inside
                      one is invalid content and its click would toggle the box as well. */}
                  <div className="flex gap-3">
                    <input
                      id="legal-consent"
                      type="checkbox"
                      required
                      checked={legalAccepted}
                      onChange={(event) => {
                        setLegalAccepted(event.target.checked);
                        setLegalTouched(true);
                        if (event.target.checked) setSignInError(null);
                      }}
                      aria-describedby="legal-consent-help"
                      className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-[#9db3ac] accent-[#12806d] focus:ring-2 focus:ring-[#b8f05a]"
                    />
                    <label
                      htmlFor="legal-consent"
                      className="cursor-pointer text-sm leading-relaxed text-[#41564f]"
                    >
                      I have read, understood and agree to CourtHub&rsquo;s Terms &amp; Conditions
                      and Privacy Policy.
                    </label>
                  </div>
                  <p
                    id="legal-consent-help"
                    className="mt-2.5 pl-8 text-xs leading-relaxed text-[#5e746e]"
                  >
                    This includes the restrictions on copying, scraping and reverse engineering the
                    platform, its workflow and its underlying system design.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-8">
                    {legalReadLinks}
                  </div>
                </div>
              ) : null}
              {signInError && (
                <p className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                  {signInError}
                </p>
              )}
              <button
                type="submit"
                disabled={signInBusy}
                className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:cursor-wait disabled:opacity-60"
              >
                {signInBusy
                  ? authSheetStep === "signup"
                    ? "Creating account…"
                    : "Signing in…"
                  : authSheetStep === "signup"
                    ? "Create account"
                    : "Sign in"}
              </button>
              {/* Google entry point for signup: role is already locked in by the time this
                  step is reached (the role step's Continue is the only way here), so it just
                  carries signupRole through the same handoff as the button above. */}
              {authSheetStep === "signup" && (
                <>
                  <div className="my-5 flex items-center gap-3">
                    <span className="h-px flex-1 bg-[#d8e4df]" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#8a9c96]">
                      or
                    </span>
                    <span className="h-px flex-1 bg-[#d8e4df]" />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleGoogleAuth(signupRole)}
                    className="flex items-center justify-center gap-2.5 rounded-full border-2 border-[#d8e4df] bg-white px-5 py-3.5 text-sm font-bold text-[#102521] transition hover:border-[#12806d]/40"
                  >
                    <GoogleGlyph className="h-4 w-4" />
                    Continue with Google
                  </button>
                </>
              )}
              {/* Sign-in has nothing to agree to — the account agreed when it was created —
                  so the documents sit under the button as a reference rather than above it
                  as a gate. Sign-up keeps its consent box above the button, where it has to
                  be read before the account can be made. */}
              {authSheetStep === "signin" && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                  {legalReadLinks}
                </div>
              )}
              <p className="mt-6 text-center text-sm text-[#5e746e]">
                {authSheetStep === "signup" ? "Already have an account?" : "New to CourtHub?"}{" "}
                <button
                  type="button"
                  onClick={() => setAuthSheetStep(authSheetStep === "signup" ? "signin" : "role")}
                  className="font-bold text-[#12806d] hover:underline"
                >
                  {authSheetStep === "signup" ? "Sign in" : "Create an account"}
                </button>
              </p>
              <p className="mt-auto pt-8 text-center text-xs leading-relaxed text-[#5e746e]">
                Your next game is closer than you think.
              </p>
            </form>
          </aside>
        </div>
      )}

      {legalOpen && (
        <LegalReader
          doc={legalOpen === "terms" ? TERMS : PRIVACY}
          onClose={() => setLegalOpen(null)}
          /* At signup, agreeing from inside the reader ticks the box and returns you to the
             form, so the document can be read and accepted without ever leaving the sheet.
             At sign-in there is nothing to tick, so the reader just offers a close button. */
          onAgree={
            authSheetStep === "signup"
              ? () => {
                  setLegalAccepted(true);
                  setLegalTouched(true);
                  setSignInError(null);
                  setLegalOpen(null);
                }
              : undefined
          }
        />
      )}

      {(bookingPromptOpen || bookingPromptClosing) && (
        <div
          className={`fixed inset-0 z-1300 grid place-items-center bg-[#061a17]/60 p-4 backdrop-blur-sm ${
            bookingPromptClosing
              ? "motion-safe:animate-[landing-overlay-out_.2s_ease-in_both]"
              : "motion-safe:animate-[landing-overlay-in_.2s_ease-out_both]"
          }`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="booking-sign-in-title"
          onMouseDown={() => closeBookingPrompt()}
        >
          <div
            className={`relative w-full max-w-md overflow-hidden rounded-3xl border border-[#b8f05a]/40 bg-white text-[#102521] shadow-2xl shadow-[#09231f]/30 ${
              bookingPromptClosing
                ? "motion-safe:animate-[modal-pop-out_.2s_ease-in_both]"
                : "motion-safe:animate-[modal-pop-in_.32s_cubic-bezier(0.22,1,0.36,1)_both]"
            }`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Dark header band, same treatment as the sign-in drawer, so the two auth
                surfaces read as one family instead of two unrelated dialogs. */}
            <div className="relative overflow-hidden bg-[#09231f] px-6 pb-7 pt-6 text-white sm:px-8">
              <div className="absolute -right-12 -top-16 h-44 w-44 rounded-full bg-[#b8f05a]/20 blur-3xl" />
              <div className="relative flex items-start justify-between gap-4">
                <div>
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#b8f05a] text-[#102521]">
                    <CalendarCheck2 className="h-5 w-5" />
                  </span>
                  <p className="mt-4 text-xs font-bold uppercase tracking-[.18em] text-[#b8f05a]">
                    Player booking
                  </p>
                  <h2
                    id="booking-sign-in-title"
                    className="mt-2 font-display text-2xl font-bold tracking-tight"
                  >
                    Sign in to book a court
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => closeBookingPrompt()}
                  aria-label="Close"
                  className="rounded-full border border-white/20 p-2 text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="px-6 pb-6 pt-5 sm:px-8 sm:pb-8">
              <p className="text-sm leading-relaxed text-[#5e746e]">
                Already have a player account? Sign in to book. New to CourtHub? Create an account
                and choose the <b className="text-[#102521]">Player</b> option.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    closeBookingPrompt(true);
                    openSignIn();
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#0b3d35] px-4 py-3 text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#126152]"
                >
                  Sign in <ChevronRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeBookingPrompt(true);
                    setAuthSheetStep("role");
                    setSignInOpen(true);
                  }}
                  className="rounded-full border border-[#0b3d35] px-4 py-3 text-sm font-bold text-[#0b3d35] transition hover:-translate-y-0.5 hover:bg-[#eff5ed]"
                >
                  Create account
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <section
        id="home"
        data-nav="Home"
        className="relative isolate min-h-175 overflow-hidden bg-[#09231f] pt-24 text-white sm:min-h-190"
      >
        {heroImages.map((image, index) => (
          <img
            key={image}
            src={image}
            alt="Players enjoying sport"
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-1000 ${index === heroIndex ? "opacity-100" : "opacity-0"}`}
            fetchPriority={index === 0 ? "high" : "auto"}
          />
        ))}
        <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(5,25,21,.92)_5%,rgba(5,25,21,.68)_48%,rgba(5,25,21,.24))]" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-linear-to-t from-[#09231f] to-transparent" />
        <div className="relative mx-auto flex min-h-155 max-w-7xl flex-col justify-end px-5 pb-16 sm:min-h-170 sm:px-8 sm:pb-24">
          <div className="max-w-3xl animate-[sport-fade-in-up_.7s_ease-out_both]">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#b8f05a]/50 bg-[#b8f05a]/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.15em] text-[#d9ff9b]">
              <span className="h-2 w-2 rounded-full bg-[#b8f05a]" /> Dedicated court booking
              platform
            </span>
            <h1 className="mt-5 font-display text-5xl font-bold leading-[.95] tracking-[-.055em] sm:text-7xl">
              Your game starts <span className="text-[#b8f05a]">here.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/78 sm:text-lg">
              Find and reserve badminton, basketball, pickleball, volleyball, tennis, football, and
              more across the Philippines with real-time availability and secure online booking.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={startBooking}
                className="inline-flex items-center gap-2 rounded-full bg-[#b8f05a] px-6 py-3.5 font-bold text-[#102521] transition hover:-translate-y-0.5 hover:bg-[#d3ff87]"
              >
                Book a court <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={openExplorer}
                className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-6 py-3.5 font-bold backdrop-blur transition hover:bg-white/20"
              >
                <Play className="h-4 w-4 fill-current" /> Explore venues
              </button>
            </div>
          </div>
          <div className="mt-12 flex items-center gap-2">
            {heroImages.map((_, index) => (
              <button
                key={index}
                aria-label={`Show slide ${index + 1}`}
                onClick={() => setHeroIndex(index)}
                className={`h-1.5 rounded-full transition-all ${index === heroIndex ? "w-10 bg-[#b8f05a]" : "w-4 bg-white/40"}`}
              />
            ))}
          </div>
        </div>
      </section>

      {/* The card floats on -mt-7, so its top 28px overlap the hero and the rest sits in a
          band of its own. The wrapper carries the Venues green so that band matches the
          section below instead of showing white page behind the card. flow-root, not
          overflow-hidden: it stops the negative margin collapsing the wrapper upward
          without clipping the card's shadow. */}
      <div className="flow-root bg-[#e9f2e5]">
        <section className="relative z-10 mx-auto -mt-7 grid max-w-6xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/30 bg-white/30 shadow-2xl shadow-[#09231f]/15 sm:grid-cols-5">
        {[
          "50+|Partner venues",
          "300+|Sports courts",
          "15k+|Bookings completed",
          "8k+|Registered players",
          "99%|Booking success",
        ].map((stat) => {
          const [value, label] = stat.split("|");
          return (
            <div key={label} className="bg-white px-4 py-5 text-center">
              <div className="font-display text-2xl font-bold text-[#0b3d35] sm:text-3xl">
                {value}
              </div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#52716a]">
                {label}
              </div>
            </div>
          );
        })}
        </section>
      </div>

      <section id="venues" data-nav="Venues" ref={venuesRef} className="bg-[#e9f2e5] py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <SectionIntro
            eyebrow="Play nearby"
            title="Featured places to make your next move."
            highlight="next move."
            action={
              <Link
                to={player ? "/explore" : "/explore/guest"}
                search={{}}
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[#0b3d35] px-5 py-3 font-cabinet text-sm font-bold text-[#0b3d35] transition hover:-translate-y-0.5 hover:bg-[#0b3d35] hover:text-white"
              >
                Browse every venue <ChevronRight className="h-4 w-4" />
              </Link>
            }
          />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {((featuredQ.data ?? []) as unknown as FeaturedVenue[]).slice(0, 3).map((venue, cardIndex) => (
              <FeaturedVenueCard
                key={venue.id}
                venue={venue}
                index={cardIndex}
                lit={venuesLit}
                onOpen={() =>
                  navigate({
                    to: "/venues/$venueId",
                    params: { venueId: String(venue.id) },
                    search: {},
                  })
                }
                onBook={() => startVenueBooking(String(venue.id))}
              />
            ))}
            {!featuredQ.isLoading && (featuredQ.data?.length ?? 0) === 0 && (
              <div className="col-span-full rounded-2xl border border-dashed border-[#aac2b8] p-10 text-center text-[#5e746e]">
                Venues will appear here as they join CourtHub.
              </div>
            )}
          </div>
        </div>
      </section>

      <section
        id="how-it-works"
        data-nav="How It Works"
        ref={howItWorksRef}
        className="bg-[#0b3d35] py-20 text-white"
      >
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">How it works as a player</p>
          <h2 className="mt-3 max-w-xl font-display text-4xl font-bold tracking-tight sm:text-5xl">
            From search to game time in four simple moves.
          </h2>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
            {[
              [
                UserPlus,
                "Create your account",
                "Sign up as a player to keep your bookings in one place.",
              ],
              [
                Building2,
                "Choose a venue",
                "Browse trusted facilities that fit your sport and location.",
              ],
              [
                CalendarCheck2,
                "Select court & time",
                "See availability, pick your court, then lock in your slot.",
              ],
              [
                ShieldCheck,
                "Complete payment",
                "Pay securely online where the venue offers online checkout.",
              ],
              [Trophy, "Enjoy your game", "Receive your confirmation and get ready to play."],
            ].map(([Icon, title, copy], index) => {
              const open = openStep === index;
              return (
                <div
                  key={title as string}
                  style={{ animationDelay: `${index * 260}ms` }}
                  onClick={() => !open && setOpenStep(index)}
                  className={`group relative isolate overflow-hidden rounded-2xl border bg-white/5 p-5 transition-[border-color,box-shadow] duration-300 ${
                    open
                      ? "cursor-default border-[#b8f05a] shadow-[0_0_26px_-4px_rgba(184,240,90,0.6)]"
                      : "cursor-pointer border-white/15 hover:border-[#b8f05a] hover:shadow-[0_0_26px_-4px_rgba(184,240,90,0.6)] focus-within:border-[#b8f05a] focus-within:shadow-[0_0_26px_-4px_rgba(184,240,90,0.6)]"
                  } ${stepsLit && !open ? "motion-safe:animate-[step-edge-light_1.1s_ease-out]" : ""}`}
                >
                  {/* The tile face. Hidden the moment it shatters — the shards above are
                      opaque and stand in for it, so leaving it visible would show through
                      the gaps as they separate. */}
                  <div className={open ? "invisible" : ""}>
                    <span
                      style={{ animationDelay: `${index * 260}ms` }}
                      className={`font-display text-5xl font-bold text-[#b8f05a]/35 transition-colors duration-300 group-hover:text-[#b8f05a] group-focus-within:text-[#b8f05a] ${
                        stepsLit ? "motion-safe:animate-[step-number-light_1.1s_ease-out]" : ""
                      }`}
                    >
                      0{index + 1}
                    </span>
                    <Icon className="mt-8 h-6 w-6 text-[#b8f05a]" />
                    <h3 className="mt-4 font-display text-xl font-bold">{title as string}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/65">{copy as string}</p>
                    <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#b8f05a]/40 bg-[#b8f05a]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[.14em] text-[#d9ff9b] opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
                      <PlayCircle className="h-3.5 w-3.5" />
                      Tap to view tutorials
                    </span>
                  </div>

                  {open && (
                    <>
                      {/* Shards of the tile face, thrown outward. Opaque tile colour so they
                          read as the card breaking rather than as an overlay. */}
                      <div className="pointer-events-none absolute inset-0 z-30 grid grid-cols-4 grid-rows-4">
                        {Array.from({ length: 16 }).map((_, i) => (
                          <span
                            key={i}
                            style={shardStyle(i, 0)}
                            className="bg-[#17473f] motion-safe:animate-[step-shatter-out_.5s_cubic-bezier(0.4,0,1,1)_forwards]"
                          />
                        ))}
                      </div>

                      {/* The same 16 cells running the path in reverse, in the player's
                          surface colour — the pieces coming back together as the video tile. */}
                      <div className="pointer-events-none absolute inset-0 z-10 grid grid-cols-4 grid-rows-4">
                        {Array.from({ length: 16 }).map((_, i) => (
                          <span
                            key={i}
                            style={shardStyle(i, 300)}
                            className="bg-[#061a17] opacity-0 motion-safe:animate-[step-shatter-in_.5s_cubic-bezier(0.22,1,0.36,1)_forwards]"
                          />
                        ))}
                      </div>

                      {/* Player face. A sample surface, not a real <video> — the tutorials do
                          not exist yet. Dropping one in is swapping this block for
                          <video autoPlay muted playsInline src={...} className="h-full w-full
                          object-cover" />; the shatter around it needs no change. */}
                      <div className="absolute inset-0 z-20 flex flex-col justify-between p-4 opacity-0 motion-safe:animate-[step-player-in_.4s_ease-out_.78s_forwards]">
                        <div className="flex items-start justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[#b8f05a]">
                            Step 0{index + 1}
                          </span>
                          <button
                            type="button"
                            aria-label="Close tutorial preview"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenStep(null);
                            }}
                            className="rounded-full border border-white/20 p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#b8f05a] text-[#102521]">
                            <PlayCircle className="h-7 w-7" />
                          </span>
                          <span className="mt-3 text-center font-display text-sm font-bold">
                            {title as string}
                          </span>
                          <span className="mt-1 text-center text-[10px] uppercase tracking-[.14em] text-white/45">
                            Tutorial coming soon
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-white/15">
                          <div className="h-full w-1/3 rounded-full bg-[#b8f05a]/70" />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* White between How It Works (#0b3d35) and Upcoming Events (#09231f), so the page keeps
          alternating rather than running three panes of dark together. */}
      <section id="learn-sports" data-nav="Learn Sports" className="py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <SectionIntro
            eyebrow="Learn sports"
            title="New to the game? Start here."
            highlight="Start here."
          />
          <div className="mt-8 flex flex-wrap gap-2">
            {learnSports.map((sport) => {
              const active = sport.slug === activeSport;
              return (
                <button
                  key={sport.slug}
                  type="button"
                  onClick={() => setActiveSport(sport.slug)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-full border px-4 py-2 font-cabinet text-sm font-semibold transition duration-300 ${
                    active
                      ? "-translate-y-0.5 border-[#12806d] bg-[#12806d] text-white shadow-md shadow-[#12806d]/25"
                      : "border-[#d8e4df] bg-white text-[#102521] hover:-translate-y-0.5 hover:border-[#12806d]/50 hover:bg-[#eaf5d8]"
                  }`}
                >
                  <span aria-hidden>{sport.emoji}</span> {sport.name}
                </button>
              );
            })}
          </div>

          {(() => {
            const sport = learnSports.find((s) => s.slug === activeSport) ?? learnSports[0];
            return (
              /* Keyed on the slug so React remounts on every switch and the entry animation
                 replays — a plain re-render would leave the keyframes already finished. */
              <div
                key={sport.slug}
                className="mt-8 grid gap-6 motion-safe:animate-[learn-panel-in_.45s_cubic-bezier(0.22,1,0.36,1)_both] lg:grid-cols-[1.05fr_.95fr]"
              >
                <div className="rounded-3xl border border-[#dce8e2] bg-white p-6 sm:p-8">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf5d8] text-2xl">
                      <span aria-hidden>{sport.emoji}</span>
                    </span>
                    <h3 className="font-cabinet text-2xl font-bold tracking-tight text-[#102521]">
                      {sport.name}
                    </h3>
                  </div>
                  <p className="mt-4 text-sm leading-relaxed text-[#5e746e]">{sport.blurb}</p>

                  {/* Quick facts before the rules: the three things someone sizing up a new
                      sport asks first — how many players, how big, how you win. */}
                  <div className="mt-6 grid gap-2 sm:grid-cols-3">
                    {sport.facts.map((fact, i) => (
                      <div
                        key={fact.label}
                        style={{ animationDelay: `${120 + i * 80}ms` }}
                        className="rounded-xl border border-[#dce8e2] bg-[#f6f8f7] p-3 motion-safe:animate-[learn-rule-in_.4s_ease-out_both]"
                      >
                        <span className="block text-[9px] font-bold uppercase tracking-[.14em] text-[#5e746e]">
                          {fact.label}
                        </span>
                        <span className="mt-1 block font-cabinet text-xs font-bold leading-snug text-[#102521]">
                          {fact.value}
                        </span>
                      </div>
                    ))}
                  </div>

                  <p className="mt-7 text-xs font-bold uppercase tracking-[.18em] text-[#12806d]">
                    How it is played
                  </p>
                  <ul className="mt-4 space-y-3">
                    {sport.rules.map((rule, i) => (
                      <li
                        key={rule}
                        style={{ animationDelay: `${360 + i * 90}ms` }}
                        className="flex gap-3 text-sm leading-relaxed text-[#102521] motion-safe:animate-[learn-rule-in_.4s_ease-out_both]"
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#b8f05a] ring-2 ring-[#b8f05a]/25" />
                        {rule}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Real photography behind the player surface. The tutorial itself is still to
                    come, so the frame shows the sport rather than an empty gradient — swapping
                    in <video> later replaces the img and the overlay stays. */}
                <div className="group relative isolate flex aspect-video flex-col justify-between overflow-hidden rounded-3xl border border-[#0f4a40] bg-[#061a17] p-5 text-white">
                  <img
                    src={sport.photo}
                    alt={`${sport.name} being played`}
                    loading="lazy"
                    className="absolute inset-0 -z-10 h-full w-full object-cover opacity-45 transition duration-700 group-hover:scale-105 group-hover:opacity-60"
                  />
                  <span className="absolute inset-0 -z-10 bg-linear-to-t from-[#061a17] via-[#061a17]/55 to-transparent" />
                  <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[#b8f05a]">
                    {sport.name} tutorial
                  </span>
                  <div className="flex flex-col items-center">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#b8f05a] text-[#102521] shadow-lg shadow-[#b8f05a]/25 transition duration-300 group-hover:scale-110">
                      <PlayCircle className="h-8 w-8" />
                    </span>
                    <span className="mt-3 text-center font-cabinet text-base font-bold">
                      Watch how {sport.name.toLowerCase()} is played
                    </span>
                    <span className="mt-1 text-center text-[10px] uppercase tracking-[.14em] text-white/50">
                      Video coming soon
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-white/15">
                    <div className="h-full w-1/4 rounded-full bg-[#b8f05a]/70" />
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </section>


      {/* Darker than How It Works above it, which is also #0b3d35 — matching tones made the
          two read as one slab with a gap in the middle. #09231f is the same dark already used
          by the CTA band and the drawer header, and the lime hairline gives the seam an edge
          rather than relying on the tonal step alone. Stays dark because the copy, the blur
          blob and the translucent card are all built for a dark ground. */}
      <section
        id="upcoming-events"
        data-nav="Upcoming Events"
        className="relative isolate overflow-hidden border-t border-[#b8f05a]/25 bg-[#09231f] py-20 text-white"
      >
        <div className="absolute -right-24 top-1/2 -z-10 h-80 w-80 -translate-y-1/2 rounded-full bg-[#b8f05a]/10 blur-3xl" />
        <div className="mx-auto grid max-w-7xl gap-8 px-5 sm:px-8 lg:grid-cols-[1fr_.9fr] lg:items-center">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">
              Upcoming events
            </p>
            <h2 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Your next game could be bigger than a booking.
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/70">
              Soon, partner venues will be able to share tournaments, leagues, open play, and
              community events directly on CourtHub.
            </p>
          </div>
          <div className="rounded-3xl border border-white/15 bg-white/[0.07] p-6 shadow-2xl backdrop-blur-sm sm:p-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#b8f05a] text-[#102521]">
              <CalendarDays className="h-6 w-6" />
            </div>
            <span className="mt-6 inline-flex rounded-full border border-[#b8f05a]/35 bg-[#b8f05a]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[.16em] text-[#d9ff9b]">
              Tenant event posting · coming soon
            </span>
            <h3 className="mt-4 font-display text-2xl font-bold">A home for local game days.</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/65">
              Check back for event schedules, tournament details, venue announcements, and ways to
              join in.
            </p>
          </div>
        </div>
      </section>

      {/* Tinted so it does not run into Highlights below, which is also plain white on max-w-7xl.
          Tinting Highlights instead would have solved this pair and created a new one, since
          Testimonials under it is already #e9f2e5. Taking Features keeps the page alternating:
          dark -> tint -> white -> tint. Structure now matches Venues: full-bleed section,
          centred inner container. */}
      <section
        id="features"
        data-nav="Features"
        ref={featuresRef}
        className="relative isolate overflow-hidden bg-[#e9f2e5] py-20"
      >
        {/* A single soft bloom behind the grid so ten white cards on a flat tint have
            something to sit on rather than floating on an empty field. */}
        <div className="pointer-events-none absolute -right-24 top-24 -z-10 h-96 w-96 rounded-full bg-[#b8f05a]/20 blur-3xl" />
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <SectionIntro
            eyebrow="Built around game time"
            title="Everything between finding a court and stepping onto it."
            highlight="stepping onto it."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {featureCards.map(([Icon, title, description], index) => (
              <article
                key={title as string}
                style={{ animationDelay: `${index * 60}ms` }}
                className={`group relative overflow-hidden rounded-2xl border border-[#dce8e2] bg-white p-5 transition duration-300 hover:-translate-y-1.5 hover:border-[#b8f05a] hover:shadow-xl hover:shadow-[#102521]/8 ${
                  featuresLit
                    ? "motion-safe:animate-[sport-fade-in-up_.5s_cubic-bezier(0.2,0.8,0.2,1)_both]"
                    : ""
                }`}
              >
                {/* A rail that grows down the left edge on hover. The why-courthub cards use a
                    rule along the foot, so the two grids stay distinguishable rather than
                    running the same trick twice. */}
                <span className="absolute inset-y-0 left-0 w-1 origin-top scale-y-0 bg-linear-to-b from-[#b8f05a] to-[#12806d] transition-transform duration-500 group-hover:scale-y-100" />
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eaf5d8] text-[#126152] transition duration-300 group-hover:bg-[#b8f05a] group-hover:text-[#102521]">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 font-cabinet text-lg font-bold tracking-tight text-[#102521] transition-colors duration-300 group-hover:text-[#12806d]">
                  {title as string}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[#5e746e]">
                  {description as string}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        id="highlights"
        data-nav="Highlights"
        className="mx-auto max-w-7xl px-5 py-20 sm:px-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionIntro
            eyebrow="The CourtHub community"
            title="More than a booking. A reason to show up."
          />
          <div className="group relative">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-[#0b3d35] bg-white px-4 py-2.5 text-sm font-bold text-[#0b3d35] shadow-sm transition group-hover:bg-[#0b3d35] group-hover:text-white focus:bg-[#0b3d35] focus:text-white"
              aria-haspopup="true"
            >
              Browse highlights <ChevronDown className="h-4 w-4" />
            </button>
            <div className="invisible absolute right-0 top-full z-20 mt-2 w-64 translate-y-1 rounded-2xl border border-[#dce8e2] bg-white p-2 opacity-0 shadow-xl transition duration-200 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
              {/* Driven by the same four categories the strip uses, and enabled: each one now
                  has sample frames to open, so a disabled item with a "Soon" pill would be
                  claiming there is nothing to see when there is. */}
              {highlightCategories.map((category) => (
                <button
                  key={category.key}
                  type="button"
                  onClick={() => setHighlightOpen({ key: category.key, idx: 0 })}
                  className="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#eff5ed]"
                >
                  <span>
                    <span className="block text-sm font-bold text-[#0b3d35]">
                      {category.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-[#5e746e]">
                      {category.copy}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#eaf5d8] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#126152]">
                    {category.images.length}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* One continuous strip instead of a grid: every tile is the same size, the track
            slides, and hovering anywhere pauses it so a tile can be read. The tiles are
            rendered twice — the loop translates -50%, landing the second copy exactly where
            the first started, which is what makes it seamless rather than snapping back. */}
        <div
          className="group/strip relative mt-10"
          onMouseEnter={pauseStrip}
          onMouseLeave={() => resumeStrip()}
          /* Capture phase: focus lands on a tile deep inside, and focus does not bubble.
             Without this, tabbing through the strip would leave it sliding under the
             keyboard user. */
          onFocusCapture={pauseStrip}
          onBlurCapture={() => resumeStrip()}
        >
          {/* Scrollable in its own right, with the native scrollbar hidden — while the track is
              paused this is what lets a trackpad, a finger, or the arrows below move it. */}
          <div
            ref={stripRef}
            onTouchStart={pauseStrip}
            onTouchEnd={() => resumeStrip(2500)}
            onTouchCancel={() => resumeStrip(2500)}
            className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div
              /* Inline, not a utility class. `animation` is a shorthand and resets
                 animation-play-state to `running`; Tailwind emits the animate-[…] rule far
                 later in the sheet than an arbitrary-property class, so at equal specificity
                 the shorthand won and the pause silently did nothing. An inline style sits
                 above the whole stylesheet and cannot be overridden by rule order. */
              style={{ animationPlayState: stripPaused ? "paused" : "running" }}
              className="flex w-max gap-3 motion-safe:animate-[highlight-marquee_40s_linear_infinite]"
            >
            {[...highlightFrames, ...highlightFrames].map((frame, index) => (
              <button
                key={`${frame.src}-${index}`}
                type="button"
                onClick={() =>
                  setHighlightOpen({
                    key: frame.category.key,
                    idx: frame.category.images.indexOf(frame.src),
                  })
                }
                aria-label={`View ${frame.category.label.toLowerCase()} highlights`}
                aria-hidden={index >= highlightFrames.length}
                tabIndex={index >= highlightFrames.length ? -1 : 0}
                className="group/tile relative h-44 w-64 shrink-0 overflow-hidden rounded-2xl bg-[#0b3d35] ring-1 ring-[#dce8e2] transition duration-300 hover:ring-2 hover:ring-[#b8f05a] focus:outline-none focus:ring-2 focus:ring-[#b8f05a] sm:h-52 sm:w-72"
              >
                <img
                  src={frame.src}
                  alt={`${frame.category.label} highlight`}
                  loading="lazy"
                  className="h-full w-full object-cover transition duration-700 group-hover/tile:scale-105"
                />
                <span className="absolute inset-0 bg-linear-to-t from-[#061a17]/85 via-[#061a17]/20 to-transparent opacity-0 transition-opacity duration-300 group-hover/tile:opacity-100" />
                <span className="absolute inset-x-3 bottom-3 flex translate-y-2 items-center justify-between gap-2 opacity-0 transition duration-300 group-hover/tile:translate-y-0 group-hover/tile:opacity-100">
                  <span className="truncate rounded-full bg-[#b8f05a] px-2.5 py-1 font-cabinet text-[10px] font-bold uppercase tracking-[.1em] text-[#102521]">
                    {frame.category.label}
                  </span>
                  <span className="shrink-0 rounded-full bg-white/15 px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] text-white backdrop-blur-sm">
                    {frame.category.images.length} photos
                  </span>
                </span>
              </button>
              ))}
            </div>
          </div>
          {/* Edges fade into the page so tiles enter and leave rather than being clipped. */}
          <span className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-linear-to-r from-white to-transparent sm:w-16" />
          <span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-white to-transparent sm:w-16" />
          {/* Arrow controls, shown once the strip is paused. One tile plus its gap per press. */}
          {[
            { dir: -1, Icon: ChevronLeft, side: "left-2 sm:left-3", label: "Scroll highlights left" },
            { dir: 1, Icon: ChevronRight, side: "right-2 sm:right-3", label: "Scroll highlights right" },
          ].map(({ dir, Icon, side, label }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              onClick={() =>
                stripRef.current?.scrollBy({ left: dir * 300, behavior: "smooth" })
              }
              /* pointer-events-none while hidden: an opacity-0 button still takes clicks, so
                 without it these would swallow taps on the tiles underneath them. */
              className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-[#dce8e2] bg-white/95 p-2 text-[#0b3d35] shadow-md transition duration-200 hover:border-[#b8f05a] hover:text-[#12806d] ${side} ${
                stripPaused ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </section>

      <section id="testimonials" className="bg-[#e9f2e5] py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <SectionIntro eyebrow="Player stories" title="People trust people. So do we." />
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-[#5e746e]">
            From finding a nearby court to getting a confirmed slot, CourtHub keeps game plans
            simple.
          </p>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                quote:
                  "Booking was fast and hassle-free. I could see which hours were open before I left home.",
                name: "Maria",
                role: "Badminton player",
                rating: 5,
                /* Pexels 29088255 — "Portrait of a smiling Filipina woman outdoors in Davao
                   Region, Philippines". Chosen off the publisher's own stated description, not
                   off the image: these were picked by searching Pexels for photos whose titles
                   explicitly identify the subject, since I cannot see the pictures themselves. */
                avatar:
                  "https://images.pexels.com/photos/29088255/pexels-photo-29088255.jpeg?auto=compress&cs=tinysrgb&w=240&h=240&fit=crop",
                likes: 200,
              },
              {
                quote:
                  "Finally an easy way to reserve courts online. The confirmation made it easy to organize our group.",
                name: "John",
                role: "Weekend basketball captain",
                rating: 5,
                /* Pexels 37437993 — "A Filipino man sitting in a jeepney while smiling,
                   captured in Manila." */
                avatar:
                  "https://images.pexels.com/photos/37437993/pexels-photo-37437993.jpeg?auto=compress&cs=tinysrgb&w=240&h=240&fit=crop",
                likes: 500,
              },
              {
                quote:
                  "I like that each venue shows its court details and payment options clearly. No more back-and-forth messages.",
                name: "Alyssa",
                role: "Pickleball player",
                rating: 5,
                /* Pexels 29341356 — "Smiling Filipina woman in Cebu City with stylish jewelry
                   and bold red lipstick". */
                avatar:
                  "https://images.pexels.com/photos/29341356/pexels-photo-29341356.jpeg?auto=compress&cs=tinysrgb&w=240&h=240&fit=crop",
                likes: 1000,
              },
            ].map(({ quote, name, role, rating, avatar, likes }) => {
              const liked = !!likedStories[name];
              const total = likes + (liked ? 1 : 0);
              /* 1000 -> "1k", 1001 -> "1k" as well; a testimonial card is not the place for
                 "1.001k". Anything under a thousand prints as-is. */
              const likeLabel = total >= 1000 ? `${Math.floor(total / 100) / 10}k` : `${total}`;
              return (
                <figure
                  key={name}
                  className="group flex min-h-64 flex-col rounded-2xl border border-[#dce8e2] bg-white p-6 shadow-[0_12px_30px_rgba(16,37,33,0.08)] transition duration-300 hover:-translate-y-1 hover:border-[#b8f05a] hover:shadow-[0_18px_38px_rgba(16,37,33,0.12)]"
                >
                  {/* Identity left, rating right — the reader knows who is speaking before
                      they weigh the score, and three cards line up on both edges. */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {/* The initial sits underneath the photo, so a portrait that fails to
                          load degrades to a letter rather than an empty circle. */}
                      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#eaf5d8] font-cabinet text-sm font-bold text-[#12806d] ring-2 ring-white">
                        {name.charAt(0)}
                        <img
                          src={avatar}
                          alt=""
                          loading="lazy"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-cabinet text-sm font-bold text-[#102521]">
                          {name}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[#5e746e]">
                          {role}
                        </span>
                      </span>
                    </div>
                    <span
                      className="flex shrink-0 items-center gap-0.5"
                      aria-label={`${rating} out of 5 stars`}
                    >
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          aria-hidden
                          className={`h-3.5 w-3.5 ${
                            i < rating ? "fill-[#f0b429] text-[#f0b429]" : "text-[#dce8e2]"
                          }`}
                        />
                      ))}
                    </span>
                  </div>

                  <blockquote className="mt-5 font-cabinet text-lg font-bold leading-snug text-[#0b3d35]">
                    “{quote}”
                  </blockquote>

                  <figcaption className="mt-auto flex items-center justify-between gap-3 border-t border-[#dce8e2] pt-4">
                    <span className="text-[11px] text-[#5e746e]">Verified player story</span>
                    <button
                      type="button"
                      aria-pressed={liked}
                      aria-label={liked ? `Unlike ${name}'s story` : `Like ${name}'s story`}
                      onClick={() =>
                        setLikedStories((prev) => ({ ...prev, [name]: !prev[name] }))
                      }
                      className={`relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold transition duration-300 ${
                        liked
                          ? "border-[#e5484d]/40 bg-[#e5484d]/10 text-[#e5484d]"
                          : "border-[#dce8e2] text-[#5e746e] hover:border-[#e5484d]/40 hover:text-[#e5484d]"
                      }`}
                    >
                      {/* key={String(liked)} remounts the icon so the pop replays on every
                          toggle — a CSS animation on a persistent node only ever runs once. */}
                      <Heart
                        key={String(liked)}
                        className={`h-3.5 w-3.5 ${liked ? "fill-current motion-safe:animate-[like-pop_.45s_ease-out]" : ""}`}
                      />
                      {likeLabel}
                      {liked && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute left-[13px] top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#e5484d] opacity-0 motion-safe:animate-[like-ring_.55s_ease-out_forwards]"
                        />
                      )}
                    </button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      </section>

      <section
        id="why-courthub"
        ref={whyRef}
        className="relative isolate overflow-hidden bg-[#09231f] py-20 text-white"
      >
        <div className="absolute -right-24 top-0 -z-10 h-80 w-80 rounded-full bg-[#b8f05a]/10 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 -z-10 h-80 w-80 rounded-full bg-[#12806d]/40 blur-3xl" />
        <div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:items-start">
          <div className="lg:sticky lg:top-24">
            {/* The logo at its own 500px size — no height class, so it renders at the
                image's natural dimensions. Preflight's `max-width:100%; height:auto` is
                what keeps it inside the column on a narrow phone instead of forcing the
                page to scroll sideways; the width/height attrs reserve the space so the
                heading below does not jump when it loads. alt is empty because the
                eyebrow right underneath already says CourtHub. */}
            {/* Kept at its natural 500px as you asked. The glow behind it is what stops a
                transparent PNG from reading as a cut-out floating on the dark ground. */}
            <div className="relative mb-6 w-fit">
              <span className="absolute inset-6 -z-10 rounded-full bg-[#b8f05a]/10 blur-3xl" />
              <img
                src="/courthub-logo.png"
                alt=""
                width={500}
                height={500}
                loading="lazy"
              />
            </div>
            <p className="font-display text-sm font-bold uppercase tracking-[.2em] text-[#b8f05a] sm:text-base">
              Why choose CourtHub
            </p>
            <h2 className="mt-2 text-balance font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Less coordinating. <span className="text-[#b8f05a]">More playing.</span>
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/70">
              CourtHub brings venue details, live court availability, and the right payment flow
              into one place—so your next game is easier to plan and easier to keep.
            </p>
            <Link
              to="/explore"
              search={{}}
              className="mt-7 inline-flex items-center gap-2 rounded-full bg-[#b8f05a] px-5 py-3 text-sm font-bold text-[#102521] transition hover:-translate-y-0.5 hover:bg-[#d3ff87]"
            >
              Find a court <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          {/* Each card gets its own icon. Eight identical check badges made the grid read as
              one repeated thing; a distinct mark per card gives the eye a way in and lets a
              reader find the one they care about without reading all eight titles. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              [CalendarCheck2, "Instant booking", "Choose available hours and reserve them in a guided flow."],
              [
                Clock3,
                "Real-time availability",
                "See open, held, and booked time slots before you commit.",
              ],
              [
                ShieldCheck,
                "Secure payments",
                "Pay online when a venue requires it, with a clear payment status.",
              ],
              [
                Building2,
                "Trusted venue details",
                "Review court information, amenities, hours, and venue policies upfront.",
              ],
              [
                CalendarDays,
                "Organized schedules",
                "Get a booking reference and keep your game plan clear.",
              ],
              [
                MapPin,
                "Built for local play",
                "Discover partner venues and more ways to get your community on court.",
              ],
              [
                Wifi,
                "Play from anywhere",
                "Use CourtHub on any connected phone, tablet, or computer—whether you are planning at home or on the way to the venue.",
              ],
              [
                Sparkles,
                "Mobile-first, installable next",
                "The booking experience is designed for phones today and ready for a future installable CourtHub app experience.",
              ],
            ].map(([Icon, title, copy], index) => (
              <article
                key={title as string}
                style={{ animationDelay: `${index * 70}ms` }}
                className={`group relative flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-white/6 p-5 backdrop-blur-sm transition duration-300 hover:-translate-y-1.5 hover:border-[#b8f05a]/60 hover:bg-white/10 hover:shadow-lg hover:shadow-[#b8f05a]/10 ${
                  whyLit
                    ? "motion-safe:animate-[sport-fade-in-up_.5s_cubic-bezier(0.2,0.8,0.2,1)_both]"
                    : ""
                }`}
              >
                {/* Icon and number share the top row. The number used to be a huge watermark
                    pinned at -right-1, so it hung off the card edge and got clipped by the
                    rounded corner — inside the padding as a small chip it reads as a label
                    instead of a stray glyph. */}
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#b8f05a]/15 text-[#b8f05a] ring-1 ring-[#b8f05a]/25 transition duration-300 group-hover:bg-[#b8f05a] group-hover:text-[#102521] group-hover:ring-[#b8f05a]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 font-cabinet text-[10px] font-bold tracking-[.1em] text-white/35 transition duration-300 group-hover:border-[#b8f05a]/40 group-hover:text-[#b8f05a]">
                    0{index + 1}
                  </span>
                </div>

                <h3 className="mt-4 font-cabinet text-lg font-bold tracking-tight transition-colors duration-300 group-hover:text-[#b8f05a]">
                  {title as string}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/65">{copy as string}</p>

                {/* A lime rule that draws itself across the foot of the card on hover — the
                    one piece of motion that makes the grid feel responsive rather than static. */}
                <span className="mt-auto block pt-4">
                  <span className="block h-px w-0 bg-linear-to-r from-[#b8f05a] to-transparent transition-all duration-500 group-hover:w-full" />
                </span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        id="about"
        data-nav="About"
        className="bg-[#e9f2e5] py-20"
      >
        {/* Tinted so it does not run into the FAQ below it, which is white on the same
            max-width — the last of the doubled-background pairs on this page. Keeps the
            alternation: dark (why-courthub) -> tint -> white (faq) -> tint (contact). */}
        <div className="mx-auto grid max-w-7xl gap-12 px-5 sm:px-8 lg:grid-cols-[1.1fr_.9fr] lg:items-start">
          <div>
            <SectionIntro
              eyebrow="About CourtHub"
              title="More access to sport starts with a better way to book."
              highlight="a better way to book."
            />
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-[#5e746e]">
              CourtHub connects players with quality sports venues across the Philippines. We are
              building the trusted place to discover a court, understand availability, and make a
              reservation without the back-and-forth.
            </p>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[#5e746e]">
              Our mission is to make sports more accessible for everyone through simpler court
              reservations and stronger local sports communities.
            </p>
          </div>

          {/* Each value now carries a line of its own. A word alone in a box gives the eye
              nothing to do and left an odd gap under the icon. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              [Handshake, "Community", "Built around local players and the venues they play at."],
              [Sparkles, "Innovation", "Booking tools that keep pace with how people actually play."],
              [ShieldCheck, "Trust", "Clear policies, clear prices, and a record of every booking."],
              [Wifi, "Accessibility", "Usable on whatever device is in your hand right now."],
              [Trophy, "Sportsmanship", "Time on court is easier to share when it is easy to plan."],
              [Clock3, "Reliability", "Availability you can act on, not a guess to be confirmed."],
            ].map(([Icon, label, copy]) => (
              <div
                key={label as string}
                className="group rounded-2xl border border-[#dce8e2] bg-white p-4 transition duration-300 hover:-translate-y-1 hover:border-[#b8f05a] hover:shadow-md"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eaf5d8] text-[#12806d] transition group-hover:bg-[#b8f05a] group-hover:text-[#102521]">
                  <Icon className="h-4 w-4" />
                </span>
                <p className="mt-3 font-cabinet text-sm font-bold text-[#102521]">
                  {label as string}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#5e746e]">{copy as string}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-5xl px-5 py-20 sm:px-8">
        {/* Centred, so this keeps its own header rather than SectionIntro, which is a
            left-aligned row built to hold an action beside the title. Sizes are matched to it
            by hand so the two do not look like different systems. */}
        <div className="text-center">
          <p className="font-display text-sm font-bold uppercase tracking-[.2em] text-[#12806d] sm:text-base">
            FAQ
          </p>
          <h2 className="mx-auto mt-2 max-w-2xl text-balance font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
            Booking questions, <span className="text-[#4d7c0f]">answered.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-[#5e746e]">
            Everything you need to know before you choose a court and lock in a game.
          </p>
        </div>
        <div className="mt-10 space-y-3">
          {[
            [
              "Can I cancel my booking?",
              "Yes, when the venue’s cancellation window allows it. Open your booking details to review the venue’s policy and cancel before its stated cutoff time.",
            ],
            [
              "How do refunds work?",
              "Refund eligibility follows the cancellation policy set by each venue. If your booking qualifies, CourtHub records the request and the refund is handled through the venue’s configured payment process.",
            ],
            [
              "Can I pay at the venue?",
              "Some venues accept payment at the venue, while others require the full amount online. The booking panel shows the exact payment requirement before you confirm.",
            ],
            [
              "What sports are supported?",
              "CourtHub supports the sports offered by its partner venues, including badminton, basketball, football, pickleball, tennis, volleyball, and more. Use the sport filter to see what is available near you.",
            ],
            [
              "How do I know my court is reserved?",
              "After you confirm a booking—or complete online payment where required—you’ll receive a booking reference. Your selected hours are then reflected in the court’s live availability.",
            ],
          ].map(([question, answer]) => (
            <details
              key={question}
              className="group overflow-hidden rounded-2xl border border-[#dce8e2] bg-white shadow-sm transition duration-300 hover:border-[#b8f05a] open:border-[#12806d]/40 open:shadow-[0_12px_28px_rgba(16,37,33,0.08)]"
            >
              <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 marker:content-none">
                {/* A lime rail that only exists when the item is open — a quiet position
                    marker in a stack of otherwise identical rows. */}
                <span className="h-8 w-1 shrink-0 rounded-full bg-transparent transition-colors duration-300 group-open:bg-[#b8f05a]" />
                <span className="flex-1 font-cabinet text-base font-bold text-[#0b3d35] transition-colors duration-300 group-hover:text-[#12806d] sm:text-lg">
                  {question}
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eff5ed] text-[#12806d] transition duration-300 group-hover:bg-[#eaf5d8] group-open:rotate-180 group-open:bg-[#b8f05a] group-open:text-[#102521]">
                  <ChevronDown className="h-4 w-4" />
                </span>
              </summary>
              <p className="ml-5 max-w-3xl border-t border-[#e9f2e5] py-4 pl-5 pr-5 text-sm leading-relaxed text-[#5e746e]">
                {answer}
              </p>
            </details>
          ))}
        </div>

        {/* Somewhere to go when the list did not cover it, rather than ending on a dead stop. */}
        <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[#aac2b8] bg-[#f6f8f7] px-5 py-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="font-cabinet text-sm font-bold text-[#102521]">Still have a question?</p>
            <p className="mt-0.5 text-[11px] text-[#5e746e]">
              Send it over and we will come back to you.
            </p>
          </div>
          <a
            href="#contact"
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#0b3d35] px-4 py-2.5 font-cabinet text-xs font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#126152]"
          >
            Contact us <ChevronRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </section>

      <section id="contact" data-nav="Contact" className="bg-[#e9f2e5] py-20">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-[.85fr_1.15fr] lg:items-start">
          <div>
            <SectionIntro
              eyebrow="Contact"
              title="Let’s get more people playing."
              highlight="playing."
            />
            <p className="mt-4 max-w-md leading-relaxed text-[#5e746e]">
              Questions about booking, venues, or becoming a CourtHub partner? Our team is ready to
              help.
            </p>

            {/* Cards rather than a bare list: each channel gets an icon, a label for what it
                is, and the value — scannable instead of three lines that all look alike. */}
            <div className="mt-8 space-y-3">
              {[
                { Icon: Mail, label: "Email us", value: "hello@courthub.ph", href: "mailto:hello@courthub.ph" },
                { Icon: Phone, label: "Call us", value: "+63 000 000 0000", href: null },
                { Icon: Clock3, label: "Office hours", value: "Mon – Fri, 9:00 AM – 6:00 PM", href: null },
              ].map(({ Icon, label, value, href }) => {
                const body = (
                  <>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eaf5d8] text-[#12806d] transition group-hover:bg-[#b8f05a] group-hover:text-[#102521]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10px] font-bold uppercase tracking-[.14em] text-[#5e746e]">
                        {label}
                      </span>
                      <span className="mt-0.5 block truncate font-cabinet text-sm font-bold text-[#102521]">
                        {value}
                      </span>
                    </span>
                  </>
                );
                const className =
                  "group flex items-center gap-3 rounded-2xl border border-[#dce8e2] bg-white p-3.5 transition duration-300 hover:-translate-y-0.5 hover:border-[#b8f05a] hover:shadow-md";
                return href ? (
                  <a key={label} href={href} className={className}>
                    {body}
                  </a>
                ) : (
                  <div key={label} className={className}>
                    {body}
                  </div>
                );
              })}
            </div>

            <div className="mt-6">
              <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#5e746e]">
                Follow along
              </p>
              {/* Buttons, not anchors: these pointed at #contact, so clicking them jumped the
                  reader back to the section they were already in. They say what they are. */}
              <div className="mt-2 flex items-center gap-2">
                {[
                  { name: "Facebook", Icon: Facebook },
                  { name: "Instagram", Icon: Instagram },
                  { name: "TikTok", Icon: Music2 },
                ].map(({ name, Icon }) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => noteSocialSoon(name)}
                    aria-label={`${name} — coming soon`}
                    className="rounded-full border border-[#dce8e2] bg-white p-2.5 text-[#0b3d35] transition hover:-translate-y-0.5 hover:border-[#b8f05a] hover:text-[#12806d]"
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
                <span
                  className={`text-[11px] font-semibold text-[#12806d] transition-opacity duration-200 ${
                    socialSoon ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {socialSoon} coming soon
                </span>
              </div>
            </div>
          </div>

          <form
            className="overflow-hidden rounded-3xl border border-[#dce8e2] bg-white shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setContactNotice(true);
            }}
          >
            <div className="relative overflow-hidden bg-[#09231f] px-5 py-5 text-white sm:px-7">
              <span className="absolute -right-10 -top-14 h-36 w-36 rounded-full bg-[#b8f05a]/20 blur-3xl" />
              <p className="relative text-[10px] font-bold uppercase tracking-[.18em] text-[#b8f05a]">
                Send a message
              </p>
              <h3 className="relative mt-1 font-cabinet text-xl font-bold tracking-tight">
                Tell us what you need
              </h3>
            </div>

            <div className="p-5 sm:p-7">
              <div className="grid gap-4 sm:grid-cols-2">
                <LandingInput label="Name" placeholder="Your name" />
                <LandingInput label="Email" placeholder="you@example.com" type="email" />
              </div>
              <LandingInput label="Subject" placeholder="How can we help?" />
              <label className="mt-4 block text-sm font-bold">
                Message
                <textarea
                  className="mt-2 min-h-32 w-full rounded-xl border border-[#d8e4df] bg-[#fbfcfb] px-3 py-2.5 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                  placeholder="Tell us a little more"
                  required
                />
              </label>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button className="inline-flex items-center gap-2 rounded-full bg-[#0b3d35] px-5 py-3 font-cabinet text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-[#126152]">
                  Send message <ChevronRight className="h-4 w-4" />
                </button>
                {contactNotice && (
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-[#12806d]">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Not connected yet — email{" "}
                    <a href="mailto:hello@courthub.ph" className="underline">
                      hello@courthub.ph
                    </a>
                  </span>
                )}
              </div>
            </div>
          </form>
        </div>

        {/* Outside the two-column grid so the rally gets the section's full width — the ball
            needs a long run for the travel to read as a rally rather than a nudge. */}
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <PaymentRally />
        </div>
      </section>

      <section className="relative isolate overflow-hidden bg-[#09231f] px-5 py-20 text-center text-white sm:px-8">
        <img
          src={heroImages[2]}
          alt=""
          className="absolute inset-0 -z-10 h-full w-full object-cover opacity-25"
          loading="lazy"
        />
        <div className="absolute inset-0 -z-10 bg-[#09231f]/75" />
        {/* Decorative badge held clear of the right edge — inset rather than bled off, so
            the disc reads whole. It comes after the tint so it paints on top of it — same
            -z-10, so DOM order decides — while staying behind the copy. Shown from md up,
            where the centred text leaves room beside it. */}
        <img
          src="/courthub-badge.png"
          alt=""
          loading="lazy"
          className="pointer-events-none absolute right-6 top-1/2 -z-10 hidden h-64 w-64 -translate-y-1/2 opacity-25 md:block lg:right-16 lg:h-80 lg:w-80"
        />
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">
          Ready when you are
        </p>
        <h2 className="mt-3 font-display text-5xl font-bold tracking-tight">Ready to play?</h2>
        <p className="mx-auto mt-4 max-w-lg text-white/70">
          Reserve your next court in minutes with CourtHub.
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <button
            type="button"
            onClick={startBooking}
            className="rounded-full bg-[#b8f05a] px-5 py-3 font-bold text-[#102521]"
          >
            Book now
          </button>
          <Link
            to="/explore"
            search={{}}
            className="rounded-full border border-white/30 px-5 py-3 font-bold hover:bg-white/10"
          >
            Browse venues
          </Link>
        </div>
      </section>

      <footer className="bg-[#061a17] px-5 py-8 text-white/65 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-5 sm:flex-row sm:justify-between">
          {/* The favicon mark, not the wordmark: at footer scale the CH monogram stays
              legible where a 4:1 wordmark would either shrink to nothing or dominate. */}
          <div className="flex items-center gap-3">
            <img
              src="/favicon.png"
              alt=""
              width={256}
              height={256}
              className="h-9 w-9 shrink-0 object-contain"
            />
            <span className="text-xs leading-relaxed">
              <span className="block text-white/80">
                © {new Date().getFullYear()} CourtHub. All rights reserved.
              </span>
              <span className="mt-0.5 block text-[11px] text-white/45">
                &times; Digitalization {new Date().getFullYear()}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-5 text-xs font-semibold">
            <Link to="/privacy" className="transition hover:text-[#b8f05a]">
              Privacy
            </Link>
            <span aria-hidden className="h-3 w-px bg-white/15" />
            <Link to="/terms" className="transition hover:text-[#b8f05a]">
              Terms &amp; Conditions
            </Link>
          </div>
        </div>
      </footer>
      {highlightOpen &&
        (() => {
          const category = highlightCategories.find((c) => c.key === highlightOpen.key);
          if (!category) return null;
          const idx =
            ((highlightOpen.idx % category.images.length) + category.images.length) %
            category.images.length;
          const step = (delta: number) =>
            setHighlightOpen((open) => open && { ...open, idx: open.idx + delta });
          return (
            <div
              className="fixed inset-0 z-1400 flex flex-col items-center justify-center gap-4 bg-black/90 p-4 motion-safe:animate-[landing-overlay-in_.2s_ease-out_both]"
              role="dialog"
              aria-modal="true"
              aria-label={`${category.label} highlights`}
              onClick={() => setHighlightOpen(null)}
            >
              <div className="absolute left-4 top-4 flex items-center gap-2">
                <span className="rounded-full bg-[#b8f05a] px-3 py-1 font-cabinet text-[11px] font-bold uppercase tracking-[.1em] text-[#102521]">
                  {category.label}
                </span>
                <span className="text-xs font-semibold text-white/60">
                  {idx + 1} / {category.images.length}
                </span>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setHighlightOpen(null);
                }}
                aria-label="Close highlights"
                className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
              >
                <X className="h-6 w-6" />
              </button>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  step(-1);
                }}
                aria-label="Previous photo"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:left-6"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  step(1);
                }}
                aria-label="Next photo"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:right-6"
              >
                <ChevronRight className="h-6 w-6" />
              </button>

              <img
                src={category.images[idx]}
                alt={`${category.label} highlight ${idx + 1}`}
                className="max-h-[70vh] max-w-full rounded-2xl object-contain"
                onClick={(event) => event.stopPropagation()}
              />

              {/* Thumbnails for the other frames in this category. */}
              <div
                className="flex items-center gap-2"
                onClick={(event) => event.stopPropagation()}
              >
                {category.images.map((src, i) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setHighlightOpen({ key: category.key, idx: i })}
                    aria-label={`Photo ${i + 1}`}
                    className={`h-12 w-16 overflow-hidden rounded-lg ring-2 transition ${
                      i === idx ? "ring-[#b8f05a]" : "ring-white/20 hover:ring-white/50"
                    }`}
                  >
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>

              {/* Where the full sets will live once the accounts are running. Every one of
                  these is a placeholder — none of them navigate anywhere yet, so they say so
                  rather than opening a dead link. */}
              <div
                className="flex flex-col items-center gap-2"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/50">
                  View full highlights on
                </span>
                <div className="flex items-center gap-2">
                  {[
                    { name: "Facebook", Icon: Facebook },
                    { name: "X", Icon: Twitter },
                    { name: "TikTok", Icon: Music2 },
                  ].map(({ name, Icon }) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => noteSocialSoon(name)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-[11px] font-bold text-white/80 transition hover:border-[#b8f05a] hover:bg-white/10 hover:text-white"
                    >
                      <Icon className="h-3.5 w-3.5" /> {name}
                    </button>
                  ))}
                </div>
                <span
                  className={`text-[11px] font-semibold text-[#b8f05a] transition-opacity duration-200 ${
                    socialSoon ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {socialSoon} highlights coming soon
                </span>
              </div>
            </div>
          );
        })()}

      {lightbox && (
        <div
          className="fixed inset-0 z-1300 flex items-center justify-center bg-black/85 p-5"
          role="dialog"
          aria-modal="true"
          aria-label="Highlight preview"
          onClick={() => setLightbox(null)}
        >
          <button
            className="absolute right-5 top-5 rounded-full bg-white/15 p-2 text-white"
            aria-label="Close preview"
          >
            <CloseIcon />
          </button>
          <img
            src={lightbox}
            alt="CourtHub community highlight"
            className="max-h-[85vh] max-w-full rounded-2xl object-contain"
          />
        </div>
      )}
    </div>
  );
}

/** `highlight` is a substring of `title` to pick out in the accent colour.
 *
 *  Note the accent is #4d7c0f, not the brand's #b8f05a. Every section using this sits on a
 *  light ground (#e9f2e5 or white) where the lime measures 1.17:1 — invisible. #4d7c0f is
 *  the same hue family carried down to 4.35:1, which is legible and still reads yellow-green.
 */
/** One of the three featured venues on the landing page.
 *
 *  Deliberately mirrors the /explore tile rather than inventing its own vocabulary: image on
 *  one half auto-advancing on hover, sports as chips with a +N overflow, today's opening
 *  window from the tenant's schedule, and a "from" price derived the same way — minRate over
 *  the court's rate rules and its effective hours, not the raw hourly_rate. A venue that
 *  prices by time of day would otherwise quote two different numbers on two pages.
 */
/** Row shape of the landing featured-venues query. */
type FeaturedVenue = {
  id: number;
  name: string;
  address: string | null;
  images: string[] | null;
  map_emoji: string | null;
  operating_hours: unknown;
  courts:
    | {
        id: number;
        name: string;
        hourly_rate: number;
        rate_rules: unknown;
        operating_hours: unknown;
        inherit_venue_hours: boolean | null;
        sports: { name: string } | null;
      }[]
    | null;
};

function FeaturedVenueCard({
  venue,
  index,
  lit,
  onOpen,
  onBook,
}: {
  venue: FeaturedVenue;
  index: number;
  lit: boolean;
  onOpen: () => void;
  onBook: () => void;
}) {
  const courts = venue.courts ?? [];
  const images = venue.images ?? [];
  const hasMultiple = images.length > 1;
  const [imgIdx, setImgIdx] = useState(0);
  const [imgHover, setImgHover] = useState(false);
  /* Hovering the details half is what reveals the court count and the hint — that half is the
     one that navigates, so the affordance belongs where the click goes. */
  const [detailsHover, setDetailsHover] = useState(false);
  /* Index of the image open in the gallery, or null. Per-card rather than lifted: nothing
     outside this card needs to know, and three cards never have two galleries open. */
  const [gallery, setGallery] = useState<number | null>(null);

  /* Same 1.4s cadence the explore tiles advance at, so the two feel like one product. */
  useEffect(() => {
    if (!imgHover || !hasMultiple) return;
    const id = window.setInterval(() => setImgIdx((i) => i + 1), 1400);
    return () => window.clearInterval(id);
  }, [imgHover, hasMultiple]);

  const lowest = useMemo(() => {
    const rates = courts.map((court) => {
      const hrs = effectiveHours(
        {
          inherit_venue_hours: court.inherit_venue_hours,
          operating_hours: court.operating_hours,
        },
        venue.operating_hours,
      );
      return minRate(Number(court.hourly_rate), normalizeRules(court.rate_rules), hrs);
    });
    return rates.length ? Math.min(...rates) : null;
  }, [courts, venue.operating_hours]);

  const hoursToday = useMemo(() => {
    const week = normalizeHours(venue.operating_hours);
    const window_ = describeWindow(week[HOUR_DAY_KEYS[zonedDayOfWeek(zonedDateISO())]]);
    if (window_ === "Closed") return { label: "Closed today", closed: true };
    if (window_ === "Open 24 hours") return { label: "Open 24 hours", closed: false };
    return { label: window_, closed: false };
  }, [venue.operating_hours]);

  const sports = useMemo(
    () => Array.from(new Set(courts.map((c) => c.sports?.name).filter(Boolean))) as string[],
    [courts],
  );
  const shownSports = sports.slice(0, 2);
  const extraSports = sports.slice(2);
  const idx = images.length ? ((imgIdx % images.length) + images.length) % images.length : 0;

  return (
    <article
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="link"
      tabIndex={0}
      style={{ animationDelay: `${index * 110}ms` }}
      className={`group flex cursor-pointer overflow-hidden rounded-2xl border border-[#dce8e2] bg-white shadow-sm transition duration-300 hover:-translate-y-1.5 hover:border-[#b8f05a] hover:shadow-xl hover:shadow-[#0b3d35]/12 focus:outline-none focus:ring-2 focus:ring-[#12806d] ${
        lit ? "motion-safe:animate-[sport-fade-in-up_.5s_cubic-bezier(0.2,0.8,0.2,1)_both]" : ""
      }`}
    >
      {/* Details half */}
      <div
        className="flex w-1/2 min-w-0 flex-col p-4"
        onMouseEnter={() => setDetailsHover(true)}
        onMouseLeave={() => setDetailsHover(false)}
      >
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-[#eaf5d8] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#4d7c0f]">
          <Star className="h-3 w-3 fill-current" /> Featured venue
        </span>
        <h3 className="mt-2 truncate font-cabinet text-lg font-bold tracking-tight text-[#102521] transition-colors duration-300 group-hover:text-[#12806d]">
          {venue.name}
        </h3>
        <span className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-[#5e746e]">
          <MapPin className="mt-px h-3 w-3 shrink-0" />
          <span className="line-clamp-2">{venue.address}</span>
        </span>
        <span
          className={`mt-2 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            hoursToday.closed
              ? "bg-[#f4e6e6] text-[#8a3d3d]"
              : "bg-[#eff5ed] text-[#12806d]"
          }`}
        >
          <Clock3 className="h-3 w-3" /> {hoursToday.label}
        </span>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {shownSports.map((sport) => (
            <span
              key={sport}
              className="rounded-full border border-[#dce8e2] bg-[#eaf5d8] px-2 py-0.5 font-cabinet text-[10px] font-semibold text-[#12806d]"
            >
              {sport}
            </span>
          ))}
          {extraSports.length > 0 && (
            <span
              title={extraSports.join(", ")}
              className="rounded-full border border-[#dce8e2] bg-white px-2 py-0.5 font-cabinet text-[10px] font-semibold text-[#5e746e]"
            >
              +{extraSports.length}
            </span>
          )}
        </div>

        <div className="mt-auto pt-3">
          {/* Fixed height so revealing this on hover does not shove the price row down. */}
          <div
            className={`h-8 transition-opacity duration-300 ${
              detailsHover ? "opacity-100" : "opacity-0"
            }`}
          >
            <span className="block text-[10px] font-semibold text-[#12806d]">
              {courts.length} {courts.length === 1 ? "court" : "courts"} available
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[#5e746e]">
              <Info className="h-3 w-3 shrink-0" /> Tap here to view more venue details
            </span>
          </div>
          <div className="mt-1 flex items-end justify-between gap-2">
            {/* No fallback copy when a venue has no courts priced yet — an empty slot reads
                better than "View availability" sitting where a price belongs. */}
            <span className="text-[11px] text-[#5e746e]">
              {lowest != null && (
                <>
                  from <b className="text-base font-bold text-[#0b3d35]">₱{lowest.toFixed(0)}</b>
                  <span className="text-[10px]"> /hr</span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onBook();
              }}
              className="shrink-0 rounded-full bg-[#0b3d35] px-3 py-1.5 font-cabinet text-[11px] font-bold text-white transition hover:bg-[#b8f05a] hover:text-[#102521]"
            >
              Book now
            </button>
          </div>
        </div>
      </div>

      {/* Image half */}
      <div
        className="relative w-1/2 shrink-0 overflow-hidden bg-[#0b3d35]"
        onMouseEnter={() => setImgHover(true)}
        onMouseLeave={() => {
          setImgHover(false);
          setImgIdx(0);
        }}
        onClick={(event) => {
          /* Without this the article's own handler fires and navigates to the venue page,
             so the gallery would open and be torn down in the same tick. */
          event.stopPropagation();
          if (images.length > 0) setGallery(idx);
        }}
      >
        {images.length > 0 ? (
          images.map((src, i) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
                i === idx ? "opacity-100" : "opacity-0"
              }`}
            />
          ))
        ) : (
          <span className="flex h-full w-full items-center justify-center text-4xl">
            {venue.map_emoji || "🏟️"}
          </span>
        )}
        {hasMultiple && (
          <span className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
            {images.map((src, i) => (
              <span
                key={src}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i === idx ? "w-3 bg-[#b8f05a]" : "w-1 bg-white/50"
                }`}
              />
            ))}
          </span>
        )}
        {images.length > 0 && (
          <span className="pointer-events-none absolute inset-x-0 top-0 flex justify-end p-2 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <span className="rounded-full bg-[#09231f]/80 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.1em] text-[#d9ff9b] backdrop-blur-sm">
              Click to view photos
            </span>
          </span>
        )}
      </div>

      {/* Gallery. Rendered inside the card but fixed to the viewport, and every control stops
          propagation so nothing here reaches the article's navigate handler underneath. */}
      {gallery !== null && images.length > 0 && (
        <div
          className="fixed inset-0 z-1400 flex items-center justify-center bg-black/90 p-4 motion-safe:animate-[landing-overlay-in_.2s_ease-out_both]"
          role="dialog"
          aria-modal="true"
          aria-label={`${venue.name} photos`}
          onClick={(event) => {
            event.stopPropagation();
            setGallery(null);
          }}
        >
          <span className="absolute left-4 top-4 max-w-[70%] truncate text-sm font-semibold text-white/80">
            {venue.name}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setGallery(null);
            }}
            aria-label="Close photos"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <X className="h-6 w-6" />
          </button>
          {hasMultiple && (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setGallery((g) => ((g ?? 0) - 1 + images.length) % images.length);
                }}
                aria-label="Previous image"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:left-6"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setGallery((g) => ((g ?? 0) + 1) % images.length);
                }}
                aria-label="Next image"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:right-6"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white backdrop-blur">
                {gallery + 1} / {images.length}
              </span>
            </>
          )}
          <img
            src={images[gallery]}
            alt={venue.name}
            className="max-h-full max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </article>
  );
}

function SectionIntro({
  eyebrow,
  title,
  highlight,
  action,
}: {
  eyebrow: string;
  title: string;
  highlight?: string;
  /** Rendered opposite the title. A node rather than a label so the caller decides whether
   *  it is a text link, a button, or nothing — the previous string prop hard-coded both the
   *  destination and the styling here, which only ever suited one section. */
  action?: ReactNode;
}) {
  const cut = highlight ? title.indexOf(highlight) : -1;
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-display text-sm font-bold uppercase tracking-[.2em] text-[#12806d] sm:text-base">
          {eyebrow}
        </p>
        <h2 className="mt-2 max-w-2xl text-balance font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
          {cut >= 0 && highlight ? (
            <>
              {title.slice(0, cut)}
              <span className="text-[#4d7c0f]">{highlight}</span>
              {title.slice(cut + highlight.length)}
            </>
          ) : (
            title
          )}
        </h2>
      </div>
      {action}
    </div>
  );
}

function LandingInput({
  label,
  placeholder,
  type = "text",
}: {
  label: string;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="mt-4 block text-sm font-bold">
      {label}
      <input
        type={type}
        placeholder={placeholder}
        className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-[#fbfcfb] px-3 py-2.5 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
        required
      />
    </label>
  );
}

function VenueList({
  venues,
  activeVenueId,
  onSelectVenue,
  activeVenue,
  listRef,
  priceFilter,
}: {
  venues: ExploreVenue[];
  activeVenueId: number | null;
  onSelectVenue: (id: number | null) => void;
  activeVenue: ExploreVenue | null | undefined;
  listRef: React.RefObject<HTMLDivElement | null>;
  priceFilter: PriceBounds | null;
}) {
  const MAX_VISIBLE = 50;
  const visibleVenues = venues.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, venues.length - MAX_VISIBLE);
  const [listScrolled, setListScrolled] = useState(false);
  const [lightbox, setLightbox] = useState<{ name: string; images: string[]; idx: number } | null>(
    null,
  );
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
          "overflow-hidden border-b-2 border-[#b8f05a]/50 bg-linear-to-br from-[#0f4a40] to-[#09231f] transition-all duration-200 " +
          (listScrolled ? "max-h-0 py-0 opacity-0" : "max-h-16 px-4 py-2 opacity-100")
        }
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 truncate font-display text-[15px] font-extrabold leading-tight tracking-tight text-[#b8f05a]">
            {activeVenue ? activeVenue.name : "Venues"}
          </div>
          <span className="shrink-0 rounded-full bg-[#b8f05a] px-2 py-0.5 text-[10px] font-extrabold tabular-nums text-[#102521] shadow-sm">
            {activeVenue
              ? `${activeVenue.courtCount} ${activeVenue.courtCount === 1 ? "court" : "courts"}`
              : `${venues.length}`}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] font-medium leading-snug tracking-normal text-white/70">
          {activeVenue
            ? "Courts at this venue"
            : hiddenCount > 0
              ? `Showing ${visibleVenues.length} of ${venues.length} · refine to see more`
              : `${venues.length === 1 ? "venue" : "venues"} found on the map`}
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
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{activeVenue.address}</span>
              </div>
              <Link
                to="/venues/$venueId"
                params={{ venueId: String(activeVenue.id) }}
                search={{}}
                className="mt-3 inline-flex items-center rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 transition"
              >
                Open venue page →
              </Link>
            </div>
            <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Courts ({activeVenue.courts.length})
            </div>
            {activeVenue.courts.map((c, i) => (
              <CourtCard
                key={c.id}
                c={c}
                index={i}
                priceFilter={priceFilter}
                onOpenLightbox={(idx) => setLightbox({ name: c.name, images: c.images ?? [], idx })}
              />
            ))}
          </div>
        ) : venues.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No venues match your search.
          </div>
        ) : (
          <div className="space-y-3">
            {visibleVenues.map((v) => (
              <VenueCard
                key={v.id}
                v={v}
                active={v.id === activeVenueId}
                onSelect={() => onSelectVenue(v.id)}
                onOpenLightbox={(idx) => setLightbox({ name: v.name, images: v.images ?? [], idx })}
              />
            ))}
            {hiddenCount > 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card/60 p-3 text-center text-[11px] text-muted-foreground">
                +{hiddenCount} more {hiddenCount === 1 ? "venue" : "venues"} — use search or filters
                to narrow down.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Full-image lightbox — stays on the explore page */}
      {lightbox && lightbox.images.length > 0 && (
        <div
          className="fixed inset-0 z-1400 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <X className="h-6 w-6" />
          </button>
          <div className="absolute left-4 top-4 max-w-[70%] truncate text-sm font-semibold text-white/80">
            {lightbox.name}
          </div>
          {lightbox.images.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(
                    (s) => s && { ...s, idx: (s.idx - 1 + s.images.length) % s.images.length },
                  );
                }}
                aria-label="Previous image"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:left-6"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((s) => s && { ...s, idx: (s.idx + 1) % s.images.length });
                }}
                aria-label="Next image"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:right-6"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white backdrop-blur">
                {lightbox.idx + 1} / {lightbox.images.length}
              </div>
            </>
          )}
          <img
            src={lightbox.images[lightbox.idx]}
            alt={lightbox.name}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function VenueCard({
  v,
  active,
  onSelect,
  onOpenLightbox,
}: {
  v: ExploreVenue;
  active: boolean;
  onSelect: () => void;
  onOpenLightbox: (idx: number) => void;
}) {
  const pinned = v.latitude != null && v.longitude != null;
  const images = v.images ?? [];
  const hasImages = images.length > 0;
  const hasMultiple = images.length > 1;
  const [imgIdx, setImgIdx] = useState(0);
  const idx = ((imgIdx % images.length) + images.length) % images.length;
  const [imgHover, setImgHover] = useState(false);
  const [sportsPopoverOpen, setSportsPopoverOpen] = useState(false);
  const VISIBLE_SPORTS = 2;
  const extraSports = (v.sports ?? []).slice(VISIBLE_SPORTS);

  // Auto-advance the photo strip while the pointer sits over the image half.
  useEffect(() => {
    if (!imgHover || !hasMultiple) return;
    const id = setInterval(() => setImgIdx((i) => i + 1), 1400);
    return () => clearInterval(id);
  }, [imgHover, hasMultiple]);

  // Today's opening window, in the venue's local day. `normalizeHours` treats a
  // missing schedule as open all day, matching the venue detail page.
  const hoursToday = useMemo(() => {
    const week = normalizeHours(v.operatingHours);
    const todayKey = HOUR_DAY_KEYS[zonedDayOfWeek(zonedDateISO())];
    const window = describeWindow(week[todayKey]);
    if (window === "Closed") return { label: "Closed today", closed: true };
    if (window === "Open 24 hours") return { label: "Open 24 hours", closed: false };
    return { label: `Open ${window}`, closed: false };
  }, [v.operatingHours]);

  const activate = () => pinned && onSelect();
  const navigate = useNavigate();

  return (
    <div
      data-vid={v.id}
      className={
        "group flex h-48 w-full flex-row overflow-hidden rounded-2xl text-left transition-all duration-200 " +
        (active
          ? "bg-primary/5 ring-2 ring-primary shadow-lg shadow-primary/10"
          : "bg-card ring-1 ring-border hover:ring-primary/60 hover:shadow-md") +
        (pinned ? "" : " opacity-50")
      }
    >
      {/* Image section — left half, fixed card height so every card matches */}
      <div
        className="relative h-full w-1/2 shrink-0 overflow-hidden bg-muted"
        onMouseEnter={() => setImgHover(true)}
        onMouseLeave={() => {
          setImgHover(false);
          setImgIdx(0);
        }}
      >
        {hasImages ? (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenLightbox(idx);
              }}
              aria-label="View full image"
              className="block h-full w-full cursor-zoom-in"
            >
              <img
                src={images[idx]}
                alt={v.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </button>
            <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent" />
            {hasMultiple && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setImgIdx((i) => i - 1);
                  }}
                  aria-label="Previous image"
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/70"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setImgIdx((i) => i + 1);
                  }}
                  aria-label="Next image"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/70"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <div className="absolute bottom-2 left-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                  {idx + 1}/{images.length}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-primary/10 to-muted text-3xl">
            {v.mapEmoji ?? "🏟️"}
          </div>
        )}

        {/* Hours status — panel pinned to the image's top-left corner */}
        <div className="absolute left-2 top-2">
          <div className="flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:ring-white/10">
            <span
              className={
                "h-1.5 w-1.5 shrink-0 rounded-full " +
                (hoursToday.closed ? "bg-muted-foreground" : "bg-emerald-500")
              }
            />
            <span
              className={
                "whitespace-nowrap text-[10px] font-bold " +
                (hoursToday.closed ? "text-muted-foreground" : "text-foreground")
              }
            >
              {hoursToday.label}
            </span>
          </div>
        </div>

        {/* Court count — solid pill so the number stays legible over any photo */}
        <div className="absolute bottom-2 right-2">
          {v.courtCount > 0 ? (
            <div className="flex items-center gap-1.5 rounded-full bg-white/95 py-1 pl-1 pr-2.5 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:ring-white/10">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-extrabold text-primary-foreground">
                {v.courtCount}
              </span>
              <span className="text-[10px] font-bold text-foreground">
                {v.courtCount === 1 ? "court" : "courts"}
              </span>
            </div>
          ) : (
            <div className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold text-white/80 backdrop-blur-sm">
              No courts yet
            </div>
          )}
        </div>
      </div>

      {/* Content section — right half, brand dark-teal panel with lime accents; every row has a fixed/min height so cards stay uniform */}
      <div className="flex flex-1 flex-col gap-2 overflow-hidden bg-linear-to-br from-[#0f4a40] to-[#09231f] p-3">
        {/* Venue name */}
        <div className="truncate rounded-lg bg-[#b8f05a]/15 px-2.5 py-1.5 font-display text-[13px] font-bold leading-tight text-[#b8f05a] ring-1 ring-[#b8f05a]/25 transition-colors group-hover:text-[#d3ff87]">
          {v.name}
        </div>

        {/* Address */}
        <div className="flex items-start gap-1.5 text-[11px] text-white/65">
          <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-[#b8f05a]" />
          <span className="line-clamp-1">{v.address}</span>
        </div>

        {/* Sports chips — space reserved even when empty, so height never shifts */}
        <div className="flex h-[22px] items-center gap-1 overflow-hidden">
          {v.sports && v.sports.length > 0 && (
            <>
              {v.sports.slice(0, VISIBLE_SPORTS).map((s) => (
                <span
                  key={s}
                  className="shrink-0 whitespace-nowrap rounded-full bg-[#b8f05a]/15 px-2 py-0.5 text-[10px] font-semibold text-[#b8f05a] ring-1 ring-[#b8f05a]/25"
                >
                  {s}
                </span>
              ))}
              {extraSports.length > 0 && (
                <Popover open={sportsPopoverOpen} onOpenChange={setSportsPopoverOpen}>
                  <PopoverTrigger asChild>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        // On a real mouse the hover handlers below already open/close this
                        // (the cursor crosses the badge before the click fires), so letting
                        // the trigger's own click-toggle also run would immediately re-close
                        // what hover just opened. Only touch devices need click-to-toggle —
                        // preventDefault tells the Radix trigger to skip its built-in toggle.
                        const hoverCapable =
                          typeof window !== "undefined" &&
                          window.matchMedia("(hover: hover) and (pointer: fine)").matches;
                        if (hoverCapable) e.preventDefault();
                      }}
                      onMouseEnter={() => setSportsPopoverOpen(true)}
                      onMouseLeave={() => setSportsPopoverOpen(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setSportsPopoverOpen((o) => !o);
                        }
                      }}
                      className="shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70 transition hover:bg-white/20"
                    >
                      +{extraSports.length}
                    </span>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    sideOffset={6}
                    className="w-auto max-w-56 border-[#b8f05a]/25 bg-linear-to-br from-[#0f4a40] to-[#09231f] p-2"
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => setSportsPopoverOpen(true)}
                    onMouseLeave={() => setSportsPopoverOpen(false)}
                  >
                    <div className="flex flex-wrap gap-1">
                      {extraSports.map((s) => (
                        <span
                          key={s}
                          className="whitespace-nowrap rounded-full bg-[#b8f05a]/15 px-2 py-0.5 text-[10px] font-semibold text-[#b8f05a] ring-1 ring-[#b8f05a]/25"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </>
          )}
        </div>

        {/* Bottom bar: distance + price — pinned to the card's bottom edge */}
        <div className="mt-auto flex min-h-[26px] items-center justify-between gap-1.5 border-t border-white/10 pt-2">
          <span className="min-w-0 shrink truncate whitespace-nowrap text-[11px] font-medium text-white/60">
            {v.distanceKm != null
              ? `${v.distanceKm.toFixed(1)} km away`
              : !pinned
                ? "No location"
                : "Available now"}
          </span>
          {v.minRate != null ? (
            <span className="shrink-0 whitespace-nowrap rounded-md bg-[#b8f05a]/15 px-2 py-0.5 text-[11px] font-bold text-[#b8f05a] ring-1 ring-[#b8f05a]/25">
              {v.maxRate != null && v.maxRate > v.minRate
                ? `₱${v.minRate.toFixed(0)}–${v.maxRate.toFixed(0)}/hr`
                : `₱${v.minRate.toFixed(0)}/hr`}
            </span>
          ) : (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-white/40">No courts</span>
          )}
        </div>

        {/* Actions — the only ways in; the card body itself is not clickable */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={activate}
            disabled={!pinned}
            className="flex-1 cursor-pointer rounded-lg bg-[#b8f05a] px-2 py-2 text-center text-[11px] font-extrabold uppercase tracking-wide text-[#102521] shadow-sm transition hover:bg-[#d3ff87] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b8f05a] focus-visible:ring-offset-1 focus-visible:ring-offset-[#09231f]"
          >
            Book Court
          </button>
          <button
            type="button"
            onClick={() =>
              navigate({ to: "/venues/$venueId", params: { venueId: String(v.id) }, search: {} })
            }
            className="flex-1 cursor-pointer rounded-lg bg-[#12806d] px-2 py-2 text-center text-[11px] font-extrabold uppercase tracking-wide text-white ring-1 ring-white/15 transition hover:bg-[#12806d]/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-[#09231f]"
          >
            View Venue
          </button>
        </div>
      </div>
    </div>
  );
}

/** Court tile in the "Courts at this venue" panel — mirrors VenueCard's
 *  split layout: photo on the left half, details and Book Now on the right. */
function CourtCard({
  c,
  index,
  priceFilter,
  onOpenLightbox,
}: {
  c: ExploreCourt;
  index: number;
  priceFilter: PriceBounds | null;
  onOpenLightbox: (idx: number) => void;
}) {
  const images = c.images ?? [];
  const hasImages = images.length > 0;
  const hasMultiple = images.length > 1;
  const lowRate = c.rateMin ?? c.hourly_rate;
  const highRate = c.rateMax ?? c.hourly_rate;
  const showsRange = highRate > lowRate;
  const [imgIdx, setImgIdx] = useState(0);
  const idx = ((imgIdx % images.length) + images.length) % images.length;
  const [imgHover, setImgHover] = useState(false);

  // Same hover-to-advance behaviour as the venue tiles.
  useEffect(() => {
    if (!imgHover || !hasMultiple) return;
    const id = setInterval(() => setImgIdx((i) => i + 1), 1400);
    return () => clearInterval(id);
  }, [imgHover, hasMultiple]);

  return (
    <div className="group flex h-40 w-full flex-row overflow-hidden rounded-2xl bg-card ring-1 ring-border transition-all duration-200 hover:ring-primary/60 hover:shadow-md">
      {/* Image half */}
      <div
        className="relative h-full w-1/2 shrink-0 overflow-hidden bg-muted"
        onMouseEnter={() => setImgHover(true)}
        onMouseLeave={() => {
          setImgHover(false);
          setImgIdx(0);
        }}
      >
        {hasImages ? (
          <>
            <button
              type="button"
              onClick={() => onOpenLightbox(idx)}
              aria-label="View full image"
              className="block h-full w-full cursor-zoom-in"
            >
              <img
                src={images[idx]}
                alt={c.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </button>
            <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent" />
            {hasMultiple && (
              <>
                <button
                  type="button"
                  onClick={() => setImgIdx((i) => i - 1)}
                  aria-label="Previous image"
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/70"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setImgIdx((i) => i + 1)}
                  aria-label="Next image"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/70"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <div className="absolute bottom-2 left-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                  {idx + 1}/{images.length}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-primary/10 to-muted text-3xl">
            {c.mapEmoji ?? "🏟️"}
          </div>
        )}

        {/* Court number — matches the venue tile's corner badge */}
        <div className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white/95 text-[11px] font-extrabold text-foreground shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:ring-white/10">
          {index + 1}
        </div>
      </div>

      {/* Details half — same dark-teal panel and lime accents as the venue tile */}
      <div className="flex flex-1 flex-col gap-2 overflow-hidden bg-linear-to-br from-[#0f4a40] to-[#09231f] p-3">
        <div className="truncate rounded-lg bg-[#b8f05a]/15 px-2.5 py-1.5 font-display text-[13px] font-bold leading-tight text-[#b8f05a] ring-1 ring-[#b8f05a]/25">
          {c.name}
        </div>

        <div className="flex h-[22px] items-center gap-1 overflow-hidden">
          {c.sportName && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-[#b8f05a]/15 px-2 py-0.5 text-[10px] font-semibold text-[#b8f05a] ring-1 ring-[#b8f05a]/25">
              {c.sportName}
            </span>
          )}
        </div>

        <div className="mt-auto flex min-h-[26px] items-center justify-between gap-1.5 border-t border-white/10 pt-2">
          {/* A time-based court shows its whole span plus the hour-by-hour
              breakdown, so "₱20–43/hr" never reads as a flat ₱20. */}
          {showsRange ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[11px] font-medium text-white/70 underline decoration-dotted underline-offset-2 transition hover:text-[#b8f05a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b8f05a]"
                >
                  <Info className="h-3 w-3 shrink-0" />
                  Rate card
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-auto max-w-xs border-[#b8f05a]/25 bg-[#0f4a40] p-2"
              >
                <RateCard
                  baseRate={c.baseRate ?? c.hourly_rate}
                  rules={c.rateRules ?? []}
                  hours={c.openHours ?? null}
                  variant="dark"
                  highlight={priceFilter}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <span className="text-[11px] font-medium text-white/60">rate</span>
          )}
          <span className="shrink-0 whitespace-nowrap rounded-md bg-[#b8f05a]/15 px-2 py-0.5 text-[11px] font-bold text-[#b8f05a] ring-1 ring-[#b8f05a]/25">
            {showsRange
              ? `₱${lowRate.toFixed(0)}–${highRate.toFixed(0)}/hr`
              : `₱${lowRate.toFixed(0)}/hr`}
          </span>
        </div>

        <Link
          to="/courts/$courtId"
          params={{ courtId: String(c.id) }}
          search={{}}
          className="w-full shrink-0 rounded-lg bg-[#b8f05a] px-3 py-2 text-center text-[11px] font-extrabold uppercase tracking-wide text-[#102521] shadow-sm transition hover:bg-[#d3ff87] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b8f05a] focus-visible:ring-offset-1 focus-visible:ring-offset-[#09231f]"
        >
          Book Now →
        </Link>
      </div>
    </div>
  );
}
