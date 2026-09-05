
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { groupBookingSessions, formatDateLabel, formatSessionLabel } from "@/lib/booking-groups";
import { canCancel, canSettleRefund, describeRefund } from "@/lib/booking-actions";
import {
  NON_COUNTING_STATUS_FILTER,
  countByUser,
  isCountableBooking,
  isRepeatCustomer,
} from "@/lib/booking-counts";

import {
  CourtBlockRulesEditor,
  allPairsEnabled,
  ruleKey,
  type RuleCourt,
} from "@/components/CourtBlockRulesEditor";
import { RateRulesEditor } from "@/components/RateRulesEditor";
import { normalizeRules, type RateRule } from "@/lib/court-pricing";
import { OperatingHoursEditor, CourtHoursEditor } from "@/components/OperatingHoursEditor";
import {
  normalizeHours,
  openHoursForDay,
  openHoursForDate,
  effectiveHours,
  fullWeek,
  describeWindow,
  HOUR_DAY_KEYS,
  type DayKey,
  type HoursMap,
} from "@/lib/operating-hours";
import {
  DEFAULT_TIMEZONE,
  addZonedDays,
  zonedDateISO,
  zonedDayBoundsUtc,
  zonedDayOfWeek,
  zonedHour,
} from "@/lib/tz";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { MapPicker } from "@/components/MapPicker";
import { ImageUploader } from "@/components/ImageUploader";
import { EmojiPicker } from "@/components/EmojiPicker";
import { MapInfoButton } from "@/components/MapInfoButton";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { NotificationBell } from "@/components/NotificationBell";
import { MasterSearch } from "@/components/MasterSearch";
import { VenuePicker } from "@/components/VenuePicker";
import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";
import { ProfileSettingsCard } from "@/components/ProfileSettingsCard";
import { UserAvatar } from "@/components/UserAvatar";
import { TENANT_ANCHORS, useTenantSearchEntries, type TenantCourtsTab } from "@/lib/tenant-search";
import type { SearchEntry } from "@/lib/master-search";
import { BookingChat } from "@/components/BookingChat";
import { CancelRefundDialog, type CancelTarget } from "@/components/CancelRefundDialog";
import { HoursConflictDialog, type HoursConflict } from "@/components/HoursConflictDialog";
import { findHoursConflicts } from "@/lib/hours-conflicts";
import { cancelBookingsWithRefund } from "@/lib/refunds.functions";

const chLogo = { url: "/CHicon.png" };
import {
  LayoutDashboard,
  CalendarDays,
  BookOpen,
  LandPlot,
  Users,
  UserCog,
  Receipt,
  Settings as SettingsIcon,
  Menu,
  X,
  Layers,
  MapPin,
  Pencil,
  Trash2,
  Clock,
  AlertTriangle,
  History as HistoryIcon,
  TableProperties,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Search as SearchIcon,
  Save,
  Bookmark,
  TicketPercent,
  LogOut,
  Filter,
  Check,
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  Repeat,
  Wallet,
  Flame,
  Trophy,
  Timer,
  Sparkles,
  CreditCard,
} from "lucide-react";

type SectionKey =
  | "dashboard" | "calendar" | "bookings" | "courts"
  | "customers" | "team" | "transactions" | "vouchers" | "settings";

const NAV: { key: SectionKey; label: string; icon: React.ComponentType<{ className?: string }> }[] =
  [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "calendar", label: "Calendar", icon: CalendarDays },
    { key: "bookings", label: "Bookings", icon: BookOpen },
    { key: "courts", label: "Venues & Courts", icon: LandPlot },
    { key: "customers", label: "Customers", icon: Users },
    { key: "team", label: "Team", icon: UserCog },
    { key: "transactions", label: "Transactions", icon: Receipt },
    { key: "vouchers", label: "Vouchers", icon: TicketPercent },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ];

/** `view` picks which player pane is showing. A search param rather than a separate route so
 *  the whole dashboard — including the tenant side, which ignores it — stays one route with
 *  one auth guard and one data layer. */
const TENANT_SECTIONS = [
  "dashboard", "calendar", "bookings", "courts",
  "customers", "team", "transactions", "vouchers", "settings",
] as const;

const dashboardSearchSchema = z.object({
  view: z.enum(["bookings", "calendar", "favorites", "settings"]).optional().catch("bookings"),
  /* Tenant deep links. A notification about a booking has to land on the booking,
     and the tenant workspace switches panes with React state rather than routes —
     so the link carries the pane, and the Dashboard seeds its state from it. */
  section: z.enum(TENANT_SECTIONS).optional().catch(undefined),
  /** Open the booking's conversation, not just the booking. Set by message links. */
  chat: z.coerce.boolean().optional().catch(undefined),
  /* Set by booking reminders so tapping the notification lands on the booking it is
     about, rather than the top of the workspace. */
  booking: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/dashboard")({
  validateSearch: dashboardSearchSchema,
  component: Dashboard,
});

const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "Asia/Manila", label: "Philippines — Asia/Manila (PHT, UTC+8)" },
  { value: "Asia/Singapore", label: "Singapore — Asia/Singapore (UTC+8)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong — Asia/Hong_Kong (UTC+8)" },
  { value: "Asia/Kuala_Lumpur", label: "Malaysia — Asia/Kuala_Lumpur (UTC+8)" },
  { value: "Asia/Jakarta", label: "Indonesia (WIB) — Asia/Jakarta (UTC+7)" },
  { value: "Asia/Bangkok", label: "Thailand — Asia/Bangkok (UTC+7)" },
  { value: "Asia/Tokyo", label: "Japan — Asia/Tokyo (UTC+9)" },
  { value: "Asia/Seoul", label: "South Korea — Asia/Seoul (UTC+9)" },
  { value: "Asia/Taipei", label: "Taiwan — Asia/Taipei (UTC+8)" },
  { value: "Australia/Sydney", label: "Australia — Australia/Sydney (UTC+10/11)" },
  { value: "UTC", label: "UTC" },
];

const TZ_BOUNDS: {
  tz: string;
  country: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}[] = [
  {
    tz: "Asia/Manila",
    country: "Philippines",
    minLat: 4.5,
    maxLat: 21.5,
    minLng: 116,
    maxLng: 127,
  },
  {
    tz: "Asia/Singapore",
    country: "Singapore",
    minLat: 1.15,
    maxLat: 1.5,
    minLng: 103.6,
    maxLng: 104.05,
  },
  {
    tz: "Asia/Hong_Kong",
    country: "Hong Kong",
    minLat: 22.15,
    maxLat: 22.58,
    minLng: 113.83,
    maxLng: 114.44,
  },
  {
    tz: "Asia/Kuala_Lumpur",
    country: "Malaysia",
    minLat: 0.85,
    maxLat: 7.4,
    minLng: 99.6,
    maxLng: 119.3,
  },
  {
    tz: "Asia/Jakarta",
    country: "Indonesia (WIB)",
    minLat: -8.8,
    maxLat: 6.1,
    minLng: 95,
    maxLng: 141,
  },
  {
    tz: "Asia/Bangkok",
    country: "Thailand",
    minLat: 5.6,
    maxLat: 20.5,
    minLng: 97.3,
    maxLng: 105.7,
  },
  { tz: "Asia/Tokyo", country: "Japan", minLat: 24, maxLat: 45.6, minLng: 122.9, maxLng: 146 },
  {
    tz: "Asia/Seoul",
    country: "South Korea",
    minLat: 33,
    maxLat: 38.7,
    minLng: 124.5,
    maxLng: 131,
  },
  {
    tz: "Asia/Taipei",
    country: "Taiwan",
    minLat: 21.8,
    maxLat: 25.4,
    minLng: 119.3,
    maxLng: 122.1,
  },
  {
    tz: "Australia/Sydney",
    country: "Australia",
    minLat: -44,
    maxLat: -10,
    minLng: 112,
    maxLng: 154,
  },
];

const PH_BOUNDS = TZ_BOUNDS[0];

function suggestTimezone(
  lat: number | null,
  lng: number | null,
): { tz: string; country: string } | null {
  if (lat == null || lng == null) return null;
  for (const b of TZ_BOUNDS) {
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) {
      return { tz: b.tz, country: b.country };
    }
  }
  return null;
}

function isInPhilippines(lat: number | null, lng: number | null): boolean {
  if (lat == null || lng == null) return false;
  return (
    lat >= PH_BOUNDS.minLat &&
    lat <= PH_BOUNDS.maxLat &&
    lng >= PH_BOUNDS.minLng &&
    lng <= PH_BOUNDS.maxLng
  );
}

export type FeeItem = { label: string; amount: number };
type Venue = {
  id: number;
  name: string;
  address: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  images: string[] | null;
  map_emoji: string | null;
  created_at?: string | null;
  is_active?: boolean;
  amenities?: string[] | null;
  food_beverages?: string[] | null;
  facility_services?: string[] | null;
  fees?: FeeItem[] | null;
  fees_notes?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  operating_hours?: unknown;
  operating_hours_text?: string | null;
  refund_cutoff_hours?: number | null;
  cancellation_notes?: string | null;
  rules?: string | null;
};

const ACTIVE_INFO_TEXT =
  "A venue can only be set inactive when none of its courts have upcoming or in-progress confirmed bookings. If bookings exist, wait until their end time passes. Any pending (awaiting-payment) bookings will be automatically cancelled and those players will be notified to pick another venue. Inactive venues are hidden from the landing page map and list.";
type Sport = { id: number; name: string; slug?: string };
type Court = {
  id: number; name: string; hourly_rate: number; is_indoor: boolean;
  sport_id: number; venue_id: number;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  blocked_hours: Record<string, number[]> | null;
  blocked_dates: Record<string, number[]> | null;
  operating_hours?: Record<string, string> | null;
  inherit_venue_hours?: boolean | null;
  coming_soon: boolean | null;
  is_active?: boolean | null;
  map_emoji: string | null;
  physical_court_id: number;
  capacity: number;
  created_at?: string | null;
  voucher_enabled?: boolean | null;
  surface_type?: string | null;
  player_capacity?: number | null;
  rate_rules?: unknown;
  sports: { name: string; slug?: string } | null;
};
type PhysicalCourt = {
  id: number;
  venue_id: number;
  name: string;
  map_emoji: string | null;
  description: string | null;
};

function CourtStatusField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-end gap-1.5 pb-2 text-sm">
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-primary" />
        <span className="whitespace-nowrap">Active</span>
      </label>
      <span className="group relative inline-flex">
        <span
          tabIndex={0}
          aria-label="Court status help"
          className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-border text-[10px] font-bold leading-none text-muted-foreground"
        >
          ?
        </span>
        <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-2.5 text-[11px] leading-relaxed text-popover-foreground shadow-lg group-hover:block group-focus-within:block">
          <b>Active</b> courts are visible to players and open for booking.
          <br />
          You can set a court to <b>Inactive</b> only when it has no upcoming bookings or scheduled sessions. If bookings still exist, deactivation is blocked — cancel them or wait until they finish first.
        </span>
      </span>
    </div>
  );
}

const DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
];

import { PlayerWorkspace } from "@/components/player/PlayerWorkspace";
/* Shared with the player calendar — see the note in the module. */
import { sportStyle } from "@/lib/sport-colors";

function Dashboard() {
  const { user } = Route.useRouteContext() as {
    user: { id: string; email?: string; user_metadata?: { role?: unknown; full_name?: unknown } };
  };
  const qc = useQueryClient();
  /* Which player pane is showing. The tenant side ignores it — see the note on
     validateSearch for why both roles share one route. */
  const search = Route.useSearch();
  const [section, setSection] = useState<SectionKey>(search.section ?? "dashboard");
  /* Not just the initial value: clicking a second notification while the dashboard is
     already open changes the search param without remounting, and the pane has to
     follow it. */
  useEffect(() => {
    if (search.section) setSection(search.section);
  }, [search.section]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [createVenueOpen, setCreateVenueOpen] = useState(false);
  const [addCourtOpen, setAddCourtOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  /* Lifted out of VenuesCourtsTabs so a search result can open a specific tab. The
     tabs themselves still switch it the same way they always did. */
  const [courtsTab, setCourtsTab] = useState<TenantCourtsTab>("venues");
  const [searchQuery, setSearchQuery] = useState("");

  const profileQ = useQuery({
    queryKey: ["profile", user.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const venuesQ = useQuery({
    queryKey: ["my-venues", user.id],
    queryFn: async () => {
      const { data: staffRows, error: se } = await supabase
        .from("staff")
        .select("venue_id")
        .eq("user_id", user.id);
      if (se) throw se;
      const ids = (staffRows ?? []).map((r) => r.venue_id);
      if (ids.length === 0) return [] as Venue[];
      const { data, error } = await supabase
        .from("venues")
        .select("*")
        .in("id", ids)
        .order("id", { ascending: false });
      if (error) throw error;
      return data as Venue[];
    },
  });

  // Read from metadata up front — it's on the route context synchronously, before
  // profileQ resolves, so the sidebar shows a name on the very first paint instead of
  // popping in once the query settles.
  const metadataName =
    typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";
  const fullName = profileQ.data?.full_name ?? metadataName;
  /* Read before the loading gate below narrows `profileQ.data` away. */
  const avatarUrl = profileQ.data?.avatar_url ?? null;

  /* Above the loading gate below: this is a hook, and the gate returns early. */
  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  }, []);
  const searchVenues = useMemo(() => venuesQ.data ?? [], [venuesQ.data]);
  const searchActions = useMemo(
    () => ({
      setSection,
      setCourtsTab,
      openCreateVenue: () => setCreateVenueOpen(true),
      openAddCourt: () => setAddCourtOpen(true),
      openCreateGroup: () => setCreateGroupOpen(true),
      onSignOut: () => {
        void signOut();
      },
    }),
    [signOut],
  );
  const { entries: searchEntries, loading: searchLoading } = useTenantSearchEntries({
    query: searchQuery,
    venues: searchVenues,
    actions: searchActions,
  });
  const shellSearch = {
    query: searchQuery,
    setQuery: setSearchQuery,
    entries: searchEntries,
    loading: searchLoading,
  };

  if (profileQ.isLoading) {
    return (
      <TenantShell
        userId={user.id}
        section={section}
        setSection={setSection}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        fullName={fullName}
        avatarUrl={avatarUrl}
        onSignOut={signOut}
        search={shellSearch}
      >
        <Skeleton />
      </TenantShell>
    );
  }
  // The profile trigger normally creates this row as part of sign-up. Use the
  // signed-in user's metadata for the first render as well, so a newly created
  // tenant is never shown the player workspace while that row is propagating.
  const metadataRole = user.user_metadata?.role === "tenant" ? "tenant" : "player";
  const role = profileQ.data?.role === "tenant" ? "tenant" : metadataRole;

  if (role !== "tenant") {
    return (
      <PlayerWorkspace
        userId={user.id}
        fullName={fullName}
        email={user.email ?? ""}
        avatarUrl={profileQ.data?.avatar_url ?? null}
        view={search.view ?? "bookings"}
        focusBookingId={search.booking}
        openChatOnArrival={search.chat}
      />
    );
  }

  const venues = venuesQ.data ?? [];
  const loadingVenues = venuesQ.isLoading;

  return (
    <TenantShell
      userId={user.id}
      section={section}
      setSection={setSection}
      mobileOpen={mobileOpen}
      setMobileOpen={setMobileOpen}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      fullName={fullName}
      avatarUrl={avatarUrl}
      onSignOut={signOut}
      search={shellSearch}
    >
      {section === "dashboard" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <DashboardOverview venues={venues} loading={loadingVenues} setSection={setSection} />
        </div>
      )}
      {section === "courts" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <SectionHeader title="Venues & Courts" subtitle="Manage your venues and courts." />
          <VenuesCourtsActions
            hasVenues={venues.length > 0}
            onCreateVenue={() => setCreateVenueOpen(true)}
            onAddCourt={() => setAddCourtOpen(true)}
            onCreateGroup={() => setCreateGroupOpen(true)}
          />
          <VenuesCourtsGlance venues={venues} />

          {loadingVenues ? (
            <Skeleton />
          ) : venues.length === 0 ? (
            <EmptyState
              title="No venues yet"
              body="Create your first venue to start adding courts and taking bookings."
              cta={
                <button
                  onClick={() => setCreateVenueOpen(true)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  + Create venue
                </button>
              }
            />
          ) : (
            <div id="add-court-anchor" className="flex min-h-0 flex-1 flex-col">
              <VenuesCourtsTabs venues={venues} tab={courtsTab} setTab={setCourtsTab} />
            </div>
          )}

          <CreateVenueDrawer
            open={createVenueOpen}
            onClose={() => setCreateVenueOpen(false)}
            onCreated={() => {
              qc.invalidateQueries({ queryKey: ["my-venues"] });
              setCreateVenueOpen(false);
            }}
          />
          <AddCourtDrawer
            open={addCourtOpen}
            onClose={() => setAddCourtOpen(false)}
            venues={venues}
            onCreated={() => {
              [
                "my-venues",
                "venues-courts-glance",
                "venues-court-counts",
                "all-tenant-courts",
                "venues-courts-table",
                "courts",
                "group-eligible-courts",
                "physical-courts-full",
                "physical-courts",
                "venues-group-counts",
              ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
              setAddCourtOpen(false);
            }}
          />
          <CreateGroupDrawer
            open={createGroupOpen}
            onClose={() => setCreateGroupOpen(false)}
            venues={venues}
            onCreated={() => {
              [
                "physical-courts-full",
                "physical-courts",
                "tenant-venues-full",
                "venues-group-counts",
                "group-eligible-courts",
                "all-tenant-courts",
                "court-block-rules",
              ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
              setCreateGroupOpen(false);
            }}
          />
        </div>
      )}
      {section === "calendar" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <CalendarSection venues={venues} />
        </div>
      )}
      {section === "bookings" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <BookingsSection
            venues={venues}
            userId={user.id}
            focusBookingId={search.booking}
            openChat={search.chat}
          />
        </div>
      )}
      {section === "customers" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <CustomersSection venues={venues} />
        </div>
      )}
      {section === "team" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <ComingSoon
            title="Team"
            body="Invite staff, assign roles and manage permissions per venue."
          />
        </div>
      )}
      {section === "transactions" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <TransactionsSection venues={venues} />
        </div>
      )}
      {section === "vouchers" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <VouchersSection venues={venues} />
        </div>
      )}
      {section === "settings" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <SettingsSection
            fullName={profileQ.data?.full_name ?? ""}
            email={user.email ?? ""}
            role={profileQ.data?.role ?? "tenant"}
            userId={user.id}
            avatarUrl={avatarUrl}
            onSaved={() => qc.invalidateQueries({ queryKey: ["profile", user.id] })}
          />
        </div>
      )}
    </TenantShell>
  );
}

function TenantShell({
  children,
  section,
  setSection,
  mobileOpen,
  setMobileOpen,
  collapsed,
  setCollapsed,
  userId,
  fullName,
  avatarUrl,
  onSignOut,
  search,
}: {
  children: React.ReactNode;
  section: SectionKey;
  setSection: (s: SectionKey) => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  userId?: string;
  fullName?: string;
  avatarUrl?: string | null;
  onSignOut?: () => void;
  /* Built by Dashboard, which owns the state a result has to act on. */
  search: {
    query: string;
    setQuery: (v: string) => void;
    entries: SearchEntry[];
    loading: boolean;
  };
}) {
  const current = NAV.find((n) => n.key === section);
  /* Both bars share one query; only one of them is ever on screen. */
  const searchField = (compact: boolean) => (
    <MasterSearch
      value={search.query}
      onValueChange={search.setQuery}
      entries={search.entries}
      loading={search.loading}
      compact={compact}
      storageKey="courthub:master-search:tenant"
      placeholder="Search venues, courts, pages…"
    />
  );
  return (
    <div className="flex h-dvh w-full">
      {/* Desktop sidebar */}
      <aside
        className={
          "sticky top-0 hidden shrink-0 self-start border-r-2 border-[#b8f05a]/40 bg-linear-to-b from-[#0f4a40] to-[#09231f] text-white md:flex md:h-dvh md:flex-col transition-[width] duration-200 " +
          (collapsed ? "md:w-16" : "md:w-62.5")
        }
      >
        <SidebarBody
          section={section}
          setSection={setSection}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          fullName={fullName}
          avatarUrl={avatarUrl}
          onSignOut={onSignOut}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-1200 md:hidden">
          <button
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-62.5 flex-col border-r-2 border-[#b8f05a]/40 bg-linear-to-b from-[#0f4a40] to-[#09231f] text-white shadow-xl">
            <SidebarBody
              section={section}
              setSection={(s) => {
                setSection(s);
                setMobileOpen(false);
              }}
              collapsed={false}
              setCollapsed={() => {}}
              onClose={() => setMobileOpen(false)}
              fullName={fullName}
              avatarUrl={avatarUrl}
              onSignOut={onSignOut}
            />
          </aside>
        </div>
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="relative flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-2 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium"
          >
            <Menu className="h-4 w-4" /> Menu
          </button>
          <span className="truncate text-sm font-semibold">{current?.label ?? "Dashboard"}</span>
          <div className="flex shrink-0 items-center gap-2">
            {searchField(true)}
            <NotificationBell userId={userId} />
          </div>
        </div>
        {/* Desktop top bar */}
        <div className="hidden items-center justify-end gap-2 border-b border-border bg-background px-6 py-2 md:flex">
          {searchField(false)}
          <NotificationBell userId={userId} />
        </div>

        <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col overflow-hidden px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarBody({
  section,
  setSection,
  collapsed,
  setCollapsed,
  onClose,
  fullName,
  avatarUrl,
  onSignOut,
}: {
  section: SectionKey;
  setSection: (s: SectionKey) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  onClose?: () => void;
  fullName?: string;
  avatarUrl?: string | null;
  onSignOut?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The rail collapses to 64px, where a 4:1 wordmark would sit ~15px tall and
              stop being readable — the circle icon stands in for it at that width. */}
          {collapsed ? (
            <img
              src={chLogo.url}
              alt="CourtHub"
              className="h-7 w-7 shrink-0 rounded-full object-contain"
            />
          ) : (
            <span className="logo-glaze shrink-0">
              <img
                src="/courthub-wordmark.png"
                alt="CourtHub"
                width={983}
                height={240}
                className="h-7 w-auto object-contain"
              />
            </span>
          )}
        </div>
        {onClose ? (
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-[#b8f05a]"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden rounded-md p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-[#b8f05a] md:inline-flex"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {NAV.map(({ key, label, icon: Icon }) => {
            const active = section === key;
            return (
              <li key={key}>
                <button
                  onClick={() => setSection(key)}
                  title={collapsed ? label : undefined}
                  className={
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
                    (active
                      ? "bg-[#b8f05a] text-[#102521] shadow-sm"
                      : "text-white/75 hover:bg-white/10 hover:text-[#b8f05a]")
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* Sitting in the rail's footer, this is the same affordance the player rail
          offers — signing out should not cost a trip through Settings. */}
      <div className="mt-auto border-t border-white/10 p-2">
        <button
          onClick={onSignOut}
          title={collapsed ? "Sign out" : undefined}
          aria-label="Sign out"
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">Sign out</span>}
        </button>
      </div>
      {!collapsed ? (
        <div className="border-t border-white/10 px-3 py-3.5">
          <span
            className="logo-glaze"
            style={{ "--logo-glaze-src": "url(/role-tenant.png)" } as CSSProperties}
          >
            <img src="/role-tenant.png" alt="" className="h-8 w-auto object-contain" />
          </span>
          {/* Picture before the name — the same shape the player rail uses. This is
              the signed-in staff member, not the venue. */}
          <div className="mt-2 flex items-center gap-2.5">
            <UserAvatar
              avatarUrl={avatarUrl}
              fullName={fullName}
              className="h-8 w-8"
              fallback="V"
            />
            <span className="min-w-0 flex-1 truncate font-display text-sm font-bold tracking-tight text-white">
              {fullName || "Venue manager"}
            </span>
          </div>
        </div>
      ) : (
        /* 64px of rail leaves no room for a name, but the picture still reads. */
        <div className="border-t border-white/10 px-3 py-3.5">
          <UserAvatar
            avatarUrl={avatarUrl}
            fullName={fullName}
            className="mx-auto h-9 w-9"
            fallback="V"
            title={fullName || "Venue manager"}
          />
        </div>
      )}
    </>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Tenant workspace</p>
      <h1 className="mt-1 font-display text-2xl font-semibold sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function ComingSoon({ title, body }: { title: string; body: string }) {
  return (
    <>
      <SectionHeader title={title} />
      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
        <p className="text-sm text-muted-foreground">{body}</p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-primary">
          Coming soon
        </p>
      </div>
    </>
  );
}

/* ── Dashboard analytics ────────────────────────────────────────────────────
   Colours are computed against the card surface (#ffffff — this app has no dark
   mode wired), never picked by eye. The brand teal #12806d measures OKLCH chroma
   0.096, just under the 0.10 floor below which a hue reads as grey once it is a
   2px line, so the series step is that same hue with the chroma corrected to
   0.102: indistinguishable as a brand colour, legible as a mark. */
const VIZ = {
  series: "#00846f", // L .545 C .102 — 4.64:1 on white
  trend: "#005647", // same hue, darker: the smoothed line reads as a summary of the series
  up: "#006300",
  down: "#d03b3b",
  pending: "#fab219",
} as const;

/* Sequential ramp for the heatmap: one hue, lightness stepping ~.08 a time so
   neighbouring buckets stay apart. Sequential rather than ordinal — the lightest
   step is allowed to recede into the surface, because "nearly empty" is exactly
   what an idle hour should look like. Index 0 is the true zero. */
const HEAT_RAMP = [
  "#f2f6f5",
  "#d8ede7",
  "#b5d8cf",
  "#91c2b5",
  "#6bac9c",
  "#419684",
  "#00806c",
  "#006a55",
] as const;

const DAY_RANGES = [7, 30, 90] as const;

/** A reporting period is either a rolling window of days or a calendar year.
 *  Generalised from the plain day count it started as, so a tenant can report on
 *  a year without a second control competing with this one over the same page. */
type PeriodKey = `d${number}` | `y${number}`;

type Period = {
  key: PeriodKey;
  /** Inclusive venue-local dates. */
  startISO: string;
  endISO: string;
  prevStartISO: string;
  prevEndISO: string;
  days: number;
  /** "the last 30 days" / "2026" — reads inside a sentence. */
  label: string;
  /** "30 days" / "2026" — reads on a button. */
  shortLabel: string;
  compareLabel: string;
};

const daysBetween = (fromISO: string, toISO: string) =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000) +
  1;

function resolvePeriod(key: PeriodKey, tz: string): Period {
  const todayISO = zonedDateISO(new Date(), tz);
  if (key.startsWith("y")) {
    const year = Number(key.slice(1));
    const startISO = `${year}-01-01`;
    const lastDay = `${year}-12-31`;
    /* The current year stops at today rather than running on to December, so the
       figure is year-to-date and the comparison below is like for like. */
    const endISO = lastDay > todayISO ? todayISO : lastDay;
    const days = daysBetween(startISO, endISO);
    const prevStartISO = `${year - 1}-01-01`;
    return {
      key,
      startISO,
      endISO,
      prevStartISO,
      /* Matched by span, not by calendar, so a part-year compares against the same
         number of days a year earlier and a leap day cannot skew the delta. */
      prevEndISO: addZonedDays(prevStartISO, days - 1),
      days,
      label: String(year),
      shortLabel: String(year),
      compareLabel: String(year - 1),
    };
  }
  const n = Number(key.slice(1));
  const startISO = addZonedDays(todayISO, -(n - 1));
  const prevEndISO = addZonedDays(startISO, -1);
  return {
    key,
    startISO,
    endISO: todayISO,
    prevStartISO: addZonedDays(prevEndISO, -(n - 1)),
    prevEndISO,
    days: n,
    label: `the last ${n} days`,
    shortLabel: `${n} days`,
    compareLabel: `the ${n} days before`,
  };
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const peso = (n: number) =>
  "₱" + Math.round(n).toLocaleString("en-PH", { maximumFractionDigits: 0 });

/** 1,284 / 12.9K / 1.4M — stat tiles get compact figures so a good month does not
 *  reflow the row. Full precision stays in the tooltip and the panels below. */
function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString("en-PH");
}

/** Percentage change, or null when there is no baseline to compare against —
 *  a first month of trading has no "vs previous" and must not claim +100%. */
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** Centred-right moving average: each point is the mean of the trailing `window`
 *  days. Short ranges get a shorter window — a 7-day mean over 7 days of data is
 *  one flat line and says nothing. */
function movingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let k = i - window + 1; k <= i; k++) sum += values[k];
    return sum / window;
  });
}

type DayPoint = { date: string; label: string; revenue: number; bookings: number };
type ScheduleRow = {
  id: number;
  userId: string;
  start: string;
  end: string;
  court: string;
  customer: string;
  status: string;
  paid: string;
};
type BoardRow = { key: string; name: string; sub: string; revenue: number; bookings: number };

function DashboardOverview({
  venues,
  loading,
  setSection,
}: {
  venues: Venue[];
  loading: boolean;
  setSection: (s: SectionKey) => void;
}) {
  const [periodKey, setPeriodKey] = useState<PeriodKey>("d30");
  const tz = venues[0]?.timezone || DEFAULT_TIMEZONE;
  const period = useMemo(() => resolvePeriod(periodKey, tz), [periodKey, tz]);
  const years = useMemo(() => tenantYears(venues, tz), [venues, tz]);
  const [metric, setMetric] = useState<"revenue" | "bookings">("revenue");
  const [chartKind, setChartKind] = useState<"area" | "bar">("area");
  const [board, setBoard] = useState<"courts" | "venues">("courts");
  const [boardSort, setBoardSort] = useState<"revenue" | "bookings">("revenue");

  const venueIds = venues.map((v) => v.id);
  const venueKey = venueIds.join(",");

  const analyticsQ = useQuery({
    queryKey: ["tenant-analytics", venueKey, periodKey],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      /* One venue's timezone stands for the account: bookings are stored as
         instants, and the tenant reads them in the clock their courts run on. */
      const todayISO = zonedDateISO(new Date(), tz);
      /* Two windows are fetched at once — the period on screen and the one before
         it — because every tile states a delta and a second round trip for the
         baseline would make the two halves disagree under a slow network. */
      const windowStartISO = period.prevStartISO;
      const currentStartISO = period.startISO;
      const periodEndISO = period.endISO;
      const fetchFrom = zonedDayBoundsUtc(windowStartISO, tz).start.toISOString();
      /* Only as far as the period runs. Today's schedule and the upcoming count
         both mean "now" whatever period is selected, so they are fetched on their
         own below rather than dragging this window out to today for a past year. */
      const fetchTo = zonedDayBoundsUtc(addZonedDays(periodEndISO, 1), tz).start.toISOString();

      const { data: courtRows, error: courtErr } = await supabase
        .from("courts")
        .select("id, name, venue_id, is_active, inherit_venue_hours, operating_hours")
        .in("venue_id", venueIds);
      if (courtErr) throw courtErr;
      const courts = courtRows ?? [];

      const courtIds = courts.map((c) => c.id);
      const { data: bookingRows, error: bookingErr } = courtIds.length
        ? await supabase
            .from("bookings")
            .select(
              "id, court_id, user_id, start_time, end_time, status, payment_status, refund_status, cancelled_at",
            )
            .in("court_id", courtIds)
            .gte("start_time", fetchFrom)
            .lt("start_time", fetchTo)
            /* Newest first, so if a very large account ever reaches the cap it is
               the oldest baseline days that fall off rather than an arbitrary
               slice of the range being read on screen. */
            .order("start_time", { ascending: false })
            .limit(10000)
        : { data: [], error: null };
      if (bookingErr) throw bookingErr;
      const bookings = bookingRows ?? [];

      /* Revenue is dated by settlement, and a payment can settle well after the row
         was created, so the fetch floor sits a month behind the window it feeds;
         the settled-date filter below is what actually decides the range. */
      const txFloor = zonedDayBoundsUtc(addZonedDays(windowStartISO, -30), tz).start.toISOString();
      const { data: txRows, error: txErr } = await supabase
        .from("transactions")
        .select("amount, status, paid_at, created_at, booking_id, venue_id")
        .in("venue_id", venueIds)
        .gte("created_at", txFloor)
        .order("created_at", { ascending: false })
        .limit(10000);
      if (txErr) throw txErr;
      const txs = txRows ?? [];

      const courtById = new Map(courts.map((c) => [c.id, c]));
      const venueById = new Map(venues.map((v) => [v.id, v]));

      /* ── daily series ──────────────────────────────────────────────────────
         Revenue is dated by settlement and bookings by the session they are for.
         They answer different questions and are deliberately never summed or put
         on one axis together — the toggle shows one at a time, and each subtitle
         says which date it is counting. */
      const dayIndex = new Map<string, number>();
      const days: DayPoint[] = [];
      for (let i = 0; i < period.days; i++) {
        const date = addZonedDays(currentStartISO, i);
        dayIndex.set(date, days.length);
        days.push({
          date,
          label: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PH", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }),
          revenue: 0,
          bookings: 0,
        });
      }

      let revenueCurrent = 0;
      let revenuePrevious = 0;
      for (const t of txs) {
        if (t.status !== "paid") continue;
        const settled = t.paid_at ?? t.created_at;
        if (!settled) continue;
        const date = zonedDateISO(new Date(settled), tz);
        if (date < windowStartISO || date > periodEndISO) continue;
        const amount = Number(t.amount) || 0;
        if (date >= currentStartISO) {
          revenueCurrent += amount;
          const idx = dayIndex.get(date);
          if (idx !== undefined) days[idx].revenue += amount;
        } else {
          revenuePrevious += amount;
        }
      }

      /* ── bookings, occupancy, heatmap, schedule ────────────────────────────
         One pass: every derived figure below reads the same rows, so nothing on
         the page can disagree with anything else on it. */
      const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
      const today: ScheduleRow[] = [];
      const courtAgg = new Map<number, { bookings: number; revenue: number; hours: number }>();
      const venueAgg = new Map<number, { bookings: number; revenue: number }>();
      let bookingsCurrent = 0;
      let bookingsPrevious = 0;
      let bookedHoursCurrent = 0;
      let bookedHoursPrevious = 0;
      let cancelledCurrent = 0;
      let totalCurrent = 0;
      let refundPending = 0;
      let refundDone = 0;
      const scheduleUserIds = new Set<string>();
      let upcoming = 0;
      const nowMs = Date.now();

      for (const b of bookings) {
        const startMs = new Date(b.start_time).getTime();
        const endMs = new Date(b.end_time).getTime();
        const date = zonedDateISO(new Date(b.start_time), tz);
        const cancelled = b.status === "cancelled" || b.cancelled_at != null;
        const live = b.status === "pending" || b.status === "confirmed";
        const hours = Math.max(0, (endMs - startMs) / 3_600_000);
        const inCurrent = date >= currentStartISO && date <= periodEndISO;
        const inPrevious = date >= windowStartISO && date < currentStartISO;

        if (inCurrent) {
          totalCurrent += 1;
          if (cancelled) cancelledCurrent += 1;
          if (b.refund_status === "pending") refundPending += 1;
          if (b.refund_status === "refunded") refundDone += 1;
        }
        /* A cancelled session neither occupied a court nor counts as a booking
           the tenant delivered — it is counted once, in the refunds panel. */
        if (cancelled) continue;

        if (inCurrent) {
          bookingsCurrent += 1;
          bookedHoursCurrent += hours;
          const idx = dayIndex.get(date);
          if (idx !== undefined) days[idx].bookings += 1;
        } else if (inPrevious) {
          bookingsPrevious += 1;
          bookedHoursPrevious += hours;
        }

        if (inCurrent) {
          /* Every hour the session covers, not just the hour it starts — the
             question the heatmap answers is when courts are *occupied*. Capped
             so a malformed row cannot spin here. */
          const steps = Math.min(24, Math.ceil(hours));
          for (let s = 0; s < steps; s++) {
            const at = new Date(startMs + s * 3_600_000);
            heat[zonedDayOfWeek(zonedDateISO(at, tz))][zonedHour(at, tz)] += 1;
          }
          const court = courtById.get(b.court_id);
          const agg = courtAgg.get(b.court_id) ?? { bookings: 0, revenue: 0, hours: 0 };
          agg.bookings += 1;
          agg.hours += hours;
          courtAgg.set(b.court_id, agg);
          if (court) {
            const vAgg = venueAgg.get(court.venue_id) ?? { bookings: 0, revenue: 0 };
            vAgg.bookings += 1;
            venueAgg.set(court.venue_id, vAgg);
          }
        }
      }

      /* ── now, whatever period is being reported on ──────────────────────────
         Today's schedule and the count of what is coming are about the clock, not
         the report. Fetched separately and cheaply — eight days — so selecting a
         past year does not drag the period window forward to today just to answer
         them, and so neither goes blank when it does. */
      const todayBounds = zonedDayBoundsUtc(todayISO, tz);
      const nowFrom = todayBounds.start.toISOString();
      const nowTo = zonedDayBoundsUtc(addZonedDays(todayISO, 8), tz).start.toISOString();
      const { data: nowRows } = courtIds.length
        ? await supabase
            .from("bookings")
            .select("id, court_id, user_id, start_time, end_time, status, payment_status")
            .in("court_id", courtIds)
            .gte("start_time", nowFrom)
            .lt("start_time", nowTo)
            .not("status", "in", NON_COUNTING_STATUS_FILTER)
            .order("start_time", { ascending: true })
            .limit(TENANT_ROW_CAP)
        : { data: [] };
      for (const b of nowRows ?? []) {
        if (!isCountableBooking({ status: b.status, cancelled_at: null })) continue;
        const startMs = new Date(b.start_time).getTime();
        if (startMs >= nowMs && startMs <= nowMs + 7 * 86_400_000) upcoming += 1;
        if (zonedDateISO(new Date(b.start_time), tz) === todayISO) {
          today.push({
            id: b.id,
            userId: b.user_id,
            start: b.start_time,
            end: b.end_time,
            court: courtById.get(b.court_id)?.name ?? `Court ${b.court_id}`,
            customer: "",
            status: b.status,
            paid: b.payment_status,
          });
          scheduleUserIds.add(b.user_id);
        }
      }

      /* Revenue per court needs the booking each payment belongs to; per venue the
         transaction already carries it. Paying today for a session two months out
         is normal here, and that booking sits outside the window fetched above —
         so the few ids still unaccounted for are looked up directly rather than
         widening the whole booking fetch to cover every future session. */
      const courtOfBooking = new Map(bookings.map((b) => [b.id, b.court_id]));
      const unresolved = Array.from(
        new Set(
          txs
            .filter((t) => t.status === "paid" && t.booking_id != null)
            .map((t) => t.booking_id)
            .filter((id) => !courtOfBooking.has(id)),
        ),
      );
      if (unresolved.length) {
        const { data: extra } = await supabase
          .from("bookings")
          .select("id, court_id")
          .in("id", unresolved.slice(0, 1000));
        for (const b of extra ?? []) courtOfBooking.set(b.id, b.court_id);
      }
      for (const t of txs) {
        if (t.status !== "paid") continue;
        const settled = t.paid_at ?? t.created_at;
        const date = settled ? zonedDateISO(new Date(settled), tz) : null;
        if (!date || date < currentStartISO || date > periodEndISO) continue;
        const amount = Number(t.amount) || 0;
        const courtId = courtOfBooking.get(t.booking_id);
        if (courtId !== undefined) {
          const agg = courtAgg.get(courtId) ?? { bookings: 0, revenue: 0, hours: 0 };
          agg.revenue += amount;
          courtAgg.set(courtId, agg);
        }
        const vAgg = venueAgg.get(t.venue_id) ?? { bookings: 0, revenue: 0 };
        vAgg.revenue += amount;
        venueAgg.set(t.venue_id, vAgg);
      }

      if (scheduleUserIds.size) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", Array.from(scheduleUserIds));
        const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? ""]));
        for (const row of today) row.customer = nameById.get(row.userId) || "Guest";
      }
      today.sort((a, b) => a.start.localeCompare(b.start));

      /* ── occupancy ─────────────────────────────────────────────────────────
         Booked hours over the hours the courts were actually open, read from the
         same operating-hours rules the booking flow enforces. A flat "12 hours a
         day" assumption would quietly flatter a venue that opens at noon. */
      const activeCourts = courts.filter((c) => c.is_active !== false);
      const openHoursOver = (fromISO: string, dayCount: number) => {
        let total = 0;
        for (const court of activeCourts) {
          const hours = effectiveHours(court, venueById.get(court.venue_id)?.operating_hours);
          for (let i = 0; i < dayCount; i++) {
            total += openHoursForDate(hours, addZonedDays(fromISO, i)).size;
          }
        }
        return total;
      };
      const capacityCurrent = openHoursOver(currentStartISO, period.days);
      const capacityPrevious = openHoursOver(windowStartISO, period.days);

      const nameOfCourt = (id: number) => courtById.get(id)?.name ?? `Court ${id}`;
      const venueOfCourt = (id: number) =>
        venueById.get(courtById.get(id)?.venue_id ?? -1)?.name ?? "";

      const courtBoard: BoardRow[] = Array.from(courtAgg.entries())
        .map(([id, agg]) => ({
          key: `court-${id}`,
          name: nameOfCourt(id),
          sub: venueOfCourt(id),
          revenue: agg.revenue,
          bookings: agg.bookings,
        }))
        .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);

      const venueBoard: BoardRow[] = Array.from(venueAgg.entries())
        .map(([id, agg]) => ({
          key: `venue-${id}`,
          name: venueById.get(id)?.name ?? `Venue ${id}`,
          sub: `${courts.filter((c) => c.venue_id === id).length} courts`,
          revenue: agg.revenue,
          bookings: agg.bookings,
        }))
        .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);

      return {
        days,
        revenue: { current: revenueCurrent, previous: revenuePrevious },
        bookings: { current: bookingsCurrent, previous: bookingsPrevious },
        occupancy: {
          current: capacityCurrent > 0 ? bookedHoursCurrent / capacityCurrent : 0,
          previous: capacityPrevious > 0 ? bookedHoursPrevious / capacityPrevious : 0,
          measurable: capacityCurrent > 0,
        },
        upcoming,
        heat,
        heatMax: Math.max(1, ...heat.flat()),
        today,
        courtBoard,
        venueBoard,
        cancels: {
          cancelled: cancelledCurrent,
          total: totalCurrent,
          refundPending,
          refundDone,
        },
        courts: courts.length,
        activeCourts: activeCourts.length,
      };
    },
  });

  const a = analyticsQ.data;
  const sparkRevenue = useMemo(() => (a?.days ?? []).map((d) => d.revenue), [a]);
  const sparkBookings = useMemo(() => (a?.days ?? []).map((d) => d.bookings), [a]);

  return (
    <>
      <SectionHeader title="Dashboard" subtitle="Your workspace at a glance." />

      {/* One filter row, above everything it scopes: the tiles, the chart and all
          four panels below re-read the same slice, so no two numbers on this page
          can be describing different windows. Withheld until there is something to
          scope — a range picker over an empty account only asks a dead question. */}
      <div
        className="mb-5 flex flex-wrap items-center gap-3"
        hidden={loading || venues.length === 0}
      >
        <div
          className="inline-flex rounded-lg border border-border bg-card p-0.5"
          role="group"
          aria-label="Date range"
        >
          {DAY_RANGES.map((days) => {
            const key: PeriodKey = `d${days}`;
            return (
              <button
                key={key}
                onClick={() => setPeriodKey(key)}
                aria-pressed={periodKey === key}
                className={
                  "rounded-md px-3 py-1.5 text-sm font-semibold transition " +
                  (periodKey === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {days} days
              </button>
            );
          })}
        </div>
        {/* Years sit in their own select rather than four more buttons: one row of
            controls, and the rolling windows stay one tap apart. */}
        <div className="relative">
          <select
            value={periodKey.startsWith("y") ? periodKey : ""}
            onChange={(e) => e.target.value && setPeriodKey(e.target.value as PeriodKey)}
            aria-label="Reporting year"
            className="appearance-none rounded-lg border border-border bg-card py-1.5 pl-3 pr-9 text-sm font-semibold outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value="">Year…</option>
            {years.map((y) => (
              <option key={y} value={`y${y}`}>
                {y}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        <span className="text-xs text-muted-foreground">compared with {period.compareLabel}</span>
        {analyticsQ.isFetching && !analyticsQ.isPending && (
          <span className="text-xs text-muted-foreground">updating…</span>
        )}
      </div>

      {loading ? (
        <Skeleton />
      ) : venues.length === 0 ? (
        <EmptyState
          title="No venues yet"
          body="Create your first venue to start taking bookings — your revenue, occupancy and busiest hours will appear here."
          cta={
            <button
              onClick={() => setSection("courts")}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Go to Venues & Courts
            </button>
          }
        />
      ) : (
        /* Held at reduced opacity rather than swapped for a skeleton while a new
           range loads: the frame stays put and nothing below jumps. */
        <div
          className={analyticsQ.isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="Revenue"
              value={peso(a?.revenue.current ?? 0)}
              delta={pctChange(a?.revenue.current ?? 0, a?.revenue.previous ?? 0)}
              spark={sparkRevenue}
              icon={<Wallet className="h-4 w-4" />}
              hint={`settled in ${period.label}`}
            />
            <MetricTile
              label="Bookings"
              value={compact(a?.bookings.current ?? 0)}
              delta={pctChange(a?.bookings.current ?? 0, a?.bookings.previous ?? 0)}
              spark={sparkBookings}
              icon={<BookOpen className="h-4 w-4" />}
              hint={`sessions played in ${period.label}`}
            />
            <MetricTile
              label="Occupancy"
              value={
                a?.occupancy.measurable ? Math.round((a?.occupancy.current ?? 0) * 100) + "%" : "—"
              }
              /* Points, not percent-of-a-percent: occupancy is already a rate, and
                 "up 12%" on a rate is the classic misread. */
              deltaPoints={
                a?.occupancy.measurable
                  ? Math.round(((a?.occupancy.current ?? 0) - (a?.occupancy.previous ?? 0)) * 100)
                  : null
              }
              icon={<Flame className="h-4 w-4" />}
              hint={
                a?.occupancy.measurable
                  ? "booked hours ÷ open hours"
                  : "set your operating hours to measure this"
              }
            />
            <MetricTile
              label="Upcoming"
              value={compact(a?.upcoming ?? 0)}
              icon={<Timer className="h-4 w-4" />}
              hint="confirmed in the next 7 days"
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {venues.length} {venues.length === 1 ? "venue" : "venues"} · {a?.courts ?? 0}{" "}
            {a?.courts === 1 ? "court" : "courts"} · {a?.activeCourts ?? 0} active
          </p>

          <TrendChart
            days={a?.days ?? []}
            metric={metric}
            setMetric={setMetric}
            kind={chartKind}
            setKind={setChartKind}
            period={period}
          />

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <PeakHoursHeatmap heat={a?.heat} max={a?.heatMax ?? 1} />
            <TodaySchedule rows={a?.today ?? []} onOpen={() => setSection("bookings")} />
            <Leaderboard
              rows={(board === "courts" ? a?.courtBoard : a?.venueBoard) ?? []}
              board={board}
              setBoard={setBoard}
              sortBy={boardSort}
              setSortBy={setBoardSort}
            />
            <RefundsPanel
              cancels={a?.cancels}
              period={period}
              onOpen={() => setSection("transactions")}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** 12-ish point sparkline. The line sits in a de-emphasised step of the series hue
 *  and only the latest point is picked out, so the tile reads as "shape, then now"
 *  rather than as a second chart competing with the one below. */
function Sparkline({ values }: { values: number[] }) {
  const points = useMemo(() => {
    if (values.length < 2) return [] as number[];
    /* Down-sampled by bucket mean, never by dropping points: a spike that lands on
       a skipped index would vanish from the shape entirely. */
    const target = 12;
    if (values.length <= target) return values;
    const size = values.length / target;
    return Array.from({ length: target }, (_, i) => {
      const from = Math.floor(i * size);
      const to = Math.max(from + 1, Math.floor((i + 1) * size));
      const slice = values.slice(from, to);
      return slice.reduce((s, v) => s + v, 0) / slice.length;
    });
  }, [values]);

  if (points.length < 2) return <div className="h-8" />;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const step = w / (points.length - 1);
  const coords = points.map((v, i) => [i * step, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const d = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={VIZ.series}
        strokeOpacity={0.45}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={2.5} fill={VIZ.series} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Stat tile: label · value · delta against a named period · sparkline.
 *  `delta` is a percentage; `deltaPoints` is for values that are already rates,
 *  where a percentage change of a percentage is the classic misreading. */
function MetricTile({
  label,
  value,
  delta,
  deltaPoints,
  spark,
  icon,
  hint,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaPoints?: number | null;
  spark?: number[];
  icon?: React.ReactNode;
  hint?: string;
}) {
  const shown = delta ?? deltaPoints ?? null;
  const flat = shown !== null && Math.abs(shown) < 0.05;
  const up = shown !== null && shown > 0;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-1 font-display text-3xl font-semibold">{value}</div>
      <div className="mt-1 flex min-h-5 items-center gap-1.5 text-xs">
        {shown === null ? (
          <span className="text-muted-foreground">{hint}</span>
        ) : (
          <>
            {/* The arrow carries the direction as well as the colour — a delta that
                is green only is invisible to a red-green reader. */}
            {flat ? (
              <span className="font-semibold text-muted-foreground">no change</span>
            ) : (
              <span
                className="inline-flex items-center gap-0.5 font-semibold"
                style={{ color: up ? VIZ.up : VIZ.down }}
              >
                {up ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {Math.abs(shown).toFixed(deltaPoints !== undefined && deltaPoints !== null ? 0 : 1)}
                {deltaPoints !== undefined && deltaPoints !== null ? " pts" : "%"}
              </span>
            )}
            <span className="text-muted-foreground">vs previous</span>
          </>
        )}
      </div>
      {spark && spark.length > 1 ? <Sparkline values={spark} /> : <div className="h-8" />}
    </div>
  );
}

/** The analytics graph. One measure at a time behind a toggle — revenue and
 *  bookings share no unit, and putting them on two y-scales is the single most
 *  misread thing a chart can do. The dashed line is the same series smoothed. */
function TrendChart({
  days,
  metric,
  setMetric,
  kind,
  setKind,
  period,
}: {
  days: DayPoint[];
  metric: "revenue" | "bookings";
  setMetric: (m: "revenue" | "bookings") => void;
  kind: "area" | "bar";
  setKind: (k: "area" | "bar") => void;
  period: Period;
}) {
  /* A seven-day mean over a seven-day range is one flat line; short periods get a
     window they can actually move inside, long ones a wider one so a year of daily
     points reads as a trend rather than as noise. */
  const window = period.days <= 7 ? 3 : period.days > 120 ? 28 : 7;
  const data = useMemo(() => {
    const series = days.map((d) => (metric === "revenue" ? d.revenue : d.bookings));
    const avg = movingAverage(series, window);
    return days.map((d, i) => ({ ...d, value: series[i], trend: avg[i] }));
  }, [days, metric, window]);

  const config = {
    value: { label: metric === "revenue" ? "Revenue" : "Bookings", color: VIZ.series },
    trend: { label: `${window}-day average`, color: VIZ.trend },
  } satisfies ChartConfig;

  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = (n: number) => (metric === "revenue" ? peso(n) : compact(n));
  /* Roughly six ticks whatever the range, so labels never collide. */
  const tickEvery = Math.max(0, Math.ceil(days.length / 6) - 1);

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {metric === "revenue" ? "Revenue" : "Bookings"} over time
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {metric === "revenue"
              ? "Payments settled each day, and the running average."
              : "Sessions starting each day, and the running average."}{" "}
            {fmt(total)} in {period.label}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-border p-0.5"
            role="group"
            aria-label="Metric"
          >
            {(["revenue", "bookings"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                aria-pressed={metric === m}
                className={
                  "rounded-md px-3 py-1 text-xs font-semibold capitalize transition " +
                  (metric === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {m}
              </button>
            ))}
          </div>
          {/* Shape, not data: the same numbers as an area or as columns. Columns
              read each day as its own quantity, which is what a tenant comparing
              one Saturday with the next actually wants. */}
          <div
            className="inline-flex rounded-lg border border-border p-0.5"
            role="group"
            aria-label="Chart type"
          >
            {(
              [
                ["area", "Area", <Activity key="a" className="h-3.5 w-3.5" />],
                ["bar", "Bars", <BarChart3 key="b" className="h-3.5 w-3.5" />],
              ] as const
            ).map(([value, label, icon]) => (
              <button
                key={value}
                onClick={() => setKind(value)}
                aria-pressed={kind === value}
                title={`Show as ${label.toLowerCase()}`}
                className={
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition " +
                  (kind === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {days.length === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
          Nothing booked in this range yet.
        </div>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <ComposedChart
            data={data}
            margin={{ left: 4, right: 8, top: 8, bottom: 0 }}
            /* The 2px separator between touching columns is surface, not a stroke
               drawn round each bar. */
            barCategoryGap={2}
          >
            <defs>
              <linearGradient id="tenant-analytics-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={VIZ.series} stopOpacity={0.18} />
                <stop offset="100%" stopColor={VIZ.series} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {/* Horizontal only, hairline, solid: the gridline is there to be read
                past, not looked at. */}
            <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
            <XAxis
              dataKey="label"
              interval={tickEvery}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={16}
            />
            <YAxis
              width={metric === "revenue" ? 56 : 36}
              tickLine={false}
              axisLine={false}
              tickMargin={4}
              tickFormatter={(v: number) => (metric === "revenue" ? "₱" + compact(v) : compact(v))}
            />
            <ChartTooltip
              /* A crosshair finds the X on a continuous area. On columns the mark
                 is the hit target, so the hovered day washes instead — a hairline
                 through a bar it already covers reads as noise. */
              cursor={
                kind === "area"
                  ? { stroke: "var(--border)", strokeWidth: 1 }
                  : { fill: "var(--muted)", fillOpacity: 0.7 }
              }
              content={
                <ChartTooltipContent
                  indicator="line"
                  formatter={(value, name) => (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">
                        {name === "trend" ? config.trend.label : config.value.label}
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {fmt(Number(value))}
                      </span>
                    </span>
                  )}
                />
              }
            />
            {kind === "area" ? (
              <Area
                dataKey="value"
                type="monotone"
                stroke={VIZ.series}
                strokeWidth={2}
                fill="url(#tenant-analytics-fill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#ffffff" }}
                isAnimationActive={false}
              />
            ) : (
              /* Capped thickness so a 7-day range does not render seven slabs, and
                 the rounded end sits only on the cap — the baseline stays square. */
              <Bar
                dataKey="value"
                fill={VIZ.series}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="trend"
              type="monotone"
              stroke={VIZ.trend}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
      )}
    </div>
  );
}

/** When courts are actually occupied, day by hour. Sequential ramp: one hue, and
 *  the palest step is allowed to sink into the surface because "nobody booked
 *  this hour" is exactly what should look like nothing. */
function PeakHoursHeatmap({ heat, max }: { heat?: number[][]; max: number }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; x: number; y: number } | null>(
    null,
  );
  const grid = heat ?? Array.from({ length: 7 }, () => new Array(24).fill(0));
  const busiest = useMemo(() => {
    let best = { dow: 0, hour: 0, count: 0 };
    grid.forEach((row, dow) =>
      row.forEach((count, hour) => {
        if (count > best.count) best = { dow, hour, count };
      }),
    );
    return best;
  }, [grid]);

  const stepOf = (count: number) =>
    count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * (HEAT_RAMP.length - 1)));

  return (
    <div className="relative rounded-2xl border border-border bg-card p-4 shadow-sm">
      <h2 className="font-display text-lg font-semibold">Peak hours</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {busiest.count > 0 ? (
          <>
            Busiest is{" "}
            <span className="font-semibold text-foreground">
              {DOW_LABELS[busiest.dow]} {fmtHourShort(busiest.hour)}
            </span>{" "}
            with {busiest.count} {busiest.count === 1 ? "booking" : "bookings"}.
          </>
        ) : (
          "No bookings in this range yet."
        )}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="border-separate border-spacing-0.5">
          <caption className="sr-only">Bookings by day of week and hour of day</caption>
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  scope="col"
                  className="pb-1 text-[9px] font-medium text-muted-foreground tabular-nums"
                >
                  {h % 6 === 0 ? fmtHourShort(h) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, dow) => (
              <tr key={dow}>
                <th
                  scope="row"
                  className="pr-1.5 text-right text-[10px] font-medium text-muted-foreground"
                >
                  {DOW_LABELS[dow]}
                </th>
                {row.map((count, hour) => (
                  <td key={hour} className="p-0">
                    {/* The 2px gap between cells is the border-spacing above — a
                        stroke round each cell would add ink that is not data. */}
                    <div
                      role="img"
                      aria-label={`${DOW_LABELS[dow]} ${fmtHourShort(hour)}: ${count} ${count === 1 ? "booking" : "bookings"}`}
                      onPointerEnter={(e) =>
                        setHover({
                          dow,
                          hour,
                          x: e.currentTarget.offsetLeft,
                          y: e.currentTarget.offsetTop,
                        })
                      }
                      onPointerLeave={() => setHover(null)}
                      className="h-4 w-4 rounded-[3px] transition-[outline] outline-transparent hover:outline-2 hover:outline-offset-1 hover:outline-primary"
                      style={{ backgroundColor: HEAT_RAMP[stepOf(count)] }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The ramp's ends are labelled with the counts they stand for, so the
          legend states a scale rather than a vague "more". */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>0 bookings</span>
        <span className="inline-flex gap-0.5">
          {HEAT_RAMP.map((c) => (
            <span
              key={c}
              className="h-3 w-3 rounded-[2px] ring-1 ring-border"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <span>
          {max} {max === 1 ? "booking" : "bookings"}
        </span>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: hover.x, top: hover.y - 38 }}
        >
          <span className="font-semibold tabular-nums text-foreground">
            {grid[hover.dow][hover.hour]}
          </span>{" "}
          <span className="text-muted-foreground">
            {DOW_LABELS[hover.dow]} {fmtHourShort(hover.hour)}
          </span>
        </div>
      )}
    </div>
  );
}

/** What is happening on the courts today. The dashboard should answer "now" as
 *  well as "last month". */
function TodaySchedule({ rows, onOpen }: { rows: ScheduleRow[]; onOpen: () => void }) {
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  const nowMs = Date.now();
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Today</h2>
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          All bookings <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {rows.length === 0
          ? "Nothing on the courts today."
          : `${rows.length} ${rows.length === 1 ? "session" : "sessions"} scheduled.`}
      </p>
      {rows.length > 0 && (
        <ul className="nice-scroll mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {rows.map((r) => {
            const done = new Date(r.end).getTime() < nowMs;
            const live = new Date(r.start).getTime() <= nowMs && !done;
            return (
              <li
                key={r.id}
                className={
                  "flex items-center gap-3 rounded-lg border px-3 py-2 " +
                  (live ? "border-primary bg-primary/5" : "border-border") +
                  (done ? " opacity-55" : "")
                }
              >
                <span className="w-24 shrink-0 text-xs font-semibold tabular-nums">
                  {time(r.start)}–{time(r.end)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{r.court}</span>
                  <span className="block text-xs break-words text-muted-foreground">
                    {r.customer}
                  </span>
                </span>
                {/* Payment state is a status, so it ships as a word — never a bare
                    colour a reader has to decode. */}
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={
                    r.paid === "paid"
                      ? { color: VIZ.up, backgroundColor: "#0063001a" }
                      : { color: "#8a6100", backgroundColor: "#fab2191f" }
                  }
                >
                  {r.paid === "paid" ? "Paid" : "Unpaid"}
                </span>
                {live && (
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-primary">
                    Now
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Which courts and venues actually earn. Bar length carries the magnitude; the
 *  bars share one hue because colouring them by rank would repaint the survivors
 *  every time the list is re-sorted. */
function Leaderboard({
  rows,
  board,
  setBoard,
  sortBy,
  setSortBy,
}: {
  rows: BoardRow[];
  board: "courts" | "venues";
  setBoard: (b: "courts" | "venues") => void;
  sortBy: "revenue" | "bookings";
  setSortBy: (s: "revenue" | "bookings") => void;
}) {
  /* Ordered here rather than in the query, so flipping the measure re-sorts rows
     already loaded instead of going back to the network for the same numbers. */
  const top = useMemo(() => {
    const list = rows.slice();
    list.sort((a, b) =>
      sortBy === "revenue"
        ? b.revenue - a.revenue || b.bookings - a.bookings
        : b.bookings - a.bookings || b.revenue - a.revenue,
    );
    return list.slice(0, 6);
  }, [rows, sortBy]);
  /* The bar measures whatever is being ranked, so its length can never disagree
     with the position of the row it sits in — the thing that made revenue order
     with a bookings count beside it read as a fault. */
  const valueOf = (r: BoardRow) => (sortBy === "revenue" ? r.revenue : r.bookings);
  const max = Math.max(1, ...top.map(valueOf));
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 font-display text-lg font-semibold">
          <Trophy className="h-4 w-4 text-muted-foreground" /> Top performers
        </h2>
        <div
          className="inline-flex rounded-lg border border-border p-0.5"
          role="group"
          aria-label="Leaderboard scope"
        >
          {(["courts", "venues"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBoard(b)}
              aria-pressed={board === b}
              className={
                "rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition " +
                (board === b
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground")
              }
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Saying what the order is by. Without it a busier court sitting second
          reads as a bug rather than as the quieter court above it having earned
          more, which is the whole point of ranking on money. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Ranked by</span>
        <div
          className="inline-flex rounded-lg border border-border p-0.5"
          role="group"
          aria-label="Rank by"
        >
          {(
            [
              ["revenue", "Revenue"],
              ["bookings", "Bookings"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setSortBy(value)}
              aria-pressed={sortBy === value}
              className={
                "rounded-md px-2.5 py-1 text-xs font-semibold transition " +
                (sortBy === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {top.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Nothing booked in this range yet.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {top.map((r, i) => (
            <li key={r.key} className="flex items-start gap-3">
              {/* Rank, so the order is stated rather than left to be inferred from
                  bar lengths that can sit very close together. */}
              <span
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums"
                style={
                  i === 0
                    ? { backgroundColor: VIZ.series, color: "#ffffff" }
                    : { backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }
                }
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                {/* Names wrap instead of truncating: a court called "Center Court
                    (Indoor) 2" is unrecognisable cut to "Center Cou…". */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm font-medium break-words">{r.name}</span>
                  {/* Whatever the rows are ordered on is the figure that leads. */}
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {sortBy === "revenue"
                      ? peso(r.revenue)
                      : `${r.bookings} ${r.bookings === 1 ? "booking" : "bookings"}`}
                  </span>
                </div>
                {r.sub && <div className="text-xs text-muted-foreground">{r.sub}</div>}
                <div className="mt-1.5 flex items-center gap-2.5">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, (valueOf(r) / max) * 100)}%`,
                        backgroundColor: VIZ.series,
                      }}
                    />
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {sortBy === "revenue"
                      ? `${r.bookings} ${r.bookings === 1 ? "booking" : "bookings"}`
                      : peso(r.revenue)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Cancellations and money owed back. All of this already sits in `bookings` and
 *  was invisible on the dashboard, which is the one place a tenant looks daily. */
function RefundsPanel({
  cancels,
  period,
  onOpen,
}: {
  cancels?: { cancelled: number; total: number; refundPending: number; refundDone: number };
  period: Period;
  onOpen: () => void;
}) {
  const c = cancels ?? { cancelled: 0, total: 0, refundPending: 0, refundDone: 0 };
  const rate = c.total > 0 ? (c.cancelled / c.total) * 100 : 0;
  /* A rate is only worth reading against a denominator; under a handful of
     bookings the percentage swings wildly and would be read as a trend. */
  const meaningful = c.total >= 5;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Cancellations &amp; refunds</h2>
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          Transactions <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">Across {period.label}.</p>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <div className="font-display text-2xl font-semibold">
            {meaningful ? rate.toFixed(1) + "%" : "—"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {meaningful ? "cancellation rate" : `too few bookings (${c.total})`}
          </div>
        </div>
        <div>
          <div className="font-display text-2xl font-semibold tabular-nums">{c.cancelled}</div>
          <div className="text-[11px] text-muted-foreground">cancelled</div>
        </div>
        <div>
          <div className="font-display text-2xl font-semibold tabular-nums">{c.refundDone}</div>
          <div className="text-[11px] text-muted-foreground">refunded</div>
        </div>
      </div>

      {/* The one row here that is an action rather than a figure: a pending refund
          is money the tenant still owes someone. Icon and words, not colour alone. */}
      <div
        className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        style={
          c.refundPending > 0
            ? { borderColor: VIZ.pending, backgroundColor: "#fab2191a" }
            : { borderColor: "var(--border)" }
        }
      >
        {c.refundPending > 0 ? (
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "#8a6100" }} />
        ) : (
          <Check className="h-4 w-4 shrink-0" style={{ color: VIZ.up }} />
        )}
        <span className="min-w-0 flex-1">
          {c.refundPending > 0 ? (
            <>
              <span className="font-semibold">{c.refundPending}</span> refund
              {c.refundPending === 1 ? "" : "s"} waiting to be settled
            </>
          ) : (
            "No refunds waiting to be settled."
          )}
        </span>
      </div>
    </div>
  );
}

function VenuesCourtsActions({
  hasVenues,
  onCreateVenue,
  onAddCourt,
  onCreateGroup,
}: {
  hasVenues: boolean;
  onCreateVenue: () => void;
  onAddCourt: () => void;
  onCreateGroup: () => void;
}) {
  const handleAddCourt = () => {
    if (!hasVenues) {
      alert("Create a venue first, then you can add courts to it.");
      onCreateVenue();
      return;
    }
    onAddCourt();
  };
  const handleCreateGroup = () => {
    if (!hasVenues) {
      alert("Create a venue first — court groups belong to a venue.");
      onCreateVenue();
      return;
    }
    onCreateGroup();
  };
  return (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
      <button
        onClick={handleCreateGroup}
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:border-primary"
      >
        + Create group
      </button>
      <button
        onClick={handleAddCourt}
        className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:border-primary"
      >
        + Add court
      </button>
      <button
        onClick={onCreateVenue}
        className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
      >
        + Create venue
      </button>
    </div>
  );
}

function CreateVenueDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  return (
    <div
      className={"fixed inset-0 z-1200 " + (open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        onClick={onClose}
        className={
          "absolute inset-0 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "opacity-0")
        }
      />
      <aside
        className={
          "absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-background shadow-2xl transition-transform duration-300 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        role="dialog"
        aria-modal="true"
        aria-label="Create venue"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <h2 className="text-lg font-bold">Create venue</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-6">
          {open && <CreateVenue onCreated={onCreated} onCancel={onClose} />}
        </div>
      </aside>
    </div>
  );
}

function CreateGroupDrawer({
  open,
  onClose,
  venues,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  venues: Venue[];
  onCreated: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  return (
    <div
      className={"fixed inset-0 z-1200 " + (open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        onClick={onClose}
        className={
          "absolute inset-0 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "opacity-0")
        }
      />
      <aside
        className={
          "absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-background shadow-2xl transition-transform duration-300 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        role="dialog"
        aria-modal="true"
        aria-label="Create court group"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <h2 className="text-lg font-bold">Create court group</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-6">
          {open && <CreateGroupForm venues={venues} onCreated={onCreated} onCancel={onClose} />}
        </div>
      </aside>
    </div>
  );
}

function CreateGroupForm({
  venues,
  onCreated,
  onCancel,
}: {
  venues: Venue[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [venueId, setVenueId] = useState<number>(venues[0]?.id ?? 0);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Existing unassigned-ish courts in the same venue that we can bundle into this new group
  const courtsQ = useQuery({
    queryKey: ["group-eligible-courts", venueId],
    enabled: !!venueId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, hourly_rate, physical_court_id, sports(name)")
        .eq("venue_id", venueId)
        .order("id");
      if (error) throw error;
      return data as unknown as Array<{
        id: number;
        name: string;
        hourly_rate: number;
        physical_court_id: number;
        sports: { name: string } | null;
      }>;
    },
  });

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rules, setRules] = useState<Set<string>>(new Set());
  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Default: every selected court blocks every other one, both ways.
      setRules(allPairsEnabled(Array.from(next)));
      return next;
    });
  };

  const selectedCourts: RuleCourt[] = (courtsQ.data ?? [])
    .filter((c) => selected.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, sport: c.sports?.name ?? null }));

  const mut = useMutation({
    mutationFn: async () => {
      if (!venueId) throw new Error("Pick a venue");
      if (!name.trim()) throw new Error("Group name is required");
      const { data: pc, error } = await supabase
        .from("physical_courts")
        .insert({
          venue_id: venueId,
          name: name.trim(),
          map_emoji: emoji,
          description: description.trim() || null,
        })
        .select("id")
        .single();
      if (error) throw error;
      const ids = Array.from(selected);
      if (ids.length > 0) {
        const { error: upErr } = await supabase
          .from("courts")
          .update({ physical_court_id: pc.id })
          .in("id", ids);
        if (upErr) throw upErr;
        // Replace pairwise blocking rules for the selected courts
        const { error: delErr } = await supabase
          .from("court_block_rules")
          .delete()
          .in("court_id", ids);
        if (delErr) throw delErr;
        const rows = Array.from(rules)
          .map((k) => k.split(">").map(Number))
          .filter(([a, b]) => selected.has(a) && selected.has(b))
          .map(([a, b]) => ({ court_id: a, blocked_court_id: b, venue_id: venueId }));
        if (rows.length > 0) {
          const { error: insErr } = await supabase.from("court_block_rules").insert(rows);
          if (insErr) throw insErr;
        }
      }
    },
    onSuccess: onCreated,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
      className="grid gap-4"
    >
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm">
        <div className="font-semibold text-primary">What is a court group?</div>
        <p className="mt-1 text-muted-foreground">
          A group represents one <b>shared space</b> that can be set up for different sports (e.g. 1
          basketball ↔ 3 badminton ↔ 4 pickleball). Bookings across grouped courts automatically
          block each other.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Venue</span>
        <select
          value={venueId}
          onChange={(e) => setVenueId(Number(e.target.value))}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>

      <Input
        label='Group name (e.g. "Court 1 — Main Slab")'
        value={name}
        onChange={setName}
        required
      />

      <div className="rounded-xl border border-border bg-background p-3">
        <EmojiPicker
          label="Group emoji"
          value={emoji}
          fallback="🏟️"
          onChange={setEmoji}
          hint="Shown on the map and in the courts table."
        />
      </div>

      <Textarea
        label="About this Group"
        value={description}
        onChange={setDescription}
        placeholder="Court size, surface, lighting, house rules…"
      />

      <div className="rounded-xl border border-dashed border-border p-3">
        <div className="text-sm font-semibold">Assign existing courts to this group</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Tick every court that lives on this same shared space (e.g. 3 badminton + 4 pickleball
          courts painted on one hall).
        </p>
        <div className="mt-3 max-h-64 overflow-y-auto nice-scroll">
          {courtsQ.isLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : (courtsQ.data ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No courts in this venue yet. You can create the group now and assign courts later from
              Add / Edit court.
            </div>
          ) : (
            <ul className="grid gap-2">
              {(courtsQ.data ?? []).map((c) => {
                const checked = selected.has(c.id);
                return (
                  <li
                    key={c.id}
                    className={
                      "flex items-center gap-3 rounded-lg border p-2 text-sm " +
                      (checked ? "border-primary bg-primary/5" : "border-border")
                    }
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                    <div className="flex-1">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {c.sports?.name ?? "—"} · ₱{Number(c.hourly_rate).toFixed(0)}/hr
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <CourtBlockRulesEditor courts={selectedCourts} rules={rules} onChange={setRules} />

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary"
        >
          Cancel
        </button>
        <button
          disabled={mut.isPending || !name.trim() || !venueId}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {mut.isPending ? "Creating…" : "Create group"}
        </button>
      </div>
    </form>
  );
}

function VenuesCourtsGlance({ venues }: { venues: Venue[] }) {
  const venueIds = venues.map((v) => v.id);
  const q = useQuery({
    queryKey: ["venues-courts-glance", venueIds.join(",")],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("courts")
        .select("id, is_indoor")
        .in("venue_id", venueIds);
      const rows = data ?? [];
      const indoor = rows.filter((c) => c.is_indoor).length;
      return { total: rows.length, indoor, outdoor: rows.length - indoor };
    },
  });
  const total = q.data?.total ?? 0;
  const indoor = q.data?.indoor ?? 0;
  const outdoor = q.data?.outdoor ?? 0;
  return (
    <div className="mb-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total venues" value={venues.length} />
      <StatCard label="Total courts" value={total} />
      <StatCard label="Indoor courts" value={indoor} />
      <StatCard label="Outdoor courts" value={outdoor} />
    </div>
  );
}

function VenuesCourtsTable({ venues }: { venues: Venue[] }) {
  const venueIds = venues.map((v) => v.id);
  const q = useQuery({
    queryKey: ["venues-courts-table", venueIds.join(",")],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, coming_soon, venue_id, sports(name)")
        .in("venue_id", venueIds)
        .order("id", { ascending: true });
      return (data ?? []) as Array<{
        id: number;
        name: string;
        hourly_rate: number;
        is_indoor: boolean;
        coming_soon: boolean | null;
        venue_id: number;
        sports: { name: string } | null;
      }>;
    },
  });
  const courts = q.data ?? [];
  if (venues.length === 0) return null;

  return (
    <div className="mb-8 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="font-semibold">Venues & courts</div>
        <div className="text-xs text-muted-foreground">
          {venues.length} venue{venues.length === 1 ? "" : "s"} · {courts.length} court
          {courts.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-semibold">Venue</th>
              <th className="px-4 py-2 text-left font-semibold">Court</th>
              <th className="px-4 py-2 text-left font-semibold">Sport</th>
              <th className="px-4 py-2 text-left font-semibold">Type</th>
              <th className="px-4 py-2 text-right font-semibold">Rate / hr</th>
              <th className="px-4 py-2 text-left font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {venues.map((v) => {
              const rows = courts.filter((c) => c.venue_id === v.id);
              if (rows.length === 0) {
                return (
                  <tr key={`v-${v.id}`}>
                    <td className="px-4 py-3 font-medium">{v.name}</td>
                    <td className="px-4 py-3 text-muted-foreground" colSpan={5}>
                      No courts yet
                    </td>
                  </tr>
                );
              }
              return rows.map((c, i) => (
                <tr key={c.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium align-top">
                    {i === 0 ? v.name : <span className="text-muted-foreground/60">↳</span>}
                  </td>
                  <td className="px-4 py-3">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.sports?.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c.is_indoor ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}
                    >
                      {c.is_indoor ? "Indoor" : "Outdoor"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    ₱{Number(c.hourly_rate).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {c.coming_soon ? (
                      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Coming soon
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                        Live
                      </span>
                    )}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-3xl font-semibold">{value}</div>
    </div>
  );
}

function QuickAction({
  title,
  body,
  onClick,
}: {
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition hover:border-primary"
    >
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{body}</div>
    </button>
  );
}
function Skeleton() {
  return <div className="h-40 animate-pulse rounded-2xl bg-muted" />;
}
function EmptyState({ title, body, cta }: { title: string; body: string; cta?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {cta && <div className="mt-6">{cta}</div>}
    </div>
  );
}

function TagInput({
  label,
  placeholder,
  values,
  onChange,
  hint,
}: {
  label: string;
  placeholder?: string;
  values: string[];
  onChange: (v: string[]) => void;
  hint?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    if (values.some((v) => v.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, t]);
    setDraft("");
  };
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-2 focus-within:ring-2 focus-within:ring-ring">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="rounded-full text-primary/70 hover:text-primary"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={add}
          placeholder={values.length ? "" : (placeholder ?? "Type and press Enter")}
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function FeesEditor({
  items,
  onChange,
  notes,
  onNotesChange,
}: {
  items: FeeItem[];
  onChange: (v: FeeItem[]) => void;
  notes: string;
  onNotesChange: (s: string) => void;
}) {
  const update = (i: number, patch: Partial<FeeItem>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  return (
    <div className="space-y-2 rounded-xl border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fees & Charges
        </span>
        <button
          type="button"
          onClick={() => onChange([...items, { label: "", amount: 0 }])}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:border-primary hover:text-primary"
        >
          + Add fee
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No line-item fees yet. Add things like racket rental, shuttlecock, guest fee, etc.
        </p>
      )}
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr,110px,auto] items-center gap-2">
            <input
              value={it.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="e.g. Racket rental"
              className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex items-center gap-1 rounded-lg border border-input bg-background px-2">
              <span className="text-xs text-muted-foreground">₱</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={Number.isFinite(it.amount) ? it.amount : 0}
                onChange={(e) => update(i, { amount: Number(e.target.value) })}
                className="w-full bg-transparent py-1.5 text-sm outline-none"
              />
            </div>
            <button
              type="button"
              aria-label="Remove fee"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <label className="block pt-1">
        <span className="text-[11px] font-medium text-muted-foreground">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          rows={2}
          placeholder="Any extra pricing notes, discounts, or conditions."
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
    </div>
  );
}

function CreateVenue({ onCreated, onCancel }: { onCreated: () => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState(
    TIMEZONE_OPTIONS.some((t) => t.value === detectedTz) ? detectedTz : "Asia/Manila",
  );
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [mapEmoji, setMapEmoji] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tzConfirmed, setTzConfirmed] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [amenities, setAmenities] = useState<string[]>([]);
  const [foodBeverages, setFoodBeverages] = useState<string[]>([]);
  const [facilityServices, setFacilityServices] = useState<string[]>([]);
  const [fees, setFees] = useState<FeeItem[]>([]);
  const [feesNotes, setFeesNotes] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [operatingHoursText, setOperatingHoursText] = useState("");
  const [openHours, setOpenHours] = useState<HoursMap>(() => fullWeek());
  const [cancellationHours, setCancellationHours] = useState<number>(24);
  const [cancellationNotes, setCancellationNotes] = useState("");
  const [rules, setRules] = useState("");
  const uploadPrefix = useRef(
    `venues/new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  ).current;

  const suggested = suggestTimezone(lat, lng);
  const pinInPH = isInPhilippines(lat, lng);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);
  const pinOutsidePH = lat != null && lng != null && !pinInPH;

  const mut = useMutation({
    mutationFn: async () => {
      if (lat == null || lng == null)
        throw new Error("Please pin your venue on the map before creating.");
      if (!pinInPH)
        throw new Error(
          "CourtHub currently supports venues in the Philippines only. Please pin a location within the Philippines.",
        );
      if (tzMismatch && !tzConfirmed)
        throw new Error(
          `Timezone doesn't match your pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`,
        );
      const cleanFees = fees
        .filter((f) => f.label.trim() && Number.isFinite(f.amount))
        .map((f) => ({ label: f.label.trim(), amount: Number(f.amount) }));
      const { error } = await supabase
        .from("venues")
        .insert({
          name,
          address,
          timezone,
          latitude: lat,
          longitude: lng,
          map_emoji: mapEmoji,
          description: description.trim() || null,
          images,
          is_active: isActive,
          amenities,
          food_beverages: foodBeverages,
          facility_services: facilityServices,
          fees: cleanFees,
          fees_notes: feesNotes.trim() || null,
          contact_phone: contactPhone.trim() || null,
          contact_email: contactEmail.trim() || null,
          operating_hours_text: operatingHoursText.trim() || null,
          operating_hours: openHours,
          refund_cutoff_hours: Number.isFinite(cancellationHours)
            ? Math.max(0, Math.floor(cancellationHours))
            : 24,
          cancellation_notes: cancellationNotes.trim() || null,
          rules: rules.trim() || null,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      setName("");
      setAddress("");
      setLat(null);
      setLng(null);
      setMapEmoji(null);
      setDescription("");
      setImages([]);
      setErr(null);
      setTzConfirmed(false);
      setIsActive(true);
      setAmenities([]);
      setFoodBeverages([]);
      setFacilityServices([]);
      setFees([]);
      setFeesNotes("");
      setContactPhone("");
      setContactEmail("");
      setOperatingHoursText("");
      setCancellationHours(24);
      setCancellationNotes("");
      setRules("");
      onCreated();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-xl font-bold">New venue</h2>
      <p className="mt-1 text-sm text-muted-foreground">A venue holds one or more courts.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
        className="mt-4 grid gap-3 sm:grid-cols-2"
      >
        <Input label="Venue name" value={name} onChange={setName} required />
        <Input label="Address" value={address} onChange={setAddress} required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Timezone</span>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Used to display court hours and bookings in the venue's local time.
          </span>
        </label>
        <div className="sm:col-span-2 rounded-xl border border-dashed border-border bg-secondary/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Map location
            </span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:border-primary hover:text-primary"
            >
              {lat != null ? "Change pin" : "📍 Pick on map"}
            </button>
          </div>
          {lat != null && lng != null ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="mt-2 block w-full overflow-hidden rounded-lg border border-border"
            >
              <div className="relative h-28 w-full overflow-hidden">
                <iframe
                  title="Selected location"
                  src={osmEmbedUrl(lat, lng)}
                  className="pointer-events-none absolute left-0 right-0 -top-6 h-48 w-full"
                  loading="lazy"
                />
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" /> Pinned
                </span>
              </div>
              <div className="bg-secondary/40 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground">
                {lat.toFixed(6)}, {lng.toFixed(6)}
              </div>
            </button>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Tap "Pick on map" to drop a pin so players can find your venue.
            </p>
          )}
        </div>
        <MapPicker
          open={pickerOpen}
          initialLat={lat}
          initialLng={lng}
          onClose={() => setPickerOpen(false)}
          onSave={(la, ln) => {
            setLat(la);
            setLng(ln);
            setPickerOpen(false);
            const s = suggestTimezone(la, ln);
            if (s) {
              setTimezone(s.tz);
              setTzConfirmed(false);
            }
          }}
          title="Pin your venue"
        />
        <div className="sm:col-span-2 rounded-xl border border-border bg-secondary/20 p-3">
          <EmojiPicker
            label="Map emoji (venue pin)"
            value={mapEmoji}
            fallback="🎾"
            onChange={setMapEmoji}
            hint="Shown on the landing-page map. Individual courts can override this."
          />
        </div>
        <div className="sm:col-span-2">
          <Textarea
            label="About this Venue (optional)"
            value={description}
            onChange={setDescription}
            placeholder="Tell players about your venue — parking, amenities, house rules…"
          />
        </div>
        <div className="sm:col-span-2">
          <ImageUploader
            label="Venue photos"
            pathPrefix={uploadPrefix}
            images={images}
            onChange={setImages}
          />
        </div>
        <div className="sm:col-span-2">
          <TagInput
            label="Amenities"
            values={amenities}
            onChange={setAmenities}
            placeholder="e.g. Parking, Showers, Wi-Fi"
            hint="Press Enter or comma to add. Shown to players on the venue page."
          />
        </div>
        <div className="sm:col-span-2">
          <TagInput
            label="Food & Beverages"
            values={foodBeverages}
            onChange={setFoodBeverages}
            placeholder="e.g. Cafe, Vending machine, Water refill"
          />
        </div>
        <div className="sm:col-span-2">
          <TagInput
            label="Facility Services"
            values={facilityServices}
            onChange={setFacilityServices}
            placeholder="e.g. Racket rental, Coaching, Ball machine"
          />
        </div>
        <div className="sm:col-span-2">
          <FeesEditor
            items={fees}
            onChange={setFees}
            notes={feesNotes}
            onNotesChange={setFeesNotes}
          />
        </div>
        <Input
          label="Inquiry phone (shown to players)"
          value={contactPhone}
          onChange={setContactPhone}
        />
        <Input label="Inquiry email (optional)" value={contactEmail} onChange={setContactEmail} />
        <div className="sm:col-span-2">
          <OperatingHoursEditor
            hours={openHours}
            onChange={setOpenHours}
            hint="Courts follow these hours by default. Players can only book inside this window, and closed hours are hidden everywhere."
          />
          <Textarea
            label="Operating hours note (optional)"
            value={operatingHoursText}
            onChange={setOperatingHoursText}
            placeholder="Extra note shown to players, e.g. Holiday hours may vary"
          />
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">
            Cancellation cutoff (hours before start)
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={cancellationHours}
            onChange={(e) => setCancellationHours(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Default 24h. Set to 0 to allow last-minute cancellations.
          </span>
        </label>
        <div className="sm:col-span-2">
          <Textarea
            label="Cancellation policy notes (optional)"
            value={cancellationNotes}
            onChange={setCancellationNotes}
            placeholder="e.g. Full refund up to 24h before. 50% within 24h. No refund after start."
          />
        </div>
        <div className="sm:col-span-2">
          <Textarea
            label="Venue rules (one per line)"
            value={rules}
            onChange={setRules}
            placeholder={
              "e.g.\n- Wear non-marking shoes\n- No outside food or drinks\n- Arrive 10 minutes early"
            }
          />
        </div>
        {pinOutsidePH && (
          <div className="sm:col-span-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <strong>Location not supported.</strong> CourtHub is currently available for venues in
            the <strong>Philippines</strong> only. Please move your pin within the Philippines to
            continue.
          </div>
        )}
        {tzMismatch && pinInPH && (
          <div className="sm:col-span-2 rounded-lg border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="flex items-start justify-between gap-2">
              <div>
                <strong>Timezone doesn't match your pin.</strong> Based on your map location this
                venue looks like it's in <strong>{suggested?.country}</strong> ({suggested?.tz}),
                but you selected <strong>{timezone}</strong>. Court hours and bookings will display
                in the wrong local time if this is incorrect.
              </div>
              <button
                type="button"
                onClick={() => {
                  setTimezone(suggested!.tz);
                  setTzConfirmed(false);
                }}
                className="shrink-0 rounded-md border border-amber-500/60 bg-background px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-100"
              >
                Use {suggested?.tz}
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={tzConfirmed}
                onChange={(e) => setTzConfirmed(e.target.checked)}
              />
              I confirm this venue uses <span className="font-mono">{timezone}</span> even though
              the pin is elsewhere.
            </label>
          </div>
        )}
        <div className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Active
          </label>
          <span
            tabIndex={0}
            role="button"
            aria-label="About the active status"
            title={ACTIVE_INFO_TEXT}
            className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-muted-foreground/40 text-[10px] font-bold text-muted-foreground hover:border-primary hover:text-primary"
          >
            ?
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            Ticked by default — the venue will appear on the landing page.
          </span>
        </div>
        <div className="sm:col-span-2 flex flex-wrap gap-2">
          <button
            disabled={mut.isPending || pinOutsidePH || (tzMismatch && !tzConfirmed)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {mut.isPending ? "Creating…" : "Create venue"}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-border px-4 py-2 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
        {err && (
          <p className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </p>
        )}
      </form>
    </section>
  );
}

function VenueSection({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const courtsQ = useQuery({
    queryKey: ["courts", venue.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("*, sports(name)")
        .eq("venue_id", venue.id)
        .order("id");
      if (error) throw error;
      return data as unknown as Court[];
    },
  });

  const courtIds = (courtsQ.data ?? []).map((c) => c.id);
  const [bookingDate, setBookingDate] = useState<string>("");
  const bookingsQ = useQuery({
    queryKey: ["venue-bookings", venue.id, courtIds.join(","), bookingDate || "upcoming"],
    enabled: courtIds.length > 0,
    queryFn: async () => {
      let q = supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status")
        .in("court_id", courtIds)
        .order("start_time", { ascending: true })
        .limit(100);
      if (bookingDate) {
        const from = new Date(`${bookingDate}T00:00:00`).toISOString();
        const to = new Date(`${bookingDate}T23:59:59`).toISOString();
        q = q.gte("start_time", from).lte("start_time", to);
      } else {
        q = q.gte("end_time", new Date().toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      return data as {
        id: number;
        court_id: number;
        start_time: string;
        end_time: string;
        status: string;
      }[];
    },
  });

  const courtName = (id: number) => courtsQ.data?.find((c) => c.id === id)?.name ?? `Court #${id}`;

  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-col gap-3 border-b border-border p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <VenueEditor venue={venue} courtsCount={courtsQ.data?.length ?? 0} />
          </div>
          <VenueLocation
            venue={venue}
            onSaved={() => qc.invalidateQueries({ queryKey: ["my-venues"] })}
          />
        </div>
      </header>
      <div className="p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(courtsQ.data ?? []).map((c) => (
            <CourtCard
              key={c.id}
              court={c}
              venueEmoji={venue.map_emoji}
              onChanged={() => {
                qc.invalidateQueries({ queryKey: ["courts", venue.id] });
                qc.invalidateQueries({ queryKey: ["venues-court-counts"] });
                qc.invalidateQueries({ queryKey: ["venues-courts-glance"] });
              }}
            />
          ))}
          <AddCourt
            venueId={venue.id}
            venueEmoji={venue.map_emoji}
            onCreated={() => {
              qc.invalidateQueries({ queryKey: ["courts", venue.id] });
              qc.invalidateQueries({ queryKey: ["venues-court-counts"] });
              qc.invalidateQueries({ queryKey: ["venues-courts-glance"] });
            }}
          />
        </div>

        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {bookingDate
                ? `Bookings on ${new Date(`${bookingDate}T00:00:00`).toLocaleDateString()}`
                : "Upcoming bookings"}
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
                className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs"
              />
              {bookingDate && (
                <button
                  onClick={() => setBookingDate("")}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary"
                >
                  Show upcoming
                </button>
              )}
            </div>
          </div>
          {courtIds.length === 0 ? null : bookingsQ.isLoading ? (
            <div className="mt-3 h-16 animate-pulse rounded-lg bg-muted" />
          ) : (bookingsQ.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {bookingDate ? "No bookings on this date." : "No upcoming bookings yet."}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
              {bookingsQ.data!.map((b) => {
                const s = new Date(b.start_time);
                const e = new Date(b.end_time);
                return (
                  <li key={b.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div>
                      <div className="font-medium">{courtName(b.court_id)}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.toLocaleDateString()} ·{" "}
                        {s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} –{" "}
                        {e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary capitalize">
                      {b.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function CourtCard({
  court,
  venueEmoji,
  onChanged,
}: {
  court: Court;
  venueEmoji: string | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [managingHours, setManagingHours] = useState(false);
  if (editing) {
    return (
      <EditCourt
        court={court}
        venueEmoji={venueEmoji}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  if (managingHours) {
    return (
      <AvailabilityEditor
        court={court}
        onDone={() => {
          setManagingHours(false);
          onChanged();
        }}
        onCancel={() => setManagingHours(false)}
      />
    );
  }
  const cover = court.images?.[0];
  const totalBlocked = Object.values(court.blocked_hours ?? {}).reduce(
    (s, arr) => s + (arr?.length ?? 0),
    0,
  );
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {cover ? (
        <img src={cover} alt={court.name} className="h-32 w-full object-cover" loading="lazy" />
      ) : (
        <div className="court-pattern h-32" />
      )}
      <div className="p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="rounded-full bg-secondary px-2 py-1 font-medium">
            {court.sports?.name}
          </span>
          <span className="text-muted-foreground">{court.is_indoor ? "Indoor" : "Outdoor"}</span>
        </div>
        {court.coming_soon && (
          <span className="mt-2 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 ring-1 ring-amber-500/30">
            Coming soon
          </span>
        )}
        <h3 className="mt-2 font-semibold">{court.name}</h3>
        {court.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{court.description}</p>
        )}
        {(court.amenities?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {court.amenities!.slice(0, 4).map((a) => (
              <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                {a}
              </span>
            ))}
            {court.amenities!.length > 4 && (
              <span className="text-[10px] text-muted-foreground">
                +{court.amenities!.length - 4} more
              </span>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <div className="text-primary">
            <span className="text-lg font-bold">₱{Number(court.hourly_rate).toFixed(0)}</span>{" "}
            <span className="text-xs text-muted-foreground">/hr</span>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Open 24/7 · <span className="font-medium text-foreground">{totalBlocked}</span> hr
          {totalBlocked === 1 ? "" : "s"} blocked / week
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setManagingHours(true)}
            className="flex-1 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20"
          >
            Manage availability
          </button>
          <button
            onClick={() => setEditing(true)}
            className="rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:border-primary hover:text-primary"
          >
            Edit details
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtHour(x: number) {
  const p = x < 12 ? "AM" : "PM";
  const h12 = x % 12 === 0 ? 12 : x % 12;
  return `${h12}:00 ${p}`;
}
function fmtHourShort(x: number) {
  const p = x < 12 ? "AM" : "PM";
  const h12 = x % 12 === 0 ? 12 : x % 12;
  return `${h12}${p}`;
}

// Serializable payloads used by create/edit forms
export type BlockedHoursMap = Record<string, number[]>;
export type BlockedDatesMap = Record<string, number[]>;

function buildInitialWeekly(source: Record<string, number[]> | null | undefined) {
  const out: Record<string, Set<number>> = {};
  for (const d of DAYS) out[d.key] = new Set(source?.[d.key] ?? []);
  return out;
}
function buildInitialDates(source: Record<string, number[]> | null | undefined) {
  const map: Record<string, Set<number>> = {};
  for (const [date, hrs] of Object.entries(source ?? {})) map[date] = new Set(hrs);
  return map;
}
export function weeklyToPayload(weekly: Record<string, Set<number>>): BlockedHoursMap {
  const out: BlockedHoursMap = {};
  for (const d of DAYS) out[d.key] = Array.from(weekly[d.key] ?? []).sort((a, b) => a - b);
  return out;
}
export function datesToPayload(dateBlocks: Record<string, Set<number>>): BlockedDatesMap {
  const out: BlockedDatesMap = {};
  for (const [date, set] of Object.entries(dateBlocks)) out[date] = Array.from(set).sort((a, b) => a - b);
  return out;
}

function AvailabilityGrid({
  weekly,
  setWeekly,
  dateBlocks,
  setDateBlocks,
  hours,
}: {
  weekly: Record<string, Set<number>>;
  setWeekly: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  dateBlocks: Record<string, Set<number>>;
  setDateBlocks: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  hours?: HoursMap;
}) {
  const [mode, setMode] = useState<"weekly" | "date">("weekly");
  const openOnDay = (day: string) => (hours ? openHoursForDay(hours, day as DayKey) : null);
  const toggleWeekly = (day: string, hour: number) => {
    setWeekly((prev) => {
      const next = { ...prev, [day]: new Set(prev[day]) };
      if (next[day].has(hour)) next[day].delete(hour);
      else next[day].add(hour);
      return next;
    });
  };
  const setAllDayWeekly = (day: string, block: boolean) => {
    setWeekly((prev) => ({
      ...prev,
      [day]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []),
    }));
  };

  const localISO = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shiftDate = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + days);
    return localISO(d);
  };
  const [selectedDate, setSelectedDate] = useState<string>(localISO(new Date()));
  const hasOverride = Object.prototype.hasOwnProperty.call(dateBlocks, selectedDate);
  const currentDateSet = dateBlocks[selectedDate] ?? new Set<number>();
  const toggleDate = (hour: number) => {
    setDateBlocks((prev) => {
      const set = new Set(prev[selectedDate] ?? []);
      if (set.has(hour)) set.delete(hour);
      else set.add(hour);
      return { ...prev, [selectedDate]: set };
    });
  };
  const setAllForDate = (block: boolean) => {
    setDateBlocks((prev) => ({
      ...prev,
      [selectedDate]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []),
    }));
  };
  const clearOverride = () => {
    setDateBlocks((prev) => {
      const next = { ...prev };
      delete next[selectedDate];
      return next;
    });
  };

  return (
    <div>
      <div className="inline-flex rounded-lg border border-border bg-background p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setMode("weekly")}
          className={
            "rounded-md px-3 py-1.5 font-semibold " +
            (mode === "weekly" ? "bg-primary text-primary-foreground" : "text-muted-foreground")
          }
        >
          Weekly pattern
        </button>
        <button
          type="button"
          onClick={() => setMode("date")}
          className={
            "rounded-md px-3 py-1.5 font-semibold " +
            (mode === "date" ? "bg-primary text-primary-foreground" : "text-muted-foreground")
          }
        >
          Specific date
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tap an hour to block it (red = closed to players). Weekly rules repeat every week.
        Specific-date overrides apply only to that date and do NOT inherit weekly blocks. Past hours
        and hours already booked by players are also unavailable automatically.
      </p>

      {mode === "weekly" ? (
        <div className="mt-3 space-y-3">
          {DAYS.map((d) => (
            <div key={d.key} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{d.label}</span>
                <div className="flex gap-1 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setAllDayWeekly(d.key, false)}
                    className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary"
                  >
                    Open all
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllDayWeekly(d.key, true)}
                    className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive"
                  >
                    Close all
                  </button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 24 }, (_, h) => h).map((h) => {
                  const open = openOnDay(d.key);
                  const closed = !!open && !open.has(h);
                  const isBlocked = weekly[d.key]?.has(h);
                  return (
                    <button
                      key={h}
                      type="button"
                      disabled={closed}
                      onClick={() => toggleWeekly(d.key, h)}
                      title={closed ? "Outside operating hours" : undefined}
                      className={
                        "rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " +
                        (closed
                          ? "cursor-not-allowed bg-muted text-muted-foreground/60 line-through"
                          : isBlocked
                            ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30"
                            : "bg-primary/10 text-foreground hover:bg-primary/20")
                      }
                    >
                      {fmtHour(h)} – {fmtHour((h + 1) % 24)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-border bg-background p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Date:</span>
            <button
              type="button"
              onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}
              className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary"
            >
              ←
            </button>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="rounded border border-input bg-background px-2 py-1"
            />
            <button
              type="button"
              onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}
              className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary"
            >
              →
            </button>
            <span
              className={
                "ml-2 rounded-full px-2 py-0.5 " +
                (hasOverride ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")
              }
            >
              {hasOverride ? "Override active (weekly ignored)" : "No override · weekly applies"}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => setAllForDate(false)}
              className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary"
            >
              Open all day
            </button>
            <button
              type="button"
              onClick={() => setAllForDate(true)}
              className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive"
            >
              Close all day
            </button>
            {hasOverride && (
              <button
                type="button"
                onClick={clearOverride}
                className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary"
              >
                Remove override (use weekly)
              </button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 24 }, (_, h) => h).map((h) => {
              const openSet = hours ? openHoursForDate(hours, selectedDate) : null;
              const closed = !!openSet && !openSet.has(h);
              const isBlocked = currentDateSet.has(h);
              return (
                <button
                  key={h}
                  type="button"
                  disabled={closed}
                  onClick={() => toggleDate(h)}
                  title={closed ? "Outside operating hours" : undefined}
                  className={
                    "rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " +
                    (closed
                      ? "cursor-not-allowed bg-muted text-muted-foreground/60 line-through"
                      : isBlocked
                        ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30"
                        : "bg-primary/10 text-foreground hover:bg-primary/20")
                  }
                >
                  {fmtHour(h)} – {fmtHour((h + 1) % 24)}
                </button>
              );
            })}
          </div>

          {Object.keys(dateBlocks).length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Existing overrides
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(dateBlocks)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([date, set]) => (
                    <li key={date}>
                      <button
                        type="button"
                        onClick={() => setSelectedDate(date)}
                        className={
                          "rounded-full border px-2 py-0.5 text-[11px] " +
                          (date === selectedDate
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border hover:border-primary hover:text-primary")
                        }
                      >
                        {new Date(`${date}T00:00:00`).toLocaleDateString()} · {set.size} hr
                        {set.size === 1 ? "" : "s"}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function useVenueHours(venueId: number | undefined) {
  const q = useQuery({
    queryKey: ["venue-hours", venueId],
    enabled: !!venueId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("operating_hours")
        .eq("id", venueId!)
        .single();
      if (error) throw error;
      return normalizeHours((data as { operating_hours?: unknown }).operating_hours);
    },
  });
  return q.data ?? fullWeek();
}

function AvailabilityEditor({
  court,
  onDone,
  onCancel,
}: {
  court: Court;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const venueHours = useVenueHours(court.venue_id);
  const courtHours = effectiveHours(court, venueHours);
  const [weekly, setWeekly] = useState<Record<string, Set<number>>>(() =>
    buildInitialWeekly(court.blocked_hours),
  );
  const [dateBlocks, setDateBlocks] = useState<Record<string, Set<number>>>(() =>
    buildInitialDates(court.blocked_dates),
  );

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("courts")
        .update({
          blocked_hours: weeklyToPayload(weekly),
          blocked_dates: datesToPayload(dateBlocks),
        })
        .eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Availability · {court.name}</h3>
          <p className="text-xs text-muted-foreground">
            Hours outside the operating window are greyed out. Use this to block extra hours inside
            opening hours, or override a specific date.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60"
          >
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="mt-3">
        <AvailabilityGrid
          weekly={weekly}
          setWeekly={setWeekly}
          dateBlocks={dateBlocks}
          setDateBlocks={setDateBlocks}
          hours={courtHours}
        />
      </div>
      {err && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      )}
    </div>
  );
}

function InlineAvailability({
  weekly,
  setWeekly,
  dateBlocks,
  setDateBlocks,
  hours,
}: {
  weekly: Record<string, Set<number>>;
  setWeekly: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  dateBlocks: Record<string, Set<number>>;
  setDateBlocks: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  hours?: HoursMap;
}) {
  const [open, setOpen] = useState(false);
  const weeklyBlocked = DAYS.reduce((s, d) => s + (weekly[d.key]?.size ?? 0), 0);
  const dateOverrides = Object.keys(dateBlocks).length;
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-primary">
            Manage availability (optional)
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {weeklyBlocked === 0 && dateOverrides === 0
              ? "All hours open by default. Tap to block specific weekly hours or add date overrides."
              : `${weeklyBlocked} weekly blocked hour${weeklyBlocked === 1 ? "" : "s"} · ${dateOverrides} date override${dateOverrides === 1 ? "" : "s"}`}
          </div>
        </div>
        <span className={"text-primary transition-transform " + (open ? "rotate-180" : "")}>▾</span>
      </button>
      {open && (
        <div className="border-t border-primary/20 p-3">
          <AvailabilityGrid
            weekly={weekly}
            setWeekly={setWeekly}
            dateBlocks={dateBlocks}
            setDateBlocks={setDateBlocks}
            hours={hours}
          />
        </div>
      )}
    </div>
  );
}

function useSportsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("id, name, slug").order("name");
      if (error) throw error;
      return data as Sport[];
    },
    enabled,
  });
}

export function sportEmoji(slug?: string | null): string {
  switch (slug) {
    case "pickleball": return "🥎";
    case "tennis": return "🎾";
    case "basketball": return "🏀";
    case "table-tennis": return "🏓";
    case "badminton": return "🏸";
    case "volleyball": return "🏐";
    case "football":
    case "soccer": return "⚽";
    default: return "🏟️";
  }
}

function parseList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function AddCourt({
  venueId,
  venueEmoji,
  onCreated,
  alwaysOpen,
  onCancel,
}: {
  venueId: number;
  venueEmoji: string | null;
  onCreated: () => void;
  alwaysOpen?: boolean;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("25");
  const [sportId, setSportId] = useState<string>("");
  const [isIndoor, setIsIndoor] = useState(false);
  const [comingSoon, setComingSoon] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [mapEmoji, setMapEmoji] = useState<string | null>(null);
  const [surfaceType, setSurfaceType] = useState("");
  const [playerCapacity, setPlayerCapacity] = useState("");
  const [availWeekly, setAvailWeekly] = useState<Record<string, Set<number>>>(() =>
    buildInitialWeekly(null),
  );
  const [availDates, setAvailDates] = useState<Record<string, Set<number>>>(() =>
    buildInitialDates(null),
  );
  const [voucherEnabled, setVoucherEnabled] = useState(false);
  const [rateRules, setRateRules] = useState<RateRule[]>([]);
  const venueHours = useVenueHours(venueId);
  const [inheritHours, setInheritHours] = useState(true);
  const [ownHours, setOwnHours] = useState<HoursMap>(() => fullWeek());
  const courtHours = inheritHours ? venueHours : ownHours;
  const [err, setErr] = useState<string | null>(null);

  const sportsQ = useSportsQuery(open || !!alwaysOpen);

  const selectedSport = sportsQ.data?.find((s) => String(s.id) === sportId);
  const fallbackEmoji = venueEmoji || sportEmoji(selectedSport?.slug) || "🎾";

  const mut = useMutation({
    mutationFn: async () => {
      // Every court gets its own physical space row; shared-space blocking is
      // configured separately through court groups.
      const { data: pcRow, error: pcErr } = await supabase
        .from("physical_courts")
        .insert({
          venue_id: venueId,
          name: `${name.trim() || "Court"} slab`,
          map_emoji: mapEmoji ?? venueEmoji ?? null,
        })
        .select("id")
        .single();
      if (pcErr) throw pcErr;
      const pcId: number = pcRow.id;
      const createdPcId: number | null = pcRow.id;
      const cap = 1;
      const footprint = 1 / cap;

      const { error } = await supabase.from("courts").insert({
        venue_id: venueId,
        sport_id: Number(sportId),
        physical_court_id: pcId,
        capacity: cap,
        footprint,
        name,
        hourly_rate: Number(rate),
        is_indoor: isIndoor,
        coming_soon: comingSoon,
        is_active: isActive,
        description: description || null,
        images,
        map_emoji: mapEmoji,
        surface_type: surfaceType.trim() || null,
        player_capacity: playerCapacity ? Math.max(1, Math.floor(Number(playerCapacity))) : null,
        blocked_hours: weeklyToPayload(availWeekly),
        blocked_dates: datesToPayload(availDates),
        voucher_enabled: voucherEnabled,
        rate_rules: normalizeRules(rateRules),
        inherit_venue_hours: inheritHours,
        operating_hours: inheritHours ? {} : ownHours,
      });

      if (error) {
        // Clean up the orphan physical_courts row so we don't leak empty surfaces
        if (createdPcId !== null) {
          await supabase.from("physical_courts").delete().eq("id", createdPcId);
        }
        throw error;
      }
    },
    onSuccess: () => {
      setOpen(false);
      setName("");
      setRate("25");
      setSportId("");
      setIsIndoor(false);
      setComingSoon(false);
      setIsActive(true);
      setDescription("");
      setImages([]);
      setMapEmoji(null);
      setSurfaceType("");
      setPlayerCapacity("");
      setAvailWeekly(buildInitialWeekly(null));
      setAvailDates(buildInitialDates(null));
      setVoucherEnabled(false);
      setRateRules([]);
      setErr(null);
      onCreated();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (!open && !alwaysOpen) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="grid min-h-32 place-items-center rounded-xl border-2 border-dashed border-border p-4 text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary"
      >
        + Add court
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!sportId) {
          setErr("Pick a sport");
          return;
        }
        mut.mutate();
      }}
      className="col-span-full rounded-xl border border-border bg-secondary/30 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Sport</span>
          <select
            value={sportId}
            onChange={(e) => setSportId(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {(sportsQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={isIndoor}
            onChange={(e) => setIsIndoor(e.target.checked)}
          />
          Indoor court
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={comingSoon}
            onChange={(e) => setComingSoon(e.target.checked)}
          />
          Coming soon
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={voucherEnabled}
            onChange={(e) => setVoucherEnabled(e.target.checked)}
          />
          Accept vouchers
        </label>
        <CourtStatusField value={isActive} onChange={setIsActive} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tick "Coming soon" if this court isn't open yet. Tick "Accept vouchers" to let players
        redeem discount codes you create in the Vouchers module for this court.
      </p>
      <RateRulesEditor baseRate={Number(rate) || 0} rules={rateRules} onChange={setRateRules} />
      <CourtHoursEditor
        inherit={inheritHours}
        onInheritChange={setInheritHours}
        hours={ownHours}
        onHoursChange={setOwnHours}
        venueHours={venueHours}
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Surface type</span>
          <input
            list="court-surface-suggestions"
            value={surfaceType}
            onChange={(e) => setSurfaceType(e.target.value)}
            placeholder="e.g. Hardwood, Concrete, Synthetic, Clay, Rubber, Acrylic"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <datalist id="court-surface-suggestions">
            <option value="Hardwood" />
            <option value="Concrete" />
            <option value="Synthetic" />
            <option value="Acrylic" />
            <option value="Rubber" />
            <option value="Clay" />
            <option value="Grass" />
            <option value="Artificial turf" />
            <option value="Vinyl flooring" />
          </datalist>
        </label>
        <Input
          label="Player capacity (max players per match)"
          value={playerCapacity}
          onChange={setPlayerCapacity}
          type="number"
        />
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea
          label="About this Court"
          value={description}
          onChange={setDescription}
          placeholder="Court size, surface, lighting, rules, etc."
        />
        <ImageUploader
          label="Court photos"
          pathPrefix={`courts/venue-${venueId}/new-${Date.now()}`}
          images={images}
          onChange={setImages}
        />
        <div className="rounded-xl border border-border bg-background p-3">
          <EmojiPicker
            label="Court map emoji"
            value={mapEmoji}
            fallback={fallbackEmoji}
            onChange={setMapEmoji}
            hint="Falls back to the venue emoji, then the sport default."
          />
        </div>
      </div>
      <InlineAvailability
        weekly={availWeekly}
        setWeekly={setAvailWeekly}
        dateBlocks={availDates}
        setDateBlocks={setAvailDates}
        hours={courtHours}
      />
      {err && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          disabled={mut.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {mut.isPending ? "Adding…" : "Add court"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (onCancel) onCancel();
            else setOpen(false);
          }}
          className="rounded-lg border border-border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddCourtDrawer({
  open,
  onClose,
  venues,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  venues: Venue[];
  onCreated: () => void;
}) {
  const [venueId, setVenueId] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setVenueId(venues.length === 1 ? venues[0].id : null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, venues]);
  const selectedVenue = venues.find((v) => v.id === venueId) ?? null;
  return (
    <div
      className={"fixed inset-0 z-1200 " + (open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        onClick={onClose}
        className={
          "absolute inset-0 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "opacity-0")
        }
      />
      <aside
        className={
          "absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-background shadow-2xl transition-transform duration-300 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        role="dialog"
        aria-modal="true"
        aria-label="Add court"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <h2 className="text-lg font-bold">Add court</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        <div className="space-y-4 p-4 sm:p-6">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Venue</span>
            <select
              value={venueId ?? ""}
              onChange={(e) => setVenueId(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select a venue…</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Choose which venue this court belongs to.
            </p>
          </label>
          {selectedVenue ? (
            <AddCourt
              key={selectedVenue.id}
              venueId={selectedVenue.id}
              venueEmoji={selectedVenue.map_emoji ?? null}
              alwaysOpen
              onCancel={onClose}
              onCreated={onCreated}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Pick a venue above to start adding a court.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function EditCourt({
  court,
  venueEmoji,
  onDone,
  onCancel,
}: {
  court: Court;
  venueEmoji: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(court.name);
  const [rate, setRate] = useState(String(court.hourly_rate));
  const [sportId, setSportId] = useState<string>(String(court.sport_id ?? ""));

  const [isIndoor, setIsIndoor] = useState(court.is_indoor);
  const [comingSoon, setComingSoon] = useState(!!court.coming_soon);
  const [isActive, setIsActive] = useState(court.is_active !== false);
  const [description, setDescription] = useState(court.description ?? "");
  const [images, setImages] = useState<string[]>(court.images ?? []);
  const [mapEmoji, setMapEmoji] = useState<string | null>(court.map_emoji ?? null);
  const [surfaceType, setSurfaceType] = useState<string>(
    (court as unknown as { surface_type?: string | null }).surface_type ?? "",
  );
  const [playerCapacity, setPlayerCapacity] = useState<string>(
    ((court as unknown as { player_capacity?: number | null }).player_capacity ?? "") === null
      ? ""
      : String((court as unknown as { player_capacity?: number | null }).player_capacity ?? ""),
  );
  const [availWeekly, setAvailWeekly] = useState<Record<string, Set<number>>>(() =>
    buildInitialWeekly(court.blocked_hours),
  );
  const [availDates, setAvailDates] = useState<Record<string, Set<number>>>(() =>
    buildInitialDates(court.blocked_dates),
  );
  const [voucherEnabled, setVoucherEnabled] = useState<boolean>(!!court.voucher_enabled);
  const [rateRules, setRateRules] = useState<RateRule[]>(() => normalizeRules(court.rate_rules));
  const venueHours = useVenueHours(court.venue_id);
  const [inheritHours, setInheritHours] = useState<boolean>(court.inherit_venue_hours !== false);
  const [ownHours, setOwnHours] = useState<HoursMap>(() => normalizeHours(court.operating_hours));
  const courtHours = inheritHours ? venueHours : ownHours;
  const [err, setErr] = useState<string | null>(null);

  const sportsQ = useSportsQuery(true);
  const sharedSpaceQ = useQuery({
    queryKey: ["edit-court-shared-space", court.id, court.physical_court_id],
    enabled: !!court.physical_court_id,
    queryFn: async () => {
      const [groupRes, membersRes, rulesRes] = await Promise.all([
        supabase
          .from("physical_courts")
          .select("id, name")
          .eq("id", court.physical_court_id)
          .maybeSingle(),
        supabase
          .from("courts")
          .select("id, name, sports(name)")
          .eq("physical_court_id", court.physical_court_id)
          .order("id"),
        supabase
          .from("court_block_rules")
          .select("court_id, blocked_court_id")
          .or(`court_id.eq.${court.id},blocked_court_id.eq.${court.id}`),
      ]);
      if (groupRes.error) throw groupRes.error;
      if (membersRes.error) throw membersRes.error;
      if (rulesRes.error) throw rulesRes.error;
      const members = (membersRes.data ?? []) as Array<{
        id: number;
        name: string;
        sports: { name: string } | null;
      }>;
      const names = new Map(members.map((member) => [member.id, member.name]));
      return {
        groupName: groupRes.data?.name ?? "Shared space",
        members,
        blocks: (rulesRes.data ?? [])
          .filter((rule) => rule.court_id === court.id)
          .map((rule) => names.get(rule.blocked_court_id) ?? `Court #${rule.blocked_court_id}`),
        blockedBy: (rulesRes.data ?? [])
          .filter((rule) => rule.blocked_court_id === court.id)
          .map((rule) => names.get(rule.court_id) ?? `Court #${rule.court_id}`),
      };
    },
  });
  const selectedSport = sportsQ.data?.find((s) => String(s.id) === sportId);
  const fallbackEmoji = venueEmoji || sportEmoji(selectedSport?.slug ?? court.sports?.slug) || "🎾";
  const sharedSpace = sharedSpaceQ.data;
  const isSharedSpace = (sharedSpace?.members.length ?? 0) >= 2;

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("courts")
        .update({
          name,
          hourly_rate: Number(rate),
          sport_id: Number(sportId),

          is_indoor: isIndoor,
          coming_soon: comingSoon,
          is_active: isActive,
          description: description || null,
          images,
          map_emoji: mapEmoji,

          surface_type: surfaceType.trim() || null,
          player_capacity: playerCapacity ? Math.max(1, Math.floor(Number(playerCapacity))) : null,
          blocked_hours: weeklyToPayload(availWeekly),
          blocked_dates: datesToPayload(availDates),
          voucher_enabled: voucherEnabled,
          rate_rules: normalizeRules(rateRules),
          inherit_venue_hours: inheritHours,
          operating_hours: inheritHours ? {} : ownHours,
        })
        .eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!sportId) {
          setErr("Pick a sport");
          return;
        }
        mut.mutate();
      }}
      className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Sport</span>
          <select
            value={sportId}
            onChange={(e) => setSportId(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {(sportsQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={isIndoor}
            onChange={(e) => setIsIndoor(e.target.checked)}
          />
          Indoor court
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={comingSoon}
            onChange={(e) => setComingSoon(e.target.checked)}
          />
          Coming soon
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={voucherEnabled}
            onChange={(e) => setVoucherEnabled(e.target.checked)}
          />
          Accept vouchers
        </label>
        <CourtStatusField value={isActive} onChange={setIsActive} />
      </div>
      {isSharedSpace && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="rounded-full border border-primary/30 bg-background px-2 py-1 text-[11px] font-semibold text-primary">
            Shared space
          </span>
          <HoverCard openDelay={150} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                aria-label="Shared space details"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/50 text-[11px] font-bold text-primary hover:bg-primary/10"
              >
                ?
              </button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-80 text-xs">
              <p className="font-semibold text-foreground">Shared space details</p>
              <p className="mt-1 text-muted-foreground">
                This court belongs to{" "}
                <span className="font-medium text-foreground">{sharedSpace!.groupName}</span> with{" "}
                {sharedSpace!.members.filter((member) => member.id !== court.id).length} linked
                court{sharedSpace!.members.length === 2 ? "" : "s"}.
              </p>
              <div className="mt-3 space-y-2 rounded-lg border border-border bg-secondary/30 p-2.5">
                <p>
                  <span className="font-semibold text-foreground">Blocks:</span>{" "}
                  {sharedSpace!.blocks.length ? sharedSpace!.blocks.join(", ") : "No courts"}
                </p>
                <p>
                  <span className="font-semibold text-foreground">Blocked by:</span>{" "}
                  {sharedSpace!.blockedBy.length ? sharedSpace!.blockedBy.join(", ") : "No courts"}
                </p>
              </div>
              <p className="mt-3 text-muted-foreground">
                Manage linked courts and directional rules from the Court Groups tab.
              </p>
            </HoverCardContent>
          </HoverCard>
          <span className="text-xs text-muted-foreground">
            This court shares a physical playing area.
          </span>
        </div>
      )}
      <RateRulesEditor baseRate={Number(rate) || 0} rules={rateRules} onChange={setRateRules} />
      <CourtHoursEditor
        inherit={inheritHours}
        onInheritChange={setInheritHours}
        hours={ownHours}
        onHoursChange={setOwnHours}
        venueHours={venueHours}
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Surface type</span>
          <input
            list="court-surface-suggestions-edit"
            value={surfaceType}
            onChange={(e) => setSurfaceType(e.target.value)}
            placeholder="e.g. Hardwood, Concrete, Synthetic, Clay, Rubber, Acrylic"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <datalist id="court-surface-suggestions-edit">
            <option value="Hardwood" />
            <option value="Concrete" />
            <option value="Synthetic" />
            <option value="Acrylic" />
            <option value="Rubber" />
            <option value="Clay" />
            <option value="Grass" />
            <option value="Artificial turf" />
            <option value="Vinyl flooring" />
          </datalist>
        </label>
        <Input
          label="Player capacity (max players per match)"
          value={playerCapacity}
          onChange={setPlayerCapacity}
          type="number"
        />
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="About this Court" value={description} onChange={setDescription} />
        <ImageUploader
          label="Court photos"
          pathPrefix={`courts/${court.id}`}
          images={images}
          onChange={setImages}
        />
        <div className="rounded-xl border border-border bg-background p-3">
          <EmojiPicker
            label="Court map emoji"
            value={mapEmoji}
            fallback={fallbackEmoji}
            onChange={setMapEmoji}
            hint="Falls back to the venue emoji, then the sport default."
          />
        </div>
      </div>
      <InlineAvailability
        weekly={availWeekly}
        setWeekly={setAvailWeekly}
        dateBlocks={availDates}
        setDateBlocks={setAvailDates}
        hours={courtHours}
      />
      {err && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          disabled={mut.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {mut.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Textarea(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        rows={3}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <input
        type={props.type ?? "text"}
        required={props.required}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

export function osmEmbedUrl(lat: number, lng: number, delta = 0.005) {
  const bbox = [lng - delta, lat - delta, lng + delta, lat + delta].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
}

function VenueLocation({ venue, onSaved }: { venue: Venue; onSaved: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mapView, setMapView] = useState<"internal" | "google">("internal");
  const [internalOpen, setInternalOpen] = useState(false);

  const mut = useMutation({
    mutationFn: async ({ lat, lng }: { lat: number; lng: number }) => {
      const { error } = await supabase
        .from("venues")
        .update({ latitude: lat, longitude: lng })
        .eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setPickerOpen(false);
      setErr(null);
      onSaved();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const hasLoc = venue.latitude != null && venue.longitude != null;
  const googleEmbedUrl = (lat: number, lng: number) =>
    `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`;

  return (
    <div className="w-full sm:w-72">
      {hasLoc ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-1 border-b border-border bg-secondary/40 p-1 text-[11px]">
            <button
              type="button"
              onClick={() => setMapView("internal")}
              className={`flex-1 rounded-md px-2 py-1 font-medium transition ${mapView === "internal" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              🗺️ Internal
            </button>
            <button
              type="button"
              onClick={() => setMapView("google")}
              className={`flex-1 rounded-md px-2 py-1 font-medium transition ${mapView === "google" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              🌐 Google
            </button>
          </div>
          {mapView === "internal" ? (
            <button
              type="button"
              onClick={() => setInternalOpen(true)}
              className="group relative block w-full text-left"
              title="View on internal map"
            >
              <div className="relative h-32 w-full overflow-hidden">
                <iframe
                  key="internal"
                  title={`${venue.name} map`}
                  src={osmEmbedUrl(venue.latitude!, venue.longitude!)}
                  className="pointer-events-none absolute left-0 right-0 -top-6 h-48 w-full"
                  loading="lazy"
                />
              </div>
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-semibold text-transparent transition group-hover:bg-black/40 group-hover:text-white">
                🔍 View on map
              </span>
            </button>
          ) : (
            <a
              href={`https://www.google.com/maps?q=${venue.latitude},${venue.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="group relative block w-full"
              title="Open in Google Maps"
            >
              <div className="relative h-32 w-full overflow-hidden">
                <iframe
                  key="google"
                  title={`${venue.name} map`}
                  src={googleEmbedUrl(venue.latitude!, venue.longitude!)}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  loading="lazy"
                />
              </div>
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-semibold text-transparent transition group-hover:bg-black/40 group-hover:text-white">
                🔍 Open in Google Maps
              </span>
            </a>
          )}

          <div className="flex items-center justify-end gap-2 bg-secondary/40 px-3 py-2 text-xs">
            <button
              onClick={() => setPickerOpen(true)}
              className="rounded-md border border-border bg-background px-2 py-1 font-medium hover:border-primary hover:text-primary"
            >
              Edit pin
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full rounded-xl border-2 border-dashed border-border px-3 py-4 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary"
        >
          📍 Add map location
        </button>
      )}
      {err && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {err}
        </p>
      )}
      <MapPicker
        open={pickerOpen}
        initialLat={venue.latitude}
        initialLng={venue.longitude}
        onClose={() => setPickerOpen(false)}
        onSave={(lat, lng) => mut.mutate({ lat, lng })}
        saving={mut.isPending}
        title={`Pin ${venue.name}`}
      />
      <MapViewModal venue={internalOpen ? venue : null} onClose={() => setInternalOpen(false)} />
    </div>
  );
}

function VenueEditor({
  venue,
  courtsCount,
  initialEditing = false,
  onDoneEditing,
}: {
  venue: Venue;
  courtsCount: number;
  initialEditing?: boolean;
  onDoneEditing?: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(initialEditing);
  const [confirmDel, setConfirmDel] = useState(false);
  const [name, setName] = useState(venue.name);
  const [address, setAddress] = useState(venue.address);
  const [description, setDescription] = useState(venue.description ?? "");
  const [images, setImages] = useState<string[]>(venue.images ?? []);
  const [timezone, setTimezone] = useState(venue.timezone || "Asia/Manila");
  const [mapEmoji, setMapEmoji] = useState<string | null>(venue.map_emoji ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [tzConfirmed, setTzConfirmed] = useState(false);
  const [isActive, setIsActive] = useState(venue.is_active !== false);
  const [amenities, setAmenities] = useState<string[]>(venue.amenities ?? []);
  const [foodBeverages, setFoodBeverages] = useState<string[]>(venue.food_beverages ?? []);
  const [facilityServices, setFacilityServices] = useState<string[]>(venue.facility_services ?? []);
  const [fees, setFees] = useState<FeeItem[]>(Array.isArray(venue.fees) ? venue.fees : []);
  const [feesNotes, setFeesNotes] = useState(venue.fees_notes ?? "");
  const [contactPhone, setContactPhone] = useState(venue.contact_phone ?? "");
  const [contactEmail, setContactEmail] = useState(venue.contact_email ?? "");
  const [operatingHoursText, setOperatingHoursText] = useState(venue.operating_hours_text ?? "");
  const [openHours, setOpenHours] = useState<HoursMap>(() => normalizeHours(venue.operating_hours));
  const [conflicts, setConflicts] = useState<HoursConflict[] | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const cancelConflictsFn = useServerFn(cancelBookingsWithRefund);

  const [cancellationHours, setCancellationHours] = useState<number>(
    venue.refund_cutoff_hours ?? 24,
  );
  const [cancellationNotes, setCancellationNotes] = useState(venue.cancellation_notes ?? "");
  const [rules, setRules] = useState(venue.rules ?? "");

  const suggested = suggestTimezone(venue.latitude, venue.longitude);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);

  const hoursChanged =
    JSON.stringify(openHours) !== JSON.stringify(normalizeHours(venue.operating_hours));

  const save = useMutation({
    mutationFn: async (opts?: { force?: boolean }) => {
      if (tzMismatch && !tzConfirmed)
        throw new Error(
          `Timezone doesn't match this venue's pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`,
        );
      if (!opts?.force && hoursChanged) {
        const found = await findHoursConflicts({ venueId: venue.id, newVenueHours: openHours });
        if (found.length > 0) {
          setConflicts(found);
          return "blocked" as const;
        }
      }
      const { error } = await supabase
        .from("venues")
        .update({
          name,
          address,
          description: description || null,
          images,
          timezone,
          map_emoji: mapEmoji,
          is_active: isActive,
          amenities,
          food_beverages: foodBeverages,
          facility_services: facilityServices,
          fees: fees
            .filter((f) => f.label.trim() && Number.isFinite(f.amount))
            .map((f) => ({ label: f.label.trim(), amount: Number(f.amount) })),
          fees_notes: feesNotes.trim() || null,
          contact_phone: contactPhone.trim() || null,
          contact_email: contactEmail.trim() || null,
          operating_hours_text: operatingHoursText.trim() || null,
          operating_hours: openHours,
          refund_cutoff_hours: Number.isFinite(cancellationHours)
            ? Math.max(0, Math.floor(cancellationHours))
            : 24,
          cancellation_notes: cancellationNotes.trim() || null,
          rules: rules.trim() || null,
        })
        .eq("id", venue.id);
      if (error) throw error;
      return "saved" as const;
    },
    onSuccess: (res) => {
      if (res === "blocked") return;
      setConflicts(null);
      setEditing(false);
      setErr(null);
      setTzConfirmed(false);
      qc.invalidateQueries({ queryKey: ["my-venues"] });
      onDoneEditing?.();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: async () => {
      // Guard: block delete if any booking exists on any court of this venue
      const { data: courts, error: cErr } = await supabase
        .from("courts")
        .select("id")
        .eq("venue_id", venue.id);
      if (cErr) throw cErr;
      const courtIds = (courts ?? []).map((c) => c.id);
      if (courtIds.length > 0) {
        const { count, error: bErr } = await supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .in("court_id", courtIds);
        if (bErr) throw bErr;
        if ((count ?? 0) > 0) {
          throw new Error("This venue has existing bookings and cannot be deleted.");
        }
        const { error: dcErr } = await supabase.from("courts").delete().in("id", courtIds);
        if (dcErr) throw dcErr;
      }
      const { error } = await supabase.from("venues").delete().eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-venues"] });
      qc.invalidateQueries({ queryKey: ["venues-court-counts"] });
      qc.invalidateQueries({ queryKey: ["venues-courts-glance"] });
    },
    onError: (e: Error) => setDelErr(e.message),
  });

  if (editing) {
    return (
      <div className="rounded-xl border border-border bg-secondary/20 p-3 sm:p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Venue name" value={name} onChange={setName} required />
          <Input label="Address" value={address} onChange={setAddress} required />
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Timezone</span>
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                setTzConfirmed(false);
              }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {TIMEZONE_OPTIONS.some((t) => t.value === timezone) ? null : (
                <option value={timezone}>{timezone} (current)</option>
              )}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
            {tzMismatch && (
              <div className="mt-2 rounded-lg border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <strong>Timezone doesn't match the pin.</strong> This venue's map pin is in{" "}
                    <strong>{suggested?.country}</strong> ({suggested?.tz}). Changing it away from
                    the suggested zone means court hours and bookings will display in a different
                    local time.
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setTimezone(suggested!.tz);
                      setTzConfirmed(false);
                    }}
                    className="shrink-0 rounded-md border border-amber-500/60 bg-background px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-100"
                  >
                    Use {suggested?.tz}
                  </button>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    checked={tzConfirmed}
                    onChange={(e) => setTzConfirmed(e.target.checked)}
                  />
                  I confirm this venue uses <span className="font-mono">{timezone}</span>.
                </label>
              </div>
            )}
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">About this Venue</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Tell players what makes this venue great."
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="sm:col-span-2">
            <ImageUploader
              label="Venue photos"
              pathPrefix={`venues/${venue.id}`}
              images={images}
              onChange={setImages}
            />
          </div>
          <div className="sm:col-span-2">
            <TagInput
              label="Amenities"
              values={amenities}
              onChange={setAmenities}
              placeholder="e.g. Parking, Showers, Wi-Fi"
              hint="Press Enter or comma to add."
            />
          </div>
          <div className="sm:col-span-2">
            <TagInput
              label="Food & Beverages"
              values={foodBeverages}
              onChange={setFoodBeverages}
              placeholder="e.g. Cafe, Vending machine, Water refill"
            />
          </div>
          <div className="sm:col-span-2">
            <TagInput
              label="Facility Services"
              values={facilityServices}
              onChange={setFacilityServices}
              placeholder="e.g. Racket rental, Coaching, Ball machine"
            />
          </div>
          <div className="sm:col-span-2">
            <FeesEditor
              items={fees}
              onChange={setFees}
              notes={feesNotes}
              onNotesChange={setFeesNotes}
            />
          </div>
          <Input
            label="Inquiry phone (shown to players)"
            value={contactPhone}
            onChange={setContactPhone}
          />
          <Input label="Inquiry email (optional)" value={contactEmail} onChange={setContactEmail} />
          <div className="sm:col-span-2">
            <OperatingHoursEditor
              hours={openHours}
              onChange={setOpenHours}
              hint="Courts follow these hours by default. Players can only book inside this window, and closed hours are hidden everywhere."
            />
            <Textarea
              label="Operating hours note (optional)"
              value={operatingHoursText}
              onChange={setOperatingHoursText}
              placeholder="Extra note shown to players, e.g. Holiday hours may vary"
            />
          </div>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">
              Cancellation cutoff (hours before start)
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={cancellationHours}
              onChange={(e) => setCancellationHours(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Default 24h. Set to 0 to allow last-minute cancellations.
            </span>
          </label>
          <div className="sm:col-span-2">
            <Textarea
              label="Cancellation policy notes (optional)"
              value={cancellationNotes}
              onChange={setCancellationNotes}
              placeholder="e.g. Full refund up to 24h before. 50% within 24h. No refund after start."
            />
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label="Venue rules (one per line)"
              value={rules}
              onChange={setRules}
              placeholder={
                "e.g.\n- Wear non-marking shoes\n- No outside food or drinks\n- Arrive 10 minutes early"
              }
            />
          </div>
          <div className="sm:col-span-2 rounded-xl border border-border bg-background p-3">
            <EmojiPicker
              label="Map emoji (venue pin)"
              value={mapEmoji}
              fallback="🎾"
              onChange={setMapEmoji}
              hint="Shown on the landing-page map. Individual courts can override this."
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Active
            </label>
            <span
              tabIndex={0}
              role="button"
              aria-label="About the active status"
              title={ACTIVE_INFO_TEXT}
              className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-muted-foreground/40 text-[10px] font-bold text-muted-foreground hover:border-primary hover:text-primary"
            >
              ?
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              Untick to hide this venue from players.
            </span>
          </div>
        </div>
        {err && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {err}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => save.mutate({})}
            disabled={save.isPending || (tzMismatch && !tzConfirmed)}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setName(venue.name);
              setAddress(venue.address);
              setDescription(venue.description ?? "");
              setImages(venue.images ?? []);
              setTimezone(venue.timezone || "Asia/Manila");
              setMapEmoji(venue.map_emoji ?? null);
              setTzConfirmed(false);
              setIsActive(venue.is_active !== false);
              setAmenities(venue.amenities ?? []);
              setFoodBeverages(venue.food_beverages ?? []);
              setFacilityServices(venue.facility_services ?? []);
              setFees(Array.isArray(venue.fees) ? venue.fees : []);
              setFeesNotes(venue.fees_notes ?? "");
              setContactPhone(venue.contact_phone ?? "");
              setContactEmail(venue.contact_email ?? "");
              setOperatingHoursText(venue.operating_hours_text ?? "");
              setCancellationHours(venue.refund_cutoff_hours ?? 24);
              setCancellationNotes(venue.cancellation_notes ?? "");
              setRules(venue.rules ?? "");
              setErr(null);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
        </div>

        {conflicts && conflicts.length > 0 && (
          <HoursConflictDialog
            conflicts={conflicts}
            busy={conflictBusy || save.isPending}
            onDismiss={() => setConflicts(null)}
            onKeep={() => save.mutate({ force: true })}
            onCancelThem={async () => {
              setConflictBusy(true);
              try {
                await cancelConflictsFn({
                  data: {
                    bookingIds: conflicts.flatMap((c) => c.bookingIds),
                    reason:
                      "The venue's operating hours changed and this slot is no longer available.",
                    refundMode: "auto",
                  },
                });
                save.mutate({ force: true });
              } catch (e) {
                setErr((e as Error).message);
                setConflicts(null);
              } finally {
                setConflictBusy(false);
              }
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <h2 className="text-xl font-bold">{venue.name}</h2>
      <p className="text-sm text-muted-foreground">
        {venue.address} · {venue.timezone}
      </p>
      {venue.description && (
        <p className="mt-1 text-sm text-muted-foreground">{venue.description}</p>
      )}
      {(venue.images?.length ?? 0) > 0 && (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {venue.images!.slice(0, 4).map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`${venue.name} ${i + 1}`}
              className="h-16 w-24 flex-none rounded-md object-cover"
              loading="lazy"
            />
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => setEditing(true)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:border-primary hover:text-primary"
        >
          ✎ Edit venue
        </button>
        {!confirmDel ? (
          <button
            onClick={() => {
              setConfirmDel(true);
              setDelErr(null);
            }}
            className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            Delete venue
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1">
            <span className="text-xs">
              Delete "{venue.name}"
              {courtsCount > 0
                ? ` and its ${courtsCount} court${courtsCount === 1 ? "" : "s"}`
                : ""}
              ?
            </span>
            <button
              onClick={() => del.mutate()}
              disabled={del.isPending}
              className="rounded-md bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60"
            >
              {del.isPending ? "Deleting…" : "Confirm"}
            </button>
            <button
              onClick={() => setConfirmDel(false)}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {delErr && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {delErr}
        </p>
      )}
    </div>
  );
}

function SettingsSection({
  fullName,
  email,
  role,
  userId,
  avatarUrl,
  onSaved,
}: {
  fullName: string;
  email: string;
  role: string;
  userId: string;
  avatarUrl: string | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(fullName);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const qc = useQueryClient();

  const paySettingsQ = useQuery({
    queryKey: ["venue-payment-settings"],
    enabled: role === "tenant",
    queryFn: async () => {
      /* Newest venue first. A tenant who has just added one comes straight here to
         set its payment mode, so it should be the row they land on rather than the
         one they page to the end to find. Ordered in SQL, not in the component, so
         paging cannot disagree with sorting. */
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, payment_mode, refund_cutoff_hours")
        .order("id", { ascending: false });
      if (error) throw error;
      return data as {
        id: number;
        name: string;
        payment_mode: string;
        refund_cutoff_hours: number;
      }[];
    },
  });

  const savePaymentSettings = async (venueId: number, mode: string, cutoff: number) => {
    const { error } = await supabase
      .from("venues")
      .update({ payment_mode: mode, refund_cutoff_hours: cutoff })
      .eq("id", venueId);
    if (error) alert(error.message);
    else qc.invalidateQueries({ queryKey: ["venue-payment-settings"] });
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: name.trim() })
      .eq("id", userId);
    setSaving(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setMsg("Saved.");
    onSaved();
  };

  const signOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return (
    <div className="space-y-6">
      <SectionHeader title="Settings" subtitle="Manage your account and preferences." />

      {/* Both cards are the ones the player workspace uses. A profile picture belongs
          to the signed-in account, not to a role, so the storage path, the policies
          and the validation are shared rather than duplicated. */}
      {role === "tenant" && userId && (
        <>
          <ProfileSettingsCard
            userId={userId}
            fullName={fullName}
            email={email}
            avatarUrl={avatarUrl}
            role="tenant"
            onSaved={onSaved}
          />
          <NotificationSettingsCard userId={userId} email={email} role="tenant" />
        </>
      )}

      <div
        id={TENANT_ANCHORS.account}
        className="rounded-2xl border border-border bg-card p-5 sm:p-6"
      >
        <h3 className="text-base font-semibold">Account</h3>
        <p className="mt-1 text-xs text-muted-foreground">Your profile information.</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Full name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              placeholder="Your full name"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input
              value={email}
              readOnly
              className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Role</span>
            <input
              value={role}
              readOnly
              className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm capitalize text-muted-foreground"
            />
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            onClick={save}
            disabled={saving || !name.trim() || name.trim() === fullName}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {msg && <span className="text-xs text-primary">{msg}</span>}
          {err && <span className="text-xs text-destructive">{err}</span>}
        </div>
      </div>

      {role === "tenant" && (
        <div
          id={TENANT_ANCHORS.payments}
          className="rounded-2xl border border-border bg-card p-5 sm:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Payment configuration</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Settle at venue keeps payment offline. Choose <b>Full payment</b> to collect the
                whole amount online through GCash, Maya, GrabPay and QR Ph. Refund cutoff blocks
                player-initiated refunds inside the window before the booking.
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-[11px] font-semibold">
              PayMongo · Test mode
            </span>
          </div>
          <PaymentSettingsTable
            venues={paySettingsQ.data ?? []}
            loading={paySettingsQ.isLoading}
            onSave={savePaymentSettings}
          />
        </div>
      )}

      <div className="rounded-2xl border border-destructive/30 bg-card p-5 sm:p-6">
        <h3 className="text-base font-semibold">Session</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Sign out of your CourtHub account on this device.
        </p>
        <button
          onClick={signOut}
          disabled={signingOut}
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive disabled:opacity-60"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

// ================= Venues & Courts tabs =================

function VenuesCourtsTabs({
  venues,
  tab,
  setTab,
}: {
  venues: Venue[];
  tab: TenantCourtsTab;
  setTab: (t: TenantCourtsTab) => void;
}) {
  const venueIds = venues.map((v) => v.id);
  const courtsTotalQ = useQuery({
    queryKey: ["venues-court-counts", venueIds],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("venue_id")
        .in("venue_id", venueIds);
      if (error) throw error;
      const map: Record<number, number> = {};
      (data ?? []).forEach((c: any) => {
        map[c.venue_id] = (map[c.venue_id] ?? 0) + 1;
      });
      return map;
    },
  });
  const courtsTotal = Object.values(courtsTotalQ.data ?? {}).reduce((a, b) => a + b, 0);
  const groupsTotalQ = useQuery({
    queryKey: ["venues-group-counts", venueIds],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data: pcs, error } = await supabase
        .from("physical_courts")
        .select("id")
        .in("venue_id", venueIds);
      if (error) throw error;
      const pcIds = (pcs ?? []).map((p: any) => p.id);
      if (pcIds.length === 0) return 0;
      const { data: cs, error: cErr } = await supabase
        .from("courts")
        .select("physical_court_id")
        .in("physical_court_id", pcIds);
      if (cErr) throw cErr;
      const counts = new Map<number, number>();
      (cs ?? []).forEach((c: any) =>
        counts.set(c.physical_court_id, (counts.get(c.physical_court_id) ?? 0) + 1),
      );
      // Mirror the Court Groups table: only surfaces shared by 2+ courts are real groups
      return pcIds.filter((id) => (counts.get(id) ?? 0) >= 2).length;
    },
  });
  const groupsTotal = groupsTotalQ.data ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex border-b border-border bg-secondary/30">
        <TabBtn active={tab === "venues"} onClick={() => setTab("venues")}>
          Venues{" "}
          <span className="ml-1.5 inline-flex min-w-5.5 items-center justify-center rounded-full bg-linear-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">
            {venues.length}
          </span>
        </TabBtn>
        <TabBtn active={tab === "courts"} onClick={() => setTab("courts")}>
          Courts{" "}
          <span className="ml-1.5 inline-flex min-w-5.5 items-center justify-center rounded-full bg-linear-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">
            {courtsTotal}
          </span>
        </TabBtn>

        <TabBtn active={tab === "groups"} onClick={() => setTab("groups")}>
          Court Groups{" "}
          <span className="ml-1.5 inline-flex min-w-5.5 items-center justify-center rounded-full bg-linear-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">
            {groupsTotal}
          </span>
          <span className="group relative ml-1 inline-flex">
            <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none opacity-70">
              ?
            </span>
            <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-left text-xs font-normal normal-case text-popover-foreground shadow-lg group-hover:block">
              <span className="block font-semibold text-primary">
                What is a Court Group / Physical Surface?
              </span>
              <span className="mt-1 block text-muted-foreground">
                One shared space can host different sports — e.g. <b>1 basketball</b> ↔{" "}
                <b>3 badminton</b> ↔ <b>4 pickleball</b>. Group those courts here so a booking on
                one automatically blocks the conflicting slots on the others.
              </span>
            </span>
          </span>
        </TabBtn>
      </div>
      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto overflow-x-auto">
        {tab === "venues" && <VenuesTab venues={venues} />}
        {tab === "courts" && <CourtsTab venues={venues} />}
        {tab === "groups" && <CourtGroupsTab venues={venues} />}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "relative px-4 sm:px-6 py-3 text-sm font-semibold transition " +
        (active ? "text-foreground" : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
    </button>
  );
}

const VENUE_COLUMNS: Array<{ id: string; label: string; required?: boolean; defaultOn?: boolean }> =
  [
    { id: "emoji", label: "Emoji", defaultOn: true },
    { id: "name", label: "Venue", required: true, defaultOn: true },
    { id: "location", label: "Location", defaultOn: true },
    { id: "description", label: "About this Venue", defaultOn: true },
    { id: "created_at", label: "Created At", defaultOn: true },
    { id: "map", label: "Map", defaultOn: true },
    { id: "courts", label: "Courts", defaultOn: true },
    { id: "status", label: "Venue Status", defaultOn: true },
    { id: "actions", label: "Actions", required: true, defaultOn: true },
    { id: "history", label: "History", defaultOn: true },
    // Optional (off by default) — surfaced from create/edit venue panels
    { id: "amenities", label: "Amenities" },
    { id: "food_beverages", label: "Food & Beverages" },
    { id: "facility_services", label: "Facility Services" },
    { id: "fees", label: "Fees & Charges" },
    { id: "contact_phone", label: "Inquiry Phone" },
    { id: "contact_email", label: "Inquiry Email" },
    { id: "operating_hours", label: "Operating Hours" },
    { id: "cancellation", label: "Cancellation Policy" },
    { id: "rules", label: "Venue Rules" },
  ];
const VENUE_COLS_STORAGE_KEY = "venues-tab-columns-v1";
const DEFAULT_VENUE_COLS = VENUE_COLUMNS.filter((c) => c.defaultOn || c.required).map((c) => c.id);

type ColumnDef = { id: string; label: string; required?: boolean; defaultOn?: boolean };

const COURT_COLUMNS: ColumnDef[] = [
  { id: "emoji", label: "Emoji", defaultOn: true },
  { id: "name", label: "Court", required: true, defaultOn: true },
  { id: "description", label: "About This Court", defaultOn: true },
  { id: "venue", label: "Venue", defaultOn: true },
  { id: "sport", label: "Sport", defaultOn: true },
  { id: "type", label: "Type", defaultOn: true },
  { id: "rate", label: "Rate / hr", defaultOn: true },
  { id: "status", label: "Status", defaultOn: true },
  { id: "created_at", label: "Created At", defaultOn: true },
  { id: "actions", label: "Actions", required: true, defaultOn: true },
  // Optional (off by default)
  { id: "history", label: "History" },
  { id: "voucher", label: "Voucher" },
  { id: "surface", label: "Surface" },
  { id: "capacity", label: "Capacity" },
];
const COURT_COLS_STORAGE_KEY = "courts-tab-columns-v1";
const DEFAULT_COURT_COLS = COURT_COLUMNS.filter((c) => c.defaultOn || c.required).map((c) => c.id);

const GROUP_COLUMNS: ColumnDef[] = [
  { id: "emoji", label: "Emoji", defaultOn: true },
  { id: "name", label: "Group", required: true, defaultOn: true },
  { id: "description", label: "About this group", defaultOn: true },
  { id: "courts_count", label: "Courts", defaultOn: true },
  { id: "rules", label: "Blocking rules", defaultOn: true },
  { id: "actions", label: "Actions", required: true, defaultOn: true },
  // Optional (off by default)
  { id: "sports", label: "Sports" },
];
const GROUP_COLS_STORAGE_KEY = "groups-tab-columns-v1";
const DEFAULT_GROUP_COLS = GROUP_COLUMNS.filter((c) => c.defaultOn || c.required).map((c) => c.id);



function useColumnPrefs(
  columns: ColumnDef[],
  defaults: string[],
  storageKey: string,
  prefKey: string,
) {
  const [selected, setSelected] = useState<string[]>(defaults);
  const sanitize = (arr: string[]) => {
    const valid = arr.filter((id) => columns.some((c) => c.id === id));
    const required = columns.filter((c) => c.required).map((c) => c.id);
    return [...required.filter((id) => !valid.includes(id)), ...valid];
  };
  useEffect(() => {
    // 1) instant paint from localStorage
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setSelected(sanitize(JSON.parse(raw) as string[]));
    } catch {}
    // 2) authoritative load from Supabase (per-user, follows sign-in)
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data } = await supabase
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", uid)
        .maybeSingle();
      const cols = (data?.prefs as any)?.[prefKey] as string[] | undefined;
      if (Array.isArray(cols) && cols.length) {
        const merged = sanitize(cols);
        setSelected(merged);
        try {
          localStorage.setItem(storageKey, JSON.stringify(merged));
        } catch {}
      }
    })();
  }, []);
  const save = (next: string[]) => {
    const clean = sanitize(next);
    setSelected(clean);
    try {
      localStorage.setItem(storageKey, JSON.stringify(clean));
    } catch {}
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data: existing } = await supabase
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", uid)
        .maybeSingle();
      const merged = { ...((existing?.prefs as any) ?? {}), [prefKey]: clean };
      await supabase
        .from("user_preferences")
        .upsert(
          { user_id: uid, prefs: merged, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
    })();
  };
  return { selected, save };
}

const useVenueColumns = () =>
  useColumnPrefs(VENUE_COLUMNS, DEFAULT_VENUE_COLS, VENUE_COLS_STORAGE_KEY, "venues_columns");
const useCourtColumns = () =>
  useColumnPrefs(COURT_COLUMNS, DEFAULT_COURT_COLS, COURT_COLS_STORAGE_KEY, "courts_columns");
const useGroupColumns = () =>
  useColumnPrefs(GROUP_COLUMNS, DEFAULT_GROUP_COLS, GROUP_COLS_STORAGE_KEY, "groups_columns");

type ColumnPreset = { name: string; columns: string[] };

function useColumnPresets(prefKey: string) {
  const [presets, setPresets] = useState<ColumnPreset[]>([]);
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data } = await supabase
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", uid)
        .maybeSingle();
      const list = (data?.prefs as any)?.[prefKey] as ColumnPreset[] | undefined;
      if (Array.isArray(list)) setPresets(list);
    })();
  }, [prefKey]);
  const persist = async (next: ColumnPreset[]) => {
    setPresets(next);
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    if (!uid) return;
    const { data: existing } = await supabase
      .from("user_preferences")
      .select("prefs")
      .eq("user_id", uid)
      .maybeSingle();
    const merged = { ...((existing?.prefs as any) ?? {}), [prefKey]: next };
    await supabase
      .from("user_preferences")
      .upsert(
        { user_id: uid, prefs: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
  };
  return { presets, persist };
}

function ColumnConfigModal({
  open,
  onClose,
  selected,
  onApply,
  columns = VENUE_COLUMNS,
  defaults = DEFAULT_VENUE_COLS,
  presetKey = "venues_column_presets",
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onApply: (next: string[]) => void;
  columns?: ColumnDef[];
  defaults?: string[];
  presetKey?: string;
}) {
  const [localSelected, setLocalSelected] = useState<string[]>(selected);
  const [availActive, setAvailActive] = useState<string | null>(null);
  const [selActive, setSelActive] = useState<string | null>(null);
  const [availQuery, setAvailQuery] = useState("");
  const [selQuery, setSelQuery] = useState("");
  const [presetName, setPresetName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const { presets, persist } = useColumnPresets(presetKey);
  useEffect(() => {
    if (open) {
      setLocalSelected(selected);
      setAvailActive(null);
      setSelActive(null);
      setAvailQuery("");
      setSelQuery("");
      setPresetName("");
      setShowSaveForm(false);
      setDeleteTarget(null);
    }
  }, [open, selected]);
  if (!open) return null;

  const availableCols = columns.filter((c) => !localSelected.includes(c.id));
  const selectedCols = localSelected
    .map((id) => columns.find((c) => c.id === id))
    .filter(Boolean) as ColumnDef[];
  const filteredAvail = availableCols.filter((c) =>
    c.label.toLowerCase().includes(availQuery.toLowerCase()),
  );
  const filteredSel = selectedCols.filter((c) =>
    c.label.toLowerCase().includes(selQuery.toLowerCase()),
  );
  const moveToSelected = () => {
    if (!availActive) return;
    setLocalSelected([...localSelected, availActive]);
    setAvailActive(null);
  };
  const moveToAvailable = () => {
    if (!selActive) return;
    const col = columns.find((c) => c.id === selActive);
    if (col?.required) return;
    setLocalSelected(localSelected.filter((id) => id !== selActive));
    setSelActive(null);
  };
  const moveUp = () => {
    if (!selActive) return;
    const idx = localSelected.indexOf(selActive);
    if (idx <= 0) return;
    const next = [...localSelected];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setLocalSelected(next);
  };
  const moveDown = () => {
    if (!selActive) return;
    const idx = localSelected.indexOf(selActive);
    if (idx < 0 || idx >= localSelected.length - 1) return;
    const next = [...localSelected];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    setLocalSelected(next);
  };
  const resetDefault = () => setLocalSelected(defaults);
  const apply = () => {
    onApply(localSelected);
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-base font-semibold">Column Configuration</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Presets bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/20 px-5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Bookmark className="h-3.5 w-3.5" /> Presets
          </div>
          <select
            value=""
            onChange={(e) => {
              const p = presets.find((x) => x.name === e.target.value);
              if (p) setLocalSelected(p.columns);
              e.currentTarget.value = "";
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          >
            <option value="">{presets.length ? "Load preset…" : "No presets yet"}</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          {presets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const name = e.target.value;
                if (!name) return;
                setDeleteTarget(name);
                e.currentTarget.value = "";
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive outline-none focus:border-destructive"
            >
              <option value="">Delete…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto flex items-center gap-2">
            {showSaveForm ? (
              <>
                <input
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset name"
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const n = presetName.trim();
                      if (!n) return;
                      const next = presets.some((p) => p.name === n)
                        ? presets.map((p) =>
                            p.name === n ? { name: n, columns: localSelected } : p,
                          )
                        : [...presets, { name: n, columns: localSelected }];
                      persist(next);
                      setPresetName("");
                      setShowSaveForm(false);
                    }
                    if (e.key === "Escape") {
                      setShowSaveForm(false);
                      setPresetName("");
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const n = presetName.trim();
                    if (!n) return;
                    const next = presets.some((p) => p.name === n)
                      ? presets.map((p) => (p.name === n ? { name: n, columns: localSelected } : p))
                      : [...presets, { name: n, columns: localSelected }];
                    persist(next);
                    setPresetName("");
                    setShowSaveForm(false);
                  }}
                  className="rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowSaveForm(false);
                    setPresetName("");
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowSaveForm(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20"
              >
                <Save className="h-3.5 w-3.5" /> Save as preset
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-[1fr_auto_1fr]">
          {/* Available */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Available Columns</div>
            <div className="relative mb-2">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={availQuery}
                onChange={(e) => setAvailQuery(e.target.value)}
                placeholder="Search…"
                className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary"
              />
            </div>
            <ul className="h-56 overflow-y-auto rounded-md border border-border bg-secondary/20">
              {filteredAvail.length === 0 && (
                <li className="p-3 text-center text-xs italic text-muted-foreground">No columns</li>
              )}
              {filteredAvail.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setAvailActive(c.id)}
                    onDoubleClick={() => {
                      setLocalSelected([...localSelected, c.id]);
                      setAvailActive(null);
                    }}
                    className={
                      "block w-full px-3 py-1.5 text-left text-xs transition " +
                      (availActive === c.id
                        ? "bg-primary/15 text-foreground"
                        : "text-foreground/80 hover:bg-secondary")
                    }
                  >
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {/* Arrows */}
          <div className="flex flex-row items-center justify-center gap-2 sm:flex-col">
            <button
              type="button"
              onClick={moveToSelected}
              disabled={!availActive}
              title="Add"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={moveToAvailable}
              disabled={!selActive || columns.find((c) => c.id === selActive)?.required}
              title="Remove"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
          {/* Selected */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Selected Columns</div>
            <div className="relative mb-2 flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={selQuery}
                  onChange={(e) => setSelQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary"
                />
              </div>
              <button
                type="button"
                onClick={moveUp}
                disabled={!selActive}
                title="Move up"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={moveDown}
                disabled={!selActive}
                title="Move down"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="h-56 overflow-y-auto rounded-md border border-border bg-secondary/20">
              {filteredSel.length === 0 && (
                <li className="p-3 text-center text-xs italic text-muted-foreground">No columns</li>
              )}
              {filteredSel.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelActive(c.id)}
                    onDoubleClick={() => {
                      if (!c.required) {
                        setLocalSelected(localSelected.filter((id) => id !== c.id));
                        setSelActive(null);
                      }
                    }}
                    className={
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition " +
                      (selActive === c.id
                        ? "bg-primary/15 text-foreground"
                        : "text-foreground/80 hover:bg-secondary")
                    }
                  >
                    <span>{c.label}</span>
                    {c.required && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Required
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={resetDefault}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide hover:bg-secondary"
          >
            Reset to Default
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary-foreground hover:bg-primary/90"
            >
              OK
            </button>
          </div>
        </div>
      </div>
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the preset{" "}
              <span className="font-semibold text-foreground">"{deleteTarget}"</span>. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) persist(presets.filter((p) => p.name !== deleteTarget));
                setDeleteTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VenuesTab({ venues }: { venues: Venue[] }) {
  const [editing, setEditing] = useState<Venue | null>(null);
  const [viewing, setViewing] = useState<Venue | null>(null);
  const [history, setHistory] = useState<Venue | null>(null);
  const [courtsFor, setCourtsFor] = useState<Venue | null>(null);
  const [colCfgOpen, setColCfgOpen] = useState(false);
  const { selected: visibleCols, save: saveCols } = useVenueColumns();

  const venueIds = venues.map((v) => v.id);
  const courtsCountQ = useQuery({
    queryKey: ["venues-court-counts", venueIds],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("venue_id")
        .in("venue_id", venueIds);
      if (error) throw error;
      const map: Record<number, number> = {};
      (data ?? []).forEach((c: any) => {
        map[c.venue_id] = (map[c.venue_id] ?? 0) + 1;
      });
      return map;
    },
  });
  const countFor = (id: number) => courtsCountQ.data?.[id] ?? 0;

  const renderHeader = (id: string) => {
    switch (id) {
      case "emoji":
        return (
          <th key={id} className="px-2 py-2 w-10">
            <button
              type="button"
              onClick={() => setColCfgOpen(true)}
              title="Configure columns"
              aria-label="Configure columns"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
            >
              <TableProperties className="h-4 w-4" />
            </button>
          </th>
        );
      case "name":
        return (
          <th key={id} className="px-3 py-2.5">
            Venue
          </th>
        );
      case "location":
        return (
          <th key={id} className="px-3 py-2.5">
            Location
          </th>
        );
      case "description":
        return (
          <th key={id} className="px-3 py-2.5">
            ABOUT THIS VENUE
          </th>
        );
      case "created_at":
        return (
          <th key={id} className="px-3 py-2.5 w-32">
            CREATED AT
          </th>
        );
      case "map":
        return (
          <th key={id} className="px-3 py-2.5 w-20 text-center">
            Map
          </th>
        );
      case "courts":
        return (
          <th key={id} className="px-3 py-2.5 w-24 text-center">
            Courts
          </th>
        );
      case "status":
        return (
          <th key={id} className="px-3 py-2.5 w-28 text-center">
            Status
          </th>
        );
      case "actions":
        return (
          <th key={id} className="px-3 py-2.5 w-40 text-right">
            Actions
          </th>
        );
      case "history":
        return (
          <th key={id} className="px-3 py-2.5 w-24 text-center">
            History
          </th>
        );
      case "amenities":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Amenities
          </th>
        );
      case "food_beverages":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Food & Beverages
          </th>
        );
      case "facility_services":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Facility Services
          </th>
        );
      case "fees":
        return (
          <th key={id} className="px-3 py-2.5 w-24 text-center">
            Fees
          </th>
        );
      case "contact_phone":
        return (
          <th key={id} className="px-3 py-2.5 w-36">
            Inquiry Phone
          </th>
        );
      case "contact_email":
        return (
          <th key={id} className="px-3 py-2.5 w-48">
            Inquiry Email
          </th>
        );
      case "operating_hours":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Operating Hours
          </th>
        );
      case "cancellation":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Cancellation
          </th>
        );
      case "rules":
        return (
          <th key={id} className="px-3 py-2.5 w-50">
            Rules
          </th>
        );
      default:
        return null;
    }
  };

  const renderCell = (id: string, v: Venue, idx: number) => {
    switch (id) {
      case "emoji":
        return (
          <td key={id} className="px-4 py-3 text-xl leading-none">
            {v.map_emoji ?? "🎾"}
          </td>
        );
      case "name":
        return (
          <td key={id} className="px-3 py-3 whitespace-nowrap">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="font-semibold whitespace-nowrap">{v.name}</span>
              {idx === 0 && venues.length > 1 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-linear-to-r from-primary via-cyan-400 to-sky-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.7)] ring-1 ring-white/40">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  Newest
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">{v.timezone}</div>
          </td>
        );
      case "location":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground min-w-45">
            {v.address}
          </td>
        );
      case "description":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-60 min-w-60 max-w-60">
            {v.description ? (
              v.description.length > 40 ? (
                <HoverCard openDelay={80} closeDelay={200}>
                  <HoverCardTrigger asChild>
                    <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40">
                      {v.description}
                    </span>
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={16}
                    avoidCollisions
                    className="w-[min(32rem,92vw)] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed"
                    style={{
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      maxHeight: "var(--radix-hover-card-content-available-height)",
                    }}
                  >
                    {v.description}
                  </HoverCardContent>
                </HoverCard>
              ) : (
                <span className="block w-full truncate">{v.description}</span>
              )
            ) : (
              <span className="italic opacity-60">No description</span>
            )}
          </td>
        );
      case "created_at":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground whitespace-nowrap">
            {v.created_at ? (
              <div className="flex flex-col">
                <span className="text-foreground">
                  {new Date(v.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(v.created_at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ) : (
              <span className="italic opacity-60">—</span>
            )}
          </td>
        );
      case "map":
        return (
          <td key={id} className="px-3 py-3 text-center">
            {v.latitude != null && v.longitude != null ? (
              <button
                type="button"
                onClick={() => setViewing(v)}
                title="View on map"
                aria-label={`View ${v.name} on map`}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
              >
                <MapPin className="h-4 w-4" />
              </button>
            ) : (
              <span className="text-xs text-muted-foreground italic">No pin</span>
            )}
          </td>
        );
      case "courts": {
        const n = countFor(v.id);
        const has = n > 0;
        return (
          <td key={id} className="px-3 py-3 text-center">
            <button
              type="button"
              onClick={() => setCourtsFor(v)}
              title={
                has ? `View ${n} court${n === 1 ? "" : "s"} under this venue` : "No courts yet"
              }
              aria-label={`View courts under ${v.name}`}
              className={
                "relative inline-flex h-9 w-9 items-center justify-center rounded-full border transition " +
                (has
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500 hover:bg-emerald-500/20"
                  : "border-border text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary")
              }
            >
              <Layers className="h-4 w-4" />
              {has && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-white text-[10px] font-semibold leading-4 text-center shadow">
                  {n}
                </span>
              )}
            </button>
          </td>
        );
      }
      case "status": {
        const active = v.is_active !== false;
        return (
          <td key={id} className="px-3 py-3 text-center">
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold " +
                (active
                  ? "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30"
                  : "bg-red-500/10 text-red-600 ring-1 ring-red-500/30")
              }
            >
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (active ? "bg-emerald-500 animate-pulse" : "bg-red-500")
                }
              />
              {active ? "Active" : "Inactive"}
            </span>
          </td>
        );
      }
      case "actions":
        return (
          <td key={id} className="px-3 py-3">
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setEditing(v)}
                title="Edit venue"
                aria-label={`Edit ${v.name}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <DeleteVenueButton venue={v} />
            </div>
          </td>
        );
      case "history":
        return (
          <td key={id} className="px-3 py-3 text-center">
            <button
              type="button"
              onClick={() => setHistory(v)}
              title="Audit history"
              aria-label={`View audit history for ${v.name}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
            >
              <HistoryIcon className="h-4 w-4" />
            </button>
          </td>
        );
      case "amenities":
      case "food_beverages":
      case "facility_services": {
        const arr =
          (id === "amenities"
            ? v.amenities
            : id === "food_beverages"
              ? v.food_beverages
              : v.facility_services) ?? [];
        if (!arr.length)
          return (
            <td key={id} className="px-3 py-3 text-muted-foreground">
              <span className="italic opacity-60">—</span>
            </td>
          );
        const text = arr.join(", ");
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-50 min-w-50 max-w-50">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">
                  {text}
                </span>
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                align="start"
                sideOffset={6}
                collisionPadding={16}
                avoidCollisions
                className="w-[min(32rem,92vw)] overflow-y-auto text-xs"
                style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}
              >
                <div className="flex flex-wrap gap-1">
                  {arr.map((t, i) => (
                    <span key={i} className="rounded-full bg-secondary px-2 py-0.5">
                      {t}
                    </span>
                  ))}
                </div>
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "fees": {
        const feesArr = Array.isArray(v.fees) ? (v.fees as FeeItem[]) : [];
        if (!feesArr.length && !v.fees_notes)
          return (
            <td key={id} className="px-3 py-3 text-center text-muted-foreground">
              <span className="italic opacity-60">—</span>
            </td>
          );
        return (
          <td key={id} className="px-3 py-3 text-center">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary cursor-help">
                  {feesArr.length} item{feesArr.length === 1 ? "" : "s"}
                </span>
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                align="center"
                sideOffset={6}
                collisionPadding={16}
                avoidCollisions
                className="w-[min(28rem,92vw)] overflow-y-auto text-xs"
                style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}
              >
                <ul className="space-y-1">
                  {feesArr.map((f, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span>{f.label}</span>
                      <span className="font-semibold">₱{Number(f.amount).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
                {v.fees_notes && (
                  <p className="mt-2 border-t border-border pt-2 text-muted-foreground whitespace-pre-wrap">
                    {v.fees_notes}
                  </p>
                )}
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "contact_phone":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground whitespace-nowrap text-xs">
            {v.contact_phone || <span className="italic opacity-60">—</span>}
          </td>
        );
      case "contact_email":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground whitespace-nowrap text-xs">
            {v.contact_email || <span className="italic opacity-60">—</span>}
          </td>
        );
      case "operating_hours":
      case "rules": {
        const text = id === "operating_hours" ? v.operating_hours_text : v.rules;
        if (!text)
          return (
            <td key={id} className="px-3 py-3 text-muted-foreground w-50">
              <span className="italic opacity-60">—</span>
            </td>
          );
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-50 min-w-50 max-w-50">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">
                  {text}
                </span>
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                align="start"
                sideOffset={6}
                collisionPadding={16}
                avoidCollisions
                className="w-[min(32rem,92vw)] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed"
                style={{
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  maxHeight: "var(--radix-hover-card-content-available-height)",
                }}
              >
                {text}
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "cancellation": {
        const hrs = (v as any).refund_cutoff_hours as number | null | undefined;
        const notes = v.cancellation_notes;
        if (hrs == null && !notes)
          return (
            <td key={id} className="px-3 py-3 text-muted-foreground w-50">
              <span className="italic opacity-60">—</span>
            </td>
          );
        const summary = hrs != null ? `Cancel up to ${hrs}h before` : "See notes";
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-50 min-w-50 max-w-50">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">
                  {summary}
                  {notes ? ` — ${notes}` : ""}
                </span>
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                align="start"
                sideOffset={6}
                collisionPadding={16}
                avoidCollisions
                className="w-[min(32rem,92vw)] overflow-y-auto text-xs"
                style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}
              >
                <p className="font-semibold text-foreground">{summary}</p>
                {notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{notes}</p>}
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      default:
        return null;
    }
  };

  return (
    <>
      <table className="w-full min-w-245 text-sm">
        <thead className="sticky top-0 z-10 bg-secondary/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
          <tr>
            {!visibleCols.includes("emoji") && (
              <th className="w-8 pl-2 pr-0 py-2">
                <button
                  type="button"
                  onClick={() => setColCfgOpen(true)}
                  title="Configure columns"
                  aria-label="Configure columns"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
                >
                  <TableProperties className="h-4 w-4" />
                </button>
              </th>
            )}
            {visibleCols.map((id) => renderHeader(id))}
          </tr>
        </thead>
        <tbody>
          {venues.map((v, idx) => (
            <tr key={v.id} className="border-t border-border align-top hover:bg-secondary/20">
              {!visibleCols.includes("emoji") && <td className="w-8 pl-2 pr-0 py-3" />}
              {visibleCols.map((id) => renderCell(id, v, idx))}
            </tr>
          ))}
        </tbody>
      </table>
      <ColumnConfigModal
        open={colCfgOpen}
        onClose={() => setColCfgOpen(false)}
        selected={visibleCols}
        onApply={saveCols}
      />

      <EditVenueDrawer venue={editing} onClose={() => setEditing(null)} />
      <MapViewModal venue={viewing} onClose={() => setViewing(null)} />
      <AuditHistoryModal venue={history} onClose={() => setHistory(null)} />
      <VenueCourtsModal venue={courtsFor} onClose={() => setCourtsFor(null)} />
    </>
  );
}

function VenueCourtsModal({ venue, onClose }: { venue: Venue | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["venue-courts-list", venue?.id],
    enabled: !!venue,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, coming_soon, map_emoji, sports(name)")
        .eq("venue_id", venue!.id)
        .order("id");
      if (error) throw error;
      return data as Array<{
        id: number;
        name: string;
        hourly_rate: number;
        is_indoor: boolean;
        coming_soon: boolean | null;
        map_emoji: string | null;
        sports: { name: string } | null;
      }>;
    },
  });
  if (!venue) return null;
  const courts = data ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-bold">Courts at {venue.name}</h3>
            <p className="text-xs text-muted-foreground">
              View only — {courts.length} court{courts.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {isLoading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : courts.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground italic">
              No courts yet under this venue.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {courts.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-3">
                  <span className="text-2xl leading-none">{c.map_emoji ?? "🎾"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{c.name}</span>
                      {c.coming_soon && (
                        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                          Coming soon
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.sports?.name ?? "Sport"} · {c.is_indoor ? "Indoor" : "Outdoor"}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-sm font-semibold text-primary">
                    ₱{Number(c.hourly_rate).toFixed(0)}
                    <span className="text-[10px] font-normal text-muted-foreground"> /hr</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

type AuditEntry = {
  id: number;
  venue_id: number;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  changes: Record<string, unknown> | null;
  created_at: string;
};

function AuditHistoryModal({ venue, onClose }: { venue: Venue | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["venue-audit", venue?.id],
    enabled: !!venue,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venue_audit_log" as never)
        .select("*")
        .eq("venue_id", venue!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AuditEntry[];
    },
  });

  if (!venue) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div
      className="fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Audit history
            </div>
            <div className="font-semibold">{venue.name}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground italic">
              No history yet.
            </div>
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {data.map((e) => (
                <li key={e.id} className="relative">
                  <span
                    className={`absolute -left-6.5 top-1.5 h-3 w-3 rounded-full ring-4 ring-card ${e.action === "created" ? "bg-primary" : "bg-amber-500"}`}
                  />
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${e.action === "created" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}
                    >
                      {e.action === "created" ? "Created" : "Last modified"}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmt(e.created_at)}</span>
                  </div>
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">by </span>
                    <span className="font-medium">{e.actor_name?.trim() || "Unknown"}</span>
                  </div>
                  {e.action === "updated" && e.changes && Object.keys(e.changes).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Object.keys(e.changes).map((k) => (
                        <span
                          key={k}
                          className="inline-flex rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function DeleteVenueButton({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: async () => {
      const { data: courts, error: cErr } = await supabase
        .from("courts")
        .select("id")
        .eq("venue_id", venue.id);
      if (cErr) throw cErr;
      const courtIds = (courts ?? []).map((c) => c.id);
      if (courtIds.length > 0) {
        const { count, error: bErr } = await supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .in("court_id", courtIds);
        if (bErr) throw bErr;
        if ((count ?? 0) > 0) {
          throw new Error("This venue has existing bookings and cannot be deleted.");
        }
        const { error: dcErr } = await supabase.from("courts").delete().in("id", courtIds);
        if (dcErr) throw dcErr;
      }
      const { error } = await supabase.from("venues").delete().eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setConfirming(false);
      setErr(null);
      qc.invalidateQueries({ queryKey: ["my-venues"] });
      qc.invalidateQueries({ queryKey: ["venues-court-counts"] });
      qc.invalidateQueries({ queryKey: ["venues-courts-glance"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirming(false);
        setErr(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
          setErr(null);
        }}
        title="Delete venue"
        aria-label={`Delete ${venue.name}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-destructive/40 text-destructive transition hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {confirming && (
        <div
          className="fixed inset-0 z-100 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!del.isPending) {
              setConfirming(false);
              setErr(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Delete "{venue.name}"?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This permanently removes the venue and all its courts. Venues with existing bookings
              cannot be deleted.
            </p>
            {err && (
              <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {err}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setConfirming(false);
                  setErr(null);
                }}
                disabled={del.isPending}
                className="rounded-lg border border-border px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60"
              >
                {del.isPending ? "Deleting…" : "Delete venue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MapViewModal({ venue, onClose }: { venue: Venue | null; onClose: () => void }) {
  const open = venue !== null;
  const elRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !venue || venue.latitude == null || venue.longitude == null) return;
    let map: any = null;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      if (cancelled || !elRef.current) return;
      map = L.map(elRef.current, { zoomControl: true, attributionControl: false }).setView(
        [venue.latitude!, venue.longitude!],
        16,
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:44px;height:44px;border-radius:9999px;background:#fff;border:2px solid #ef4444;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 6px 18px rgba(0,0,0,.2);">${venue.map_emoji ?? "🎾"}</div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });
      L.marker([venue.latitude!, venue.longitude!], { icon }).addTo(map);
      setTimeout(() => map.invalidateSize(), 80);
    })();
    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [open, venue]);

  if (!open || !venue) return null;
  return (
    <div className="fixed inset-0 z-1300 flex items-center justify-center p-4">
      <div onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl bg-background shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xl leading-none">{venue.map_emoji ?? "🎾"}</span>
              <h2 className="truncate text-base font-bold sm:text-lg">{venue.name}</h2>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{venue.address}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        <div className="relative">
          <div ref={elRef} className="h-[60vh] w-full" />
          <MapInfoButton
            getCenter={() =>
              venue.latitude != null && venue.longitude != null
                ? { lat: venue.latitude, lng: venue.longitude }
                : null
            }
            className="bottom-3 right-3"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs sm:px-5">
          <span className="text-muted-foreground">
            View only · edits are made from the Edit action.
          </span>
          <a
            href={`https://www.google.com/maps?q=${venue.latitude},${venue.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary hover:underline"
          >
            Open in Google Maps ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function EditVenueDrawer({ venue, onClose }: { venue: Venue | null; onClose: () => void }) {
  const qc = useQueryClient();
  const open = venue !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const courtsQ = useQuery({
    queryKey: ["courts-count", venue?.id],
    enabled: open,
    queryFn: async () => {
      const { count } = await supabase
        .from("courts")
        .select("id", { count: "exact", head: true })
        .eq("venue_id", venue!.id);
      return count ?? 0;
    },
  });

  return (
    <div
      className={"fixed inset-0 z-1200 " + (open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        onClick={onClose}
        className={
          "absolute inset-0 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "opacity-0")
        }
      />
      <aside
        className={
          "absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-background shadow-2xl transition-transform duration-300 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        role="dialog"
        aria-modal="true"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <h2 className="text-lg font-bold">Edit venue</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        {open && venue && (
          <div className="space-y-4 p-4 sm:p-6">
            <VenueEditor
              venue={venue}
              courtsCount={courtsQ.data ?? 0}
              initialEditing
              onDoneEditing={onClose}
            />
            <div className="rounded-xl border border-border p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Map location
              </div>
              <VenueLocation
                venue={venue}
                onSaved={() => qc.invalidateQueries({ queryKey: ["my-venues"] })}
              />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

// ------- Courts tab -------

type CourtRow = Court & { venue: Venue };

function DeleteCourtButton({ court, onDeleted }: { court: CourtRow; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const usageQ = useQuery({
    queryKey: ["court-delete-usage", court.id],
    enabled: open,
    queryFn: async () => {
      const nowIso = new Date().toISOString();
      const [all, upcoming, paid] = await Promise.all([
        supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("court_id", court.id),
        supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("court_id", court.id)
          .eq("status", "confirmed")
          .gte("start_time", nowIso),
        supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("court_id", court.id)
          .eq("payment_status", "paid"),
      ]);
      if (all.error) throw all.error;
      if (upcoming.error) throw upcoming.error;
      if (paid.error) throw paid.error;
      return { total: all.count ?? 0, upcoming: upcoming.count ?? 0, paid: paid.count ?? 0 };
    },
  });

  const usage = usageQ.data;
  const blocked = !!usage && usage.total > 0;

  const del = useMutation({
    mutationFn: async () => {
      // Re-check right before deleting so nothing slips through.
      const { count, error: cErr } = await supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("court_id", court.id);
      if (cErr) throw cErr;
      if ((count ?? 0) > 0)
        throw new Error("This court has booking history and cannot be deleted.");
      const { error } = await supabase.from("courts").delete().eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setOpen(false);
      setErr(null);
      onDeleted();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setErr(null);
        }}
        title="Delete court"
        aria-label={`Delete ${court.name}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-destructive/40 text-destructive align-middle transition hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-1300 flex items-center justify-center whitespace-normal bg-black/50 p-4 text-left"
          onClick={() => {
            if (!del.isPending) setOpen(false);
          }}
        >
          <div
            className="w-full max-w-md whitespace-normal wrap-break-word rounded-2xl border border-border bg-background p-5 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Delete "{court.name}"?</h3>
            {usageQ.isLoading ? (
              <p className="mt-2 text-sm text-muted-foreground">Checking bookings…</p>
            ) : blocked ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <div className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="text-xs">
                    <p className="font-semibold">This court can't be deleted.</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {usage!.upcoming > 0 && (
                        <li>
                          {usage!.upcoming} upcoming confirmed booking
                          {usage!.upcoming === 1 ? "" : "s"}
                        </li>
                      )}
                      {usage!.paid > 0 && (
                        <li>
                          {usage!.paid} paid transaction{usage!.paid === 1 ? "" : "s"} on record
                        </li>
                      )}
                      <li>
                        {usage!.total} booking record{usage!.total === 1 ? "" : "s"} in total
                      </li>
                    </ul>
                    <p className="mt-2 text-muted-foreground">
                      Booking and payment history must stay intact. Set the court to <b>Inactive</b>{" "}
                      in Edit court instead — it disappears from players but keeps its records.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                This court has no bookings or transactions. Deleting it is permanent and removes its
                pricing, hours and images.
              </p>
            )}
            {err && (
              <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {err}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={del.isPending}
                className="rounded-lg border border-border px-3 py-1.5 text-xs"
              >
                Close
              </button>
              {!blocked && !usageQ.isLoading && (
                <button
                  onClick={() => del.mutate()}
                  disabled={del.isPending}
                  className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60"
                >
                  {del.isPending ? "Deleting…" : "Delete court"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CourtsTab({ venues }: { venues: Venue[] }) {
  const qc = useQueryClient();
  const venueIds = venues.map((v) => v.id);
  const courtsQ = useQuery({
    queryKey: ["all-tenant-courts", venueIds.join(",")],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("*, sports(name)")
        .in("venue_id", venueIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (error) throw error;
      const byId = new Map(venues.map((v) => [v.id, v]));
      return (data as unknown as Court[]).map((c) => ({
        ...c,
        venue: byId.get(c.venue_id)!,
      })) as CourtRow[];
    },
  });

  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [editing, setEditing] = useState<CourtRow | null>(null);
  const [managingHours, setManagingHours] = useState<CourtRow | null>(null);
  const [historyCourt, setHistoryCourt] = useState<CourtRow | null>(null);
  const [colCfgOpen, setColCfgOpen] = useState(false);
  const { selected: visibleCols, save: saveCols } = useCourtColumns();

  const rows = (courtsQ.data ?? []).filter(
    (c) => venueFilter === "all" || c.venue_id === venueFilter,
  );
  const invalidate = () => {
    [
      "all-tenant-courts",
      "venues-courts-glance",
      "venues-court-counts",
      "venues-courts-table",
      "courts",
      "physical-courts-full",
      "physical-courts",
      "venues-group-counts",
      "group-eligible-courts",
    ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };

  const cfgButton = (
    <button
      type="button"
      onClick={() => setColCfgOpen(true)}
      title="Configure columns"
      aria-label="Configure columns"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
    >
      <TableProperties className="h-4 w-4" />
    </button>
  );

  const renderHeader = (id: string) => {
    switch (id) {
      case "emoji":
        return (
          <th key={id} className="px-4 py-2.5 w-10">
            {cfgButton}
          </th>
        );
      case "name":
        return (
          <th key={id} className="px-3 py-2.5">
            Court
          </th>
        );
      case "description":
        return (
          <th key={id} className="px-3 py-2.5">
            About This Court
          </th>
        );
      case "venue":
        return (
          <th key={id} className="px-3 py-2.5">
            Venue
          </th>
        );
      case "sport":
        return (
          <th key={id} className="px-3 py-2.5">
            Sport
          </th>
        );
      case "type":
        return (
          <th key={id} className="px-3 py-2.5">
            Type
          </th>
        );
      case "surface":
        return (
          <th key={id} className="px-3 py-2.5">
            Surface
          </th>
        );
      case "capacity":
        return (
          <th key={id} className="px-3 py-2.5 text-center">
            Capacity
          </th>
        );
      case "rate":
        return (
          <th key={id} className="px-3 py-2.5 text-right">
            Rate / hr
          </th>
        );
      case "voucher":
        return (
          <th key={id} className="px-3 py-2.5 text-center">
            Voucher
          </th>
        );
      case "status":
        return (
          <th key={id} className="px-3 py-2.5">
            Status
          </th>
        );
      case "created_at":
        return (
          <th key={id} className="px-3 py-2.5 w-32">
            Created At
          </th>
        );
      case "history":
        return (
          <th key={id} className="px-3 py-2.5 w-24 text-center">
            History
          </th>
        );
      case "actions":
        return (
          <th key={id} className="px-3 py-2.5 text-right">
            Actions
          </th>
        );
      default:
        return null;
    }
  };

  const renderCell = (id: string, c: CourtRow) => {
    switch (id) {
      case "emoji":
        return (
          <td key={id} className="px-4 py-3 text-xl leading-none">
            {c.map_emoji ?? c.venue.map_emoji ?? "🎾"}
          </td>
        );
      case "name":
        return (
          <td key={id} className="px-3 py-3">
            <div className="font-semibold">{c.name}</div>
          </td>
        );
      case "description":
        return (
          <td key={id} className="px-3 py-3">
            {c.description?.trim() ? (
              <p
                title={c.description}
                className="line-clamp-2 max-w-65 whitespace-normal wrap-break-word text-[12px] leading-snug text-muted-foreground"
              >
                {c.description}
              </p>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </td>
        );
      case "venue":
        return (
          <td key={id} className="px-3 py-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[13px] font-semibold leading-tight text-foreground ring-1 ring-primary/20">
              <span className="text-base leading-none">{c.venue.map_emoji ?? "🏟️"}</span>
              {c.venue.name}
            </span>
          </td>
        );
      case "sport":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground">
            {c.sports?.name ?? "—"}
          </td>
        );
      case "type":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground">
            {c.is_indoor ? "Indoor" : "Outdoor"}
          </td>
        );
      case "surface":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground">
            {c.surface_type?.trim() ? c.surface_type : "—"}
          </td>
        );
      case "capacity":
        return (
          <td key={id} className="px-3 py-3 text-center tabular-nums text-muted-foreground">
            {c.player_capacity ?? "—"}
          </td>
        );
      case "rate":
        return (
          <td key={id} className="px-3 py-3 text-right">
            <span className="text-[15px] font-bold tabular-nums text-foreground [text-shadow:0_0_10px_rgba(250,204,21,0.85)]">
              ₱{Number(c.hourly_rate).toFixed(0)}
            </span>
          </td>
        );
      case "voucher":
        return (
          <td key={id} className="px-3 py-3 text-center">
            {c.voucher_enabled ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 ring-1 ring-emerald-500/30">
                True
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground ring-1 ring-border">
                False
              </span>
            )}
          </td>
        );
      case "status":
        return (
          <td key={id} className="px-3 py-3">
            {c.coming_soon ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 ring-1 ring-amber-500/30">
                Coming soon
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 ring-1 ring-emerald-500/30">
                ACTIVE
              </span>
            )}
          </td>
        );
      case "created_at":
        return (
          <td key={id} className="px-3 py-3">
            {c.created_at ? (
              <div className="flex flex-col leading-tight">
                <span className="text-foreground">
                  {new Date(c.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(c.created_at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </td>
        );
      case "history":
        return (
          <td key={id} className="px-3 py-3 text-center">
            <button
              type="button"
              onClick={() => setHistoryCourt(c)}
              title="Audit history"
              aria-label={`View audit history for ${c.name}`}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
            >
              <HistoryIcon className="h-3.5 w-3.5" />
            </button>
          </td>
        );
      case "actions":
        return (
          <td key={id} className="px-3 py-3">
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setEditing(c)}
                title="Edit court"
                aria-label={`Edit ${c.name}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <DeleteCourtButton court={c} onDeleted={invalidate} />
            </div>
          </td>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <label className="text-xs text-muted-foreground">Filter venue:</label>
        <VenuePicker venues={venues} value={venueFilter} onChange={setVenueFilter} size="xs" />
      </div>
      {courtsQ.isLoading ? (
        <div className="p-6">
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No courts yet. Use <strong>Add court</strong> to create one.
        </div>
      ) : (
        <table className="w-full min-w-225 text-sm">
          <thead className="sticky top-10.25 z-10 bg-secondary/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
            <tr>
              {!visibleCols.includes("emoji") && (
                <th className="w-8 pl-2 pr-0 py-2.5">{cfgButton}</th>
              )}
              {visibleCols.map((id) => renderHeader(id))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-border align-middle hover:bg-secondary/20">
                {!visibleCols.includes("emoji") && <td className="w-8 pl-2 pr-0 py-3" />}
                {visibleCols.map((id) => renderCell(id, c))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ColumnConfigModal
        open={colCfgOpen}
        onClose={() => setColCfgOpen(false)}
        selected={visibleCols}
        onApply={saveCols}
        columns={COURT_COLUMNS}
        defaults={DEFAULT_COURT_COLS}
        presetKey="courts_column_presets"
      />
      <CourtAuditHistoryModal court={historyCourt} onClose={() => setHistoryCourt(null)} />
      <CourtDrawer title="Edit court" open={editing !== null} onClose={() => setEditing(null)}>
        {editing && (
          <EditCourt
            court={editing}
            venueEmoji={editing.venue.map_emoji}
            onDone={() => {
              invalidate();
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </CourtDrawer>
      <CourtDrawer
        title="Manage availability"
        open={managingHours !== null}
        onClose={() => setManagingHours(null)}
      >
        {managingHours && (
          <AvailabilityEditor
            court={managingHours}
            onDone={() => {
              invalidate();
              setManagingHours(null);
            }}
            onCancel={() => setManagingHours(null)}
          />
        )}
      </CourtDrawer>
    </>
  );
}

type CourtAuditEntry = {
  id: number;
  court_id: number;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  changes: Record<string, unknown> | null;
  created_at: string;
};

function CourtAuditHistoryModal({
  court,
  onClose,
}: {
  court: { id: number; name: string } | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["court-audit", court?.id],
    enabled: !!court,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("court_audit_log" as never)
        .select("*")
        .eq("court_id", court!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CourtAuditEntry[];
    },
  });

  if (!court) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div
      className="fixed inset-0 z-1300 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Court history
            </div>
            <div className="font-semibold">{court.name}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground italic">
              No history yet.
            </div>
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {data.map((e) => (
                <li key={e.id} className="relative">
                  <span
                    className={`absolute -left-6.5 top-1.5 h-3 w-3 rounded-full ring-4 ring-card ${e.action === "created" ? "bg-primary" : "bg-amber-500"}`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${e.action === "created" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}
                    >
                      {e.action === "created" ? "Created" : "Last modified"}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmt(e.created_at)}</span>
                  </div>
                  <div className="mt-1 text-sm">
                    <span className="text-muted-foreground">by </span>
                    <span className="font-medium">{e.actor_name?.trim() || "Unknown"}</span>
                  </div>
                  {e.action === "updated" && e.changes && Object.keys(e.changes).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Object.keys(e.changes).map((k) => (
                        <span
                          key={k}
                          className="inline-flex rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function CourtDrawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  return (
    <div
      className={"fixed inset-0 z-1200 " + (open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        onClick={onClose}
        className={
          "absolute inset-0 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "opacity-0")
        }
      />
      <aside
        className={
          "absolute right-0 top-0 h-full w-full max-w-2xl overflow-y-auto bg-background shadow-2xl transition-transform duration-300 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        role="dialog"
        aria-modal="true"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-6">{open && children}</div>
      </aside>
    </div>
  );
}

// ================= Court Groups (physical courts / shared surfaces) =================

function CourtGroupsTab({ venues }: { venues: Venue[] }) {
  const [venueId, setVenueId] = useState<number | null>(venues[0]?.id ?? null);
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [colCfgOpen, setColCfgOpen] = useState(false);
  const { selected: visibleCols, save: saveCols } = useGroupColumns();
  useEffect(() => {
    if (!venueId && venues[0]) setVenueId(venues[0].id);
  }, [venues, venueId]);

  const groupsQ = useQuery({
    queryKey: ["physical-courts-full", venueId],
    enabled: !!venueId,
    queryFn: async () => {
      const { data: pcs, error } = await supabase
        .from("physical_courts")
        .select("id, venue_id, name, map_emoji, description")
        .eq("venue_id", venueId!)
        .order("id");
      if (error) throw error;
      const pcIds = (pcs ?? []).map((p) => p.id);
      if (pcIds.length === 0) return [] as GroupRow[];
      const { data: cs, error: cErr } = await supabase
        .from("courts")
        .select("id, name, physical_court_id, sports(name)")
        .in("physical_court_id", pcIds);
      if (cErr) throw cErr;
      const byPc = new Map<number, GroupRow["layouts"]>();
      (cs ?? []).forEach((c: any) => {
        const arr = byPc.get(c.physical_court_id) ?? [];
        arr.push({ id: c.id, name: c.name, sport: c.sports?.name ?? null });
        byPc.set(c.physical_court_id, arr);
      });
      const courtIds = (cs ?? []).map((c: any) => c.id as number);
      const rulesByCourt = new Map<number, number>();
      if (courtIds.length > 0) {
        const { data: rs, error: rErr } = await supabase
          .from("court_block_rules")
          .select("court_id")
          .in("court_id", courtIds);
        if (rErr) throw rErr;
        (rs ?? []).forEach((r: any) =>
          rulesByCourt.set(r.court_id, (rulesByCourt.get(r.court_id) ?? 0) + 1),
        );
      }
      return (pcs ?? [])
        .map((p: any) => {
          const layouts = byPc.get(p.id) ?? [];
          const rulesCount = layouts.reduce((sum, l) => sum + (rulesByCourt.get(l.id) ?? 0), 0);
          return { ...p, layouts, rulesCount };
        })
        .filter((g) => g.layouts.length >= 2) as GroupRow[];
    },
  });

  const groups = groupsQ.data ?? [];

  const cfgButton = (
    <button
      type="button"
      onClick={() => setColCfgOpen(true)}
      title="Configure columns"
      aria-label="Configure columns"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
    >
      <TableProperties className="h-4 w-4" />
    </button>
  );

  const renderHeader = (id: string) => {
    switch (id) {
      case "emoji":
        return (
          <th key={id} className="px-3 py-2 w-10 font-semibold">
            {cfgButton}
          </th>
        );
      case "name":
        return (
          <th key={id} className="px-3 py-2 font-semibold">
            Group
          </th>
        );
      case "description":
        return (
          <th key={id} className="px-3 py-2 font-semibold">
            About this group
          </th>
        );
      case "courts_count":
        return (
          <th key={id} className="px-3 py-2 font-semibold text-center">
            Courts
          </th>
        );
      case "rules":
        return (
          <th key={id} className="px-3 py-2 font-semibold text-center">
            Blocking rules
          </th>
        );
      case "sports":
        return (
          <th key={id} className="px-3 py-2 font-semibold">
            Sports
          </th>
        );
      case "actions":
        return (
          <th key={id} className="px-3 py-2 font-semibold text-right">
            Actions
          </th>
        );
      default:
        return null;
    }
  };

  const renderCell = (id: string, g: GroupRow) => {
    switch (id) {
      case "emoji":
        return (
          <td key={id} className="px-3 py-3 text-lg leading-none">
            {g.map_emoji ?? "🏟️"}
          </td>
        );
      case "name":
        return (
          <td key={id} className="px-3 py-3">
            <span className="font-medium">{g.name}</span>
          </td>
        );
      case "description":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground">
            {g.description || "—"}
          </td>
        );
      case "courts_count":
        return (
          <td key={id} className="px-3 py-3 text-center">
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary ring-1 ring-primary/20">
              {g.layouts.length}
            </span>
          </td>
        );
      case "rules":
        return (
          <td key={id} className="px-3 py-3 text-center">
            {g.rulesCount > 0 ? (
              <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-foreground ring-1 ring-border">
                {g.rulesCount} {g.rulesCount === 1 ? "rule" : "rules"} set up
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No rules yet</span>
            )}
          </td>
        );
      case "sports": {
        const list = Array.from(new Set(g.layouts.map((l) => l.sport).filter(Boolean))) as string[];
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground text-xs">
            {list.length ? list.join(", ") : "—"}
          </td>
        );
      }
      case "actions":
        return (
          <td key={id} className="px-3 py-3">
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setEditing(g)}
                title="Edit group"
                aria-label={`Edit ${g.name}`}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <DeleteGroupButton group={g} />
            </div>
          </td>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-6">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Venue</span>
          <select
            value={venueId ?? ""}
            onChange={(e) => setVenueId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Use <b className="text-foreground">+ Create group</b> to bundle courts that share the same
          physical space.
        </p>
      </div>
      <div className="flex-1 overflow-auto nice-scroll px-4 pb-6 sm:px-6">
        {groupsQ.isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No shared-surface groups yet for this venue. Click{" "}
            <b className="text-foreground">+ Create group</b> above to bundle courts that share one
            physical space.
          </div>
        ) : (
          <table className="w-full min-w-180 border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                {!visibleCols.includes("emoji") && (
                  <th className="w-8 pl-2 pr-0 py-2">{cfgButton}</th>
                )}
                {visibleCols.map((id) => renderHeader(id))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className="border-t border-border align-top">
                  {!visibleCols.includes("emoji") && <td className="w-8 pl-2 pr-0 py-3" />}
                  {visibleCols.map((id) => renderCell(id, g))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ColumnConfigModal
        open={colCfgOpen}
        onClose={() => setColCfgOpen(false)}
        selected={visibleCols}
        onApply={saveCols}
        columns={GROUP_COLUMNS}
        defaults={DEFAULT_GROUP_COLS}
        presetKey="groups_column_presets"
      />
      {editing && <EditGroupDrawer group={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type GroupRow = {
  id: number;
  venue_id: number;
  name: string;
  map_emoji: string | null;
  description: string | null;
  rulesCount: number;
  layouts: Array<{ id: number; name: string; sport: string | null }>;
};

function DeleteGroupButton({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const courtIds = group.layouts.map((l) => l.id);
      if (courtIds.length > 0) {
        const { count, error } = await supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .in("court_id", courtIds)
          .eq("status", "confirmed")
          .gte("end_time", new Date().toISOString());
        if (error) throw error;
        if ((count ?? 0) > 0)
          throw new Error(
            "This group has upcoming confirmed bookings and cannot be deleted until they finish or are cancelled.",
          );
        // Detach courts from the physical surface by giving each its own new slab
        for (const c of group.layouts) {
          const { data: pc, error: pcErr } = await supabase
            .from("physical_courts")
            .insert({ venue_id: (group as any).venue_id ?? undefined, name: c.name })
            .select("id")
            .single();
          if (pcErr) {
            // Fall back: leave the physical_court_id — parent will still delete-cascade if we allow, but safer to abort.
            throw pcErr;
          }
          const { error: upErr } = await supabase
            .from("courts")
            .update({ physical_court_id: pc.id, capacity: 1, footprint: 1 })
            .eq("id", c.id);
          if (upErr) throw upErr;
        }
      }
      const { error } = await supabase.from("physical_courts").delete().eq("id", group.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setConfirm(false);
      setErr(null);
      [
        "physical-courts-full",
        "physical-courts",
        "tenant-venues-full",
        "venues-group-counts",
        "group-eligible-courts",
        "all-tenant-courts",
        "court-block-rules",
      ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErr(null);
          setConfirm(true);
        }}
        title="Delete group"
        aria-label={`Delete ${group.name}`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {confirm && (
        <div
          className="fixed inset-0 z-70 grid place-items-center bg-black/50 p-4"
          onClick={() => !mut.isPending && setConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-destructive/40 bg-background p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold">Delete group permanently?</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  <b className="text-foreground">{group.name}</b> will be{" "}
                  <b className="text-destructive">permanently deleted</b>. Its courts remain but
                  each becomes independent again.
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              ⚠ This action is <b>permanent</b> and cannot be undone.
            </div>
            {err && (
              <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {err}
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={mut.isPending}
                onClick={() => setConfirm(false)}
                className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={mut.isPending}
                onClick={() => mut.mutate()}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground disabled:opacity-50"
              >
                {mut.isPending ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function EditGroupDrawer({ group, onClose }: { group: GroupRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState<string | null>(group.map_emoji);
  const [description, setDescription] = useState(group.description ?? "");
  const [addSel, setAddSel] = useState<Set<number>>(new Set());
  const [detachSel, setDetachSel] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const memberSet = new Set(group.layouts.map((l) => l.id));

  // All courts in this venue (members are pre-ticked, others can be attached)
  const eligibleQ = useQuery({
    queryKey: ["group-add-eligible", group.venue_id, group.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, physical_court_id, sports(name)")
        .eq("venue_id", group.venue_id)
        .order("id");
      if (error) throw error;
      return (data ?? []) as Array<{
        id: number;
        name: string;
        physical_court_id: number;
        sports: { name: string } | null;
      }>;
    },
  });

  // Pairwise blocking rules among the courts of this group
  const memberIds = [
    ...group.layouts.filter((l) => !detachSel.has(l.id)).map((l) => l.id),
    ...Array.from(addSel),
  ];

  const rulesQ = useQuery({
    queryKey: ["court-block-rules", group.id, group.layouts.map((l) => l.id).join(",")],
    enabled: group.layouts.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("court_block_rules")
        .select("court_id, blocked_court_id")
        .in(
          "court_id",
          group.layouts.map((l) => l.id),
        );
      if (error) throw error;
      return (data ?? []).map((r) => ruleKey(r.court_id, r.blocked_court_id));
    },
  });
  const [rulesDraft, setRulesDraft] = useState<Set<string> | null>(null);
  const rules = rulesDraft ?? new Set(rulesQ.data ?? []);
  const ruleCourts: RuleCourt[] = [
    ...group.layouts
      .filter((l) => !detachSel.has(l.id))
      .map((l) => ({ id: l.id, name: l.name, sport: l.sport })),
    ...(eligibleQ.data ?? [])
      .filter((c) => addSel.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, sport: c.sports?.name ?? null })),
  ];

  const toggleAdd = (id: number) => {
    setAddSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDetach = (id: number) => {
    setErr(null);
    setDetachSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Group name is required");
      // Update group fields
      const { error } = await supabase
        .from("physical_courts")
        .update({ name: name.trim(), map_emoji: emoji, description: description.trim() || null })
        .eq("id", group.id);
      if (error) throw error;
      // Detach unticked members (blocked if they have upcoming confirmed bookings)
      for (const id of Array.from(detachSel)) {
        const { count, error: cErr } = await supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("court_id", id)
          .eq("status", "confirmed")
          .gte("end_time", new Date().toISOString());
        if (cErr) throw cErr;
        if ((count ?? 0) > 0)
          throw new Error(
            "A court you unticked has upcoming confirmed bookings and cannot be detached until they finish or are cancelled.",
          );
        const { data: pc, error: pcErr } = await supabase
          .from("physical_courts")
          .insert({ venue_id: group.venue_id, name: `Slab ${Date.now()}` })
          .select("id")
          .single();
        if (pcErr) throw pcErr;
        const { error: dErr } = await supabase
          .from("courts")
          .update({ physical_court_id: pc.id })
          .eq("id", id);
        if (dErr) throw dErr;
        const { error: rErr } = await supabase
          .from("court_block_rules")
          .delete()
          .eq("court_id", id);
        if (rErr) throw rErr;
      }
      // Attach newly selected courts
      for (const id of Array.from(addSel)) {
        const { error: upErr } = await supabase
          .from("courts")
          .update({ physical_court_id: group.id })
          .eq("id", id);
        if (upErr) throw upErr;
      }
      // Replace pairwise blocking rules for all courts in this group
      const ids = memberIds;

      if (ids.length > 0) {
        const { error: delErr } = await supabase
          .from("court_block_rules")
          .delete()
          .in("court_id", ids);
        if (delErr) throw delErr;
        const rows = Array.from(rules)
          .map((k) => k.split(">").map(Number))
          .filter(([a, b]) => ids.includes(a) && ids.includes(b))
          .map(([a, b]) => ({ court_id: a, blocked_court_id: b, venue_id: group.venue_id }));
        if (rows.length > 0) {
          const { error: insErr } = await supabase.from("court_block_rules").insert(rows);
          if (insErr) throw insErr;
        }
      }
    },
    onSuccess: () => {
      [
        "physical-courts-full",
        "physical-courts",
        "tenant-venues-full",
        "venues-group-counts",
        "group-eligible-courts",
        "all-tenant-courts",
        "court-block-rules",
      ].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const eligible = eligibleQ.data ?? [];

  return (
    <div className="fixed inset-0 z-70 flex" onClick={onClose}>
      <div className="flex-1 bg-black/50" />
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-background shadow-2xl nice-scroll"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-5 py-4">
          <h3 className="text-lg font-semibold">Edit group</h3>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
          className="grid gap-4 p-5"
        >
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
            Editing the <b className="text-foreground">whole group</b> — group name, emoji,
            description, and which courts belong to this shared space.
          </div>

          <Input label="Group name" value={name} onChange={setName} required />
          <div className="rounded-xl border border-border bg-background p-3">
            <EmojiPicker
              label="Group emoji"
              value={emoji}
              fallback="🏟️"
              onChange={setEmoji}
              hint="Shown on the map and in the courts table."
            />
          </div>
          <Textarea
            label="About this Group (optional)"
            value={description}
            onChange={setDescription}
            placeholder="Court size, surface, lighting, house rules…"
          />

          <CourtBlockRulesEditor courts={ruleCourts} rules={rules} onChange={setRulesDraft} />

          <div className="rounded-xl border border-dashed border-border p-3">
            <div className="text-sm font-semibold">Courts in this group</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Tick courts from this venue to include them in this group; untick to detach.
            </p>
            <div className="mt-3 grid gap-2">
              {eligible.length === 0 && (
                <p className="text-xs text-muted-foreground">No courts in this venue.</p>
              )}
              {eligible.map((c) => {
                const isMember = memberSet.has(c.id);
                const checked = isMember ? !detachSel.has(c.id) : addSel.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-sm ${checked ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => (isMember ? toggleDetach(c.id) : toggleAdd(c.id))}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {c.sports?.name ?? "—"}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {err && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary"
            >
              Cancel
            </button>
            <button
              disabled={mut.isPending || !name.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {mut.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ================= Transactions =================

type TxRow = {
  id: string;
  booking_id: number;
  venue_id: number;
  user_id: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  mode: string;
  raw: { payment_id?: string } | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

function TransactionsSection({ venues }: { venues: Venue[] }) {
  const qc = useQueryClient();
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "paid" | "pending" | "failed" | "refunded"
  >("all");

  const txQ = useQuery({
    queryKey: ["tenant-transactions", venueFilter, statusFilter],
    queryFn: async () => {
      let q = supabase
        .from("transactions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (venueFilter !== "all") q = q.eq("venue_id", venueFilter);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TxRow[];
    },
  });

  /* The Date column renders `paid_at ?? created_at`, but the query orders on
     `created_at` alone — a payment settled later than the row was created lands out
     of order against the date the tenant is reading. Sort on what is on screen. */
  const rows = useMemo(
    () =>
      (txQ.data ?? [])
        .slice()
        .sort(
          (a, b) =>
            new Date(b.paid_at ?? b.created_at).getTime() -
            new Date(a.paid_at ?? a.created_at).getTime(),
        ),
    [txQ.data],
  );
  const paid = rows.filter((r) => r.status === "paid");
  const now = Date.now();
  const sumSince = (ms: number) =>
    paid
      .filter((r) => new Date(r.paid_at ?? r.created_at).getTime() >= now - ms)
      .reduce((s, r) => s + Number(r.amount), 0);
  const todaySum = sumSince(24 * 3_600_000);
  const weekSum = sumSince(7 * 24 * 3_600_000);
  const monthSum = sumSince(30 * 24 * 3_600_000);
  const uniqueCustomers = new Set(paid.map((r) => r.user_id)).size;
  const totalBookings = new Set(paid.map((r) => r.booking_id)).size;

  const currency = (n: number) =>
    "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      paid: "bg-primary/15 text-primary",
      pending: "bg-amber-500/15 text-amber-700",
      failed: "bg-destructive/15 text-destructive",
      refunded: "bg-muted text-muted-foreground",
      cancelled: "bg-muted text-muted-foreground",
    };
    return (
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary text-foreground"}`}
      >
        {s}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Transactions"
        subtitle="Track online payments, refunds and customer activity across your venues."
      />

      {/* KPI tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <PlayerKpi label="Sales · Today" value={currency(todaySum)} />
        <PlayerKpi label="Sales · 7 days" value={currency(weekSum)} />
        <PlayerKpi label="Sales · 30 days" value={currency(monthSum)} />
        <PlayerKpi label="Paid bookings" value={String(totalBookings)} />
        <PlayerKpi label="Unique customers" value={String(uniqueCustomers)} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <VenuePicker venues={venues} value={venueFilter} onChange={setVenueFilter} />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>
        <span className="ml-auto rounded-full bg-secondary px-3 py-1 text-xs font-semibold">
          PayMongo · {paid[0]?.mode === "live" ? "Live" : "Test"} mode
        </span>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="nice-scroll max-h-[55vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">PayMongo payment ID</th>
                <th className="px-4 py-3">Booking</th>
                <th className="px-4 py-3">Venue</th>
              </tr>
            </thead>
            <tbody>
              {txQ.isLoading ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                    No transactions yet. Once players start paying online, they'll show up here.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {fmtDate(r.paid_at ?? r.created_at)}
                    </td>
                    <td className="px-4 py-3 font-semibold">{currency(Number(r.amount))}</td>
                    <td className="px-4 py-3 capitalize">{r.method.replace("_", " ")}</td>
                    <td className="px-4 py-3">{statusBadge(r.status)}</td>
                    <td className="px-4 py-3">
                      <code className="text-xs font-semibold">{r.raw?.payment_id ?? "—"}</code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">#{r.booking_id}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {venues.find((v) => v.id === r.venue_id)?.name ?? `Venue #${r.venue_id}`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

type PaySettingsVenue = {
  id: number;
  name: string;
  payment_mode: string;
  refund_cutoff_hours: number;
};

/**
 * Payment configuration for every venue, as one table.
 *
 * Stacked cards were fine for two venues and became a very long scroll for a tenant
 * with a dozen — each one repeating its own labels. A table puts the settings in
 * columns so they can be compared down the page, which is how a manager actually reads
 * them ("which of my venues still take payment at the counter?"), and the filter makes
 * the last venue reachable without scrolling at all.
 *
 * On a phone the same rows render as cards, because a four-column table with editable
 * controls does not fit and horizontal scrolling to reach a Save button is worse than
 * the repetition.
 */
const PAY_PAGE_SIZE = 10;
/** Below this, a search box is noise — scrolling a short list is faster than typing. */
const PAY_SEARCH_THRESHOLD = 6;

type PayModeFilter = "all" | "full" | "none";

const PAY_MODE_LABEL: Record<string, string> = {
  full: "Full payment",
  none: "Settle at venue",
};

/**
 * Payment configuration for every venue, as one paged table.
 *
 * Stacked cards were fine for two venues and became a very long scroll for a dozen,
 * each repeating its own labels. Columns let a manager read *down* the page, which is
 * how the question actually gets asked — "which of my venues still take payment at the
 * counter?" — and the Payment mode header answers exactly that question by filtering.
 *
 * On a phone the same rows render as cards: a four-column table with editable controls
 * does not fit, and scrolling sideways to reach a Save button is worse than repetition.
 */
function PaymentSettingsTable({
  venues,
  loading,
  onSave,
}: {
  venues: PaySettingsVenue[];
  loading: boolean;
  onSave: (id: number, mode: string, cutoff: number) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<PayModeFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return venues.filter((v) => {
      if (modeFilter !== "all" && v.payment_mode !== modeFilter) return false;
      if (q && !v.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [venues, query, modeFilter]);

  /* Narrowing the list can leave you on a page that no longer exists — clamp rather
     than showing an empty table with a live Next button. */
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAY_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    safePage * PAY_PAGE_SIZE,
    safePage * PAY_PAGE_SIZE + PAY_PAGE_SIZE,
  );

  const resetTo = (fn: () => void) => {
    fn();
    setPage(0);
  };

  if (loading) {
    return <p className="mt-4 text-sm text-muted-foreground">Loading venues…</p>;
  }
  if (venues.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Create a venue first to configure payment settings.
      </p>
    );
  }

  const modeHeader = (
    <button
      type="button"
      onClick={() => setFilterOpen(true)}
      className={
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide transition hover:bg-secondary " +
        (modeFilter === "all" ? "text-muted-foreground" : "bg-primary/10 text-primary")
      }
      title="Filter by payment mode"
    >
      Payment mode
      <Filter className="h-3 w-3" />
    </button>
  );

  return (
    <div className="mt-4">
      {venues.length >= PAY_SEARCH_THRESHOLD && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => resetTo(() => setQuery(e.target.value))}
            placeholder={`Search ${venues.length} venues…`}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={() => resetTo(() => setQuery(""))}
              aria-label="Clear search"
              className="rounded p-1 text-muted-foreground hover:bg-secondary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {modeFilter !== "all" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Showing only</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">
            {PAY_MODE_LABEL[modeFilter]}
            <button
              onClick={() => resetTo(() => setModeFilter("all"))}
              aria-label="Clear payment mode filter"
              className="rounded-full hover:bg-primary/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No venue matches {query.trim() ? `“${query.trim()}”` : "this filter"}.
        </p>
      ) : (
        <>
          {/* Desktop: one table */}
          <div className="hidden overflow-hidden rounded-xl border border-border sm:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Venue</th>
                  <th className="px-4 py-2 font-semibold">{modeHeader}</th>
                  <th className="px-4 py-2.5 font-semibold">Refund cutoff</th>
                  <th className="px-4 py-2.5 text-right font-semibold">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((v) => (
                  <VenuePaymentRow key={v.id} venue={v} onSave={onSave} layout="row" />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same rows as cards, with the filter still reachable */}
          <div className="sm:hidden">
            <div className="mb-2 flex justify-end">{modeHeader}</div>
            <div className="space-y-3">
              {pageRows.map((v) => (
                <VenuePaymentRow key={v.id} venue={v} onSave={onSave} layout="card" />
              ))}
            </div>
          </div>

          {filtered.length > PAY_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Showing {safePage * PAY_PAGE_SIZE + 1}–{safePage * PAY_PAGE_SIZE + pageRows.length}{" "}
                of {filtered.length}
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold transition hover:border-primary disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span className="px-1 text-xs tabular-nums text-muted-foreground">
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold transition hover:border-primary disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {filterOpen && (
        <PayModeFilterDialog
          value={modeFilter}
          counts={{
            all: venues.length,
            full: venues.filter((v) => v.payment_mode === "full").length,
            none: venues.filter((v) => v.payment_mode === "none").length,
          }}
          onClose={() => setFilterOpen(false)}
          onPick={(next) => {
            resetTo(() => setModeFilter(next));
            setFilterOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** Filter chooser for the Payment mode column. Counts are shown because the useful
 *  question is usually "how many are still on settle at venue?" — which the filter
 *  answers before you even apply it. */
function PayModeFilterDialog({
  value,
  counts,
  onClose,
  onPick,
}: {
  value: PayModeFilter;
  counts: { all: number; full: number; none: number };
  onClose: () => void;
  onPick: (v: PayModeFilter) => void;
}) {
  const options: { key: PayModeFilter; label: string; hint: string; count: number }[] = [
    { key: "all", label: "All venues", hint: "No filter", count: counts.all },
    {
      key: "full",
      label: "Full payment",
      hint: "Collected online through PayMongo before the booking is confirmed",
      count: counts.full,
    },
    {
      key: "none",
      label: "Settle at venue",
      hint: "Nothing is collected online; the player pays at the counter",
      count: counts.none,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[1400] grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Filter by payment mode"
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold">Filter by payment mode</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Show only venues set up one way.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {options.map((o) => (
            <button
              key={o.key}
              onClick={() => onPick(o.key)}
              className={
                "flex w-full items-start gap-2.5 rounded-xl border p-3 text-left text-sm transition " +
                (value === o.key
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50")
              }
            >
              <Check
                className={
                  "mt-0.5 h-4 w-4 shrink-0 " + (value === o.key ? "text-primary" : "opacity-0")
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{o.label}</span>
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold tabular-nums">
                    {o.count}
                  </span>
                </span>
                <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                  {o.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function VenuePaymentRow({
  venue,
  onSave,
  layout,
}: {
  venue: PaySettingsVenue;
  onSave: (id: number, mode: string, cutoff: number) => Promise<void>;
  layout: "row" | "card";
}) {
  const [mode, setMode] = useState(venue.payment_mode);
  const [cutoff, setCutoff] = useState(venue.refund_cutoff_hours);
  const [saving, setSaving] = useState(false);
  const dirty = mode !== venue.payment_mode || cutoff !== venue.refund_cutoff_hours;

  const save = async () => {
    setSaving(true);
    await onSave(venue.id, mode, cutoff);
    setSaving(false);
  };

  const modeSelect = (
    <select
      value={mode}
      onChange={(e) => setMode(e.target.value)}
      className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
    >
      <option value="none">Settle at venue</option>
      <option value="full">Full payment</option>
    </select>
  );

  const cutoffInput = (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        value={cutoff}
        onChange={(e) => setCutoff(Number(e.target.value))}
        className="w-20 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      />
      <span className="text-xs text-muted-foreground">hrs</span>
    </div>
  );

  const saveButton = (
    <button
      disabled={!dirty || saving}
      onClick={save}
      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
    >
      {saving ? "Saving…" : dirty ? "Save" : "Saved"}
    </button>
  );

  /* An unsaved edit is easy to walk away from in a table of ten venues, so the row
     says so rather than relying on the button alone. */
  const dirtyDot = dirty && (
    <span
      title="Unsaved changes"
      className="ml-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 align-middle"
    />
  );

  if (layout === "card") {
    return (
      <div className="rounded-xl border border-border bg-background p-3">
        <p className="text-sm font-semibold">
          {venue.name}
          {dirtyDot}
        </p>
        <label className="mt-3 block">
          <span className="text-[11px] font-medium text-muted-foreground">Payment mode</span>
          <div className="mt-1">{modeSelect}</div>
        </label>
        <label className="mt-3 block">
          <span className="text-[11px] font-medium text-muted-foreground">Refund cutoff</span>
          <div className="mt-1">{cutoffInput}</div>
        </label>
        <div className="mt-3 flex justify-end">{saveButton}</div>
      </div>
    );
  }

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3">
        <span className="font-medium">{venue.name}</span>
        {dirtyDot}
      </td>
      <td className="px-4 py-3">{modeSelect}</td>
      <td className="px-4 py-3">{cutoffInput}</td>
      <td className="px-4 py-3 text-right">{saveButton}</td>
    </tr>
  );
}

// ================= Bookings =================

type BookingRow = {
  id: number;
  court_id: number;
  user_id: string;
  start_time: string;
  end_time: string;
  status: string;
  refund_method?: string | null;
  refund_reference?: string | null;
  payment_status: string;
  refund_status?: string | null;
  created_at: string;
  unit_price: number | null;
  discount_amount: number | null;
  courts: { name: string; venue_id: number; venues: { name: string } | null } | null;
};

/**
 * Records how a refund was actually returned.
 *
 * The method matters after the fact: "refunded" alone cannot distinguish money PayMongo
 * pushed back automatically from money a manager sent by GCash after agreeing it in the
 * chat. The reference is what makes the manual case auditable.
 */
function SettleRefundDialog({
  target,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  target: { ids: number[]; label: string };
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (method: "manual" | "paymongo", reference: string) => void;
}) {
  const [method, setMethod] = useState<"manual" | "paymongo">("manual");
  const [reference, setReference] = useState("");

  return (
    <div className="fixed inset-0 z-[1400] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
        <h3 className="font-display text-base font-bold">Mark refund settled</h3>
        <p className="mt-1 text-xs text-muted-foreground">{target.label}</p>
        <p className="mt-3 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
          Only record this once the money has actually left your side. The player is told
          immediately, and the booking moves from <b>Awaiting refund</b> to <b>Refunded</b>.
        </p>

        <div className="mt-4 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input
              type="radio"
              className="mt-0.5"
              checked={method === "manual"}
              onChange={() => setMethod("manual")}
            />
            <span>
              Sent manually
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                GCash, bank transfer or cash — the destination you agreed in the booking chat.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input
              type="radio"
              className="mt-0.5"
              checked={method === "paymongo"}
              onChange={() => setMethod("paymongo")}
            />
            <span>
              Returned through PayMongo
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                Use this only if you pushed the refund from the PayMongo dashboard yourself.
              </span>
            </span>
          </label>
        </div>

        <label className="mt-4 block">
          <span className="text-xs font-medium text-muted-foreground">
            Reference{" "}
            {method === "manual" ? "(GCash ref. no., receipt or note)" : "(PayMongo refund id)"}
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value.slice(0, 200))}
            placeholder={method === "manual" ? "e.g. GCash ref 0123 4567 8901" : "e.g. ref_..."}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Optional, but it is what proves the refund later. Shown to the player.
          </span>
        </label>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Not yet
          </button>
          <button
            onClick={() => onConfirm(method, reference)}
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Recording…" : "Mark settled"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingsSection({
  venues,
  userId,
  focusBookingId,
  openChat,
}: {
  venues: Venue[];
  userId: string;
  /** From `?booking=` on a notification link — the session anchor id. */
  focusBookingId?: number;
  /** From `?chat=1` on a message notification. */
  openChat?: boolean;
}) {
  const qc = useQueryClient();
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [status, setStatus] = useState<"all" | "upcoming" | "past" | "cancelled" | "expired">(
    "upcoming",
  );
  const [payFilter, setPayFilter] = useState<
    "all" | "paid" | "pending" | "unpaid" | "failed" | "cancelled" | "refunded"
  >("all");
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [settleTarget, setSettleTarget] = useState<{ ids: number[]; label: string } | null>(null);
  const [chat, setChat] = useState<{
    bookingId: number;
    venueId: number;
    playerId: string;
    title: string;
    subtitle: string;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /* One shot per target. `sessions` is rebuilt on every render, so an effect that
     depended on it would re-run forever and keep re-opening the chat. */
  const focusHandled = useRef<number | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  /* A notification points at one specific booking, and the default filters hide most
     of them — a cancelled or refunded booking is not in "Upcoming". Widen the filters
     so the thing being linked to is actually on screen. */
  useEffect(() => {
    if (!focusBookingId) return;
    focusHandled.current = null;
    setStatus("all");
    setPayFilter("all");
    setVenueFilter("all");
  }, [focusBookingId]);

  const bookingsQ = useQuery({
    queryKey: ["tenant-bookings", venueFilter, status, payFilter],
    queryFn: async () => {
      let q = supabase
        .from("bookings")
        .select(
          "id, court_id, user_id, start_time, end_time, status, payment_status, refund_status, refund_method, refund_reference, created_at, unit_price, discount_amount, courts(name, venue_id, venues(name))",
        )
        .order("start_time", { ascending: false })
        .limit(500);
      if (payFilter !== "all") q = q.eq("payment_status", payFilter);
      const { data, error } = await q;
      if (error) throw error;
      const nowIso = new Date().toISOString();
      let rows = (data as unknown as BookingRow[]) ?? [];
      if (venueFilter !== "all") rows = rows.filter((r) => r.courts?.venue_id === venueFilter);
      if (status === "upcoming")
        rows = rows.filter(
          (r) => r.end_time >= nowIso && (r.status === "pending" || r.status === "confirmed"),
        );
      else if (status === "past")
        rows = rows.filter(
          (r) => r.end_time < nowIso && r.status !== "cancelled" && r.status !== "expired",
        );
      else if (status === "cancelled") rows = rows.filter((r) => r.status === "cancelled");
      else if (status === "expired") rows = rows.filter((r) => r.status === "expired");
      return rows;
    },
  });

  // Load player names for uid list
  const uids = Array.from(new Set((bookingsQ.data ?? []).map((r) => r.user_id)));
  const namesQ = useQuery({
    queryKey: ["profile-names", uids.sort().join(",")],
    enabled: uids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", uids);
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string | null; phone: string | null }[];
    },
  });
  const nameMap = new Map((namesQ.data ?? []).map((p) => [p.id, p]));
  const rows = bookingsQ.data ?? [];
  /* "Upcoming" is a work queue: the soonest booking is the one that still needs
     handling, so it stays on top. Every other filter is a record of what happened,
     where newest means most recently booked rather than the furthest-out slot.
     `created_at` ties are broken on the slot so a multi-court batch stays stable. */
  const sessions = groupBookingSessions(rows).sort((a, b) =>
    status === "upcoming"
      ? a.start_time.localeCompare(b.start_time)
      : b.first.created_at.localeCompare(a.first.created_at) ||
        b.start_time.localeCompare(a.start_time),
  );

  /* One round trip for the whole table rather than a query per row. Keyed on the ids
     actually on screen so it refetches when the filters change. */
  const bookingIdsOnScreen = rows.map((r) => r.id);
  const unreadQ = useQuery({
    queryKey: ["unread-messages", bookingIdsOnScreen.join(",")],
    enabled: bookingIdsOnScreen.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("unread_counts_for_bookings", {
        _booking_ids: bookingIdsOnScreen,
      });
      if (error) throw error;
      const map = new Map<number, number>();
      for (const r of data ?? []) map.set(Number(r.booking_id), Number(r.unread));
      return map;
    },
  });
  /* A session is several booking rows but one conversation per row id; the thread is
     opened on `first`, so that is the row whose count belongs on the button. */
  const unreadFor = (ids: number[]) => ids.reduce((n, id) => n + (unreadQ.data?.get(id) ?? 0), 0);

  const settleRefund = useMutation({
    mutationFn: async (args: {
      ids: number[];
      method: "manual" | "paymongo";
      reference: string;
    }) => {
      const { error } = await supabase.rpc("staff_mark_refund_settled", {
        _booking_ids: args.ids,
        _method: args.method,
        _reference: args.reference.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setSettleTarget(null);
      qc.invalidateQueries({ queryKey: ["tenant-bookings"] });
    },
  });

  /* The link carries the session's anchor id, but any hourly row of the session is a
     valid match — `ids.includes` rather than an equality test on the first id, so a
     link still resolves if the anchor row is filtered out. */
  useEffect(() => {
    if (!focusBookingId || bookingsQ.isLoading) return;
    if (focusHandled.current === focusBookingId) return;
    const target = sessions.find((x) => x.ids.includes(focusBookingId));
    if (!target) return;
    focusHandled.current = focusBookingId;

    document
      .getElementById(`tenant-booking-${target.ids[0]}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });

    if (openChat) {
      const r = target.first;
      const venueId = r.courts?.venue_id;
      if (venueId) {
        setChat({
          bookingId: r.id,
          venueId,
          playerId: r.user_id,
          title: nameMap.get(r.user_id)?.full_name || "Player",
          subtitle: `${formatDateLabel(target.start_time)} · ${formatSessionLabel(target.start_time, target.end_time)} · ${r.courts?.name ?? `Court #${r.court_id}`}`,
        });
      }
    }
  }, [focusBookingId, openChat, bookingsQ.isLoading, sessions, nameMap]);

  const totalUpcoming = rows.filter(
    (r) =>
      r.end_time >= new Date().toISOString() &&
      (r.status === "pending" || r.status === "confirmed"),
  ).length;
  const paidCount = rows.filter((r) => r.payment_status === "paid").length;
  const unpaidCount = rows.filter(
    (r) => r.payment_status === "pending" && r.status === "pending",
  ).length;

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const payBadge = (s: string, refundStatus?: string | null) => {
    const map: Record<string, string> = {
      paid: "bg-primary/15 text-primary",
      pending: "bg-amber-500/15 text-amber-700",
      unpaid: "bg-amber-500/15 text-amber-700",
      failed: "bg-destructive/10 text-destructive",
      cancelled: "bg-muted text-muted-foreground",
      refunded: "bg-muted text-muted-foreground",
    };
    const label =
      refundStatus === "pending"
        ? "Awaiting refund"
        : s === "pending"
          ? "Payment pending"
          : s.replace(/_/g, " ");
    return (
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}
      >
        {label}
      </span>
    );
  };
  const stBadge = (s: string) => {
    const map: Record<string, string> = {
      confirmed: "bg-primary/10 text-primary",
      cancelled: "bg-destructive/10 text-destructive",
      pending: "bg-amber-500/15 text-amber-700",
      expired: "bg-muted text-muted-foreground",
    };
    const label = s === "pending" ? "Payment in progress" : s;
    return (
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}
      >
        {label}
      </span>
    );
  };
  const paymentHoldRemaining = (booking: BookingRow) => {
    if (booking.status !== "pending" || booking.payment_status !== "pending") return null;
    const seconds = Math.max(
      0,
      Math.ceil((new Date(booking.created_at).getTime() + 15 * 60_000 - nowMs) / 1000),
    );
    if (seconds === 0) return "Payment hold expired";
    return `Hold expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="Bookings" subtitle="Monitor every reservation across your venues." />
      <div className="grid gap-3 sm:grid-cols-3">
        <PlayerKpi label="Upcoming" value={String(totalUpcoming)} />
        <PlayerKpi label="Paid" value={String(paidCount)} />
        <PlayerKpi label="Awaiting payment" value={String(unpaidCount)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <VenuePicker venues={venues} value={venueFilter} onChange={setVenueFilter} />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="cancelled">Cancelled</option>
          <option value="expired">Expired</option>
          <option value="all">All</option>
        </select>
        <select
          value={payFilter}
          onChange={(e) => setPayFilter(e.target.value as typeof payFilter)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">Any payment</option>
          <option value="paid">Paid</option>
          <option value="pending">Payment pending</option>
          <option value="unpaid">Unpaid (legacy)</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="refunded">Refunded</option>
        </select>
      </div>

      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="nice-scroll max-h-[65vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Venue · Court</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Payment</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookingsQ.isLoading ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                    No bookings match these filters yet.
                  </td>
                </tr>
              ) : (
                sessions.map((s) => {
                  const r = s.first;
                  const p = nameMap.get(r.user_id);
                  const paid = s.items.some((i) => i.payment_status === "paid");
                  const cancelled = r.status === "cancelled";
                  const venueId = r.courts?.venue_id;
                  const label = `${formatDateLabel(s.start_time)} · ${formatSessionLabel(s.start_time, s.end_time)} · ${r.courts?.name ?? `Court #${r.court_id}`}`;
                  const focused = !!focusBookingId && s.ids.includes(focusBookingId);
                  /* The rules live in @/lib/booking-actions so they can be tested; using
                   them here is what makes those tests mean anything. */
                  const actionInput = {
                    status: r.status,
                    refund_status: r.refund_status ?? "none",
                    sessionEndsAt: s.end_time,
                  };
                  const showCancel = canCancel(actionInput, nowMs);
                  const showSettle = canSettleRefund(actionInput);
                  const refundNote = describeRefund(r.refund_status ?? "none", r.refund_method);
                  return (
                    <tr
                      key={s.key}
                      id={`tenant-booking-${s.ids[0]}`}
                      className={
                        "border-t border-border transition-colors " +
                        (focused ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : "")
                      }
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDateLabel(s.start_time)}
                        <div className="text-[11px] text-muted-foreground">
                          {formatSessionLabel(s.start_time, s.end_time)}
                        </div>
                        {s.ids.length > 1 && (
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {s.ids.length} slots
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {r.courts?.venues?.name ?? "—"}
                        <div className="text-[11px] text-muted-foreground">
                          {r.courts?.name ?? `Court #${r.court_id}`}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {p?.full_name || "Player"}
                        <div className="text-[11px] text-muted-foreground">
                          {p?.phone || r.user_id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {stBadge(r.status)}
                        {paymentHoldRemaining(r) && (
                          <div className="mt-1 text-[10px] font-medium text-amber-700">
                            {paymentHoldRemaining(r)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {payBadge(r.payment_status, r.refund_status)}
                        {/* "Refunded" alone does not say whether PayMongo pushed it back or
                          a manager sent it by hand — which is the whole question when a
                          player asks where their money went. */}
                        {refundNote && (
                          <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
                            {refundNote}
                            {r.refund_reference && (
                              <span className="block truncate" title={r.refund_reference}>
                                {r.refund_reference}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5 whitespace-nowrap">
                          {venueId && (
                            <button
                              onClick={() =>
                                setChat({
                                  bookingId: r.id,
                                  venueId,
                                  playerId: r.user_id,
                                  title: p?.full_name || "Player",
                                  subtitle: label,
                                })
                              }
                              className="relative rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold hover:border-primary hover:text-primary"
                            >
                              Message
                              {/* So a venue can see WHICH booking is waiting on them without
                                depending on a notification having been noticed. Clears
                                itself once the thread is opened. */}
                              {unreadFor(s.ids) > 0 && (
                                <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                                  {unreadFor(s.ids) > 9 ? "9+" : unreadFor(s.ids)}
                                </span>
                              )}
                            </button>
                          )}
                          {/* A refund the venue agreed to settle itself sits on "Awaiting
                            refund" until someone records that it was sent. Nothing in the
                            app called staff_mark_refund_settled before, so this was a
                            dead end. */}
                          {showSettle && (
                            <button
                              onClick={() => setSettleTarget({ ids: s.ids, label })}
                              className="rounded-lg border border-primary/50 px-2.5 py-1.5 text-[11px] font-semibold text-primary hover:bg-primary/10"
                            >
                              Mark refund settled
                            </button>
                          )}
                          {showCancel && (
                            <button
                              onClick={() => setCancelTarget({ label, slots: s.items })}
                              className="rounded-lg border border-destructive/40 px-2.5 py-1.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {cancelTarget && (
        <CancelRefundDialog
          target={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["tenant-bookings"] });
            qc.invalidateQueries({ queryKey: ["notifications"] });
          }}
        />
      )}

      {settleTarget && (
        <SettleRefundDialog
          target={settleTarget}
          busy={settleRefund.isPending}
          error={settleRefund.error instanceof Error ? settleRefund.error.message : null}
          onClose={() => settleRefund.isPending || setSettleTarget(null)}
          onConfirm={(method, reference) =>
            settleRefund.mutate({ ids: settleTarget.ids, method, reference })
          }
        />
      )}
      {chat && (
        <BookingChat
          bookingId={chat.bookingId}
          venueId={chat.venueId}
          playerId={chat.playerId}
          meId={userId}
          title={`Chat with ${chat.title}`}
          subtitle={chat.subtitle}
          onClose={() => {
            setChat(null);
            qc.invalidateQueries({ queryKey: ["unread-messages"] });
          }}
        />
      )}
    </div>
  );
}

// ================= Customers =================

/** How many booking rows a single tenant query will pull back. Raised from the
 *  2,000 it was: the lifetime pass behind repeat-customer status has to see a
 *  customer's whole history, and 2,000 rows across a multi-venue account is a
 *  season, not a history. See REPORT: above this cap the lifetime count is a
 *  floor, not a total, which the UI says out loud rather than hiding. */
const TENANT_ROW_CAP = 10_000;

/** "all" is the whole book. A year is a reporting period — it scopes what a
 *  customer booked and spent, and never what they are. */
type ReportYear = "all" | number;

/** Current year back to the oldest venue, capped at five entries so the control
 *  stays a control. */
function tenantYears(venues: Venue[], tz: string): number[] {
  const thisYear = Number(zonedDateISO(new Date(), tz).slice(0, 4));
  let earliest = thisYear;
  for (const v of venues) {
    if (!v.created_at) continue;
    const y = new Date(v.created_at).getUTCFullYear();
    if (Number.isFinite(y) && y < earliest) earliest = y;
  }
  earliest = Math.max(earliest, thisYear - 4);
  const out: number[] = [];
  for (let y = thisYear; y >= earliest; y--) out.push(y);
  return out;
}

type CustomerSortKey = "recent" | "spend" | "name" | "bookings";

/** Each column has a direction it is naturally read in first — money and counts
 *  from the top, names from A. Clicking the column already sorted flips it. */
const CUSTOMER_SORT_DEFAULT_DIR: Record<CustomerSortKey, "asc" | "desc"> = {
  recent: "desc",
  spend: "desc",
  bookings: "desc",
  name: "asc",
};

function CustomerTh({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: CustomerSortKey;
  sort: { key: CustomerSortKey; dir: "asc" | "desc" };
  onSort: (k: CustomerSortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className="px-4 py-3"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={
          "group inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-foreground " +
          (active ? "text-foreground" : "")
        }
      >
        {label}
        {/* The arrow shows only on the column actually sorting, so the header row
            does not read as four competing controls. */}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronDown className="h-3.5 w-3.5 opacity-0 transition group-hover:opacity-40" />
        )}
      </button>
    </th>
  );
}

function CustomersSection({ venues }: { venues: Venue[] }) {
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  /* Defaults to the whole book, so the roster a tenant already knows is what
     loads; picking a year narrows the reporting, never the repeat verdict. */
  const [year, setYear] = useState<ReportYear>("all");
  const [query, setQuery] = useState("");
  /* One piece of state behind both the select and the column headers, so the two
     controls can never claim different orderings of the same table. */
  const [sort, setSort] = useState<{ key: CustomerSortKey; dir: "asc" | "desc" }>({
    key: "recent",
    dir: "desc",
  });
  const sortOn = (key: CustomerSortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: CUSTOMER_SORT_DEFAULT_DIR[key] },
    );

  const dataQ = useQuery({
    queryKey: ["tenant-customers", venueFilter, year],
    queryFn: async () => {
      const tz = venues[0]?.timezone || DEFAULT_TIMEZONE;
      /* The reporting period. Null means the whole book. */
      const period =
        year === "all"
          ? null
          : {
              from: zonedDayBoundsUtc(`${year}-01-01`, tz).start.toISOString(),
              to: zonedDayBoundsUtc(`${year + 1}-01-01`, tz).start.toISOString(),
            };

      let bq = supabase
        .from("bookings")
        .select(
          "id, user_id, start_time, end_time, payment_status, status, cancelled_at, courts!inner(venue_id)",
        )
        /* Excluded in the query rather than after it. A cancelled row can never
           count, so letting one occupy a slot under the cap spends a row that
           could have been a real booking. */
        .not("status", "in", NON_COUNTING_STATUS_FILTER)
        .is("cancelled_at", null)
        .order("start_time", { ascending: false })
        .limit(TENANT_ROW_CAP);
      if (venueFilter !== "all") bq = bq.eq("courts.venue_id", venueFilter);
      if (period) bq = bq.gte("start_time", period.from).lt("start_time", period.to);
      const { data: bookingRows, error } = await bq;
      if (error) throw error;
      /* The predicate runs again on the way in. The filter above and this share
         one definition, and if the two ever drift it is the code that decides. */
      const bookings = (bookingRows ?? []).filter(isCountableBooking);

      let txQ = supabase
        .from("transactions")
        .select("user_id, amount, status, venue_id, paid_at, created_at");
      if (venueFilter !== "all") txQ = txQ.eq("venue_id", venueFilter);
      const { data: txRows } = await txQ;
      /* Spend follows the reporting period by settlement date, matching how the
         Dashboard dates revenue, so the two panes cannot disagree about a year. */
      const txs = (txRows ?? []).filter((t) => {
        if (t.status !== "paid") return false;
        if (!period) return true;
        const settled = t.paid_at ?? t.created_at;
        return !!settled && settled >= period.from && settled < period.to;
      });

      const uids = Array.from(new Set(bookings.map((b) => b.user_id)));

      /* ── the lifetime pass ──────────────────────────────────────────────────
         Repeat status is lifetime return behaviour, so this deliberately carries
         no period filter even when a year is selected. It selects the two columns
         the count needs and nothing else, so the cap stretches much further here
         than it would over full booking rows. When a year is not selected the
         period query already is the whole book, and is reused. */
      let lifetimeRows: { user_id: string; status: string | null; cancelled_at: string | null }[] =
        bookings;
      let lifetimeSaturated = bookings.length >= TENANT_ROW_CAP;
      if (period && uids.length > 0) {
        let lq = supabase
          .from("bookings")
          .select("user_id, status, cancelled_at, start_time, courts!inner(venue_id)")
          .not("status", "in", NON_COUNTING_STATUS_FILTER)
          .is("cancelled_at", null)
          .in("user_id", uids)
          /* Newest first so that if the cap is ever reached it is the oldest rows
             that fall off. Truncation then costs a long-dormant customer their
             badge — which the notice on screen says — rather than dropping an
             arbitrary slice nobody can reason about. */
          .order("start_time", { ascending: false })
          .limit(TENANT_ROW_CAP);
        if (venueFilter !== "all") lq = lq.eq("courts.venue_id", venueFilter);
        const { data: lifetime, error: lifetimeErr } = await lq;
        if (lifetimeErr) throw lifetimeErr;
        lifetimeRows = lifetime ?? [];
        lifetimeSaturated = lifetimeRows.length >= TENANT_ROW_CAP;
      }
      const lifetimeCounts = countByUser(lifetimeRows.filter(isCountableBooking));

      const { data: profiles } =
        uids.length > 0
          ? await supabase
              .from("profiles")
              .select("id, full_name, phone, avatar_url, created_at")
              .in("id", uids)
          : {
              data: [] as {
                id: string;
                full_name: string | null;
                phone: string | null;
                avatar_url: string | null;
                created_at: string;
              }[],
            };

      type Agg = {
        id: string;
        name: string;
        phone: string;
        avatarUrl: string | null;
        since: string | null;
        /** Countable bookings inside the reporting period. */
        bookings: number;
        /** Countable bookings across the customer's whole history here. */
        lifetimeBookings: number;
        paidBookings: number;
        spent: number;
        lastAt: string | null;
      };
      const map = new Map<string, Agg>();
      for (const b of bookings) {
        const cur = map.get(b.user_id) ?? {
          id: b.user_id,
          name: "",
          phone: "",
          avatarUrl: null,
          since: null,
          bookings: 0,
          lifetimeBookings: 0,
          paidBookings: 0,
          spent: 0,
          lastAt: null,
        };
        /* Cancelled rows never reach here — they are gone from the query and from
           the predicate above — so this can no longer make a one-off booker who
           cancelled once look like a customer who came back. */
        cur.bookings += 1;
        if (b.payment_status === "paid") cur.paidBookings += 1;
        if (!cur.lastAt || b.start_time > cur.lastAt) cur.lastAt = b.start_time;
        map.set(b.user_id, cur);
      }
      for (const [id, cur] of map) cur.lifetimeBookings = lifetimeCounts.get(id) ?? cur.bookings;
      for (const t of txs) {
        const cur = map.get(t.user_id);
        if (cur) cur.spent += Number(t.amount);
      }
      for (const p of profiles ?? []) {
        const cur = map.get(p.id);
        if (cur) {
          cur.name = p.full_name ?? "";
          cur.phone = p.phone ?? "";
          cur.avatarUrl = p.avatar_url;
          cur.since = p.created_at;
        }
      }
      return { rows: Array.from(map.values()), lifetimeSaturated };
    },
  });

  /* Memoised, not `dataQ.data ?? []` inline: the fallback builds a fresh array
     on every render, which would change the deps of the sort below each time
     and re-sort the whole table for nothing. */
  const all = useMemo(() => dataQ.data?.rows ?? [], [dataQ.data]);

  /* Ordered and filtered outside the query so typing or re-sorting works on rows
     already loaded instead of refetching every booking and transaction again. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? all.filter(
          (r) =>
            (r.name || "player").toLowerCase().includes(needle) ||
            (r.phone ?? "").toLowerCase().includes(needle),
        )
      : all.slice();
    const sign = sort.dir === "asc" ? -1 : 1;
    list.sort((a, b) => {
      switch (sort.key) {
        case "spend":
          return sign * (b.spent - a.spent || b.bookings - a.bookings);
        case "bookings":
          return sign * (b.bookings - a.bookings || b.spent - a.spent);
        case "name":
          /* localeCompare so "Ángeles" files where a reader expects it, and the
             unnamed fall in as "Player" rather than sorting ahead of everyone. */
          return -sign * (a.name || "Player").localeCompare(b.name || "Player");
        default:
          return sign * (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
      }
    });
    return list;
  }, [all, query, sort]);

  /* The tiles count the whole book, never the search result — a total that drops
     as you type is not a total. */
  const totalCustomers = all.length;
  const totalSpent = all.reduce((s, r) => s + r.spent, 0);
  /* Lifetime, never the period. A customer who booked three times in 2024 and
     once in the year being reported on is still someone who came back. */
  const repeat = all.filter((r) => isRepeatCustomer(r.lifetimeBookings)).length;
  const years = useMemo(
    () => tenantYears(venues, venues[0]?.timezone || DEFAULT_TIMEZONE),
    [venues],
  );
  /* Said out loud rather than hidden: past the cap the lifetime counts are a
     floor, so a long-standing customer could read as first-time. */
  const lifetimeSaturated = dataQ.data?.lifetimeSaturated ?? false;
  const currency = (n: number) =>
    "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <SectionHeader title="Customers" subtitle="Players who have booked your venues." />
      <div className="grid gap-3 sm:grid-cols-3">
        <PlayerKpi
          label="Total customers"
          value={String(totalCustomers)}
          icon={<Users className="h-4 w-4" />}
        />
        <PlayerKpi
          label="Repeat customers"
          value={String(repeat)}
          hint={
            totalCustomers > 0
              ? `${Math.round((repeat / totalCustomers) * 100)}% booked more than once`
              : undefined
          }
          icon={<Repeat className="h-4 w-4" />}
        />
        <PlayerKpi
          label="Lifetime revenue"
          value={currency(totalSpent)}
          icon={<Wallet className="h-4 w-4" />}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-55 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            placeholder="Search name or phone"
            aria-label="Search customers"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <VenuePicker venues={venues} value={venueFilter} onChange={setVenueFilter} />
        {/* The reporting period. It scopes the bookings, spend and last-booking
            figures below; it deliberately does not reach the repeat badge, which
            is about whether someone ever came back, not when. */}
        <div className="relative">
          <select
            value={year === "all" ? "all" : String(year)}
            onChange={(e) => setYear(e.target.value === "all" ? "all" : Number(e.target.value))}
            aria-label="Reporting year"
            className="appearance-none rounded-lg border border-border bg-background py-2 pl-3 pr-9 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value="all">All time</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        {/* The same ordering the column headers drive. A native select keeps the
            platform's own picker on a phone, so the chevron is drawn rather than
            the control replaced. */}
        <div className="relative">
          <select
            value={sort.key}
            onChange={(e) => {
              const key = e.target.value as CustomerSortKey;
              setSort({ key, dir: CUSTOMER_SORT_DEFAULT_DIR[key] });
            }}
            aria-label="Sort customers"
            className="appearance-none rounded-lg border border-border bg-background py-2 pl-3 pr-9 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value="recent">Most recent booking</option>
            <option value="spend">Highest spend</option>
            <option value="bookings">Most bookings</option>
            <option value="name">Name A–Z</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>
      {lifetimeSaturated && (
        <div
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          style={{ borderColor: VIZ.pending, backgroundColor: "#fab2191a" }}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#8a6100" }} />
          <span>
            This account has more than {TENANT_ROW_CAP.toLocaleString("en-PH")} bookings on record,
            so the lifetime history behind the repeat badge is read from the most recent{" "}
            {TENANT_ROW_CAP.toLocaleString("en-PH")}. The booking counts shown are exact; a
            long-dormant customer may be missing a repeat badge they have earned.
          </span>
        </div>
      )}
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="nice-scroll max-h-[65vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <CustomerTh label="Customer" sortKey="name" sort={sort} onSort={sortOn} />
                <th className="px-4 py-3">Phone</th>
                <CustomerTh label="Bookings" sortKey="bookings" sort={sort} onSort={sortOn} />
                <CustomerTh label="Spent" sortKey="spend" sort={sort} onSort={sortOn} />
                <CustomerTh label="Last booking" sortKey="recent" sort={sort} onSort={sortOn} />
              </tr>
            </thead>
            <tbody>
              {dataQ.isLoading ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  {/* Told apart on purpose: an empty book and a search that matched
                      nothing look identical otherwise, and only one of them is
                      fixed by clearing the box. */}
                  <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                    {all.length === 0
                      ? "No customers yet — once players book, they'll show up here."
                      : `No customer matches “${query.trim()}”.`}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          avatarUrl={r.avatarUrl}
                          fullName={r.name || "Player"}
                          className="h-9 w-9 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="font-medium break-words">{r.name || "Player"}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                            {/* A repeat booker is the one fact a venue acts on, and
                                it was previously buried in a bare count. Word and
                                icon, never the badge colour alone. */}
                            {isRepeatCustomer(r.lifetimeBookings) && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold"
                                style={{ color: VIZ.up, backgroundColor: "#0063001a" }}
                              >
                                <Repeat className="h-3 w-3" /> Repeat
                              </span>
                            )}
                            {r.since && (
                              <span>
                                since{" "}
                                {new Date(r.since).toLocaleDateString("en-PH", {
                                  month: "short",
                                  year: "numeric",
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.phone || "—"}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium tabular-nums">{r.bookings}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {r.paidBookings} paid
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums">{currency(r.spent)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.lastAt
                        ? new Date(r.lastAt).toLocaleDateString("en-PH", { dateStyle: "medium" })
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ================= Calendar (Day view) =================

type CalBooking = {
  id: number;
  court_id: number;
  user_id: string;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  courts: {
    name: string;
    venue_id: number;
    sport_id: number;
    venues: { name: string } | null;
    sports: { name: string; slug: string | null } | null;
  } | null;
};

function CalendarSection({ venues }: { venues: Venue[] }) {
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [sportFilter, setSportFilter] = useState<string | "all">("all");
  const [day, setDay] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const dayStart = new Date(day);
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const venueIds = venueFilter === "all" ? venues.map((v) => v.id) : [venueFilter];

  const courtsQ = useQuery({
    queryKey: [
      "cal-courts",
      venueIds
        .slice()
        .sort((a, b) => a - b)
        .join(","),
    ],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, venue_id, sport_id, sports(name, slug)")
        .in("venue_id", venueIds)
        .order("venue_id", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: number;
        name: string;
        venue_id: number;
        sport_id: number;
        sports: { name: string; slug: string | null } | null;
      }[];
    },
  });

  const bookingsQ = useQuery({
    queryKey: [
      "cal-bookings",
      venueIds
        .slice()
        .sort((a, b) => a - b)
        .join(","),
      dayStart.toISOString(),
    ],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select(
          "id, court_id, user_id, start_time, end_time, status, payment_status, courts!inner(name, venue_id, sport_id, venues(name), sports(name, slug))",
        )
        .lt("start_time", dayEnd.toISOString())
        .gt("end_time", dayStart.toISOString())
        .in("courts.venue_id", venueIds)
        .neq("status", "cancelled")
        .order("start_time", { ascending: true });
      if (error) throw error;
      return (data as unknown as CalBooking[]) ?? [];
    },
  });

  const uids = Array.from(new Set((bookingsQ.data ?? []).map((r) => r.user_id)));
  const namesQ = useQuery({
    queryKey: ["cal-profile-names", uids.slice().sort().join(",")],
    enabled: uids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", uids);
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string | null }[];
    },
  });
  const nameMap = new Map((namesQ.data ?? []).map((p) => [p.id, p.full_name]));

  const allCourts = courtsQ.data ?? [];
  const sportsInView = Array.from(
    new Map(
      allCourts
        .filter((c) => c.sports)
        .map((c) => [c.sports!.slug ?? c.sports!.name.toLowerCase(), c.sports!]),
    ).values(),
  );

  const courtsShown =
    sportFilter === "all"
      ? allCourts
      : allCourts.filter((c) => (c.sports?.slug ?? c.sports?.name.toLowerCase()) === sportFilter);

  const bookings = (bookingsQ.data ?? []).filter((b) => {
    if (sportFilter === "all") return true;
    const slug = b.courts?.sports?.slug ?? b.courts?.sports?.name.toLowerCase();
    return slug === sportFilter;
  });

  // Hourly rows are merged into one session block per player + court run.
  const sessions = groupBookingSessions(bookings);

  // Full 24-hour day is always visible; "compact" shrinks rows so it fits without scrolling.
  const [compact, setCompact] = useState(true);
  const HOUR_START = 0;
  const HOUR_END = 24;
  const HOURS = HOUR_END - HOUR_START;
  const ROW_H = compact ? 34 : 60;
  const gridHeight = HOURS * ROW_H;

  const isToday = (() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime() === day.getTime();
  })();

  const nudgeDay = (delta: number) => {
    const d = new Date(day);
    d.setDate(d.getDate() + delta);
    setDay(d);
  };

  const dayLabel = day.toLocaleDateString("en-PH", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Calendar"
        subtitle="Full 24-hour day view across every court, sport and player."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-full border border-border bg-card">
            <button className="bg-foreground px-4 py-1.5 text-xs font-semibold text-background">
              Day
            </button>
            <button disabled className="px-4 py-1.5 text-xs font-medium text-muted-foreground/60">
              Schedule
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => nudgeDay(-1)}
              className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-sm hover:bg-secondary"
              aria-label="Previous day"
            >
              ‹
            </button>
            <button
              onClick={() => {
                const t = new Date();
                t.setHours(0, 0, 0, 0);
                setDay(t);
              }}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold ${isToday ? "bg-primary text-primary-foreground" : "border border-border bg-card hover:bg-secondary"}`}
            >
              Today
            </button>
            <button
              onClick={() => nudgeDay(1)}
              className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-sm hover:bg-secondary"
              aria-label="Next day"
            >
              ›
            </button>
          </div>
        </div>

        <div className="text-sm font-semibold sm:text-base">{dayLabel}</div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCompact((v) => !v)}
            className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold hover:bg-secondary"
            title="Toggle row height — compact fits all 24 hours on one screen"
          >
            {compact ? "Compact 24h" : "Expanded 24h"}
          </button>
          <VenuePicker venues={venues} value={venueFilter} onChange={setVenueFilter} size="xs" />

          <div className="inline-flex flex-wrap items-center gap-1">
            <button
              onClick={() => setSportFilter("all")}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold ${sportFilter === "all" ? "bg-primary text-primary-foreground" : "border border-border bg-card hover:bg-secondary"}`}
            >
              All
            </button>
            {sportsInView.map((s) => {
              const slug = s.slug ?? s.name.toLowerCase();
              const active = sportFilter === slug;
              const st = sportStyle(slug);
              return (
                <button
                  key={slug}
                  onClick={() => setSportFilter(active ? "all" : slug)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${active ? "bg-foreground text-background" : "border border-border bg-card hover:bg-secondary"}`}
                >
                  <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card shadow-sm">
        {courtsQ.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading calendar…</div>
        ) : courtsShown.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No courts to display. Add a court to see it here.
          </div>
        ) : (
          <div className="nice-scroll max-h-[72vh] overflow-auto">
            <div className="min-w-max">
              <div className="sticky top-0 z-20 flex border-b border-border bg-card/95 backdrop-blur">
                <div className="sticky left-0 z-30 w-16 shrink-0 bg-card/95" />
                {courtsShown.map((c) => {
                  const st = sportStyle(c.sports?.slug ?? c.sports?.name.toLowerCase());
                  return (
                    <div key={c.id} className="w-40 shrink-0 border-l border-border px-3 py-2">
                      <div className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {c.name}
                      </div>
                      <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {c.sports?.name ?? "Sport"}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="relative flex">
                <div
                  className="sticky left-0 z-10 w-16 shrink-0 bg-card"
                  style={{ height: gridHeight }}
                >
                  {Array.from({ length: HOURS }).map((_, i) => {
                    const h = HOUR_START + i;
                    const label =
                      h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;
                    return (
                      <div
                        key={h}
                        style={{ height: ROW_H }}
                        className="relative border-t border-transparent"
                      >
                        <div
                          className={`absolute right-2 whitespace-nowrap text-[10px] font-medium leading-none text-muted-foreground ${i === 0 ? "top-0.5" : "top-0 -translate-y-1/2"}`}
                        >
                          {label}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {courtsShown.map((c) => {
                  const colSessions = sessions.filter((s) => s.first.court_id === c.id);
                  return (
                    <div
                      key={c.id}
                      className="relative w-40 shrink-0 border-l border-border"
                      style={{ height: gridHeight }}
                    >
                      {Array.from({ length: HOURS }).map((_, i) => (
                        <div
                          key={i}
                          style={{ top: i * ROW_H, height: ROW_H }}
                          className={`absolute inset-x-0 border-t ${(HOUR_START + i) % 6 === 0 ? "border-border" : "border-border/40"}`}
                        />
                      ))}

                      {colSessions.map((sess) => {
                        const b = sess.first;
                        const s = new Date(sess.start_time);
                        const e = new Date(sess.end_time);
                        // Clip overnight sessions to the visible day.
                        const startH = s < dayStart ? 0 : s.getHours() + s.getMinutes() / 60;
                        const rawEnd = e > dayEnd ? 24 : e.getHours() + e.getMinutes() / 60;
                        const endH = rawEnd <= startH ? 24 : rawEnd;
                        const top = Math.max(0, (startH - HOUR_START) * ROW_H);
                        const height = Math.max(22, (endH - startH) * ROW_H - 3);
                        const st = sportStyle(
                          b.courts?.sports?.slug ?? b.courts?.sports?.name.toLowerCase(),
                        );
                        const sportName = b.courts?.sports?.name ?? "Booking";
                        const player = nameMap.get(b.user_id) || "Player";
                        const range = `${s.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}`;
                        const density = height < 34 ? "xs" : height < 58 ? "sm" : "full";
                        return (
                          <div
                            key={sess.key}
                            style={{ top, height }}
                            title={`${player} · ${sportName} · ${range} (${sess.hours} hr${sess.hours > 1 ? "s" : ""})`}
                            className={`absolute inset-x-1 flex flex-col justify-center overflow-hidden rounded-lg border ${st.bg} ${st.border} ${st.text} px-1.5 py-0.5 shadow-sm`}
                          >
                            <div className="flex min-w-0 items-center gap-1 text-[11px] font-semibold leading-tight">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} />
                              <span className="truncate">{player}</span>
                              {density === "xs" && (
                                <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] font-medium opacity-70">
                                  {sess.hours}h
                                </span>
                              )}
                            </div>
                            {density !== "xs" && (
                              <div className="truncate whitespace-nowrap text-[10px] leading-tight opacity-75">
                                {range} · {sess.hours}h
                              </div>
                            )}
                            {density === "full" && (
                              <div className="truncate whitespace-nowrap text-[10px] leading-tight opacity-80">
                                {sportName}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {isToday &&
                        (() => {
                          const now = new Date();
                          const nowTop =
                            (now.getHours() + now.getMinutes() / 60 - HOUR_START) * ROW_H;
                          return (
                            <div
                              className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-primary"
                              style={{ top: nowTop }}
                            />
                          );
                        })()}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold">
          Players booked on {dayLabel}
          <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {sessions.length}
          </span>
        </div>
        {bookingsQ.isLoading ? (
          <div className="text-xs text-muted-foreground">Loading bookings…</div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-muted-foreground">No bookings for this date.</div>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((sess) => {
              const b = sess.first;
              const st = sportStyle(b.courts?.sports?.slug ?? b.courts?.sports?.name.toLowerCase());
              return (
                <li
                  key={sess.key}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                    <span className="truncate font-semibold">
                      {nameMap.get(b.user_id) || "Player"}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {b.courts?.sports?.name ?? "Sport"} · {b.courts?.name} ·{" "}
                      {b.courts?.venues?.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {formatSessionLabel(sess.start_time, sess.end_time)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${sess.items.some((i) => i.payment_status === "paid") ? "bg-emerald-100 text-emerald-800" : "bg-secondary text-muted-foreground"}`}
                    >
                      {sess.items.some((i) => i.payment_status === "paid") ? "Paid" : "Unpaid"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
/** Shared stat tile used by the tenant sections (transactions, bookings, customers).
 *  The player workspace uses `PlayerTile` instead — see the note there. */
function PlayerKpi({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Optional, so the seven call sites that predate it keep rendering as they did. */
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      </div>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ===========================================================================
// Vouchers Section
// ===========================================================================
function VouchersSection({ venues }: { venues: Venue[] }) {
  const qc = useQueryClient();
  const [venueId, setVenueId] = useState<number | null>(venues[0]?.id ?? null);

  const vq = useQuery({
    queryKey: ["vouchers", venueId],
    queryFn: async () => {
      if (!venueId) return [];
      const { data, error } = await supabase
        .from("vouchers")
        .select(
          "id, code, discount_type, discount_value, expires_at, max_uses, one_per_user, min_booking_amount, is_active, notes, created_at",
        )
        .eq("venue_id", venueId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!venueId,
  });

  const usageQ = useQuery({
    queryKey: ["voucher-usage", venueId],
    queryFn: async () => {
      if (!venueId) return {} as Record<string, number>;
      const ids = (vq.data ?? []).map((v) => v.id);
      if (ids.length === 0) return {};
      const { data, error } = await supabase
        .from("voucher_redemptions")
        .select("voucher_id")
        .in("voucher_id", ids);
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of data ?? [])
        map[r.voucher_id as string] = (map[r.voucher_id as string] ?? 0) + 1;
      return map;
    },
    enabled: !!venueId && !!vq.data,
  });

  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("10");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [maxUses, setMaxUses] = useState("");
  const [onePerUser, setOnePerUser] = useState(true);
  const [minAmount, setMinAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const genCode = () => {
    const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 8; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
    setCode(s);
  };

  const createMut = useMutation({
    mutationFn: async () => {
      if (!venueId) throw new Error("Pick a venue");
      const c = code.trim().toUpperCase();
      if (!c) throw new Error("Voucher code is required");
      const val = Number(discountValue);
      if (!val || val <= 0) throw new Error("Discount must be greater than 0");
      if (discountType === "percent" && val > 100) throw new Error("Percentage cannot exceed 100");
      const payload = {
        venue_id: venueId,
        code: c,
        discount_type: discountType,
        discount_value: val,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        max_uses: maxUses ? Math.max(1, Math.floor(Number(maxUses))) : null,
        one_per_user: onePerUser,
        min_booking_amount: minAmount ? Number(minAmount) : null,
        notes: notes.trim() || null,
        is_active: true,
      };
      const { error } = await supabase.from("vouchers").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      setCode("");
      setDiscountValue("10");
      setExpiresAt("");
      setMaxUses("");
      setMinAmount("");
      setNotes("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["vouchers", venueId] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("vouchers").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vouchers", venueId] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("vouchers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vouchers", venueId] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-bold">Vouchers</h2>
        <p className="text-sm text-muted-foreground">
          Create discount codes players can redeem when booking a court that accepts vouchers.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Venue:</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          value={venueId ?? ""}
          onChange={(e) => setVenueId(e.target.value ? Number(e.target.value) : null)}
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>

      {venueId && (
        <div className="rounded-2xl border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <TicketPercent className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">Create voucher</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Code</label>
              <div className="flex gap-1">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g. SUMMER10"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm uppercase"
                />
                <button
                  type="button"
                  onClick={genCode}
                  className="rounded-md border px-2 text-xs hover:bg-secondary"
                >
                  Auto
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Discount type</label>
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as "percent" | "amount")}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="percent">Percentage (%)</option>
                <option value="amount">Fixed amount (₱)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                {discountType === "percent" ? "Percentage off" : "Amount off (₱)"}
              </label>
              <input
                type="number"
                min="1"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Expires at (optional)</label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Max total uses (optional)</label>
              <input
                type="number"
                min="1"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                Minimum booking amount (₱, optional)
              </label>
              <input
                type="number"
                min="0"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onePerUser}
                onChange={(e) => setOnePerUser(e.target.checked)}
              />
              One redemption per player
            </label>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1 block text-xs font-medium">Notes (optional, internal)</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          {err && <div className="mt-2 text-sm text-red-600">{err}</div>}
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {createMut.isPending ? "Creating…" : "Create voucher"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Players can only redeem a voucher on courts where you've ticked <b>Accept vouchers</b>{" "}
            (in Add/Edit court).
          </p>
        </div>
      )}

      <div className="rounded-2xl border bg-card">
        <div className="border-b px-4 py-2 text-sm font-semibold">
          Vouchers ({vq.data?.length ?? 0})
        </div>
        <div className="nice-scroll overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Code</th>
                <th className="p-3 text-left">Discount</th>
                <th className="p-3 text-left">Uses</th>
                <th className="p-3 text-left">Expires</th>
                <th className="p-3 text-left">Min ₱</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(vq.data ?? []).map((v) => {
                const used = usageQ.data?.[v.id as string] ?? 0;
                return (
                  <tr key={v.id as string} className="border-t">
                    <td className="p-3 font-mono font-semibold">{v.code}</td>
                    <td className="p-3">
                      {v.discount_type === "percent"
                        ? `${v.discount_value}%`
                        : `₱${Number(v.discount_value).toFixed(2)}`}
                    </td>
                    <td className="p-3">
                      {used}
                      {v.max_uses ? ` / ${v.max_uses}` : ""}
                      {v.one_per_user && (
                        <span className="ml-1 text-[10px] text-muted-foreground">(1/player)</span>
                      )}
                    </td>
                    <td className="p-3">
                      {v.expires_at ? new Date(v.expires_at as string).toLocaleString() : "—"}
                    </td>
                    <td className="p-3">
                      {v.min_booking_amount ? `₱${Number(v.min_booking_amount).toFixed(2)}` : "—"}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() =>
                          toggleActive.mutate({ id: v.id as string, is_active: !v.is_active })
                        }
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.is_active ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
                      >
                        {v.is_active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete voucher ${v.code}? Existing redemptions will be removed.`,
                            )
                          )
                            del.mutate(v.id as string);
                        }}
                        className="rounded-md border px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {(vq.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground">
                    No vouchers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
