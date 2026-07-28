import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { retryBookingPayment, cancelPendingBookings } from "@/lib/paymongo.functions";
import { groupBookingSessions, formatDateLabel, formatSessionLabel, formatTimeRange } from "@/lib/booking-groups";

import { CourtBlockRulesEditor, allPairsEnabled, ruleKey, type RuleCourt } from "@/components/CourtBlockRulesEditor";
import { RateRulesEditor } from "@/components/RateRulesEditor";
import { normalizeRules, type RateRule } from "@/lib/court-pricing";
import { OperatingHoursEditor, CourtHoursEditor } from "@/components/OperatingHoursEditor";
import { normalizeHours, openHoursForDay, openHoursForDate, effectiveHours, fullWeek, describeWindow, HOUR_DAY_KEYS, type DayKey, type HoursMap } from "@/lib/operating-hours";
import { MapPicker } from "@/components/MapPicker";
import { ImageUploader } from "@/components/ImageUploader";
import { EmojiPicker } from "@/components/EmojiPicker";
import { MapInfoButton } from "@/components/MapInfoButton";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { NotificationBell } from "@/components/NotificationBell";
import { BookingChat } from "@/components/BookingChat";
import { CancelRefundDialog, type CancelTarget } from "@/components/CancelRefundDialog";
import { HoursConflictDialog, type HoursConflict } from "@/components/HoursConflictDialog";
import { findHoursConflicts } from "@/lib/hours-conflicts";
import { cancelBookingsWithRefund } from "@/lib/refunds.functions";

const chLogo = { url: "/CHicon.png" };
import {
  LayoutDashboard, CalendarDays, BookOpen, LandPlot, Users, UserCog,
  Receipt, Settings as SettingsIcon, Menu, X, Layers, MapPin, Pencil, Trash2, Clock, AlertTriangle, History as HistoryIcon,
  TableProperties, ChevronRight, ChevronLeft, ChevronUp, ChevronDown, Search as SearchIcon, Save, Bookmark, TicketPercent,
} from "lucide-react";

type SectionKey =
  | "dashboard" | "calendar" | "bookings" | "courts"
  | "customers" | "team" | "transactions" | "vouchers" | "settings";

const NAV: { key: SectionKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
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

export const Route = createFileRoute("/_authenticated/dashboard")({
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

// Rough country bounding boxes → suggested timezone. Philippines is the
// primary market so we restrict pins to it by default (see PH_BOUNDS below).
const TZ_BOUNDS: { tz: string; country: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
  { tz: "Asia/Manila", country: "Philippines", minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127 },
  { tz: "Asia/Singapore", country: "Singapore", minLat: 1.15, maxLat: 1.5, minLng: 103.6, maxLng: 104.05 },
  { tz: "Asia/Hong_Kong", country: "Hong Kong", minLat: 22.15, maxLat: 22.58, minLng: 113.83, maxLng: 114.44 },
  { tz: "Asia/Kuala_Lumpur", country: "Malaysia", minLat: 0.85, maxLat: 7.4, minLng: 99.6, maxLng: 119.3 },
  { tz: "Asia/Jakarta", country: "Indonesia (WIB)", minLat: -8.8, maxLat: 6.1, minLng: 95, maxLng: 141 },
  { tz: "Asia/Bangkok", country: "Thailand", minLat: 5.6, maxLat: 20.5, minLng: 97.3, maxLng: 105.7 },
  { tz: "Asia/Tokyo", country: "Japan", minLat: 24, maxLat: 45.6, minLng: 122.9, maxLng: 146 },
  { tz: "Asia/Seoul", country: "South Korea", minLat: 33, maxLat: 38.7, minLng: 124.5, maxLng: 131 },
  { tz: "Asia/Taipei", country: "Taiwan", minLat: 21.8, maxLat: 25.4, minLng: 119.3, maxLng: 122.1 },
  { tz: "Australia/Sydney", country: "Australia", minLat: -44, maxLat: -10, minLng: 112, maxLng: 154 },
];

const PH_BOUNDS = TZ_BOUNDS[0];

function suggestTimezone(lat: number | null, lng: number | null): { tz: string; country: string } | null {
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
  return lat >= PH_BOUNDS.minLat && lat <= PH_BOUNDS.maxLat && lng >= PH_BOUNDS.minLng && lng <= PH_BOUNDS.maxLng;
}

export type FeeItem = { label: string; amount: number };
type Venue = { id: number; name: string; address: string; timezone: string; latitude: number | null; longitude: number | null; description: string | null; images: string[] | null; map_emoji: string | null; created_at?: string | null; is_active?: boolean; amenities?: string[] | null; food_beverages?: string[] | null; facility_services?: string[] | null; fees?: FeeItem[] | null; fees_notes?: string | null; contact_phone?: string | null; contact_email?: string | null; operating_hours?: unknown; operating_hours_text?: string | null; refund_cutoff_hours?: number | null; cancellation_notes?: string | null; rules?: string | null };

const ACTIVE_INFO_TEXT = "A venue can only be set inactive when none of its courts have upcoming or in-progress confirmed bookings. If bookings exist, wait until their end time passes. Any pending (awaiting-payment) bookings will be automatically cancelled and those players will be notified to pick another venue. Inactive venues are hidden from the landing page map and list.";
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
type PhysicalCourt = { id: number; venue_id: number; name: string; map_emoji: string | null; description: string | null };

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


function Dashboard() {
  const { user } = Route.useRouteContext() as { user: { id: string; email?: string } };
  const qc = useQueryClient();
  const [section, setSection] = useState<SectionKey>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [createVenueOpen, setCreateVenueOpen] = useState(false);
  const [addCourtOpen, setAddCourtOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);

  const profileQ = useQuery({
    queryKey: ["profile", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const venuesQ = useQuery({
    queryKey: ["my-venues", user.id],
    queryFn: async () => {
      const { data: staffRows, error: se } = await supabase.from("staff").select("venue_id").eq("user_id", user.id);
      if (se) throw se;
      const ids = (staffRows ?? []).map((r) => r.venue_id);
      if (ids.length === 0) return [] as Venue[];
      const { data, error } = await supabase.from("venues").select("*").in("id", ids).order("id", { ascending: false });
      if (error) throw error;
      return data as Venue[];
    },
  });

  if (profileQ.isLoading) {
    return (
      <TenantShell userId={user.id} section={section} setSection={setSection} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} collapsed={collapsed} setCollapsed={setCollapsed}>
        <Skeleton />
      </TenantShell>
    );
  }
  if (profileQ.data?.role !== "tenant") {
    return <PlayerDashboard userId={user.id} fullName={profileQ.data?.full_name ?? ""} email={user.email ?? ""} />;
  }

  const venues = venuesQ.data ?? [];
  const loadingVenues = venuesQ.isLoading;

  return (
    <TenantShell userId={user.id} section={section} setSection={setSection} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} collapsed={collapsed} setCollapsed={setCollapsed}>
      {section === "dashboard" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <DashboardOverview venues={venues} loading={loadingVenues} setSection={setSection} />
        </div>
      )}
      {section === "courts" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <SectionHeader title="Venues & Courts" subtitle="Manage your venues and courts." />
          <VenuesCourtsActions hasVenues={venues.length > 0} onCreateVenue={() => setCreateVenueOpen(true)} onAddCourt={() => setAddCourtOpen(true)} onCreateGroup={() => setCreateGroupOpen(true)} />
          <VenuesCourtsGlance venues={venues} />

          {loadingVenues ? <Skeleton /> : venues.length === 0 ? (
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
            <div id="add-court-anchor" className="flex min-h-0 flex-1 flex-col"><VenuesCourtsTabs venues={venues} /></div>
          )}

          <CreateVenueDrawer
            open={createVenueOpen}
            onClose={() => setCreateVenueOpen(false)}
            onCreated={() => { qc.invalidateQueries({ queryKey: ["my-venues"] }); setCreateVenueOpen(false); }}
          />
          <AddCourtDrawer
            open={addCourtOpen}
            onClose={() => setAddCourtOpen(false)}
            venues={venues}
            onCreated={() => { ["my-venues", "venues-courts-glance", "venues-court-counts", "all-tenant-courts", "venues-courts-table", "courts", "group-eligible-courts", "physical-courts-full", "physical-courts", "venues-group-counts"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setAddCourtOpen(false); }}
          />
          <CreateGroupDrawer
            open={createGroupOpen}
            onClose={() => setCreateGroupOpen(false)}
            venues={venues}
            onCreated={() => { ["physical-courts-full", "physical-courts", "tenant-venues-full", "venues-group-counts", "group-eligible-courts", "all-tenant-courts", "court-block-rules"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setCreateGroupOpen(false); }}
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
          <BookingsSection venues={venues} userId={user.id} />
        </div>
      )}
      {section === "customers" && (
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <CustomersSection venues={venues} />
        </div>
      )}
      {section === "team" && <div className="nice-scroll min-h-0 flex-1 overflow-y-auto pr-1"><ComingSoon title="Team" body="Invite staff, assign roles and manage permissions per venue." /></div>}
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
            onSaved={() => qc.invalidateQueries({ queryKey: ["profile", user.id] })}
          />
        </div>
      )}
    </TenantShell>
  );
}


function TenantShell({
  children, section, setSection, mobileOpen, setMobileOpen, collapsed, setCollapsed, userId,
}: {
  children: React.ReactNode;
  section: SectionKey;
  setSection: (s: SectionKey) => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  userId?: string;
}) {

  const current = NAV.find((n) => n.key === section);
  return (
    <div className="flex h-[100dvh] w-full">
      {/* Desktop sidebar */}
      <aside
        className={
          "sticky top-0 hidden shrink-0 self-start border-r border-border bg-card md:flex md:h-[100dvh] md:flex-col transition-[width] duration-200 " +
          (collapsed ? "md:w-16" : "md:w-60")
        }
      >
        <SidebarBody
          section={section}
          setSection={setSection}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[1200] md:hidden">
          <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-card shadow-xl">
            <SidebarBody
              section={section}
              setSection={(s) => { setSection(s); setMobileOpen(false); }}
              collapsed={false}
              setCollapsed={() => {}}
              onClose={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2 md:hidden">
          <button onClick={() => setMobileOpen(true)} className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium">
            <Menu className="h-4 w-4" /> Menu
          </button>
          <span className="text-sm font-semibold">{current?.label ?? "Dashboard"}</span>
          <NotificationBell userId={userId} />
        </div>
        {/* Desktop top bar */}
        <div className="hidden items-center justify-end border-b border-border bg-background px-6 py-2 md:flex">
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
  section, setSection, collapsed, setCollapsed, onClose,
}: {
  section: SectionKey;
  setSection: (s: SectionKey) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <img src={chLogo.url} alt="CourtHub" className="h-7 w-7 shrink-0 rounded-full object-contain" />
          {!collapsed && <span className="truncate font-display text-sm font-bold tracking-tight">CourtHub</span>}
        </div>
        {onClose ? (
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden rounded-md p-1 text-muted-foreground hover:bg-secondary md:inline-flex"
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
                      ? "bg-primary/15 text-primary"
                      : "text-foreground/80 hover:bg-secondary hover:text-foreground")
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
      {!collapsed && (
        <div className="border-t border-border px-3 py-3.5">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
            <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Tenant
            </span>
          </div>
          <div className="mt-0.5 font-display text-base font-bold tracking-tight text-foreground">
            Workspace
          </div>
        </div>


      )}
    </>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
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
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-primary">Coming soon</p>
      </div>
    </>
  );
}

function DashboardOverview({ venues, loading, setSection }: { venues: Venue[]; loading: boolean; setSection: (s: SectionKey) => void }) {
  const venueIds = venues.map((v) => v.id);
  const statsQ = useQuery({
    queryKey: ["tenant-stats", venueIds.join(",")],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data: courts } = await supabase.from("courts").select("id, venue_id").in("venue_id", venueIds);
      const courtIds = (courts ?? []).map((c) => c.id);
      let upcoming = 0;
      if (courtIds.length) {
        const { count } = await supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .in("court_id", courtIds)
          .gte("end_time", new Date().toISOString());
        upcoming = count ?? 0;
      }
      return { courts: courtIds.length, upcoming };
    },
  });

  return (
    <>
      <SectionHeader title="Dashboard" subtitle="Your workspace at a glance." />
      {loading ? <Skeleton /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Venues" value={venues.length} />
          <StatCard label="Courts" value={statsQ.data?.courts ?? 0} />
          <StatCard label="Upcoming bookings" value={statsQ.data?.upcoming ?? 0} />
        </div>
      )}
    </>
  );
}

function VenuesCourtsActions({ hasVenues, onCreateVenue, onAddCourt, onCreateGroup }: { hasVenues: boolean; onCreateVenue: () => void; onAddCourt: () => void; onCreateGroup: () => void }) {
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

function CreateVenueDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  return (
    <div className={"fixed inset-0 z-[1200] " + (open ? "pointer-events-auto" : "pointer-events-none")}>
      <div
        onClick={onClose}
        className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")}
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
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">
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

function CreateGroupDrawer({ open, onClose, venues, onCreated }: { open: boolean; onClose: () => void; venues: Venue[]; onCreated: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  return (
    <div className={"fixed inset-0 z-[1200] " + (open ? "pointer-events-auto" : "pointer-events-none")}>
      <div
        onClick={onClose}
        className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")}
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
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">✕</button>
        </div>
        <div className="p-4 sm:p-6">
          {open && <CreateGroupForm venues={venues} onCreated={onCreated} onCancel={onClose} />}
        </div>
      </aside>
    </div>
  );
}

function CreateGroupForm({ venues, onCreated, onCancel }: { venues: Venue[]; onCreated: () => void; onCancel: () => void }) {
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
      const { data, error } = await supabase.from("courts")
        .select("id, name, hourly_rate, physical_court_id, sports(name)")
        .eq("venue_id", venueId).order("id");
      if (error) throw error;
      return data as unknown as Array<{ id: number; name: string; hourly_rate: number; physical_court_id: number; sports: { name: string } | null }>;
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
      const { data: pc, error } = await supabase.from("physical_courts").insert({
        venue_id: venueId, name: name.trim(), map_emoji: emoji, description: description.trim() || null,
      }).select("id").single();
      if (error) throw error;
      const ids = Array.from(selected);
      if (ids.length > 0) {
        const { error: upErr } = await supabase.from("courts")
          .update({ physical_court_id: pc.id }).in("id", ids);
        if (upErr) throw upErr;
        // Replace pairwise blocking rules for the selected courts
        const { error: delErr } = await supabase.from("court_block_rules").delete().in("court_id", ids);
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
    <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="grid gap-4">
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm">
        <div className="font-semibold text-primary">What is a court group?</div>
        <p className="mt-1 text-muted-foreground">
          A group represents one <b>shared space</b> that can be set up for different sports (e.g. 1 basketball ↔ 3 badminton ↔ 4 pickleball). Bookings across grouped courts automatically block each other.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Venue</span>
        <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>

      <Input label='Group name (e.g. "Court 1 — Main Slab")' value={name} onChange={setName} required />

      <div className="rounded-xl border border-border bg-background p-3">
        <EmojiPicker label="Group emoji" value={emoji} fallback="🏟️" onChange={setEmoji} hint="Shown on the map and in the courts table." />
      </div>

      <Textarea label="About this Group" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, house rules…" />

      <div className="rounded-xl border border-dashed border-border p-3">
        <div className="text-sm font-semibold">Assign existing courts to this group</div>
        <p className="mt-1 text-xs text-muted-foreground">Tick every court that lives on this same shared space (e.g. 3 badminton + 4 pickleball courts painted on one hall).</p>
        <div className="mt-3 max-h-64 overflow-y-auto nice-scroll">
          {courtsQ.isLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : (courtsQ.data ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground">No courts in this venue yet. You can create the group now and assign courts later from Add / Edit court.</div>
          ) : (
            <ul className="grid gap-2">
              {(courtsQ.data ?? []).map((c) => {
                const checked = selected.has(c.id);
                return (
                  <li key={c.id} className={"flex items-center gap-3 rounded-lg border p-2 text-sm " + (checked ? "border-primary bg-primary/5" : "border-border")}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                    <div className="flex-1">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">{c.sports?.name ?? "—"} · ₱{Number(c.hourly_rate).toFixed(0)}/hr</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <CourtBlockRulesEditor courts={selectedCourts} rules={rules} onChange={setRules} />



      {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary">Cancel</button>
        <button disabled={mut.isPending || !name.trim() || !venueId} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
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
      const { data } = await supabase.from("courts").select("id, is_indoor").in("venue_id", venueIds);
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
      return (data ?? []) as Array<{ id: number; name: string; hourly_rate: number; is_indoor: boolean; coming_soon: boolean | null; venue_id: number; sports: { name: string } | null }>;
    },
  });
  const courts = q.data ?? [];
  if (venues.length === 0) return null;

  return (
    <div className="mb-8 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="font-semibold">Venues & courts</div>
        <div className="text-xs text-muted-foreground">{venues.length} venue{venues.length === 1 ? "" : "s"} · {courts.length} court{courts.length === 1 ? "" : "s"}</div>
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
                    <td className="px-4 py-3 text-muted-foreground" colSpan={5}>No courts yet</td>
                  </tr>
                );
              }
              return rows.map((c, i) => (
                <tr key={c.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium align-top">{i === 0 ? v.name : <span className="text-muted-foreground/60">↳</span>}</td>
                  <td className="px-4 py-3">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.sports?.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c.is_indoor ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                      {c.is_indoor ? "Indoor" : "Outdoor"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">₱{Number(c.hourly_rate).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {c.coming_soon ? (
                      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Coming soon</span>
                    ) : (
                      <span className="inline-flex rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Live</span>
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
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
    </div>
  );
}

function QuickAction({ title, body, onClick }: { title: string; body: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition hover:border-primary">
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{body}</div>
    </button>
  );
}
function Skeleton() { return <div className="h-40 animate-pulse rounded-2xl bg-muted" />; }
function EmptyState({ title, body, cta }: { title: string; body: string; cta?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {cta && <div className="mt-6">{cta}</div>}
    </div>
  );
}

function TagInput({ label, placeholder, values, onChange, hint }: { label: string; placeholder?: string; values: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    if (values.some((v) => v.toLowerCase() === t.toLowerCase())) { setDraft(""); return; }
    onChange([...values, t]);
    setDraft("");
  };
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-2 focus-within:ring-2 focus-within:ring-ring">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="rounded-full text-primary/70 hover:text-primary">×</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
            else if (e.key === "Backspace" && !draft && values.length) { onChange(values.slice(0, -1)); }
          }}
          onBlur={add}
          placeholder={values.length ? "" : placeholder ?? "Type and press Enter"}
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function FeesEditor({ items, onChange, notes, onNotesChange }: { items: FeeItem[]; onChange: (v: FeeItem[]) => void; notes: string; onNotesChange: (s: string) => void }) {
  const update = (i: number, patch: Partial<FeeItem>) => onChange(items.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  return (
    <div className="space-y-2 rounded-xl border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Fees & Charges</span>
        <button type="button" onClick={() => onChange([...items, { label: "", amount: 0 }])} className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:border-primary hover:text-primary">+ Add fee</button>
      </div>
      {items.length === 0 && <p className="text-[11px] text-muted-foreground">No line-item fees yet. Add things like racket rental, shuttlecock, guest fee, etc.</p>}
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr,110px,auto] items-center gap-2">
            <input value={it.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="e.g. Racket rental" className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <div className="flex items-center gap-1 rounded-lg border border-input bg-background px-2">
              <span className="text-xs text-muted-foreground">₱</span>
              <input type="number" min={0} step="0.01" value={Number.isFinite(it.amount) ? it.amount : 0} onChange={(e) => update(i, { amount: Number(e.target.value) })} className="w-full bg-transparent py-1.5 text-sm outline-none" />
            </div>
            <button type="button" aria-label="Remove fee" onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-destructive hover:text-destructive">Remove</button>
          </div>
        ))}
      </div>
      <label className="block pt-1">
        <span className="text-[11px] font-medium text-muted-foreground">Notes (optional)</span>
        <textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} rows={2} placeholder="Any extra pricing notes, discounts, or conditions." className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
      </label>
    </div>
  );
}

function CreateVenue({ onCreated, onCancel }: { onCreated: () => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState(
    TIMEZONE_OPTIONS.some((t) => t.value === detectedTz) ? detectedTz : "Asia/Manila"
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
  const uploadPrefix = useRef(`venues/new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).current;

  const suggested = suggestTimezone(lat, lng);
  const pinInPH = isInPhilippines(lat, lng);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);
  const pinOutsidePH = lat != null && lng != null && !pinInPH;

  const mut = useMutation({
    mutationFn: async () => {
      if (lat == null || lng == null) throw new Error("Please pin your venue on the map before creating.");
      if (!pinInPH) throw new Error("CourtHub currently supports venues in the Philippines only. Please pin a location within the Philippines.");
      if (tzMismatch && !tzConfirmed) throw new Error(`Timezone doesn't match your pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`);
      const cleanFees = fees.filter((f) => f.label.trim() && Number.isFinite(f.amount)).map((f) => ({ label: f.label.trim(), amount: Number(f.amount) }));
      const { error } = await supabase.from("venues").insert({ name, address, timezone, latitude: lat, longitude: lng, map_emoji: mapEmoji, description: description.trim() || null, images, is_active: isActive, amenities, food_beverages: foodBeverages, facility_services: facilityServices, fees: cleanFees, fees_notes: feesNotes.trim() || null, contact_phone: contactPhone.trim() || null, contact_email: contactEmail.trim() || null, operating_hours_text: operatingHoursText.trim() || null, operating_hours: openHours, refund_cutoff_hours: Number.isFinite(cancellationHours) ? Math.max(0, Math.floor(cancellationHours)) : 24, cancellation_notes: cancellationNotes.trim() || null, rules: rules.trim() || null });
      if (error) throw error;
    },
    onSuccess: () => { setName(""); setAddress(""); setLat(null); setLng(null); setMapEmoji(null); setDescription(""); setImages([]); setErr(null); setTzConfirmed(false); setIsActive(true); setAmenities([]); setFoodBeverages([]); setFacilityServices([]); setFees([]); setFeesNotes(""); setContactPhone(""); setContactEmail(""); setOperatingHoursText(""); setCancellationHours(24); setCancellationNotes(""); setRules(""); onCreated(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-xl font-bold">New venue</h2>
      <p className="mt-1 text-sm text-muted-foreground">A venue holds one or more courts.</p>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="mt-4 grid gap-3 sm:grid-cols-2">
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
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-muted-foreground">Used to display court hours and bookings in the venue's local time.</span>
        </label>
        <div className="sm:col-span-2 rounded-xl border border-dashed border-border bg-secondary/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Map location</span>
            <button type="button" onClick={() => setPickerOpen(true)} className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:border-primary hover:text-primary">
              {lat != null ? "Change pin" : "📍 Pick on map"}
            </button>
          </div>
          {lat != null && lng != null ? (
            <button type="button" onClick={() => setPickerOpen(true)} className="mt-2 block w-full overflow-hidden rounded-lg border border-border">
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
              <div className="bg-secondary/40 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground">{lat.toFixed(6)}, {lng.toFixed(6)}</div>
            </button>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">Tap "Pick on map" to drop a pin so players can find your venue.</p>
          )}
        </div>
        <MapPicker
          open={pickerOpen}
          initialLat={lat}
          initialLng={lng}
          onClose={() => setPickerOpen(false)}
          onSave={(la, ln) => {
            setLat(la); setLng(ln); setPickerOpen(false);
            const s = suggestTimezone(la, ln);
            if (s) { setTimezone(s.tz); setTzConfirmed(false); }
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
          <Textarea label="About this Venue (optional)" value={description} onChange={setDescription} placeholder="Tell players about your venue — parking, amenities, house rules…" />
        </div>
        <div className="sm:col-span-2">
          <ImageUploader label="Venue photos" pathPrefix={uploadPrefix} images={images} onChange={setImages} />
        </div>
        <div className="sm:col-span-2">
          <TagInput label="Amenities" values={amenities} onChange={setAmenities} placeholder="e.g. Parking, Showers, Wi-Fi" hint="Press Enter or comma to add. Shown to players on the venue page." />
        </div>
        <div className="sm:col-span-2">
          <TagInput label="Food & Beverages" values={foodBeverages} onChange={setFoodBeverages} placeholder="e.g. Cafe, Vending machine, Water refill" />
        </div>
        <div className="sm:col-span-2">
          <TagInput label="Facility Services" values={facilityServices} onChange={setFacilityServices} placeholder="e.g. Racket rental, Coaching, Ball machine" />
        </div>
        <div className="sm:col-span-2">
          <FeesEditor items={fees} onChange={setFees} notes={feesNotes} onNotesChange={setFeesNotes} />
        </div>
        <Input label="Inquiry phone (shown to players)" value={contactPhone} onChange={setContactPhone} />
        <Input label="Inquiry email (optional)" value={contactEmail} onChange={setContactEmail} />
        <div className="sm:col-span-2">
          <OperatingHoursEditor hours={openHours} onChange={setOpenHours} hint="Courts follow these hours by default. Players can only book inside this window, and closed hours are hidden everywhere." />
            <Textarea label="Operating hours note (optional)" value={operatingHoursText} onChange={setOperatingHoursText} placeholder="Extra note shown to players, e.g. Holiday hours may vary" />
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Cancellation cutoff (hours before start)</span>
          <input type="number" min={0} step={1} value={cancellationHours} onChange={(e) => setCancellationHours(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <span className="mt-1 block text-[11px] text-muted-foreground">Default 24h. Set to 0 to allow last-minute cancellations.</span>
        </label>
        <div className="sm:col-span-2">
          <Textarea label="Cancellation policy notes (optional)" value={cancellationNotes} onChange={setCancellationNotes} placeholder="e.g. Full refund up to 24h before. 50% within 24h. No refund after start." />
        </div>
        <div className="sm:col-span-2">
          <Textarea label="Venue rules (one per line)" value={rules} onChange={setRules} placeholder={"e.g.\n- Wear non-marking shoes\n- No outside food or drinks\n- Arrive 10 minutes early"} />
        </div>
        {pinOutsidePH && (
          <div className="sm:col-span-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <strong>Location not supported.</strong> CourtHub is currently available for venues in the <strong>Philippines</strong> only. Please move your pin within the Philippines to continue.
          </div>
        )}
        {tzMismatch && pinInPH && (
          <div className="sm:col-span-2 rounded-lg border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="flex items-start justify-between gap-2">
              <div>
                <strong>Timezone doesn't match your pin.</strong> Based on your map location this venue looks like it's in <strong>{suggested?.country}</strong> ({suggested?.tz}), but you selected <strong>{timezone}</strong>. Court hours and bookings will display in the wrong local time if this is incorrect.
              </div>
              <button type="button" onClick={() => { setTimezone(suggested!.tz); setTzConfirmed(false); }} className="shrink-0 rounded-md border border-amber-500/60 bg-background px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-100">
                Use {suggested?.tz}
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={tzConfirmed} onChange={(e) => setTzConfirmed(e.target.checked)} />
              I confirm this venue uses <span className="font-mono">{timezone}</span> even though the pin is elsewhere.
            </label>
          </div>
        )}
        <div className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-primary" />
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
          <span className="ml-auto text-[11px] text-muted-foreground">Ticked by default — the venue will appear on the landing page.</span>
        </div>
        <div className="sm:col-span-2 flex flex-wrap gap-2">
          <button disabled={mut.isPending || pinOutsidePH || (tzMismatch && !tzConfirmed)} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">

            {mut.isPending ? "Creating…" : "Create venue"}
          </button>
          {onCancel && <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>}
        </div>
        {err && <p className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
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
        .from("courts").select("*, sports(name)").eq("venue_id", venue.id).order("id");
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
      return data as { id: number; court_id: number; start_time: string; end_time: string; status: string }[];
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
          <VenueLocation venue={venue} onSaved={() => qc.invalidateQueries({ queryKey: ["my-venues"] })} />
        </div>
      </header>
      <div className="p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(courtsQ.data ?? []).map((c) => (
            <CourtCard key={c.id} court={c} venueEmoji={venue.map_emoji} onChanged={() => { qc.invalidateQueries({ queryKey: ["courts", venue.id] }); qc.invalidateQueries({ queryKey: ["venues-court-counts"] }); qc.invalidateQueries({ queryKey: ["venues-courts-glance"] }); }} />
          ))}
          <AddCourt venueId={venue.id} venueEmoji={venue.map_emoji} onCreated={() => { qc.invalidateQueries({ queryKey: ["courts", venue.id] }); qc.invalidateQueries({ queryKey: ["venues-court-counts"] }); qc.invalidateQueries({ queryKey: ["venues-courts-glance"] }); }} />
        </div>


        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {bookingDate ? `Bookings on ${new Date(`${bookingDate}T00:00:00`).toLocaleDateString()}` : "Upcoming bookings"}
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
                className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs"
              />
              {bookingDate && (
                <button onClick={() => setBookingDate("")} className="rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary">
                  Show upcoming
                </button>
              )}
            </div>
          </div>
          {courtIds.length === 0 ? null : bookingsQ.isLoading ? (
            <div className="mt-3 h-16 animate-pulse rounded-lg bg-muted" />
          ) : (bookingsQ.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{bookingDate ? "No bookings on this date." : "No upcoming bookings yet."}</p>
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
                        {s.toLocaleDateString()} · {s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – {e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary capitalize">{b.status}</span>
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

function CourtCard({ court, venueEmoji, onChanged }: { court: Court; venueEmoji: string | null; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [managingHours, setManagingHours] = useState(false);
  if (editing) {
    return <EditCourt court={court} venueEmoji={venueEmoji} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  }
  if (managingHours) {
    return <AvailabilityEditor court={court} onDone={() => { setManagingHours(false); onChanged(); }} onCancel={() => setManagingHours(false)} />;
  }
  const cover = court.images?.[0];
  const totalBlocked = Object.values(court.blocked_hours ?? {}).reduce((s, arr) => s + (arr?.length ?? 0), 0);
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {cover ? (
        <img src={cover} alt={court.name} className="h-32 w-full object-cover" loading="lazy" />
      ) : (
        <div className="court-pattern h-32" />
      )}
      <div className="p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="rounded-full bg-secondary px-2 py-1 font-medium">{court.sports?.name}</span>
          <span className="text-muted-foreground">{court.is_indoor ? "Indoor" : "Outdoor"}</span>
        </div>
        {court.coming_soon && (
          <span className="mt-2 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 ring-1 ring-amber-500/30">
            Coming soon
          </span>
        )}
        <h3 className="mt-2 font-semibold">{court.name}</h3>
        {court.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{court.description}</p>}
        {(court.amenities?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {court.amenities!.slice(0, 4).map((a) => (
              <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">{a}</span>
            ))}
            {(court.amenities!.length > 4) && <span className="text-[10px] text-muted-foreground">+{court.amenities!.length - 4} more</span>}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <div className="text-primary"><span className="text-lg font-bold">₱{Number(court.hourly_rate).toFixed(0)}</span> <span className="text-xs text-muted-foreground">/hr</span></div>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Open 24/7 · <span className="font-medium text-foreground">{totalBlocked}</span> hr{totalBlocked === 1 ? "" : "s"} blocked / week
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => setManagingHours(true)} className="flex-1 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20">
            Manage availability
          </button>
          <button onClick={() => setEditing(true)} className="rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:border-primary hover:text-primary">Edit details</button>
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
  weekly, setWeekly, dateBlocks, setDateBlocks, hours,
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
      if (next[day].has(hour)) next[day].delete(hour); else next[day].add(hour);
      return next;
    });
  };
  const setAllDayWeekly = (day: string, block: boolean) => {
    setWeekly((prev) => ({ ...prev, [day]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []) }));
  };

  const localISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shiftDate = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return localISO(d); };
  const [selectedDate, setSelectedDate] = useState<string>(localISO(new Date()));
  const hasOverride = Object.prototype.hasOwnProperty.call(dateBlocks, selectedDate);
  const currentDateSet = dateBlocks[selectedDate] ?? new Set<number>();
  const toggleDate = (hour: number) => {
    setDateBlocks((prev) => {
      const set = new Set(prev[selectedDate] ?? []);
      if (set.has(hour)) set.delete(hour); else set.add(hour);
      return { ...prev, [selectedDate]: set };
    });
  };
  const setAllForDate = (block: boolean) => {
    setDateBlocks((prev) => ({ ...prev, [selectedDate]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []) }));
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
        <button type="button" onClick={() => setMode("weekly")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "weekly" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Weekly pattern</button>
        <button type="button" onClick={() => setMode("date")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "date" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Specific date</button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tap an hour to block it (red = closed to players). Weekly rules repeat every week. Specific-date overrides apply only to that date and do NOT inherit weekly blocks. Past hours and hours already booked by players are also unavailable automatically.
      </p>

      {mode === "weekly" ? (
        <div className="mt-3 space-y-3">
          {DAYS.map((d) => (
            <div key={d.key} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{d.label}</span>
                <div className="flex gap-1 text-[10px]">
                  <button type="button" onClick={() => setAllDayWeekly(d.key, false)} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Open all</button>
                  <button type="button" onClick={() => setAllDayWeekly(d.key, true)} className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive">Close all</button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 24 }, (_, h) => h).map((h) => {
                  const open = openOnDay(d.key);
                  const closed = !!open && !open.has(h);
                  const isBlocked = weekly[d.key]?.has(h);
                  return (
                    <button key={h} type="button" disabled={closed} onClick={() => toggleWeekly(d.key, h)}
                      title={closed ? "Outside operating hours" : undefined}
                      className={"rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " + (closed ? "cursor-not-allowed bg-muted text-muted-foreground/60 line-through" : isBlocked ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30" : "bg-primary/10 text-foreground hover:bg-primary/20")}>
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
            <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary">←</button>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="rounded border border-input bg-background px-2 py-1" />
            <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary">→</button>
            <span className={"ml-2 rounded-full px-2 py-0.5 " + (hasOverride ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              {hasOverride ? "Override active (weekly ignored)" : "No override · weekly applies"}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
            <button type="button" onClick={() => setAllForDate(false)} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Open all day</button>
            <button type="button" onClick={() => setAllForDate(true)} className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive">Close all day</button>
            {hasOverride && (
              <button type="button" onClick={clearOverride} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Remove override (use weekly)</button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 24 }, (_, h) => h).map((h) => {
              const openSet = hours ? openHoursForDate(hours, selectedDate) : null;
              const closed = !!openSet && !openSet.has(h);
              const isBlocked = currentDateSet.has(h);
              return (
                <button key={h} type="button" disabled={closed} onClick={() => toggleDate(h)}
                  title={closed ? "Outside operating hours" : undefined}
                  className={"rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " + (closed ? "cursor-not-allowed bg-muted text-muted-foreground/60 line-through" : isBlocked ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30" : "bg-primary/10 text-foreground hover:bg-primary/20")}>
                  {fmtHour(h)} – {fmtHour((h + 1) % 24)}
                </button>
              );
            })}
          </div>

          {Object.keys(dateBlocks).length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Existing overrides</div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(dateBlocks).sort(([a], [b]) => a.localeCompare(b)).map(([date, set]) => (
                  <li key={date}>
                    <button type="button" onClick={() => setSelectedDate(date)} className={"rounded-full border px-2 py-0.5 text-[11px] " + (date === selectedDate ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary hover:text-primary")}>
                      {new Date(`${date}T00:00:00`).toLocaleDateString()} · {set.size} hr{set.size === 1 ? "" : "s"}
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
      const { data, error } = await supabase.from("venues").select("operating_hours").eq("id", venueId!).single();
      if (error) throw error;
      return normalizeHours((data as { operating_hours?: unknown }).operating_hours);
    },
  });
  return q.data ?? fullWeek();
}

function AvailabilityEditor({ court, onDone, onCancel }: { court: Court; onDone: () => void; onCancel: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const venueHours = useVenueHours(court.venue_id);
  const courtHours = effectiveHours(court, venueHours);
  const [weekly, setWeekly] = useState<Record<string, Set<number>>>(() => buildInitialWeekly(court.blocked_hours));
  const [dateBlocks, setDateBlocks] = useState<Record<string, Set<number>>>(() => buildInitialDates(court.blocked_dates));

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("courts").update({
        blocked_hours: weeklyToPayload(weekly),
        blocked_dates: datesToPayload(dateBlocks),
      }).eq("id", court.id);
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
          <p className="text-xs text-muted-foreground">Hours outside the operating window are greyed out. Use this to block extra hours inside opening hours, or override a specific date.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="mt-3">
        <AvailabilityGrid weekly={weekly} setWeekly={setWeekly} dateBlocks={dateBlocks} setDateBlocks={setDateBlocks} hours={courtHours} />
      </div>
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}

function InlineAvailability({
  weekly, setWeekly, dateBlocks, setDateBlocks, hours,
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
          <div className="text-xs font-semibold uppercase tracking-wider text-primary">Manage availability (optional)</div>
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
          <AvailabilityGrid weekly={weekly} setWeekly={setWeekly} dateBlocks={dateBlocks} setDateBlocks={setDateBlocks} hours={hours} />
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
  return input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function AddCourt({ venueId, venueEmoji, onCreated, alwaysOpen, onCancel }: { venueId: number; venueEmoji: string | null; onCreated: () => void; alwaysOpen?: boolean; onCancel?: () => void }) {
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
  const [availWeekly, setAvailWeekly] = useState<Record<string, Set<number>>>(() => buildInitialWeekly(null));
  const [availDates, setAvailDates] = useState<Record<string, Set<number>>>(() => buildInitialDates(null));
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
      const { data: pcRow, error: pcErr } = await supabase.from("physical_courts").insert({
        venue_id: venueId, name: `${name.trim() || "Court"} slab`, map_emoji: mapEmoji ?? venueEmoji ?? null,
      }).select("id").single();
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
      setOpen(false); setName(""); setRate("25"); setSportId(""); setIsIndoor(false); setComingSoon(false); setIsActive(true); setDescription(""); setImages([]); setMapEmoji(null); setSurfaceType(""); setPlayerCapacity(""); setAvailWeekly(buildInitialWeekly(null)); setAvailDates(buildInitialDates(null)); setVoucherEnabled(false); setRateRules([]); setErr(null);
      onCreated();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (!open && !alwaysOpen) {
    return (
      <button onClick={() => setOpen(true)} className="grid min-h-[128px] place-items-center rounded-xl border-2 border-dashed border-border p-4 text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary">
        + Add court
      </button>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sportId) { setErr("Pick a sport"); return; } mut.mutate(); }}
      className="col-span-full rounded-xl border border-border bg-secondary/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Sport</span>
          <select value={sportId} onChange={(e) => setSportId(e.target.value)} required
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
            <option value="">Select…</option>
            {(sportsQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={isIndoor} onChange={(e) => setIsIndoor(e.target.checked)} />
          Indoor court
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={comingSoon} onChange={(e) => setComingSoon(e.target.checked)} />
          Coming soon
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={voucherEnabled} onChange={(e) => setVoucherEnabled(e.target.checked)} />
          Accept vouchers
        </label>
        <CourtStatusField value={isActive} onChange={setIsActive} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tick "Coming soon" if this court isn't open yet. Tick "Accept vouchers" to let players redeem discount codes you create in the Vouchers module for this court.
      </p>
      <RateRulesEditor baseRate={Number(rate) || 0} rules={rateRules} onChange={setRateRules} />
      <CourtHoursEditor inherit={inheritHours} onInheritChange={setInheritHours} hours={ownHours} onHoursChange={setOwnHours} venueHours={venueHours} />
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
        <Input label="Player capacity (max players per match)" value={playerCapacity} onChange={setPlayerCapacity} type="number" />
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="About this Court" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, rules, etc." />
        <ImageUploader label="Court photos" pathPrefix={`courts/venue-${venueId}/new-${Date.now()}`} images={images} onChange={setImages} />
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
      <InlineAvailability weekly={availWeekly} setWeekly={setAvailWeekly} dateBlocks={availDates} setDateBlocks={setAvailDates} hours={courtHours} />
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={mut.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {mut.isPending ? "Adding…" : "Add court"}
        </button>
        <button type="button" onClick={() => { if (onCancel) onCancel(); else setOpen(false); }} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}

function AddCourtDrawer({ open, onClose, venues, onCreated }: { open: boolean; onClose: () => void; venues: Venue[]; onCreated: () => void }) {
  const [venueId, setVenueId] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setVenueId(venues.length === 1 ? venues[0].id : null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose, venues]);
  const selectedVenue = venues.find((v) => v.id === venueId) ?? null;
  return (
    <div className={"fixed inset-0 z-[1200] " + (open ? "pointer-events-auto" : "pointer-events-none")}>
      <div
        onClick={onClose}
        className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")}
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
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">
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
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">Choose which venue this court belongs to.</p>
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

function EditCourt({ court, venueEmoji, onDone, onCancel }: { court: Court; venueEmoji: string | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(court.name);
  const [rate, setRate] = useState(String(court.hourly_rate));
  const [sportId, setSportId] = useState<string>(String(court.sport_id ?? ""));

  const [isIndoor, setIsIndoor] = useState(court.is_indoor);
  const [comingSoon, setComingSoon] = useState(!!court.coming_soon);
  const [isActive, setIsActive] = useState(court.is_active !== false);
  const [description, setDescription] = useState(court.description ?? "");
  const [images, setImages] = useState<string[]>(court.images ?? []);
  const [mapEmoji, setMapEmoji] = useState<string | null>(court.map_emoji ?? null);
  const [surfaceType, setSurfaceType] = useState<string>(((court as unknown as { surface_type?: string | null }).surface_type) ?? "");
  const [playerCapacity, setPlayerCapacity] = useState<string>(
    ((court as unknown as { player_capacity?: number | null }).player_capacity ?? "") === null
      ? ""
      : String((court as unknown as { player_capacity?: number | null }).player_capacity ?? "")
  );
  const [availWeekly, setAvailWeekly] = useState<Record<string, Set<number>>>(() => buildInitialWeekly(court.blocked_hours));
  const [availDates, setAvailDates] = useState<Record<string, Set<number>>>(() => buildInitialDates(court.blocked_dates));
  const [voucherEnabled, setVoucherEnabled] = useState<boolean>(!!court.voucher_enabled);
  const [rateRules, setRateRules] = useState<RateRule[]>(() => normalizeRules(court.rate_rules));
  const venueHours = useVenueHours(court.venue_id);
  const [inheritHours, setInheritHours] = useState<boolean>(court.inherit_venue_hours !== false);
  const [ownHours, setOwnHours] = useState<HoursMap>(() => normalizeHours(court.operating_hours));
  const courtHours = inheritHours ? venueHours : ownHours;
  const [err, setErr] = useState<string | null>(null);

  const sportsQ = useSportsQuery(true);
  const selectedSport = sportsQ.data?.find((s) => String(s.id) === sportId);
  const fallbackEmoji = venueEmoji || sportEmoji(selectedSport?.slug ?? court.sports?.slug) || "🎾";

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("courts").update({
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
      }).eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sportId) { setErr("Pick a sport"); return; } mut.mutate(); }} className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Sport</span>
          <select value={sportId} onChange={(e) => setSportId(e.target.value)} required
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
            <option value="">Select…</option>
            {(sportsQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={isIndoor} onChange={(e) => setIsIndoor(e.target.checked)} />
          Indoor court
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={comingSoon} onChange={(e) => setComingSoon(e.target.checked)} />
          Coming soon
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={voucherEnabled} onChange={(e) => setVoucherEnabled(e.target.checked)} />
          Accept vouchers
        </label>
        <CourtStatusField value={isActive} onChange={setIsActive} />
      </div>
      <RateRulesEditor baseRate={Number(rate) || 0} rules={rateRules} onChange={setRateRules} />
      <CourtHoursEditor inherit={inheritHours} onInheritChange={setInheritHours} hours={ownHours} onHoursChange={setOwnHours} venueHours={venueHours} />
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
        <Input label="Player capacity (max players per match)" value={playerCapacity} onChange={setPlayerCapacity} type="number" />
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="About this Court" value={description} onChange={setDescription} />
        <ImageUploader label="Court photos" pathPrefix={`courts/${court.id}`} images={images} onChange={setImages} />
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
      <InlineAvailability weekly={availWeekly} setWeekly={setAvailWeekly} dateBlocks={availDates} setDateBlocks={setAvailDates} hours={courtHours} />
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={mut.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {mut.isPending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}

function Textarea(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
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


function Input(props: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
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
      const { error } = await supabase.from("venues").update({ latitude: lat, longitude: lng }).eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => { setPickerOpen(false); setErr(null); onSaved(); },
    onError: (e: Error) => setErr(e.message),
  });

  const hasLoc = venue.latitude != null && venue.longitude != null;
  const googleEmbedUrl = (lat: number, lng: number) => `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`;

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
            <button onClick={() => setPickerOpen(true)} className="rounded-md border border-border bg-background px-2 py-1 font-medium hover:border-primary hover:text-primary">Edit pin</button>
          </div>
        </div>
      ) : (

        <button onClick={() => setPickerOpen(true)} className="w-full rounded-xl border-2 border-dashed border-border px-3 py-4 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary">
          📍 Add map location
        </button>
      )}
      {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
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

function VenueEditor({ venue, courtsCount, initialEditing = false, onDoneEditing }: { venue: Venue; courtsCount: number; initialEditing?: boolean; onDoneEditing?: () => void }) {
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


  const [cancellationHours, setCancellationHours] = useState<number>(venue.refund_cutoff_hours ?? 24);
  const [cancellationNotes, setCancellationNotes] = useState(venue.cancellation_notes ?? "");
  const [rules, setRules] = useState(venue.rules ?? "");

  const suggested = suggestTimezone(venue.latitude, venue.longitude);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);

  const hoursChanged = JSON.stringify(openHours) !== JSON.stringify(normalizeHours(venue.operating_hours));

  const save = useMutation({
    mutationFn: async (opts?: { force?: boolean }) => {
      if (tzMismatch && !tzConfirmed) throw new Error(`Timezone doesn't match this venue's pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`);
      if (!opts?.force && hoursChanged) {
        const found = await findHoursConflicts({ venueId: venue.id, newVenueHours: openHours });
        if (found.length > 0) {
          setConflicts(found);
          return "blocked" as const;
        }
      }
      const { error } = await supabase
        .from("venues")
        .update({ name, address, description: description || null, images, timezone, map_emoji: mapEmoji, is_active: isActive, amenities, food_beverages: foodBeverages, facility_services: facilityServices, fees: fees.filter((f) => f.label.trim() && Number.isFinite(f.amount)).map((f) => ({ label: f.label.trim(), amount: Number(f.amount) })), fees_notes: feesNotes.trim() || null, contact_phone: contactPhone.trim() || null, contact_email: contactEmail.trim() || null, operating_hours_text: operatingHoursText.trim() || null, operating_hours: openHours, refund_cutoff_hours: Number.isFinite(cancellationHours) ? Math.max(0, Math.floor(cancellationHours)) : 24, cancellation_notes: cancellationNotes.trim() || null, rules: rules.trim() || null })
        .eq("id", venue.id);
      if (error) throw error;
      return "saved" as const;
    },
    onSuccess: (res) => {
      if (res === "blocked") return;
      setConflicts(null);
      setEditing(false); setErr(null); setTzConfirmed(false); qc.invalidateQueries({ queryKey: ["my-venues"] }); onDoneEditing?.();
    },
    onError: (e: Error) => setErr(e.message),
  });


  const del = useMutation({
    mutationFn: async () => {
      // Guard: block delete if any booking exists on any court of this venue
      const { data: courts, error: cErr } = await supabase.from("courts").select("id").eq("venue_id", venue.id);
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-venues"] }); qc.invalidateQueries({ queryKey: ["venues-court-counts"] }); qc.invalidateQueries({ queryKey: ["venues-courts-glance"] }); },
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
              onChange={(e) => { setTimezone(e.target.value); setTzConfirmed(false); }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {TIMEZONE_OPTIONS.some((t) => t.value === timezone) ? null : (
                <option value={timezone}>{timezone} (current)</option>
              )}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
            {tzMismatch && (
              <div className="mt-2 rounded-lg border border-amber-400/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <strong>Timezone doesn't match the pin.</strong> This venue's map pin is in <strong>{suggested?.country}</strong> ({suggested?.tz}). Changing it away from the suggested zone means court hours and bookings will display in a different local time.
                  </div>
                  <button type="button" onClick={() => { setTimezone(suggested!.tz); setTzConfirmed(false); }} className="shrink-0 rounded-md border border-amber-500/60 bg-background px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-100">
                    Use {suggested?.tz}
                  </button>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={tzConfirmed} onChange={(e) => setTzConfirmed(e.target.checked)} />
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
            <ImageUploader label="Venue photos" pathPrefix={`venues/${venue.id}`} images={images} onChange={setImages} />
          </div>
          <div className="sm:col-span-2">
            <TagInput label="Amenities" values={amenities} onChange={setAmenities} placeholder="e.g. Parking, Showers, Wi-Fi" hint="Press Enter or comma to add." />
          </div>
          <div className="sm:col-span-2">
            <TagInput label="Food & Beverages" values={foodBeverages} onChange={setFoodBeverages} placeholder="e.g. Cafe, Vending machine, Water refill" />
          </div>
          <div className="sm:col-span-2">
            <TagInput label="Facility Services" values={facilityServices} onChange={setFacilityServices} placeholder="e.g. Racket rental, Coaching, Ball machine" />
          </div>
          <div className="sm:col-span-2">
            <FeesEditor items={fees} onChange={setFees} notes={feesNotes} onNotesChange={setFeesNotes} />
          </div>
          <Input label="Inquiry phone (shown to players)" value={contactPhone} onChange={setContactPhone} />
          <Input label="Inquiry email (optional)" value={contactEmail} onChange={setContactEmail} />
          <div className="sm:col-span-2">
            <OperatingHoursEditor hours={openHours} onChange={setOpenHours} hint="Courts follow these hours by default. Players can only book inside this window, and closed hours are hidden everywhere." />
            <Textarea label="Operating hours note (optional)" value={operatingHoursText} onChange={setOperatingHoursText} placeholder="Extra note shown to players, e.g. Holiday hours may vary" />
          </div>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Cancellation cutoff (hours before start)</span>
            <input type="number" min={0} step={1} value={cancellationHours} onChange={(e) => setCancellationHours(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            <span className="mt-1 block text-[11px] text-muted-foreground">Default 24h. Set to 0 to allow last-minute cancellations.</span>
          </label>
          <div className="sm:col-span-2">
            <Textarea label="Cancellation policy notes (optional)" value={cancellationNotes} onChange={setCancellationNotes} placeholder="e.g. Full refund up to 24h before. 50% within 24h. No refund after start." />
          </div>
          <div className="sm:col-span-2">
            <Textarea label="Venue rules (one per line)" value={rules} onChange={setRules} placeholder={"e.g.\n- Wear non-marking shoes\n- No outside food or drinks\n- Arrive 10 minutes early"} />
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
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-primary" />
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
            <span className="ml-auto text-[11px] text-muted-foreground">Untick to hide this venue from players.</span>
          </div>
        </div>
        {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => save.mutate({})} disabled={save.isPending || (tzMismatch && !tzConfirmed)} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          <button onClick={() => { setEditing(false); setName(venue.name); setAddress(venue.address); setDescription(venue.description ?? ""); setImages(venue.images ?? []); setTimezone(venue.timezone || "Asia/Manila"); setMapEmoji(venue.map_emoji ?? null); setTzConfirmed(false); setIsActive(venue.is_active !== false); setAmenities(venue.amenities ?? []); setFoodBeverages(venue.food_beverages ?? []); setFacilityServices(venue.facility_services ?? []); setFees(Array.isArray(venue.fees) ? venue.fees : []); setFeesNotes(venue.fees_notes ?? ""); setContactPhone(venue.contact_phone ?? ""); setContactEmail(venue.contact_email ?? ""); setOperatingHoursText(venue.operating_hours_text ?? ""); setCancellationHours(venue.refund_cutoff_hours ?? 24); setCancellationNotes(venue.cancellation_notes ?? ""); setRules(venue.rules ?? ""); setErr(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
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
                    reason: "The venue's operating hours changed and this slot is no longer available.",
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
      <p className="text-sm text-muted-foreground">{venue.address} · {venue.timezone}</p>
      {venue.description && <p className="mt-1 text-sm text-muted-foreground">{venue.description}</p>}
      {(venue.images?.length ?? 0) > 0 && (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {venue.images!.slice(0, 4).map((src, i) => (
            <img key={i} src={src} alt={`${venue.name} ${i + 1}`} className="h-16 w-24 flex-none rounded-md object-cover" loading="lazy" />
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => setEditing(true)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:border-primary hover:text-primary">
          ✎ Edit venue
        </button>
        {!confirmDel ? (
          <button onClick={() => { setConfirmDel(true); setDelErr(null); }} className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
            Delete venue
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1">
            <span className="text-xs">Delete "{venue.name}"{courtsCount > 0 ? ` and its ${courtsCount} court${courtsCount === 1 ? "" : "s"}` : ""}?</span>
            <button onClick={() => del.mutate()} disabled={del.isPending} className="rounded-md bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60">
              {del.isPending ? "Deleting…" : "Confirm"}
            </button>
            <button onClick={() => setConfirmDel(false)} className="rounded-md border border-border bg-background px-2 py-0.5 text-xs">Cancel</button>
          </div>
        )}
      </div>
      {delErr && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{delErr}</p>}
    </div>
  );
}

function SettingsSection({
  fullName, email, role, userId, onSaved,
}: { fullName: string; email: string; role: string; userId: string; onSaved: () => void }) {
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
      const { data, error } = await supabase.from("venues").select("id, name, payment_mode, refund_cutoff_hours");
      if (error) throw error;
      return data as { id: number; name: string; payment_mode: string; refund_cutoff_hours: number }[];
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
    setSaving(true); setMsg(null); setErr(null);
    const { error } = await supabase.from("profiles").update({ full_name: name.trim() }).eq("id", userId);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setMsg("Saved."); onSaved();
  };

  const signOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    window.location.href = "/";
  };


  return (
    <div className="space-y-6">
      <SectionHeader title="Settings" subtitle="Manage your account and preferences." />

      <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
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
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Payments</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose how players pay online per venue. Set to <b>Full payment</b> or <b>50% downpayment</b> to enable the GCash / Maya / GrabPay / QR Ph checkout for that venue's courts. Refund cutoff blocks player-initiated refunds inside the window before the booking.
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-[11px] font-semibold">PayMongo · Test mode</span>
          </div>
          <div className="mt-4 space-y-3">
            {paySettingsQ.isLoading && <p className="text-sm text-muted-foreground">Loading venues…</p>}
            {!paySettingsQ.isLoading && (paySettingsQ.data ?? []).map((v) => (
              <VenuePaymentRow key={v.id} venue={v} onSave={savePaymentSettings} />
            ))}
            {!paySettingsQ.isLoading && (paySettingsQ.data?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">Create a venue first to configure payment settings.</p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-destructive/30 bg-card p-5 sm:p-6">

        <h3 className="text-base font-semibold">Session</h3>
        <p className="mt-1 text-xs text-muted-foreground">Sign out of your CourtHub account on this device.</p>
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

function VenuesCourtsTabs({ venues }: { venues: Venue[] }) {
  const [tab, setTab] = useState<"venues" | "courts" | "groups">("venues");
  const venueIds = venues.map((v) => v.id);
  const courtsTotalQ = useQuery({
    queryKey: ["venues-court-counts", venueIds],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("courts").select("venue_id").in("venue_id", venueIds);
      if (error) throw error;
      const map: Record<number, number> = {};
      (data ?? []).forEach((c: any) => { map[c.venue_id] = (map[c.venue_id] ?? 0) + 1; });
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
      (cs ?? []).forEach((c: any) => counts.set(c.physical_court_id, (counts.get(c.physical_court_id) ?? 0) + 1));
      // Mirror the Court Groups table: only surfaces shared by 2+ courts are real groups
      return pcIds.filter((id) => (counts.get(id) ?? 0) >= 2).length;
    },
  });
  const groupsTotal = groupsTotalQ.data ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex border-b border-border bg-secondary/30">
        <TabBtn active={tab === "venues"} onClick={() => setTab("venues")}>
          Venues <span className="ml-1.5 inline-flex min-w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">{venues.length}</span>
        </TabBtn>
        <TabBtn active={tab === "courts"} onClick={() => setTab("courts")}>
          Courts <span className="ml-1.5 inline-flex min-w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">{courtsTotal}</span>
        </TabBtn>

        <TabBtn active={tab === "groups"} onClick={() => setTab("groups")}>
          Court Groups <span className="ml-1.5 inline-flex min-w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-primary via-cyan-400 to-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.6)] ring-1 ring-white/40">{groupsTotal}</span>
          <span className="group relative ml-1 inline-flex">
            <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none opacity-70">?</span>
            <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-left text-xs font-normal normal-case text-popover-foreground shadow-lg group-hover:block">
              <span className="block font-semibold text-primary">What is a Court Group / Physical Surface?</span>
              <span className="mt-1 block text-muted-foreground">One shared space can host different sports — e.g. <b>1 basketball</b> ↔ <b>3 badminton</b> ↔ <b>4 pickleball</b>. Group those courts here so a booking on one automatically blocks the conflicting slots on the others.</span>
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

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

const VENUE_COLUMNS: Array<{ id: string; label: string; required?: boolean; defaultOn?: boolean }> = [
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



function useColumnPrefs(columns: ColumnDef[], defaults: string[], storageKey: string, prefKey: string) {
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
        try { localStorage.setItem(storageKey, JSON.stringify(merged)); } catch {}
      }
    })();
  }, []);
  const save = (next: string[]) => {
    const clean = sanitize(next);
    setSelected(clean);
    try { localStorage.setItem(storageKey, JSON.stringify(clean)); } catch {}
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data: existing } = await supabase
        .from("user_preferences")
        .select("prefs")
        .eq("user_id", uid)
        .maybeSingle();
      const merged = { ...(existing?.prefs as any ?? {}), [prefKey]: clean };
      await supabase
        .from("user_preferences")
        .upsert({ user_id: uid, prefs: merged, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    })();
  };
  return { selected, save };
}

const useVenueColumns = () => useColumnPrefs(VENUE_COLUMNS, DEFAULT_VENUE_COLS, VENUE_COLS_STORAGE_KEY, "venues_columns");
const useCourtColumns = () => useColumnPrefs(COURT_COLUMNS, DEFAULT_COURT_COLS, COURT_COLS_STORAGE_KEY, "courts_columns");
const useGroupColumns = () => useColumnPrefs(GROUP_COLUMNS, DEFAULT_GROUP_COLS, GROUP_COLS_STORAGE_KEY, "groups_columns");

type ColumnPreset = { name: string; columns: string[] };

function useColumnPresets(prefKey: string) {
  const [presets, setPresets] = useState<ColumnPreset[]>([]);
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data } = await supabase.from("user_preferences").select("prefs").eq("user_id", uid).maybeSingle();
      const list = (data?.prefs as any)?.[prefKey] as ColumnPreset[] | undefined;
      if (Array.isArray(list)) setPresets(list);
    })();
  }, [prefKey]);
  const persist = async (next: ColumnPreset[]) => {
    setPresets(next);
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    if (!uid) return;
    const { data: existing } = await supabase.from("user_preferences").select("prefs").eq("user_id", uid).maybeSingle();
    const merged = { ...(existing?.prefs as any ?? {}), [prefKey]: next };
    await supabase.from("user_preferences").upsert({ user_id: uid, prefs: merged, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  };
  return { presets, persist };
}


function ColumnConfigModal({ open, onClose, selected, onApply, columns = VENUE_COLUMNS, defaults = DEFAULT_VENUE_COLS, presetKey = "venues_column_presets" }: { open: boolean; onClose: () => void; selected: string[]; onApply: (next: string[]) => void; columns?: ColumnDef[]; defaults?: string[]; presetKey?: string }) {
  const [localSelected, setLocalSelected] = useState<string[]>(selected);
  const [availActive, setAvailActive] = useState<string | null>(null);
  const [selActive, setSelActive] = useState<string | null>(null);
  const [availQuery, setAvailQuery] = useState("");
  const [selQuery, setSelQuery] = useState("");
  const [presetName, setPresetName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const { presets, persist } = useColumnPresets(presetKey);
  useEffect(() => { if (open) { setLocalSelected(selected); setAvailActive(null); setSelActive(null); setAvailQuery(""); setSelQuery(""); setPresetName(""); setShowSaveForm(false); setDeleteTarget(null); } }, [open, selected]);
  if (!open) return null;

  const availableCols = columns.filter((c) => !localSelected.includes(c.id));
  const selectedCols = localSelected.map((id) => columns.find((c) => c.id === id)).filter(Boolean) as ColumnDef[];
  const filteredAvail = availableCols.filter((c) => c.label.toLowerCase().includes(availQuery.toLowerCase()));
  const filteredSel = selectedCols.filter((c) => c.label.toLowerCase().includes(selQuery.toLowerCase()));
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
  const apply = () => { onApply(localSelected); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true">

      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-base font-semibold">Column Configuration</h3>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        {/* Presets bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/20 px-5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Bookmark className="h-3.5 w-3.5" /> Presets
          </div>
          <select
            value=""
            onChange={(e) => { const p = presets.find((x) => x.name === e.target.value); if (p) setLocalSelected(p.columns); e.currentTarget.value = ""; }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          >
            <option value="">{presets.length ? "Load preset…" : "No presets yet"}</option>
            {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          {presets.length > 0 && (
            <select
              value=""
              onChange={(e) => { const name = e.target.value; if (!name) return; setDeleteTarget(name); e.currentTarget.value = ""; }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive outline-none focus:border-destructive"
            >
              <option value="">Delete…</option>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
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
                  onKeyDown={(e) => { if (e.key === "Enter") { const n = presetName.trim(); if (!n) return; const next = presets.some((p) => p.name === n) ? presets.map((p) => p.name === n ? { name: n, columns: localSelected } : p) : [...presets, { name: n, columns: localSelected }]; persist(next); setPresetName(""); setShowSaveForm(false); } if (e.key === "Escape") { setShowSaveForm(false); setPresetName(""); } }}
                />
                <button
                  type="button"
                  onClick={() => { const n = presetName.trim(); if (!n) return; const next = presets.some((p) => p.name === n) ? presets.map((p) => p.name === n ? { name: n, columns: localSelected } : p) : [...presets, { name: n, columns: localSelected }]; persist(next); setPresetName(""); setShowSaveForm(false); }}
                  className="rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >Save</button>
                <button type="button" onClick={() => { setShowSaveForm(false); setPresetName(""); }} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary">Cancel</button>
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
              <input value={availQuery} onChange={(e) => setAvailQuery(e.target.value)} placeholder="Search…" className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary" />
            </div>
            <ul className="h-56 overflow-y-auto rounded-md border border-border bg-secondary/20">
              {filteredAvail.length === 0 && <li className="p-3 text-center text-xs italic text-muted-foreground">No columns</li>}
              {filteredAvail.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setAvailActive(c.id)}
                    onDoubleClick={() => { setLocalSelected([...localSelected, c.id]); setAvailActive(null); }}
                    className={"block w-full px-3 py-1.5 text-left text-xs transition " + (availActive === c.id ? "bg-primary/15 text-foreground" : "text-foreground/80 hover:bg-secondary")}
                  >
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {/* Arrows */}
          <div className="flex flex-row items-center justify-center gap-2 sm:flex-col">
            <button type="button" onClick={moveToSelected} disabled={!availActive} title="Add" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent"><ChevronRight className="h-4 w-4" /></button>
            <button type="button" onClick={moveToAvailable} disabled={!selActive || columns.find((c) => c.id === selActive)?.required} title="Remove" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent"><ChevronLeft className="h-4 w-4" /></button>
          </div>
          {/* Selected */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Selected Columns</div>
            <div className="relative mb-2 flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input value={selQuery} onChange={(e) => setSelQuery(e.target.value)} placeholder="Search…" className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary" />
              </div>
              <button type="button" onClick={moveUp} disabled={!selActive} title="Move up" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40"><ChevronUp className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={moveDown} disabled={!selActive} title="Move down" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary disabled:opacity-40"><ChevronDown className="h-3.5 w-3.5" /></button>
            </div>
            <ul className="h-56 overflow-y-auto rounded-md border border-border bg-secondary/20">
              {filteredSel.length === 0 && <li className="p-3 text-center text-xs italic text-muted-foreground">No columns</li>}
              {filteredSel.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelActive(c.id)}
                    onDoubleClick={() => { if (!c.required) { setLocalSelected(localSelected.filter((id) => id !== c.id)); setSelActive(null); } }}
                    className={"flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition " + (selActive === c.id ? "bg-primary/15 text-foreground" : "text-foreground/80 hover:bg-secondary")}
                  >
                    <span>{c.label}</span>
                    {c.required && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Required</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={resetDefault} className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide hover:bg-secondary">Reset to Default</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide hover:bg-secondary">Cancel</button>
            <button type="button" onClick={apply} className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary-foreground hover:bg-primary/90">OK</button>
          </div>
        </div>
      </div>
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the preset <span className="font-semibold text-foreground">"{deleteTarget}"</span>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) persist(presets.filter((p) => p.name !== deleteTarget)); setDeleteTarget(null); }}
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
      const { data, error } = await supabase.from("courts").select("venue_id").in("venue_id", venueIds);
      if (error) throw error;
      const map: Record<number, number> = {};
      (data ?? []).forEach((c: any) => { map[c.venue_id] = (map[c.venue_id] ?? 0) + 1; });
      return map;
    },
  });
  const countFor = (id: number) => courtsCountQ.data?.[id] ?? 0;

  const renderHeader = (id: string) => {
    switch (id) {
      case "emoji": return (
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
      case "name": return <th key={id} className="px-3 py-2.5">Venue</th>;
      case "location": return <th key={id} className="px-3 py-2.5">Location</th>;
      case "description": return <th key={id} className="px-3 py-2.5">ABOUT THIS VENUE</th>;
      case "created_at": return <th key={id} className="px-3 py-2.5 w-32">CREATED AT</th>;
      case "map": return <th key={id} className="px-3 py-2.5 w-20 text-center">Map</th>;
      case "courts": return <th key={id} className="px-3 py-2.5 w-24 text-center">Courts</th>;
      case "status": return <th key={id} className="px-3 py-2.5 w-28 text-center">Status</th>;
      case "actions": return <th key={id} className="px-3 py-2.5 w-40 text-right">Actions</th>;
      case "history": return <th key={id} className="px-3 py-2.5 w-24 text-center">History</th>;
      case "amenities": return <th key={id} className="px-3 py-2.5 w-[200px]">Amenities</th>;
      case "food_beverages": return <th key={id} className="px-3 py-2.5 w-[200px]">Food & Beverages</th>;
      case "facility_services": return <th key={id} className="px-3 py-2.5 w-[200px]">Facility Services</th>;
      case "fees": return <th key={id} className="px-3 py-2.5 w-24 text-center">Fees</th>;
      case "contact_phone": return <th key={id} className="px-3 py-2.5 w-36">Inquiry Phone</th>;
      case "contact_email": return <th key={id} className="px-3 py-2.5 w-48">Inquiry Email</th>;
      case "operating_hours": return <th key={id} className="px-3 py-2.5 w-[200px]">Operating Hours</th>;
      case "cancellation": return <th key={id} className="px-3 py-2.5 w-[200px]">Cancellation</th>;
      case "rules": return <th key={id} className="px-3 py-2.5 w-[200px]">Rules</th>;
      default: return null;
    }
  };

  const renderCell = (id: string, v: Venue, idx: number) => {
    switch (id) {
      case "emoji":
        return <td key={id} className="px-4 py-3 text-xl leading-none">{v.map_emoji ?? "🎾"}</td>;
      case "name":
        return (
          <td key={id} className="px-3 py-3 whitespace-nowrap">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="font-semibold whitespace-nowrap">{v.name}</span>
              {idx === 0 && venues.length > 1 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-primary via-cyan-400 to-sky-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground shadow-[0_2px_8px_-2px_rgba(9,230,210,0.7)] ring-1 ring-white/40"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />Newest</span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">{v.timezone}</div>
          </td>
        );
      case "location":
        return <td key={id} className="px-3 py-3 text-muted-foreground min-w-[180px]">{v.address}</td>;
      case "description":
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-[240px] min-w-[240px] max-w-[240px]">
            {v.description ? (
              v.description.length > 40 ? (
                <HoverCard openDelay={80} closeDelay={200}>
                  <HoverCardTrigger asChild>
                    <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40">{v.description}</span>
                  </HoverCardTrigger>
                  <HoverCardContent side="bottom" align="start" sideOffset={6} collisionPadding={16} avoidCollisions className="w-[min(32rem,92vw)] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed" style={{ overflowWrap: "anywhere", wordBreak: "break-word", maxHeight: "var(--radix-hover-card-content-available-height)" }}>
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
                <span className="text-foreground">{new Date(v.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                <span className="text-[11px] text-muted-foreground">{new Date(v.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
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
              <button type="button" onClick={() => setViewing(v)} title="View on map" aria-label={`View ${v.name} on map`} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary">
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
            <button type="button" onClick={() => setCourtsFor(v)} title={has ? `View ${n} court${n === 1 ? "" : "s"} under this venue` : "No courts yet"} aria-label={`View courts under ${v.name}`} className={"relative inline-flex h-9 w-9 items-center justify-center rounded-full border transition " + (has ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500 hover:bg-emerald-500/20" : "border-border text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary")}>
              <Layers className="h-4 w-4" />
              {has && (<span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-white text-[10px] font-semibold leading-4 text-center shadow">{n}</span>)}
            </button>
          </td>
        );
      }
      case "status": {
        const active = v.is_active !== false;
        return (
          <td key={id} className="px-3 py-3 text-center">
            <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold " + (active ? "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/30" : "bg-red-500/10 text-red-600 ring-1 ring-red-500/30")}>
              <span className={"h-1.5 w-1.5 rounded-full " + (active ? "bg-emerald-500 animate-pulse" : "bg-red-500")} />
              {active ? "Active" : "Inactive"}
            </span>
          </td>
        );
      }
      case "actions":
        return (
          <td key={id} className="px-3 py-3">
            <div className="flex items-center justify-end gap-1">
              <button type="button" onClick={() => setEditing(v)} title="Edit venue" aria-label={`Edit ${v.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <DeleteVenueButton venue={v} />
            </div>
          </td>
        );
      case "history":
        return (
          <td key={id} className="px-3 py-3 text-center">
            <button type="button" onClick={() => setHistory(v)} title="Audit history" aria-label={`View audit history for ${v.name}`} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary">
              <HistoryIcon className="h-4 w-4" />
            </button>
          </td>
        );
      case "amenities":
      case "food_beverages":
      case "facility_services": {
        const arr = (id === "amenities" ? v.amenities : id === "food_beverages" ? v.food_beverages : v.facility_services) ?? [];
        if (!arr.length) return <td key={id} className="px-3 py-3 text-muted-foreground"><span className="italic opacity-60">—</span></td>;
        const text = arr.join(", ");
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-[200px] min-w-[200px] max-w-[200px]">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">{text}</span>
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="start" sideOffset={6} collisionPadding={16} avoidCollisions className="w-[min(32rem,92vw)] overflow-y-auto text-xs" style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}>
                <div className="flex flex-wrap gap-1">
                  {arr.map((t, i) => <span key={i} className="rounded-full bg-secondary px-2 py-0.5">{t}</span>)}
                </div>
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "fees": {
        const feesArr = Array.isArray(v.fees) ? v.fees as FeeItem[] : [];
        if (!feesArr.length && !v.fees_notes) return <td key={id} className="px-3 py-3 text-center text-muted-foreground"><span className="italic opacity-60">—</span></td>;
        return (
          <td key={id} className="px-3 py-3 text-center">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary cursor-help">{feesArr.length} item{feesArr.length === 1 ? "" : "s"}</span>
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="center" sideOffset={6} collisionPadding={16} avoidCollisions className="w-[min(28rem,92vw)] overflow-y-auto text-xs" style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}>
                <ul className="space-y-1">
                  {feesArr.map((f, i) => <li key={i} className="flex justify-between gap-2"><span>{f.label}</span><span className="font-semibold">₱{Number(f.amount).toLocaleString()}</span></li>)}
                </ul>
                {v.fees_notes && <p className="mt-2 border-t border-border pt-2 text-muted-foreground whitespace-pre-wrap">{v.fees_notes}</p>}
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "contact_phone":
        return <td key={id} className="px-3 py-3 text-muted-foreground whitespace-nowrap text-xs">{v.contact_phone || <span className="italic opacity-60">—</span>}</td>;
      case "contact_email":
        return <td key={id} className="px-3 py-3 text-muted-foreground whitespace-nowrap text-xs">{v.contact_email || <span className="italic opacity-60">—</span>}</td>;
      case "operating_hours":
      case "rules": {
        const text = id === "operating_hours" ? v.operating_hours_text : v.rules;
        if (!text) return <td key={id} className="px-3 py-3 text-muted-foreground w-[200px]"><span className="italic opacity-60">—</span></td>;
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-[200px] min-w-[200px] max-w-[200px]">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">{text}</span>
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="start" sideOffset={6} collisionPadding={16} avoidCollisions className="w-[min(32rem,92vw)] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed" style={{ overflowWrap: "anywhere", wordBreak: "break-word", maxHeight: "var(--radix-hover-card-content-available-height)" }}>{text}</HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      case "cancellation": {
        const hrs = (v as any).refund_cutoff_hours as number | null | undefined;
        const notes = v.cancellation_notes;
        if (hrs == null && !notes) return <td key={id} className="px-3 py-3 text-muted-foreground w-[200px]"><span className="italic opacity-60">—</span></td>;
        const summary = hrs != null ? `Cancel up to ${hrs}h before` : "See notes";
        return (
          <td key={id} className="px-3 py-3 text-muted-foreground w-[200px] min-w-[200px] max-w-[200px]">
            <HoverCard openDelay={80} closeDelay={200}>
              <HoverCardTrigger asChild>
                <span className="block w-full truncate cursor-help border-b border-dotted border-muted-foreground/40 text-xs">{summary}{notes ? ` — ${notes}` : ""}</span>
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="start" sideOffset={6} collisionPadding={16} avoidCollisions className="w-[min(32rem,92vw)] overflow-y-auto text-xs" style={{ maxHeight: "var(--radix-hover-card-content-available-height)" }}>
                <p className="font-semibold text-foreground">{summary}</p>
                {notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{notes}</p>}
              </HoverCardContent>
            </HoverCard>
          </td>
        );
      }
      default: return null;
    }
  };

  return (
    <>
      <table className="w-full min-w-[980px] text-sm">
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
      <ColumnConfigModal open={colCfgOpen} onClose={() => setColCfgOpen(false)} selected={visibleCols} onApply={saveCols} />

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
      return data as Array<{ id: number; name: string; hourly_rate: number; is_indoor: boolean; coming_soon: boolean | null; map_emoji: string | null; sports: { name: string } | null }>;
    },
  });
  if (!venue) return null;
  const courts = data ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-bold">Courts at {venue.name}</h3>
            <p className="text-xs text-muted-foreground">View only — {courts.length} court{courts.length === 1 ? "" : "s"}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {isLoading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : courts.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground italic">No courts yet under this venue.</p>
          ) : (
            <ul className="divide-y divide-border">
              {courts.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-3">
                  <span className="text-2xl leading-none">{c.map_emoji ?? "🎾"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{c.name}</span>
                      {c.coming_soon && (
                        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">Coming soon</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.sports?.name ?? "Sport"} · {c.is_indoor ? "Indoor" : "Outdoor"}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-sm font-semibold text-primary">
                    ₱{Number(c.hourly_rate).toFixed(0)}<span className="text-[10px] font-normal text-muted-foreground"> /hr</span>
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

type AuditEntry = { id: number; venue_id: number; action: string; actor_id: string | null; actor_name: string | null; changes: Record<string, unknown> | null; created_at: string };


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
    new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Audit history</div>
            <div className="font-semibold">{venue.name}</div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground italic">No history yet.</div>
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {data.map((e) => (
                <li key={e.id} className="relative">
                  <span className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ring-4 ring-card ${e.action === "created" ? "bg-primary" : "bg-amber-500"}`} />
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${e.action === "created" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>
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
                        <span key={k} className="inline-flex rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{k}</span>
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
      const { data: courts, error: cErr } = await supabase.from("courts").select("id").eq("venue_id", venue.id);
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
    onSuccess: () => { setConfirming(false); setErr(null); qc.invalidateQueries({ queryKey: ["my-venues"] }); qc.invalidateQueries({ queryKey: ["venues-court-counts"] }); qc.invalidateQueries({ queryKey: ["venues-courts-glance"] }); },
    onError: (e: Error) => setErr(e.message),
  });

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setConfirming(false); setErr(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  return (
    <>
      <button
        type="button"
        onClick={() => { setConfirming(true); setErr(null); }}
        title="Delete venue"
        aria-label={`Delete ${venue.name}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-destructive/40 text-destructive transition hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {confirming && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!del.isPending) { setConfirming(false); setErr(null); } }}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold">Delete "{venue.name}"?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This permanently removes the venue and all its courts. Venues with existing bookings cannot be deleted.
            </p>
            {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { setConfirming(false); setErr(null); }} disabled={del.isPending} className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
              <button onClick={() => del.mutate()} disabled={del.isPending} className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60">
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
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
        16
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
    <div className="fixed inset-0 z-[1300] flex items-center justify-center p-4">
      <div onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div role="dialog" aria-modal="true" className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xl leading-none">{venue.map_emoji ?? "🎾"}</span>
              <h2 className="truncate text-base font-bold sm:text-lg">{venue.name}</h2>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{venue.address}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">✕</button>
        </div>
        <div className="relative">
          <div ref={elRef} className="h-[60vh] w-full" />
          <MapInfoButton
            getCenter={() => (venue.latitude != null && venue.longitude != null ? { lat: venue.latitude, lng: venue.longitude } : null)}
            className="bottom-3 right-3"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs sm:px-5">
          <span className="text-muted-foreground">View only · edits are made from the Edit action.</span>
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  const courtsQ = useQuery({
    queryKey: ["courts-count", venue?.id],
    enabled: open,
    queryFn: async () => {
      const { count } = await supabase.from("courts").select("id", { count: "exact", head: true }).eq("venue_id", venue!.id);
      return count ?? 0;
    },
  });

  return (
    <div className={"fixed inset-0 z-[1200] " + (open ? "pointer-events-auto" : "pointer-events-none")}>
      <div onClick={onClose} className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")} />
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
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">✕</button>
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
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Map location</div>
              <VenueLocation venue={venue} onSaved={() => qc.invalidateQueries({ queryKey: ["my-venues"] })} />
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
        supabase.from("bookings").select("id", { count: "exact", head: true }).eq("court_id", court.id),
        supabase.from("bookings").select("id", { count: "exact", head: true }).eq("court_id", court.id).eq("status", "confirmed").gte("start_time", nowIso),
        supabase.from("bookings").select("id", { count: "exact", head: true }).eq("court_id", court.id).eq("payment_status", "paid"),
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
      const { count, error: cErr } = await supabase.from("bookings").select("id", { count: "exact", head: true }).eq("court_id", court.id);
      if (cErr) throw cErr;
      if ((count ?? 0) > 0) throw new Error("This court has booking history and cannot be deleted.");
      const { error } = await supabase.from("courts").delete().eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: () => { setOpen(false); setErr(null); onDeleted(); },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setErr(null); }}
        title="Delete court"
        aria-label={`Delete ${court.name}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-destructive/40 text-destructive align-middle transition hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[1300] flex items-center justify-center whitespace-normal bg-black/50 p-4 text-left" onClick={() => { if (!del.isPending) setOpen(false); }}>
          <div className="w-full max-w-md whitespace-normal break-words rounded-2xl border border-border bg-background p-5 text-left shadow-xl" onClick={(e) => e.stopPropagation()}>
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
                      {usage!.upcoming > 0 && <li>{usage!.upcoming} upcoming confirmed booking{usage!.upcoming === 1 ? "" : "s"}</li>}
                      {usage!.paid > 0 && <li>{usage!.paid} paid transaction{usage!.paid === 1 ? "" : "s"} on record</li>}
                      <li>{usage!.total} booking record{usage!.total === 1 ? "" : "s"} in total</li>
                    </ul>
                    <p className="mt-2 text-muted-foreground">
                      Booking and payment history must stay intact. Set the court to <b>Inactive</b> in Edit court instead — it disappears from players but keeps its records.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                This court has no bookings or transactions. Deleting it is permanent and removes its pricing, hours and images.
              </p>
            )}
            {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={del.isPending} className="rounded-lg border border-border px-3 py-1.5 text-xs">Close</button>
              {!blocked && !usageQ.isLoading && (
                <button onClick={() => del.mutate()} disabled={del.isPending} className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-60">
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
        .from("courts").select("*, sports(name)").in("venue_id", venueIds).order("created_at", { ascending: false }).order("id", { ascending: false });
      if (error) throw error;
      const byId = new Map(venues.map((v) => [v.id, v]));
      return (data as unknown as Court[]).map((c) => ({ ...c, venue: byId.get(c.venue_id)! })) as CourtRow[];
    },
  });

  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [editing, setEditing] = useState<CourtRow | null>(null);
  const [managingHours, setManagingHours] = useState<CourtRow | null>(null);
  const [historyCourt, setHistoryCourt] = useState<CourtRow | null>(null);
  const [colCfgOpen, setColCfgOpen] = useState(false);
  const { selected: visibleCols, save: saveCols } = useCourtColumns();

  const rows = (courtsQ.data ?? []).filter((c) => venueFilter === "all" || c.venue_id === venueFilter);
  const invalidate = () => {
    ["all-tenant-courts", "venues-courts-glance", "venues-court-counts", "venues-courts-table", "courts", "physical-courts-full", "physical-courts", "venues-group-counts", "group-eligible-courts"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
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
      case "emoji": return <th key={id} className="px-4 py-2.5 w-10">{cfgButton}</th>;
      case "name": return <th key={id} className="px-3 py-2.5">Court</th>;
      case "description": return <th key={id} className="px-3 py-2.5">About This Court</th>;
      case "venue": return <th key={id} className="px-3 py-2.5">Venue</th>;
      case "sport": return <th key={id} className="px-3 py-2.5">Sport</th>;
      case "type": return <th key={id} className="px-3 py-2.5">Type</th>;
      case "surface": return <th key={id} className="px-3 py-2.5">Surface</th>;
      case "capacity": return <th key={id} className="px-3 py-2.5 text-center">Capacity</th>;
      case "rate": return <th key={id} className="px-3 py-2.5 text-right">Rate / hr</th>;
      case "voucher": return <th key={id} className="px-3 py-2.5 text-center">Voucher</th>;
      case "status": return <th key={id} className="px-3 py-2.5">Status</th>;
      case "created_at": return <th key={id} className="px-3 py-2.5 w-32">Created At</th>;
      case "history": return <th key={id} className="px-3 py-2.5 w-24 text-center">History</th>;
      case "actions": return <th key={id} className="px-3 py-2.5 text-right">Actions</th>;
      default: return null;
    }
  };

  const renderCell = (id: string, c: CourtRow) => {
    switch (id) {
      case "emoji": return <td key={id} className="px-4 py-3 text-xl leading-none">{c.map_emoji ?? c.venue.map_emoji ?? "🎾"}</td>;
      case "name": return <td key={id} className="px-3 py-3"><div className="font-semibold">{c.name}</div></td>;
      case "description": return (
        <td key={id} className="px-3 py-3">
          {c.description?.trim() ? (
            <p title={c.description} className="line-clamp-2 max-w-[260px] whitespace-normal break-words text-[12px] leading-snug text-muted-foreground">{c.description}</p>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
      );
      case "venue": return (
        <td key={id} className="px-3 py-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[13px] font-semibold leading-tight text-foreground ring-1 ring-primary/20">
            <span className="text-base leading-none">{c.venue.map_emoji ?? "🏟️"}</span>{c.venue.name}
          </span>
        </td>
      );
      case "sport": return <td key={id} className="px-3 py-3 text-muted-foreground">{c.sports?.name ?? "—"}</td>;
      case "type": return <td key={id} className="px-3 py-3 text-muted-foreground">{c.is_indoor ? "Indoor" : "Outdoor"}</td>;
      case "surface": return <td key={id} className="px-3 py-3 text-muted-foreground">{c.surface_type?.trim() ? c.surface_type : "—"}</td>;
      case "capacity": return <td key={id} className="px-3 py-3 text-center tabular-nums text-muted-foreground">{c.player_capacity ?? "—"}</td>;
      case "rate": return <td key={id} className="px-3 py-3 text-right"><span className="text-[15px] font-bold tabular-nums text-foreground [text-shadow:0_0_10px_rgba(250,204,21,0.85)]">₱{Number(c.hourly_rate).toFixed(0)}</span></td>;
      case "voucher": return (
        <td key={id} className="px-3 py-3 text-center">
          {c.voucher_enabled ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 ring-1 ring-emerald-500/30">True</span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground ring-1 ring-border">False</span>
          )}
        </td>
      );
      case "status": return (
        <td key={id} className="px-3 py-3">
          {c.coming_soon ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 ring-1 ring-amber-500/30">Coming soon</span>
          ) : (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 ring-1 ring-emerald-500/30">ACTIVE</span>
          )}
        </td>
      );
      case "created_at": return (
        <td key={id} className="px-3 py-3">
          {c.created_at ? (
            <div className="flex flex-col leading-tight">
              <span className="text-foreground">{new Date(c.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
              <span className="text-[11px] text-muted-foreground">{new Date(c.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            </div>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
      );
      case "history": return (
        <td key={id} className="px-3 py-3 text-center">
          <button type="button" onClick={() => setHistoryCourt(c)} title="Audit history" aria-label={`View audit history for ${c.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary">
            <HistoryIcon className="h-3.5 w-3.5" />
          </button>
        </td>
      );
      case "actions": return (
        <td key={id} className="px-3 py-3">
          <div className="flex items-center justify-end gap-1">
            <button type="button" onClick={() => setEditing(c)} title="Edit court" aria-label={`Edit ${c.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <DeleteCourtButton court={c} onDeleted={invalidate} />
          </div>
        </td>
      );
      default: return null;
    }
  };

  return (
    <>
      <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <label className="text-xs text-muted-foreground">Filter venue:</label>
        <select
          value={venueFilter === "all" ? "all" : String(venueFilter)}
          onChange={(e) => setVenueFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="all">All venues</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        
      </div>
      {courtsQ.isLoading ? (
        <div className="p-6"><div className="h-24 animate-pulse rounded-lg bg-muted" /></div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No courts yet. Use <strong>Add court</strong> to create one.</div>
      ) : (
        <table className="w-full min-w-[900px] text-sm">
          <thead className="sticky top-[41px] z-10 bg-secondary/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
            <tr>
              {!visibleCols.includes("emoji") && <th className="w-8 pl-2 pr-0 py-2.5">{cfgButton}</th>}
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
            onDone={() => { invalidate(); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        )}
      </CourtDrawer>
      <CourtDrawer title="Manage availability" open={managingHours !== null} onClose={() => setManagingHours(null)}>
        {managingHours && (
          <AvailabilityEditor
            court={managingHours}
            onDone={() => { invalidate(); setManagingHours(null); }}
            onCancel={() => setManagingHours(null)}
          />
        )}
      </CourtDrawer>
    </>
  );
}


type CourtAuditEntry = { id: number; court_id: number; action: string; actor_id: string | null; actor_name: string | null; changes: Record<string, unknown> | null; created_at: string };

function CourtAuditHistoryModal({ court, onClose }: { court: { id: number; name: string } | null; onClose: () => void }) {
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
    new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Court history</div>
            <div className="font-semibold">{court.name}</div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground italic">No history yet.</div>
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {data.map((e) => (
                <li key={e.id} className="relative">
                  <span className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ring-4 ring-card ${e.action === "created" ? "bg-primary" : "bg-amber-500"}`} />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${e.action === "created" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>
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
                        <span key={k} className="inline-flex rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{k}</span>
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

function CourtDrawer({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  return (
    <div className={"fixed inset-0 z-[1200] " + (open ? "pointer-events-auto" : "pointer-events-none")}>
      <div onClick={onClose} className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (open ? "opacity-100" : "opacity-0")} />
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
          <button onClick={onClose} aria-label="Close" className="rounded-md border border-border px-2 py-1 text-sm hover:bg-secondary">✕</button>
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
  useEffect(() => { if (!venueId && venues[0]) setVenueId(venues[0].id); }, [venues, venueId]);

  const groupsQ = useQuery({
    queryKey: ["physical-courts-full", venueId],
    enabled: !!venueId,
    queryFn: async () => {
      const { data: pcs, error } = await supabase.from("physical_courts")
        .select("id, venue_id, name, map_emoji, description").eq("venue_id", venueId!).order("id");
      if (error) throw error;
      const pcIds = (pcs ?? []).map((p) => p.id);
      if (pcIds.length === 0) return [] as GroupRow[];
      const { data: cs, error: cErr } = await supabase.from("courts")
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
        const { data: rs, error: rErr } = await supabase.from("court_block_rules")
          .select("court_id").in("court_id", courtIds);
        if (rErr) throw rErr;
        (rs ?? []).forEach((r: any) => rulesByCourt.set(r.court_id, (rulesByCourt.get(r.court_id) ?? 0) + 1));
      }
      return (pcs ?? []).map((p: any) => {
        const layouts = byPc.get(p.id) ?? [];
        const rulesCount = layouts.reduce((sum, l) => sum + (rulesByCourt.get(l.id) ?? 0), 0);
        return { ...p, layouts, rulesCount };
      }).filter((g) => g.layouts.length >= 2) as GroupRow[];
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
      case "emoji": return <th key={id} className="px-3 py-2 w-10 font-semibold">{cfgButton}</th>;
      case "name": return <th key={id} className="px-3 py-2 font-semibold">Group</th>;
      case "description": return <th key={id} className="px-3 py-2 font-semibold">About this group</th>;
      case "courts_count": return <th key={id} className="px-3 py-2 font-semibold text-center">Courts</th>;
      case "rules": return <th key={id} className="px-3 py-2 font-semibold text-center">Blocking rules</th>;
      case "sports": return <th key={id} className="px-3 py-2 font-semibold">Sports</th>;
      case "actions": return <th key={id} className="px-3 py-2 font-semibold text-right">Actions</th>;
      default: return null;
    }
  };

  const renderCell = (id: string, g: GroupRow) => {
    switch (id) {
      case "emoji": return <td key={id} className="px-3 py-3 text-lg leading-none">{g.map_emoji ?? "🏟️"}</td>;
      case "name": return <td key={id} className="px-3 py-3"><span className="font-medium">{g.name}</span></td>;
      case "description": return <td key={id} className="px-3 py-3 text-muted-foreground">{g.description || "—"}</td>;
      case "courts_count": return (
        <td key={id} className="px-3 py-3 text-center">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary ring-1 ring-primary/20">{g.layouts.length}</span>
        </td>
      );
      case "rules": return (
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
      case "actions": return (
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
      default: return null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-6">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Venue</span>
          <select value={venueId ?? ""} onChange={(e) => setVenueId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 rounded-lg border border-input bg-background px-3 py-2 text-sm">
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Use <b className="text-foreground">+ Create group</b> to bundle courts that share the same physical space.
        </p>
      </div>
      <div className="flex-1 overflow-auto nice-scroll px-4 pb-6 sm:px-6">
        {groupsQ.isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No shared-surface groups yet for this venue. Click <b className="text-foreground">+ Create group</b> above to bundle courts that share one physical space.
          </div>
        ) : (
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                {!visibleCols.includes("emoji") && <th className="w-8 pl-2 pr-0 py-2">{cfgButton}</th>}
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


type GroupRow = { id: number; venue_id: number; name: string; map_emoji: string | null; description: string | null; rulesCount: number; layouts: Array<{ id: number; name: string; sport: string | null }> };

function DeleteGroupButton({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const courtIds = group.layouts.map((l) => l.id);
      if (courtIds.length > 0) {
        const { count, error } = await supabase.from("bookings")
          .select("id", { count: "exact", head: true })
          .in("court_id", courtIds)
          .eq("status", "confirmed")
          .gte("end_time", new Date().toISOString());
        if (error) throw error;
        if ((count ?? 0) > 0) throw new Error("This group has upcoming confirmed bookings and cannot be deleted until they finish or are cancelled.");
        // Detach courts from the physical surface by giving each its own new slab
        for (const c of group.layouts) {
          const { data: pc, error: pcErr } = await supabase.from("physical_courts")
            .insert({ venue_id: (group as any).venue_id ?? undefined, name: c.name })
            .select("id").single();
          if (pcErr) {
            // Fall back: leave the physical_court_id — parent will still delete-cascade if we allow, but safer to abort.
            throw pcErr;
          }
          const { error: upErr } = await supabase.from("courts")
            .update({ physical_court_id: pc.id, capacity: 1, footprint: 1 }).eq("id", c.id);
          if (upErr) throw upErr;
        }
      }
      const { error } = await supabase.from("physical_courts").delete().eq("id", group.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setConfirm(false); setErr(null);
      qc.invalidateQueries({ queryKey: ["physical-courts-full"] });
      qc.invalidateQueries({ queryKey: ["physical-courts"] });
      qc.invalidateQueries({ queryKey: ["tenant-venues-full"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => { setErr(null); setConfirm(true); }}
        title="Delete group"
        aria-label={`Delete ${group.name}`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {confirm && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" onClick={() => !mut.isPending && setConfirm(false)}>
          <div className="w-full max-w-md rounded-2xl border border-destructive/40 bg-background p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold">Delete group permanently?</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  <b className="text-foreground">{group.name}</b> will be <b className="text-destructive">permanently deleted</b>. Its courts remain but each becomes independent again.
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              ⚠ This action is <b>permanent</b> and cannot be undone.
            </div>
            {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" disabled={mut.isPending} onClick={() => setConfirm(false)} className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary">Cancel</button>
              <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground disabled:opacity-50">
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
      const { data, error } = await supabase.from("courts")
        .select("id, name, physical_court_id, sports(name)")
        .eq("venue_id", group.venue_id).order("id");
      if (error) throw error;
      return (data ?? []) as Array<{ id: number; name: string; physical_court_id: number; sports: { name: string } | null }>;
    },
  });

  // Pairwise blocking rules among the courts of this group
  const memberIds = [...group.layouts.filter((l) => !detachSel.has(l.id)).map((l) => l.id), ...Array.from(addSel)];

  const rulesQ = useQuery({
    queryKey: ["court-block-rules", group.id, group.layouts.map((l) => l.id).join(",")],
    enabled: group.layouts.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("court_block_rules")
        .select("court_id, blocked_court_id")
        .in("court_id", group.layouts.map((l) => l.id));
      if (error) throw error;
      return (data ?? []).map((r) => ruleKey(r.court_id, r.blocked_court_id));
    },
  });
  const [rulesDraft, setRulesDraft] = useState<Set<string> | null>(null);
  const rules = rulesDraft ?? new Set(rulesQ.data ?? []);
  const ruleCourts: RuleCourt[] = [
    ...group.layouts.filter((l) => !detachSel.has(l.id)).map((l) => ({ id: l.id, name: l.name, sport: l.sport })),
    ...(eligibleQ.data ?? []).filter((c) => addSel.has(c.id)).map((c) => ({ id: c.id, name: c.name, sport: c.sports?.name ?? null })),
  ];

  const toggleAdd = (id: number) => {
    setAddSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleDetach = (id: number) => {
    setErr(null);
    setDetachSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Group name is required");
      // Update group fields
      const { error } = await supabase.from("physical_courts")
        .update({ name: name.trim(), map_emoji: emoji, description: description.trim() || null })
        .eq("id", group.id);
      if (error) throw error;
      // Detach unticked members (blocked if they have upcoming confirmed bookings)
      for (const id of Array.from(detachSel)) {
        const { count, error: cErr } = await supabase.from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("court_id", id)
          .eq("status", "confirmed")
          .gte("end_time", new Date().toISOString());
        if (cErr) throw cErr;
        if ((count ?? 0) > 0) throw new Error("A court you unticked has upcoming confirmed bookings and cannot be detached until they finish or are cancelled.");
        const { data: pc, error: pcErr } = await supabase.from("physical_courts")
          .insert({ venue_id: group.venue_id, name: `Slab ${Date.now()}` }).select("id").single();
        if (pcErr) throw pcErr;
        const { error: dErr } = await supabase.from("courts")
          .update({ physical_court_id: pc.id }).eq("id", id);
        if (dErr) throw dErr;
        const { error: rErr } = await supabase.from("court_block_rules").delete().eq("court_id", id);
        if (rErr) throw rErr;
      }
      // Attach newly selected courts
      for (const id of Array.from(addSel)) {
        const { error: upErr } = await supabase.from("courts")
          .update({ physical_court_id: group.id }).eq("id", id);
        if (upErr) throw upErr;
      }
      // Replace pairwise blocking rules for all courts in this group
      const ids = memberIds;

      if (ids.length > 0) {
        const { error: delErr } = await supabase.from("court_block_rules").delete().in("court_id", ids);
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
      qc.invalidateQueries({ queryKey: ["physical-courts-full"] });
      qc.invalidateQueries({ queryKey: ["physical-courts"] });
      qc.invalidateQueries({ queryKey: ["tenant-venues-full"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const eligible = eligibleQ.data ?? [];

  return (
    <div className="fixed inset-0 z-[70] flex" onClick={onClose}>
      <div className="flex-1 bg-black/50" />
      <div className="h-full w-full max-w-lg overflow-y-auto bg-background shadow-2xl nice-scroll" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-5 py-4">
          <h3 className="text-lg font-semibold">Edit group</h3>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="grid gap-4 p-5">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
            Editing the <b className="text-foreground">whole group</b> — group name, emoji, description, and which courts belong to this shared space.
          </div>

          <Input label="Group name" value={name} onChange={setName} required />
          <div className="rounded-xl border border-border bg-background p-3">
            <EmojiPicker label="Group emoji" value={emoji} fallback="🏟️" onChange={setEmoji} hint="Shown on the map and in the courts table." />
          </div>
          <Textarea label="About this Group (optional)" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, house rules…" />

          <CourtBlockRulesEditor courts={ruleCourts} rules={rules} onChange={setRulesDraft} />

          <div className="rounded-xl border border-dashed border-border p-3">
            <div className="text-sm font-semibold">Courts in this group</div>
            <p className="mt-1 text-xs text-muted-foreground">Tick courts from this venue to include them in this group; untick to detach.</p>
            <div className="mt-3 grid gap-2">
              {eligible.length === 0 && <p className="text-xs text-muted-foreground">No courts in this venue.</p>}
              {eligible.map((c) => {
                const isMember = memberSet.has(c.id);
                const checked = isMember ? !detachSel.has(c.id) : addSel.has(c.id);
                return (
                  <label key={c.id} className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-sm ${checked ? "border-primary bg-primary/5" : "border-border"}`}>
                    <input type="checkbox" checked={checked} onChange={() => (isMember ? toggleDetach(c.id) : toggleAdd(c.id))} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">{c.sports?.name ?? "—"}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>


          {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary">Cancel</button>
            <button disabled={mut.isPending || !name.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
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
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

function TransactionsSection({ venues }: { venues: Venue[] }) {
  const qc = useQueryClient();
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "paid" | "pending" | "failed" | "refunded">("all");

  const txQ = useQuery({
    queryKey: ["tenant-transactions", venueFilter, statusFilter],
    queryFn: async () => {
      let q = supabase.from("transactions").select("*").order("created_at", { ascending: false }).limit(500);
      if (venueFilter !== "all") q = q.eq("venue_id", venueFilter);
      if (statusFilter !== "all") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TxRow[];
    },
  });

  const settingsQ = useQuery({
    queryKey: ["venue-payment-settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("venues").select("id, name, payment_mode, refund_cutoff_hours");
      if (error) throw error;
      return data as { id: number; name: string; payment_mode: string; refund_cutoff_hours: number }[];
    },
  });

  const rows = txQ.data ?? [];
  const paid = rows.filter((r) => r.status === "paid");
  const now = Date.now();
  const sumSince = (ms: number) => paid.filter((r) => new Date(r.paid_at ?? r.created_at).getTime() >= now - ms).reduce((s, r) => s + Number(r.amount), 0);
  const todaySum = sumSince(24 * 3_600_000);
  const weekSum = sumSince(7 * 24 * 3_600_000);
  const monthSum = sumSince(30 * 24 * 3_600_000);
  const uniqueCustomers = new Set(paid.map((r) => r.user_id)).size;
  const totalBookings = new Set(paid.map((r) => r.booking_id)).size;

  const savePaymentSettings = async (venueId: number, mode: string, cutoff: number) => {
    const { error } = await supabase
      .from("venues")
      .update({ payment_mode: mode, refund_cutoff_hours: cutoff })
      .eq("id", venueId);
    if (error) alert(error.message);
    else qc.invalidateQueries({ queryKey: ["venue-payment-settings"] });
  };

  const currency = (n: number) => "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      paid: "bg-primary/15 text-primary",
      pending: "bg-amber-500/15 text-amber-700",
      failed: "bg-destructive/15 text-destructive",
      refunded: "bg-muted text-muted-foreground",
      cancelled: "bg-muted text-muted-foreground",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary text-foreground"}`}>{s}</span>;
  };

  return (
    <div className="space-y-6">
      <SectionHeader title="Transactions" subtitle="Track online payments, refunds and customer activity across your venues." />

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
        <select
          value={venueFilter}
          onChange={(e) => setVenueFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All venues</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
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
        <span className="ml-auto rounded-full bg-secondary px-3 py-1 text-xs font-semibold">PayMongo · {paid[0]?.mode === "live" ? "Live" : "Test"} mode</span>
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
                <th className="px-4 py-3">Booking</th>
                <th className="px-4 py-3">Venue</th>
              </tr>
            </thead>
            <tbody>
              {txQ.isLoading ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>No transactions yet. Once players start paying online, they'll show up here.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDate(r.paid_at ?? r.created_at)}</td>
                  <td className="px-4 py-3 font-semibold">{currency(Number(r.amount))}</td>
                  <td className="px-4 py-3 capitalize">{r.method.replace("_", " ")}</td>
                  <td className="px-4 py-3">{statusBadge(r.status)}</td>
                  <td className="px-4 py-3 text-muted-foreground">#{r.booking_id}</td>
                  <td className="px-4 py-3 text-muted-foreground">{venues.find((v) => v.id === r.venue_id)?.name ?? `Venue #${r.venue_id}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-venue payment settings */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Payment settings per venue</h3>
            <p className="mt-1 text-xs text-muted-foreground">Choose how players pay online. Refund cutoff blocks player-initiated refunds inside the window before the booking.</p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {(settingsQ.data ?? []).map((v) => (
            <VenuePaymentRow key={v.id} venue={v} onSave={savePaymentSettings} />
          ))}
          {(settingsQ.data?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">Create a venue first to configure payment settings.</p>}
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function VenuePaymentRow({
  venue, onSave,
}: {
  venue: { id: number; name: string; payment_mode: string; refund_cutoff_hours: number };
  onSave: (id: number, mode: string, cutoff: number) => Promise<void>;
}) {
  const [mode, setMode] = useState(venue.payment_mode);
  const [cutoff, setCutoff] = useState(venue.refund_cutoff_hours);
  const [saving, setSaving] = useState(false);
  const dirty = mode !== venue.payment_mode || cutoff !== venue.refund_cutoff_hours;

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-background p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
      <div>
        <p className="text-sm font-semibold">{venue.name}</p>
        <p className="text-[11px] text-muted-foreground">
          Current: <span className="font-medium capitalize">{venue.payment_mode.replace("_", " ")}</span> · Refund cutoff {venue.refund_cutoff_hours}h
        </p>
      </div>
      <label className="block">
        <span className="text-[11px] font-medium text-muted-foreground">Payment mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm">
          <option value="none">No online payment</option>
          <option value="full">Full payment</option>
          <option value="downpayment_50">50% downpayment</option>
        </select>
      </label>
      <label className="block">
        <span className="text-[11px] font-medium text-muted-foreground">Refund cutoff (hrs)</span>
        <input type="number" min={0} value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))} className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1.5 text-sm" />
      </label>
      <button
        disabled={!dirty || saving}
        onClick={async () => { setSaving(true); await onSave(venue.id, mode, cutoff); setSaving(false); }}
        className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
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
  payment_status: string;
  created_at: string;
  courts: { name: string; venue_id: number; venues: { name: string } | null } | null;
};

function BookingsSection({ venues, userId }: { venues: Venue[]; userId: string }) {
  const qc = useQueryClient();
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [status, setStatus] = useState<"all" | "upcoming" | "past" | "cancelled">("upcoming");
  const [payFilter, setPayFilter] = useState<"all" | "paid" | "unpaid" | "refunded">("all");
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [chat, setChat] = useState<{ bookingId: number; venueId: number; playerId: string; title: string; subtitle: string } | null>(null);



  const bookingsQ = useQuery({
    queryKey: ["tenant-bookings", venueFilter, status, payFilter],
    queryFn: async () => {
      let q = supabase
        .from("bookings")
        .select("id, court_id, user_id, start_time, end_time, status, payment_status, created_at, courts(name, venue_id, venues(name))")
        .order("start_time", { ascending: false })
        .limit(500);
      if (payFilter !== "all") q = q.eq("payment_status", payFilter);
      const { data, error } = await q;
      if (error) throw error;
      const nowIso = new Date().toISOString();
      let rows = (data as unknown as BookingRow[]) ?? [];
      if (venueFilter !== "all") rows = rows.filter((r) => r.courts?.venue_id === venueFilter);
      if (status === "upcoming") rows = rows.filter((r) => r.end_time >= nowIso && r.status !== "cancelled");
      else if (status === "past") rows = rows.filter((r) => r.end_time < nowIso && r.status !== "cancelled");
      else if (status === "cancelled") rows = rows.filter((r) => r.status === "cancelled");
      return rows;
    },
  });

  // Load player names for uid list
  const uids = Array.from(new Set((bookingsQ.data ?? []).map((r) => r.user_id)));
  const namesQ = useQuery({
    queryKey: ["profile-names", uids.sort().join(",")],
    enabled: uids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, full_name, phone").in("id", uids);
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string | null; phone: string | null }[];
    },
  });
  const nameMap = new Map((namesQ.data ?? []).map((p) => [p.id, p]));

  const rows = bookingsQ.data ?? [];
  const sessions = groupBookingSessions(rows).sort((a, b) => b.start_time.localeCompare(a.start_time));

  const totalUpcoming = rows.filter((r) => r.end_time >= new Date().toISOString() && r.status !== "cancelled").length;
  const paidCount = rows.filter((r) => r.payment_status === "paid").length;
  const unpaidCount = rows.filter((r) => r.payment_status === "unpaid" && r.status !== "cancelled").length;

  const fmt = (iso: string) => new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const payBadge = (s: string) => {
    const map: Record<string, string> = {
      paid: "bg-primary/15 text-primary",
      unpaid: "bg-amber-500/15 text-amber-700",
      refunded: "bg-muted text-muted-foreground",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}>{s}</span>;
  };
  const stBadge = (s: string) => {
    const map: Record<string, string> = {
      confirmed: "bg-primary/10 text-primary",
      cancelled: "bg-destructive/10 text-destructive",
      pending: "bg-amber-500/15 text-amber-700",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}>{s}</span>;
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
        <select value={venueFilter} onChange={(e) => setVenueFilter(e.target.value === "all" ? "all" : Number(e.target.value))} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <option value="all">All venues</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <select value={payFilter} onChange={(e) => setPayFilter(e.target.value as typeof payFilter)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <option value="all">Any payment</option>
          <option value="paid">Paid</option>
          <option value="unpaid">Unpaid</option>
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
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>No bookings match these filters yet.</td></tr>
              ) : sessions.map((s) => {
                const r = s.first;
                const p = nameMap.get(r.user_id);
                const paid = s.items.some((i) => i.payment_status === "paid");
                const cancelled = r.status === "cancelled";
                const venueId = r.courts?.venue_id;
                const label = `${formatDateLabel(s.start_time)} · ${formatSessionLabel(s.start_time, s.end_time)} · ${r.courts?.name ?? `Court #${r.court_id}`}`;
                return (
                  <tr key={s.key} className="border-t border-border">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDateLabel(s.start_time)}
                      <div className="text-[11px] text-muted-foreground">{formatSessionLabel(s.start_time, s.end_time)}</div>
                      {s.ids.length > 1 && <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.ids.length} slots</div>}
                    </td>
                    <td className="px-4 py-3">{r.courts?.venues?.name ?? "—"}<div className="text-[11px] text-muted-foreground">{r.courts?.name ?? `Court #${r.court_id}`}</div></td>
                    <td className="px-4 py-3">{p?.full_name || "Player"}<div className="text-[11px] text-muted-foreground">{p?.phone || r.user_id.slice(0, 8)}</div></td>
                    <td className="px-4 py-3">{stBadge(r.status)}</td>
                    <td className="px-4 py-3">{payBadge(r.payment_status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5 whitespace-nowrap">
                        {venueId && (
                          <button
                            onClick={() => setChat({ bookingId: r.id, venueId, playerId: r.user_id, title: p?.full_name || "Player", subtitle: label })}
                            className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold hover:border-primary hover:text-primary"
                          >
                            Message
                          </button>
                        )}
                        {!cancelled && (
                          <button
                            onClick={() => setCancelTarget({ bookingIds: s.ids, label, hasPaid: paid })}
                            className="rounded-lg border border-destructive/40 px-2.5 py-1.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

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

      {chat && (
        <BookingChat
          bookingId={chat.bookingId}
          venueId={chat.venueId}
          playerId={chat.playerId}
          meId={userId}
          title={`Chat with ${chat.title}`}
          subtitle={chat.subtitle}
          onClose={() => setChat(null)}
        />
      )}
    </div>
  );
}


// ================= Customers =================

function CustomersSection({ venues }: { venues: Venue[] }) {
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");

  const dataQ = useQuery({
    queryKey: ["tenant-customers", venueFilter],
    queryFn: async () => {
      let bq = supabase
        .from("bookings")
        .select("id, user_id, start_time, end_time, payment_status, status, courts!inner(venue_id)")
        .order("start_time", { ascending: false })
        .limit(2000);
      if (venueFilter !== "all") bq = bq.eq("courts.venue_id", venueFilter);
      const { data: bookings, error } = await bq;
      if (error) throw error;

      const txQ = supabase.from("transactions").select("user_id, amount, status, venue_id");
      const { data: txs } = venueFilter === "all" ? await txQ : await txQ.eq("venue_id", venueFilter);

      const uids = Array.from(new Set((bookings ?? []).map((b) => b.user_id)));
      const { data: profiles } = uids.length > 0
        ? await supabase.from("profiles").select("id, full_name, phone").in("id", uids)
        : { data: [] as { id: string; full_name: string | null; phone: string | null }[] };

      type Agg = { id: string; name: string; phone: string; bookings: number; paidBookings: number; spent: number; lastAt: string | null };
      const map = new Map<string, Agg>();
      for (const b of bookings ?? []) {
        const cur = map.get(b.user_id) ?? { id: b.user_id, name: "", phone: "", bookings: 0, paidBookings: 0, spent: 0, lastAt: null };
        cur.bookings += 1;
        if (b.payment_status === "paid") cur.paidBookings += 1;
        if (!cur.lastAt || b.start_time > cur.lastAt) cur.lastAt = b.start_time;
        map.set(b.user_id, cur);
      }
      for (const t of txs ?? []) {
        if (t.status !== "paid") continue;
        const cur = map.get(t.user_id);
        if (cur) cur.spent += Number(t.amount);
      }
      for (const p of profiles ?? []) {
        const cur = map.get(p.id);
        if (cur) { cur.name = p.full_name ?? ""; cur.phone = p.phone ?? ""; }
      }
      return Array.from(map.values()).sort((a, b) => b.spent - a.spent || b.bookings - a.bookings);
    },
  });

  const rows = dataQ.data ?? [];
  const totalCustomers = rows.length;
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const repeat = rows.filter((r) => r.bookings > 1).length;
  const currency = (n: number) => "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <SectionHeader title="Customers" subtitle="Players who have booked your venues." />
      <div className="grid gap-3 sm:grid-cols-3">
        <PlayerKpi label="Total customers" value={String(totalCustomers)} />
        <PlayerKpi label="Repeat customers" value={String(repeat)} />
        <PlayerKpi label="Lifetime revenue" value={currency(totalSpent)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <select value={venueFilter} onChange={(e) => setVenueFilter(e.target.value === "all" ? "all" : Number(e.target.value))} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <option value="all">All venues</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="nice-scroll max-h-[65vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Bookings</th>
                <th className="px-4 py-3">Paid</th>
                <th className="px-4 py-3">Spent</th>
                <th className="px-4 py-3">Last booking</th>
              </tr>
            </thead>
            <tbody>
              {dataQ.isLoading ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={6}>No customers yet — once players book, they'll show up here.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium">{r.name || "Player"}<div className="text-[11px] text-muted-foreground">{r.id.slice(0, 8)}…</div></td>
                  <td className="px-4 py-3 text-muted-foreground">{r.phone || "—"}</td>
                  <td className="px-4 py-3">{r.bookings}</td>
                  <td className="px-4 py-3">{r.paidBookings}</td>
                  <td className="px-4 py-3 font-semibold">{currency(r.spent)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.lastAt ? new Date(r.lastAt).toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—"}</td>
                </tr>
              ))}
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

const SPORT_COLORS: Record<string, { bg: string; dot: string; text: string; border: string }> = {
  tennis:      { bg: "bg-emerald-100", dot: "bg-emerald-500", text: "text-emerald-900", border: "border-emerald-200" },
  basketball:  { bg: "bg-amber-100",   dot: "bg-amber-500",   text: "text-amber-900",   border: "border-amber-200" },
  badminton:   { bg: "bg-sky-100",     dot: "bg-sky-500",     text: "text-sky-900",     border: "border-sky-200" },
  volleyball:  { bg: "bg-violet-100",  dot: "bg-violet-500",  text: "text-violet-900",  border: "border-violet-200" },
  pickleball:  { bg: "bg-pink-100",    dot: "bg-pink-500",    text: "text-pink-900",    border: "border-pink-200" },
  football:    { bg: "bg-lime-100",    dot: "bg-lime-500",    text: "text-lime-900",    border: "border-lime-200" },
  squash:      { bg: "bg-rose-100",    dot: "bg-rose-500",    text: "text-rose-900",    border: "border-rose-200" },
  default:     { bg: "bg-slate-100",   dot: "bg-slate-500",   text: "text-slate-900",   border: "border-slate-200" },
};
function sportStyle(slug?: string | null) {
  if (!slug) return SPORT_COLORS.default;
  return SPORT_COLORS[slug.toLowerCase()] ?? SPORT_COLORS.default;
}

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
    queryKey: ["cal-courts", venueIds.slice().sort((a, b) => a - b).join(",")],
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
        id: number; name: string; venue_id: number; sport_id: number;
        sports: { name: string; slug: string | null } | null;
      }[];
    },
  });

  const bookingsQ = useQuery({
    queryKey: ["cal-bookings", venueIds.slice().sort((a, b) => a - b).join(","), dayStart.toISOString()],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, court_id, user_id, start_time, end_time, status, payment_status, courts!inner(name, venue_id, sport_id, venues(name), sports(name, slug))")
        .gte("start_time", dayStart.toISOString())
        .lt("start_time", dayEnd.toISOString())
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
      const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", uids);
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
        .map((c) => [c.sports!.slug ?? c.sports!.name.toLowerCase(), c.sports!])
    ).values()
  );

  const courtsShown = sportFilter === "all"
    ? allCourts
    : allCourts.filter((c) => (c.sports?.slug ?? c.sports?.name.toLowerCase()) === sportFilter);

  const bookings = (bookingsQ.data ?? []).filter((b) => {
    if (sportFilter === "all") return true;
    const slug = b.courts?.sports?.slug ?? b.courts?.sports?.name.toLowerCase();
    return slug === sportFilter;
  });

  const HOUR_START = 6;
  const HOUR_END = 22;
  const HOURS = HOUR_END - HOUR_START;
  const ROW_H = 60;
  const gridHeight = HOURS * ROW_H;

  const isToday = (() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return t.getTime() === day.getTime();
  })();

  const nudgeDay = (delta: number) => {
    const d = new Date(day);
    d.setDate(d.getDate() + delta);
    setDay(d);
  };

  const dayLabel = day.toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="space-y-5">
      <SectionHeader title="Calendar" subtitle="Day view across every court and sport." />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-full border border-border bg-card">
            <button className="bg-foreground px-4 py-1.5 text-xs font-semibold text-background">Day</button>
            <button disabled className="px-4 py-1.5 text-xs font-medium text-muted-foreground/60">Schedule</button>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => nudgeDay(-1)} className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-sm hover:bg-secondary" aria-label="Previous day">‹</button>
            <button
              onClick={() => { const t = new Date(); t.setHours(0,0,0,0); setDay(t); }}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold ${isToday ? "bg-primary text-primary-foreground" : "border border-border bg-card hover:bg-secondary"}`}
            >
              Today
            </button>
            <button onClick={() => nudgeDay(1)} className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-sm hover:bg-secondary" aria-label="Next day">›</button>
          </div>
        </div>

        <div className="text-sm font-semibold sm:text-base">{dayLabel}</div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={venueFilter}
            onChange={(e) => setVenueFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
          >
            <option value="all">All venues</option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
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
          <div className="p-6 text-sm text-muted-foreground">No courts to display. Add a court to see it here.</div>
        ) : (
          <div className="nice-scroll overflow-auto">
            <div className="min-w-max">
              <div className="sticky top-0 z-10 flex border-b border-border bg-card/95 backdrop-blur">
                <div className="w-16 shrink-0" />
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

              <div className="flex">
                <div className="w-16 shrink-0" style={{ height: gridHeight }}>
                  {Array.from({ length: HOURS }).map((_, i) => {
                    const h = HOUR_START + i;
                    const label = h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;
                    return (
                      <div key={h} style={{ height: ROW_H }} className="relative">
                        <div className="absolute -top-2 right-2 text-[10px] font-medium text-muted-foreground">{label}</div>
                      </div>
                    );
                  })}
                </div>

                {courtsShown.map((c) => {
                  const colBookings = bookings.filter((b) => b.court_id === c.id);
                  return (
                    <div key={c.id} className="relative w-40 shrink-0 border-l border-border" style={{ height: gridHeight }}>
                      {Array.from({ length: HOURS }).map((_, i) => (
                        <div key={i} style={{ top: i * ROW_H, height: ROW_H }} className="absolute inset-x-0 border-t border-border/60" />
                      ))}

                      {colBookings.map((b) => {
                        const s = new Date(b.start_time);
                        const e = new Date(b.end_time);
                        const startH = s.getHours() + s.getMinutes() / 60;
                        const endH = e.getHours() + e.getMinutes() / 60;
                        const top = Math.max(0, (startH - HOUR_START) * ROW_H);
                        const height = Math.max(24, (endH - startH) * ROW_H - 4);
                        const st = sportStyle(b.courts?.sports?.slug ?? b.courts?.sports?.name.toLowerCase());
                        const sportName = b.courts?.sports?.name ?? "Booking";
                        const player = nameMap.get(b.user_id) || "Player";
                        return (
                          <div
                            key={b.id}
                            style={{ top, height }}
                            className={`absolute inset-x-1 rounded-xl border ${st.bg} ${st.border} ${st.text} px-2.5 py-2 shadow-sm`}
                          >
                            <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                              <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                              {sportName}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] opacity-80">{player}</div>
                            <div className="mt-0.5 text-[10px] opacity-70">
                              {s.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} – {e.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {bookingsQ.isLoading && <div className="text-xs text-muted-foreground">Loading bookings…</div>}
    </div>
  );
}

// ================= Player Dashboard =================

type PlayerBooking = {
  id: number;
  court_id: number;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  created_at: string;
  courts: {
    name: string;
    hourly_rate: number;
    map_emoji: string | null;
    images: string[] | null;
    sports: { name: string } | null;
    venues: { id: number; name: string; address: string | null; is_active: boolean } | null;
  } | null;
};

function PlayerDashboard({ userId, fullName, email }: { userId: string; fullName: string; email: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"upcoming" | "past" | "cancelled">("upcoming");
  const [chat, setChat] = useState<{ bookingId: number; venueId: number; title: string; subtitle: string } | null>(null);


  const bookingsQ = useQuery({
    queryKey: ["player-bookings", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status, payment_status, created_at, courts(name, hourly_rate, map_emoji, images, sports(name), venues(id, name, address, is_active))")
        .eq("user_id", userId)
        .order("start_time", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data as unknown as PlayerBooking[]) ?? [];
    },
  });

  const txQ = useQuery({
    queryKey: ["player-transactions", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("id, booking_id, amount, status, method, paid_at, created_at, provider_ref")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(400);
      if (error) throw error;
      return (data ?? []) as { id: string; booking_id: number; amount: number; status: string; method: string | null; paid_at: string | null; created_at: string; provider_ref: string | null }[];
    },
  });

  const retryFn = useServerFn(retryBookingPayment);
  const cancelPendingFn = useServerFn(cancelPendingBookings);
  const [payFor, setPayFor] = useState<{ ids: number[]; amount: number; courtName: string } | null>(null);
  const [payMethod, setPayMethod] = useState<"gcash" | "paymaya" | "grab_pay" | "qrph">("gcash");
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  const cancelMut = useMutation({
    mutationFn: async (bookingId: number) => {
      const { error } = await supabase.from("bookings").update({ status: "cancelled" }).eq("id", bookingId).eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["player-bookings", userId] }),
  });

  const rows = bookingsQ.data ?? [];
  const txByBooking = new Map((txQ.data ?? []).map((t) => [t.booking_id, t]));
  const now = new Date();
  const nowIso = now.toISOString();

  const upcoming = rows.filter((r) => r.end_time >= nowIso && r.status !== "cancelled");
  const past = rows.filter((r) => r.end_time < nowIso && r.status !== "cancelled");
  const cancelled = rows.filter((r) => r.status === "cancelled");

  const totalSpent = (txQ.data ?? []).filter((t) => t.status === "paid").reduce((s, t) => s + Number(t.amount || 0), 0);
  const nextUp = upcoming.slice().sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
  const allSessions = groupBookingSessions(rows);
  const nextUpSession = nextUp ? allSessions.find((s) => s.ids.includes(nextUp.id)) : undefined;

  const shown = (tab === "upcoming"
    ? groupBookingSessions(upcoming).sort((a, b) => a.start_time.localeCompare(b.start_time))
    : groupBookingSessions(tab === "past" ? past : cancelled).sort((a, b) => b.start_time.localeCompare(a.start_time)));


  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  const hours = (a: string, b: string) => Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 3600000));
  const peso = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const payBadge = (s: string) => {
    const map: Record<string, string> = {
      paid: "bg-primary/15 text-primary",
      unpaid: "bg-amber-500/15 text-amber-700",
      refunded: "bg-muted text-muted-foreground",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}>{s}</span>;
  };
  const stBadge = (s: string) => {
    const map: Record<string, string> = {
      confirmed: "bg-primary/10 text-primary",
      pending: "bg-amber-500/15 text-amber-700",
      cancelled: "bg-destructive/10 text-destructive",
      completed: "bg-emerald-500/15 text-emerald-700",
    };
    const label = s === "pending" ? "Awaiting payment" : s;
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${map[s] ?? "bg-secondary"}`}>{label}</span>;
  };

  // Group unpaid pending bookings by their shared checkout session (provider_ref)
  // so "Pay now" retries the full slot batch together.
  const siblingsForRetry = (bookingId: number): number[] => {
    const tx = (txQ.data ?? []).find((t) => t.booking_id === bookingId);
    if (!tx?.provider_ref) return [bookingId];
    const sameSession = (txQ.data ?? [])
      .filter((t) => t.provider_ref === tx.provider_ref)
      .map((t) => t.booking_id);
    const eligible = rows
      .filter((r) => sameSession.includes(r.id) && r.payment_status !== "paid" && r.status !== "cancelled")
      .map((r) => r.id);
    return eligible.length > 0 ? eligible : [bookingId];
  };

  const openPay = (b: PlayerBooking) => {
    const ids = siblingsForRetry(b.id);
    const bookings = rows.filter((r) => ids.includes(r.id));
    const hrs = bookings.length;
    const rate = b.courts?.hourly_rate ?? 0;
    // Payment amount reflects the venue's payment_mode via retry fn; assume full here for display.
    const amount = rate * hrs;
    setPayFor({ ids, amount, courtName: `${b.courts?.venues?.name ?? ""} · ${b.courts?.name ?? ""}` });
    setPayErr(null);
  };

  const submitPay = async () => {
    if (!payFor) return;
    setPayBusy(true);
    setPayErr(null);
    try {
      const res = await retryFn({
        data: { bookingIds: payFor.ids, method: payMethod, origin: window.location.origin },
      });
      window.location.href = res.checkoutUrl;
    } catch (e) {
      setPayErr((e as Error).message);
      setPayBusy(false);
    }
  };

  const cancelPending = async (bookingId: number) => {
    if (!confirm("Cancel this unpaid booking? It will not be reserved.")) return;
    const ids = siblingsForRetry(bookingId);
    await cancelPendingFn({ data: { bookingIds: ids } });
    qc.invalidateQueries({ queryKey: ["player-bookings", userId] });
  };


  return (
    <main className="mx-auto min-h-[100dvh] max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Player workspace</p>
          <h1 className="mt-1 font-display text-2xl font-semibold sm:text-3xl">Hi, {fullName || email.split("@")[0]} 👋</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track your court bookings, upcoming games and payment history.</p>
        </div>
        <div className="flex items-center gap-2">
          <NotificationBell userId={userId} />
          <Link to="/" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">Find a court</Link>
        </div>

      </div>

      {/* KPI tiles */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <PlayerKpi label="Upcoming" value={String(upcoming.filter((r) => r.payment_status === "paid").length)} hint={nextUp ? `Next: ${fmtDate(nextUp.start_time)}` : "No upcoming"} />
        <PlayerKpi label="Awaiting payment" value={String(upcoming.filter((r) => r.payment_status !== "paid").length)} hint="Reserved only after payment" />
        <PlayerKpi label="Total spent" value={peso(totalSpent)} hint={`${(txQ.data ?? []).filter((t) => t.status === "paid").length} paid`} />
        <PlayerKpi label="Cancelled" value={String(cancelled.length)} hint="Lifetime" />
      </div>

      {/* Unpaid banner */}
      {upcoming.filter((r) => r.payment_status !== "paid").length > 0 && tab === "upcoming" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            You have unpaid booking{upcoming.filter((r) => r.payment_status !== "paid").length > 1 ? "s" : ""}. Slots are only reserved after payment.
          </p>
        </div>
      )}

      {/* Next up highlight */}
      {nextUp && tab === "upcoming" && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-primary/15 text-2xl">{nextUp.courts?.map_emoji ?? "🎾"}</div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Next game</p>
                <p className="mt-0.5 font-semibold">{nextUp.courts?.venues?.name ?? "Venue"} · {nextUp.courts?.name}</p>
                <p className="text-xs text-muted-foreground">{fmtDate(nextUp.start_time)} · {formatTimeRange(nextUpSession?.start_time ?? nextUp.start_time, nextUpSession?.end_time ?? nextUp.end_time)} · {nextUp.courts?.sports?.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {payBadge(nextUp.payment_status)}
              {stBadge(nextUp.status)}
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mt-6 flex gap-2 border-b border-border">
        {(["upcoming", "past", "cancelled"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold capitalize transition ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t} <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px]">{t === "upcoming" ? upcoming.length : t === "past" ? past.length : cancelled.length}</span>
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-4">
        {bookingsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading your bookings…</div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="font-semibold">Nothing here yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {tab === "upcoming" ? "Book a court to see it here." : tab === "past" ? "Your past games will show here." : "No cancelled bookings."}
            </p>
            {tab === "upcoming" && (
              <Link to="/" className="mt-3 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Browse courts</Link>
            )}
          </div>
        ) : (
          <ul className="grid gap-3">
            {shown.map((sess) => {
              const b = sess.first;
              const tx = txByBooking.get(b.id);
              const h = sess.hours;
              const txTotal = sess.ids.reduce((sum, id) => sum + Number(txByBooking.get(id)?.amount ?? 0), 0);
              const amount = txTotal > 0 ? txTotal : (b.courts?.hourly_rate ?? 0) * h;
              const venueInactive = b.courts?.venues?.is_active === false;
              const paymentFailed = b.payment_status !== "paid" && b.status !== "cancelled";

              return (
                <li key={sess.key} className="overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm">

                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-xl">{b.courts?.map_emoji ?? "🎾"}</div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{b.courts?.venues?.name ?? "Venue"} · <span className="text-muted-foreground">{b.courts?.name}</span></p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{b.courts?.sports?.name ?? "Sport"} · {h} hr{h > 1 ? "s" : ""}</p>
                        <p className="mt-1 text-sm">{fmtDate(sess.start_time)}</p>
                        <p className="text-xs text-muted-foreground">{formatTimeRange(sess.start_time, sess.end_time)}{sess.ids.length > 1 ? ` · ${sess.ids.length} slots` : ""}</p>

                        {b.courts?.venues?.address && <p className="mt-1 truncate text-[11px] text-muted-foreground">📍 {b.courts.venues.address}</p>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <p className="font-semibold text-primary">{peso(amount)}</p>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {venueInactive && (
                          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-destructive ring-1 ring-destructive/30">Venue inactive</span>
                        )}
                        {payBadge(b.payment_status)}
                        {stBadge(b.status)}
                      </div>
                      {tx?.method && <p className="text-[10px] uppercase tracking-wider text-muted-foreground">via {tx.method}</p>}
                    </div>
                  </div>
                  {venueInactive && paymentFailed && (
                    <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                      This venue is no longer active. Payment can't be completed — please choose another venue.
                    </div>
                  )}
                  {(() => {
                    const isUnpaidUpcoming = tab === "upcoming" && b.payment_status !== "paid" && b.status !== "cancelled" && new Date(b.start_time) > now;
                    const isPaidUpcoming = tab === "upcoming" && b.payment_status === "paid" && new Date(b.start_time) > now;
                    const vId = b.courts?.venues?.id;
                    return (
                      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                        {vId && (
                          <button
                            onClick={() => setChat({
                              bookingId: b.id,
                              venueId: vId,
                              title: b.courts?.venues?.name ?? "Venue",
                              subtitle: `${fmtDate(sess.start_time)} · ${formatSessionLabel(sess.start_time, sess.end_time)}`,
                            })}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                          >
                            Message venue
                          </button>
                        )}
                        {isUnpaidUpcoming && (
                          <>
                            <button
                              onClick={() => openPay(b)}
                              disabled={venueInactive}
                              title={venueInactive ? "Venue is inactive — payment disabled" : undefined}
                              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Pay now
                            </button>
                            <button
                              onClick={() => cancelPending(b.id)}
                              className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                            >
                              Cancel
                            </button>
                          </>

                        )}
                        {isPaidUpcoming && (
                          <button
                            onClick={() => { if (confirm("Cancel this booking?")) cancelMut.mutate(b.id); }}
                            disabled={cancelMut.isPending}
                            className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          >
                            Cancel booking
                          </button>
                        )}
                      </div>
                    );
                  })()}

                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Sign out row */}
      <div className="mt-10 flex justify-center">
        <button
          onClick={async () => { await supabase.auth.signOut(); window.location.href = "/"; }}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-muted-foreground hover:border-destructive hover:text-destructive"
        >
          Sign out
        </button>
      </div>

      {chat && (
        <BookingChat
          bookingId={chat.bookingId}
          venueId={chat.venueId}
          playerId={userId}
          meId={userId}
          title={chat.title}
          subtitle={chat.subtitle}
          onClose={() => setChat(null)}
        />
      )}


      {/* Pay now modal */}
      {payFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-semibold">Complete payment</h3>
                <p className="mt-1 text-xs text-muted-foreground">{payFor.courtName}</p>
              </div>
              <button onClick={() => setPayFor(null)} className="rounded-lg p-1 hover:bg-muted" disabled={payBusy}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-secondary/60 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{payFor.ids.length} hour{payFor.ids.length > 1 ? "s" : ""}</span>
                <span className="font-semibold">{peso(payFor.amount)}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Final amount depends on venue payment mode (full or 50% down).</p>
            </div>
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Payment method</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {([
                  { v: "gcash", l: "GCash" },
                  { v: "paymaya", l: "Maya" },
                  { v: "grab_pay", l: "GrabPay" },
                  { v: "qrph", l: "QR Ph" },
                ] as const).map((m) => (
                  <button
                    key={m.v}
                    onClick={() => setPayMethod(m.v)}
                    disabled={payBusy}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${payMethod === m.v ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/50"}`}
                  >
                    {m.l}
                  </button>
                ))}
              </div>
            </div>
            {payErr && <p className="mt-3 text-xs font-medium text-destructive">{payErr}</p>}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setPayFor(null)}
                disabled={payBusy}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50"
              >
                Not now
              </button>
              <button
                onClick={submitPay}
                disabled={payBusy}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {payBusy ? "Redirecting…" : "Continue to pay"}
              </button>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              Your slot is only reserved after payment is successful. If cancelled, the booking is removed.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function PlayerKpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold">{value}</p>
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
      const { data, error } = await supabase.from("vouchers")
        .select("id, code, discount_type, discount_value, expires_at, max_uses, one_per_user, min_booking_amount, is_active, notes, created_at")
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
      const { data, error } = await supabase.from("voucher_redemptions")
        .select("voucher_id").in("voucher_id", ids);
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of data ?? []) map[r.voucher_id as string] = (map[r.voucher_id as string] ?? 0) + 1;
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
      setCode(""); setDiscountValue("10"); setExpiresAt(""); setMaxUses(""); setMinAmount(""); setNotes(""); setErr(null);
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
        <p className="text-sm text-muted-foreground">Create discount codes players can redeem when booking a court that accepts vouchers.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Venue:</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          value={venueId ?? ""}
          onChange={(e) => setVenueId(e.target.value ? Number(e.target.value) : null)}
        >
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
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
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. SUMMER10" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm uppercase" />
                <button type="button" onClick={genCode} className="rounded-md border px-2 text-xs hover:bg-secondary">Auto</button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Discount type</label>
              <select value={discountType} onChange={(e) => setDiscountType(e.target.value as "percent" | "amount")} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                <option value="percent">Percentage (%)</option>
                <option value="amount">Fixed amount (₱)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                {discountType === "percent" ? "Percentage off" : "Amount off (₱)"}
              </label>
              <input type="number" min="1" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Expires at (optional)</label>
              <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Max total uses (optional)</label>
              <input type="number" min="1" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Minimum booking amount (₱, optional)</label>
              <input type="number" min="0" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onePerUser} onChange={(e) => setOnePerUser(e.target.checked)} />
              One redemption per player
            </label>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="mb-1 block text-xs font-medium">Notes (optional, internal)</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
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
            Players can only redeem a voucher on courts where you've ticked <b>Accept vouchers</b> (in Add/Edit court).
          </p>
        </div>
      )}

      <div className="rounded-2xl border bg-card">
        <div className="border-b px-4 py-2 text-sm font-semibold">Vouchers ({vq.data?.length ?? 0})</div>
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
                      {v.discount_type === "percent" ? `${v.discount_value}%` : `₱${Number(v.discount_value).toFixed(2)}`}
                    </td>
                    <td className="p-3">
                      {used}{v.max_uses ? ` / ${v.max_uses}` : ""}
                      {v.one_per_user && <span className="ml-1 text-[10px] text-muted-foreground">(1/player)</span>}
                    </td>
                    <td className="p-3">{v.expires_at ? new Date(v.expires_at as string).toLocaleString() : "—"}</td>
                    <td className="p-3">{v.min_booking_amount ? `₱${Number(v.min_booking_amount).toFixed(2)}` : "—"}</td>
                    <td className="p-3">
                      <button
                        onClick={() => toggleActive.mutate({ id: v.id as string, is_active: !v.is_active })}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${v.is_active ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
                      >
                        {v.is_active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => { if (window.confirm(`Delete voucher ${v.code}? Existing redemptions will be removed.`)) del.mutate(v.id as string); }}
                        className="rounded-md border px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {(vq.data ?? []).length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No vouchers yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
