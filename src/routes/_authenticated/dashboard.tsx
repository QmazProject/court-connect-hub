import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { retryBookingPayment, cancelPendingBookings } from "@/lib/paymongo.functions";
import { MapPicker } from "@/components/MapPicker";
import { ImageUploader } from "@/components/ImageUploader";
import { EmojiPicker } from "@/components/EmojiPicker";
import { MapInfoButton } from "@/components/MapInfoButton";
import chLogo from "@/assets/CHicon.png.asset.json";
import {
  LayoutDashboard, CalendarDays, BookOpen, LandPlot, Users, UserCog,
  Receipt, Settings as SettingsIcon, Menu, X, Layers, MapPin, Pencil, Trash2, AlertTriangle,
} from "lucide-react";

type SectionKey =
  | "dashboard" | "calendar" | "bookings" | "courts"
  | "customers" | "team" | "transactions" | "settings";

const NAV: { key: SectionKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
  { key: "bookings", label: "Bookings", icon: BookOpen },
  { key: "courts", label: "Venues & Courts", icon: LandPlot },
  { key: "customers", label: "Customers", icon: Users },
  { key: "team", label: "Team", icon: UserCog },
  { key: "transactions", label: "Transactions", icon: Receipt },
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

type Venue = { id: number; name: string; address: string; timezone: string; latitude: number | null; longitude: number | null; description: string | null; images: string[] | null; map_emoji: string | null };
type Sport = { id: number; name: string; slug?: string };
type Court = {
  id: number; name: string; hourly_rate: number; is_indoor: boolean;
  sport_id: number; venue_id: number;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  blocked_hours: Record<string, number[]> | null;
  blocked_dates: Record<string, number[]> | null;
  coming_soon: boolean | null;
  map_emoji: string | null;
  physical_court_id: number;
  capacity: number;
  sports: { name: string; slug?: string } | null;
};
type PhysicalCourt = { id: number; venue_id: number; name: string; map_emoji: string | null; description: string | null };

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
      const { data, error } = await supabase.from("venues").select("*").in("id", ids);
      if (error) throw error;
      return data as Venue[];
    },
  });

  if (profileQ.isLoading) {
    return (
      <TenantShell section={section} setSection={setSection} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} collapsed={collapsed} setCollapsed={setCollapsed}>
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
    <TenantShell section={section} setSection={setSection} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} collapsed={collapsed} setCollapsed={setCollapsed}>
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
            onCreated={() => { qc.invalidateQueries({ queryKey: ["my-venues"] }); qc.invalidateQueries({ queryKey: ["venues-courts-glance"] }); setAddCourtOpen(false); }}
          />
          <CreateGroupDrawer
            open={createGroupOpen}
            onClose={() => setCreateGroupOpen(false)}
            venues={venues}
            onCreated={() => { qc.invalidateQueries({ queryKey: ["physical-courts-full"] }); qc.invalidateQueries({ queryKey: ["physical-courts"] }); setCreateGroupOpen(false); }}
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
          <BookingsSection venues={venues} />
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
  children, section, setSection, mobileOpen, setMobileOpen, collapsed, setCollapsed,
}: {
  children: React.ReactNode;
  section: SectionKey;
  setSection: (s: SectionKey) => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
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
          <span className="w-16" />
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
        .select("id, name, capacity, hourly_rate, physical_court_id, sports(name)")
        .eq("venue_id", venueId).order("id");
      if (error) throw error;
      return data as unknown as Array<{ id: number; name: string; capacity: number; hourly_rate: number; physical_court_id: number; sports: { name: string } | null }>;
    },
  });

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [caps, setCaps] = useState<Record<number, string>>({});
  const toggle = (id: number, cur: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else { next.add(id); setCaps((c) => ({ ...c, [id]: c[id] ?? String(cur ?? 1) })); }
      return next;
    });
  };

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
        for (const id of ids) {
          const cap = Math.max(1, Math.floor(Number(caps[id] ?? "1") || 1));
          const footprint = 1 / cap;
          const { error: upErr } = await supabase.from("courts")
            .update({ physical_court_id: pc.id, capacity: cap, footprint }).eq("id", id);
          if (upErr) throw upErr;
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
          A group represents one <b>physical slab</b> that can be configured for different sports (e.g. 1 basketball ↔ 3 badminton ↔ 4 pickleball). Bookings across grouped courts automatically block each other.
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

      <Textarea label="Description (optional)" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, house rules…" />

      <div className="rounded-xl border border-dashed border-border p-3">
        <div className="text-sm font-semibold">Assign existing courts to this group</div>
        <p className="mt-1 text-xs text-muted-foreground">Tick every court that lives on this same physical slab. Set the max simultaneous matches per hour (capacity) for each.</p>
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
                    <input type="checkbox" checked={checked} onChange={() => toggle(c.id, c.capacity ?? 1)} />
                    <div className="flex-1">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">{c.sports?.name ?? "—"} · ₱{Number(c.hourly_rate).toFixed(0)}/hr</div>
                    </div>
                    {checked && (
                      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        Cap
                        <input type="number" min={1} value={caps[c.id] ?? String(c.capacity ?? 1)}
                          onChange={(e) => setCaps((s) => ({ ...s, [c.id]: e.target.value }))}
                          className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm" />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tzConfirmed, setTzConfirmed] = useState(false);

  const suggested = suggestTimezone(lat, lng);
  const pinInPH = isInPhilippines(lat, lng);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);
  const pinOutsidePH = lat != null && lng != null && !pinInPH;

  const mut = useMutation({
    mutationFn: async () => {
      if (lat == null || lng == null) throw new Error("Please pin your venue on the map before creating.");
      if (!pinInPH) throw new Error("CourtHub currently supports venues in the Philippines only. Please pin a location within the Philippines.");
      if (tzMismatch && !tzConfirmed) throw new Error(`Timezone doesn't match your pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`);
      const { error } = await supabase.from("venues").insert({ name, address, timezone, latitude: lat, longitude: lng, map_emoji: mapEmoji });
      if (error) throw error;
    },
    onSuccess: () => { setName(""); setAddress(""); setLat(null); setLng(null); setMapEmoji(null); setErr(null); setTzConfirmed(false); onCreated(); },
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
              <iframe title="Selected location" src={osmEmbedUrl(lat, lng)} className="pointer-events-none h-28 w-full" loading="lazy" />
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
            <CourtCard key={c.id} court={c} venueEmoji={venue.map_emoji} onChanged={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
          ))}
          <AddCourt venueId={venue.id} venueEmoji={venue.map_emoji} onCreated={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
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

function AvailabilityEditor({ court, onDone, onCancel }: { court: Court; onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"weekly" | "date">("weekly");
  const [err, setErr] = useState<string | null>(null);

  // --- Weekly state
  const initialWeekly: Record<string, Set<number>> = {};
  for (const d of DAYS) initialWeekly[d.key] = new Set(court.blocked_hours?.[d.key] ?? []);
  const [weekly, setWeekly] = useState(initialWeekly);
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

  // --- Per-date state
  const localISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shiftDate = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return localISO(d); };
  const [selectedDate, setSelectedDate] = useState<string>(localISO(new Date()));
  const [dateBlocks, setDateBlocks] = useState<Record<string, Set<number>>>(() => {
    const map: Record<string, Set<number>> = {};
    for (const [date, hrs] of Object.entries(court.blocked_dates ?? {})) map[date] = new Set(hrs);
    return map;
  });
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

  const mut = useMutation({
    mutationFn: async () => {
      const weeklyPayload: Record<string, number[]> = {};
      for (const d of DAYS) weeklyPayload[d.key] = Array.from(weekly[d.key]).sort((a, b) => a - b);
      const datesPayload: Record<string, number[]> = {};
      for (const [date, set] of Object.entries(dateBlocks)) datesPayload[date] = Array.from(set).sort((a, b) => a - b);
      const { error } = await supabase.from("courts").update({ blocked_hours: weeklyPayload, blocked_dates: datesPayload }).eq("id", court.id);
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
          <p className="text-xs text-muted-foreground">Weekly rules repeat every week. Specific-date overrides apply to that date only and do NOT inherit weekly blocks.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="mt-3 inline-flex rounded-lg border border-border bg-background p-0.5 text-xs">
        <button type="button" onClick={() => setMode("weekly")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "weekly" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Weekly pattern</button>
        <button type="button" onClick={() => setMode("date")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "date" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Specific date</button>
      </div>

      {mode === "weekly" ? (
        <div className="mt-4 space-y-3">
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
                  const isBlocked = weekly[d.key].has(h);
                  return (
                    <button key={h} type="button" onClick={() => toggleWeekly(d.key, h)}
                      className={"rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " + (isBlocked ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30" : "bg-primary/10 text-foreground hover:bg-primary/20")}>
                      {fmtHour(h)} – {fmtHour((h + 1) % 24)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-border bg-background p-3">
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

          <p className="mt-2 text-[11px] text-muted-foreground">Tapping any hour creates a fresh override for this date starting empty — weekly blocked hours do NOT carry over.</p>

          <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 24 }, (_, h) => h).map((h) => {
              const isBlocked = currentDateSet.has(h);
              return (
                <button key={h} type="button" onClick={() => toggleDate(h)}
                  className={"rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap transition " + (isBlocked ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30" : "bg-primary/10 text-foreground hover:bg-primary/20")}>
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

      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
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
  const [description, setDescription] = useState("");
  const [amenities, setAmenities] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [mapEmoji, setMapEmoji] = useState<string | null>(null);
  const [physicalCourtId, setPhysicalCourtId] = useState<string>("new");
  const [capacity, setCapacity] = useState("1");
  const [err, setErr] = useState<string | null>(null);

  const sportsQ = useSportsQuery(open || !!alwaysOpen);
  const pcQ = useQuery({
    queryKey: ["physical-courts", venueId],
    enabled: open || !!alwaysOpen,
    queryFn: async () => {
      const { data, error } = await supabase.from("physical_courts").select("id, name, map_emoji").eq("venue_id", venueId).order("id");
      if (error) throw error;
      return data as { id: number; name: string; map_emoji: string | null }[];
    },
  });

  const selectedSport = sportsQ.data?.find((s) => String(s.id) === sportId);
  const fallbackEmoji = venueEmoji || sportEmoji(selectedSport?.slug) || "🎾";

  const mut = useMutation({
    mutationFn: async () => {
      let pcId: number;
      if (physicalCourtId === "new") {
        const { data, error } = await supabase.from("physical_courts").insert({
          venue_id: venueId, name, map_emoji: mapEmoji ?? venueEmoji ?? null,
        }).select("id").single();
        if (error) throw error;
        pcId = data.id;
      } else {
        pcId = Number(physicalCourtId);
      }
      const cap = Math.max(1, Math.floor(Number(capacity) || 1));
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
        description: description || null,
        amenities: parseList(amenities),
        images,
        map_emoji: mapEmoji,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      setOpen(false); setName(""); setRate("25"); setSportId(""); setComingSoon(false); setDescription(""); setAmenities(""); setImages([]); setMapEmoji(null); setPhysicalCourtId("new"); setCapacity("1"); setErr(null);
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
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Tick "Coming soon" if this court isn't open yet — players will see a badge and won't be able to book until you untick it.
      </p>
      <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-primary">Physical surface</div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Multiple courts can share one physical slab (e.g. 1 basketball ↔ 3 badminton ↔ 4 pickleball). Bookings across the same surface are auto-conflict-checked.
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Shared surface</span>
            <select value={physicalCourtId} onChange={(e) => setPhysicalCourtId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <option value="new">➕ New standalone surface</option>
              {(pcQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.map_emoji ?? "🎾"} {p.name}</option>)}
            </select>
          </label>
          <Input label="Slots per hour (capacity)" value={capacity} onChange={setCapacity} type="number" />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Capacity = how many simultaneous matches of this sport fit. Basketball = 1, Badminton = 3, Pickleball = 4.
        </p>
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="Description" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, rules, etc." />
        <Textarea label="Amenities (comma or new line separated)" value={amenities} onChange={setAmenities} placeholder="Showers, Parking, Locker room, Water dispenser" />
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
  const [isIndoor, setIsIndoor] = useState(court.is_indoor);
  const [comingSoon, setComingSoon] = useState(!!court.coming_soon);
  const [description, setDescription] = useState(court.description ?? "");
  const [amenities, setAmenities] = useState((court.amenities ?? []).join(", "));
  const [images, setImages] = useState<string[]>(court.images ?? []);
  const [mapEmoji, setMapEmoji] = useState<string | null>(court.map_emoji ?? null);
  const [physicalCourtId, setPhysicalCourtId] = useState<string>(String(court.physical_court_id));
  const [capacity, setCapacity] = useState(String(court.capacity ?? 1));
  const [err, setErr] = useState<string | null>(null);

  const fallbackEmoji = venueEmoji || sportEmoji(court.sports?.slug) || "🎾";

  const pcQ = useQuery({
    queryKey: ["physical-courts", court.venue_id],
    queryFn: async () => {
      const { data, error } = await supabase.from("physical_courts").select("id, name, map_emoji").eq("venue_id", court.venue_id).order("id");
      if (error) throw error;
      return data as { id: number; name: string; map_emoji: string | null }[];
    },
  });

  const mut = useMutation({
    mutationFn: async () => {
      const cap = Math.max(1, Math.floor(Number(capacity) || 1));
      const footprint = 1 / cap;
      const { error } = await supabase.from("courts").update({
        name,
        hourly_rate: Number(rate),
        is_indoor: isIndoor,
        coming_soon: comingSoon,
        description: description || null,
        amenities: parseList(amenities),
        images,
        map_emoji: mapEmoji,
        physical_court_id: Number(physicalCourtId),
        capacity: cap,
        footprint,
      }).eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={isIndoor} onChange={(e) => setIsIndoor(e.target.checked)} />
          Indoor court
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={comingSoon} onChange={(e) => setComingSoon(e.target.checked)} />
          Coming soon
        </label>
      </div>
      <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-primary">Physical surface</div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Shared surface</span>
            <select value={physicalCourtId} onChange={(e) => setPhysicalCourtId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              {(pcQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.map_emoji ?? "🎾"} {p.name}</option>)}
            </select>
          </label>
          <Input label="Slots per hour (capacity)" value={capacity} onChange={setCapacity} type="number" />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Group with other courts that share the same slab so bookings correctly conflict.
        </p>
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="Description" value={description} onChange={setDescription} />
        <Textarea label="Amenities (comma or new line separated)" value={amenities} onChange={setAmenities} />
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

  const suggested = suggestTimezone(venue.latitude, venue.longitude);
  const tzMismatch = !!(suggested && suggested.tz !== timezone);

  const save = useMutation({
    mutationFn: async () => {
      if (tzMismatch && !tzConfirmed) throw new Error(`Timezone doesn't match this venue's pin (${suggested?.country}). Confirm the override or switch to ${suggested?.tz}.`);
      const { error } = await supabase
        .from("venues")
        .update({ name, address, description: description || null, images, timezone, map_emoji: mapEmoji })
        .eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => { setEditing(false); setErr(null); setTzConfirmed(false); qc.invalidateQueries({ queryKey: ["my-venues"] }); onDoneEditing?.(); },
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-venues"] }); },
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
            <span className="text-xs font-medium text-muted-foreground">Description</span>
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
          <div className="sm:col-span-2 rounded-xl border border-border bg-background p-3">
            <EmojiPicker
              label="Map emoji (venue pin)"
              value={mapEmoji}
              fallback="🎾"
              onChange={setMapEmoji}
              hint="Shown on the landing-page map. Individual courts can override this."
            />
          </div>
        </div>
        {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || (tzMismatch && !tzConfirmed)} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          <button onClick={() => { setEditing(false); setName(venue.name); setAddress(venue.address); setDescription(venue.description ?? ""); setImages(venue.images ?? []); setTimezone(venue.timezone || "Asia/Manila"); setMapEmoji(venue.map_emoji ?? null); setTzConfirmed(false); setErr(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
        </div>
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
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex border-b border-border bg-secondary/30">
        <TabBtn active={tab === "venues"} onClick={() => setTab("venues")}>
          Venues <span className="ml-1 rounded-full bg-background px-1.5 py-0.5 text-[10px] font-semibold">{venues.length}</span>
        </TabBtn>
        <TabBtn active={tab === "courts"} onClick={() => setTab("courts")}>Courts</TabBtn>
        <TabBtn active={tab === "groups"} onClick={() => setTab("groups")}>
          Court Groups
          <span className="group relative ml-1 inline-flex">
            <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none opacity-70">?</span>
            <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-left text-xs font-normal normal-case text-popover-foreground shadow-lg group-hover:block">
              <span className="block font-semibold text-primary">What is a Court Group / Physical Surface?</span>
              <span className="mt-1 block text-muted-foreground">One physical slab can host different sports at different capacities — e.g. <b>1 basketball</b> ↔ <b>3 badminton</b> ↔ <b>4 pickleball</b>. Group those courts here so a booking on one automatically blocks the conflicting slots on the others.</span>
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
        (active ? "text-primary" : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
    </button>
  );
}

function VenuesTab({ venues }: { venues: Venue[] }) {
  const [editing, setEditing] = useState<Venue | null>(null);
  const [viewing, setViewing] = useState<Venue | null>(null);
  return (
    <>
      <table className="w-full min-w-[900px] text-sm">
        <thead className="sticky top-0 z-10 bg-secondary/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
          <tr>
            <th className="px-4 py-2.5 w-10"></th>
            <th className="px-3 py-2.5">Venue</th>
            <th className="px-3 py-2.5">Location</th>
            <th className="px-3 py-2.5">Description</th>
            <th className="px-3 py-2.5 w-20 text-center">Map</th>
            <th className="px-3 py-2.5 w-40 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {venues.map((v) => (
            <tr key={v.id} className="border-t border-border align-top hover:bg-secondary/20">
              <td className="px-4 py-3 text-xl leading-none">{v.map_emoji ?? "🎾"}</td>
              <td className="px-3 py-3">
                <div className="font-semibold">{v.name}</div>
                <div className="text-[11px] text-muted-foreground">{v.timezone}</div>
              </td>
              <td className="px-3 py-3 text-muted-foreground min-w-[180px]">{v.address}</td>
              <td className="px-3 py-3 text-muted-foreground max-w-[260px]">
                {v.description ? <span className="line-clamp-2">{v.description}</span> : <span className="italic opacity-60">No description</span>}
              </td>
              <td className="px-3 py-3 text-center">
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
              <td className="px-3 py-3">
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditing(v)}
                    title="Edit venue"
                    aria-label={`Edit ${v.name}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition hover:border-primary hover:bg-primary/10 hover:text-primary"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <DeleteVenueButton venue={v} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <EditVenueDrawer venue={editing} onClose={() => setEditing(null)} />
      <MapViewModal venue={viewing} onClose={() => setViewing(null)} />
    </>
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
    onSuccess: () => { setConfirming(false); setErr(null); qc.invalidateQueries({ queryKey: ["my-venues"] }); },
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
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-destructive/40 text-destructive transition hover:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4" />
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

function CourtsTab({ venues }: { venues: Venue[] }) {
  const qc = useQueryClient();
  const venueIds = venues.map((v) => v.id);
  const courtsQ = useQuery({
    queryKey: ["all-tenant-courts", venueIds.join(",")],
    enabled: venueIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts").select("*, sports(name)").in("venue_id", venueIds).order("venue_id").order("id");
      if (error) throw error;
      const byId = new Map(venues.map((v) => [v.id, v]));
      return (data as unknown as Court[]).map((c) => ({ ...c, venue: byId.get(c.venue_id)! })) as CourtRow[];
    },
  });

  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [editing, setEditing] = useState<CourtRow | null>(null);
  const [managingHours, setManagingHours] = useState<CourtRow | null>(null);

  const rows = (courtsQ.data ?? []).filter((c) => venueFilter === "all" || c.venue_id === venueFilter);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["all-tenant-courts"] });
    qc.invalidateQueries({ queryKey: ["venues-courts-glance"] });
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
        <span className="ml-auto text-xs text-muted-foreground">{rows.length} court{rows.length === 1 ? "" : "s"}</span>
      </div>
      {courtsQ.isLoading ? (
        <div className="p-6"><div className="h-24 animate-pulse rounded-lg bg-muted" /></div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No courts yet. Use <strong>Add court</strong> to create one.</div>
      ) : (
        <table className="w-full min-w-[900px] text-sm">
          <thead className="sticky top-[41px] z-10 bg-secondary/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
            <tr>
              <th className="px-4 py-2.5 w-10"></th>
              <th className="px-3 py-2.5">Court</th>
              <th className="px-3 py-2.5">Venue</th>
              <th className="px-3 py-2.5">Sport</th>
              <th className="px-3 py-2.5">Type</th>
              <th className="px-3 py-2.5 text-right">Rate / hr</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-border align-middle hover:bg-secondary/20">
                <td className="px-4 py-3 text-xl leading-none">{c.map_emoji ?? c.venue.map_emoji ?? "🎾"}</td>
                <td className="px-3 py-3">
                  <div className="font-semibold">{c.name}</div>
                  {c.description && <div className="text-[11px] text-muted-foreground line-clamp-1 max-w-[240px]">{c.description}</div>}
                </td>
                <td className="px-3 py-3">
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    <span>{c.venue.map_emoji ?? "🏟️"}</span>{c.venue.name}
                  </span>
                </td>
                <td className="px-3 py-3 text-muted-foreground">{c.sports?.name ?? "—"}</td>
                <td className="px-3 py-3 text-muted-foreground">{c.is_indoor ? "Indoor" : "Outdoor"}</td>
                <td className="px-3 py-3 text-right font-semibold text-primary tabular-nums">₱{Number(c.hourly_rate).toFixed(0)}</td>
                <td className="px-3 py-3">
                  {c.coming_soon ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 ring-1 ring-amber-500/30">Coming soon</span>
                  ) : (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 ring-1 ring-emerald-500/30">Live</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <button onClick={() => setManagingHours(c)} className="mr-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/20">Hours</button>
                  <button onClick={() => setEditing(c)} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:border-primary hover:text-primary">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        .select("id, name, capacity, physical_court_id, sports(name)")
        .in("physical_court_id", pcIds);
      if (cErr) throw cErr;
      const byPc = new Map<number, GroupRow["layouts"]>();
      (cs ?? []).forEach((c: any) => {
        const arr = byPc.get(c.physical_court_id) ?? [];
        arr.push({ id: c.id, name: c.name, capacity: c.capacity, sport: c.sports?.name ?? null });
        byPc.set(c.physical_court_id, arr);
      });
      return (pcs ?? []).map((p: any) => ({ ...p, layouts: byPc.get(p.id) ?? [] }))
        .filter((g) => g.layouts.length !== 1) as GroupRow[];
    },
  });

  const groups = groupsQ.data ?? [];

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
          Use <b className="text-foreground">+ Create group</b> to bundle courts that share the same physical slab.
        </p>
      </div>
      <div className="flex-1 overflow-auto nice-scroll px-4 pb-6 sm:px-6">
        {groupsQ.isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No shared-surface groups yet for this venue. Click <b className="text-foreground">+ Create group</b> above to bundle courts onto one physical slab.
          </div>
        ) : (
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Group</th>
                <th className="px-3 py-2 font-semibold">Description</th>
                <th className="px-3 py-2 font-semibold">Court layouts</th>
                <th className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className="border-t border-border align-top">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="text-lg">{g.map_emoji ?? "🏟️"}</span>
                      <span>{g.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{g.description || "—"}</td>
                  <td className="px-3 py-3">
                    {g.layouts.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No courts assigned yet — edit a court and set its physical surface to this group.</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {g.layouts.map((l) => (
                          <span key={l.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-xs">
                            <b>{l.sport ?? "—"}</b> · {l.name} · cap {l.capacity}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <EditGroupDrawer group={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type GroupRow = { id: number; venue_id: number; name: string; map_emoji: string | null; description: string | null; layouts: Array<{ id: number; name: string; capacity: number; sport: string | null }> };

function DeleteGroupButton({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const courtIds = group.layouts.map((l) => l.id);
      if (courtIds.length > 0) {
        const { count, error } = await supabase.from("bookings")
          .select("id", { count: "exact", head: true }).in("court_id", courtIds);
        if (error) throw error;
        if ((count ?? 0) > 0) throw new Error("This group has existing bookings and cannot be deleted.");
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
                  <b className="text-foreground">{group.name}</b> will be <b className="text-destructive">permanently deleted</b>. Its courts remain but each becomes an independent slab again.
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
  const [caps, setCaps] = useState<Record<number, string>>(() =>
    Object.fromEntries(group.layouts.map((l) => [l.id, String(l.capacity ?? 1)])),
  );
  const [addSel, setAddSel] = useState<Set<number>>(new Set());
  const [addCaps, setAddCaps] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);

  // Courts in same venue that could be added to this group (currently on other slabs)
  const eligibleQ = useQuery({
    queryKey: ["group-add-eligible", group.venue_id, group.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("courts")
        .select("id, name, capacity, physical_court_id, sports(name)")
        .eq("venue_id", group.venue_id).order("id");
      if (error) throw error;
      return (data ?? []).filter((c: any) => c.physical_court_id !== group.id) as Array<{ id: number; name: string; capacity: number; physical_court_id: number; sports: { name: string } | null }>;
    },
  });

  const toggleAdd = (id: number, cur: number) => {
    setAddSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else { next.add(id); setAddCaps((c) => ({ ...c, [id]: c[id] ?? String(cur ?? 1) })); }
      return next;
    });
  };

  const removeMember = async (courtId: number) => {
    setErr(null);
    // Only allow removing if no bookings on that court
    const { count, error: cErr } = await supabase.from("bookings")
      .select("id", { count: "exact", head: true }).eq("court_id", courtId);
    if (cErr) { setErr(cErr.message); return; }
    if ((count ?? 0) > 0) { setErr("This court has bookings and cannot be detached from the group."); return; }
    const { data: pc, error: pcErr } = await supabase.from("physical_courts")
      .insert({ venue_id: group.venue_id, name: `Slab ${Date.now()}` }).select("id").single();
    if (pcErr) { setErr(pcErr.message); return; }
    const { error: upErr } = await supabase.from("courts")
      .update({ physical_court_id: pc.id, capacity: 1, footprint: 1 }).eq("id", courtId);
    if (upErr) { setErr(upErr.message); return; }
    qc.invalidateQueries({ queryKey: ["physical-courts-full"] });
    qc.invalidateQueries({ queryKey: ["group-add-eligible", group.venue_id, group.id] });
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Group name is required");
      // Update group fields
      const { error } = await supabase.from("physical_courts")
        .update({ name: name.trim(), map_emoji: emoji, description: description.trim() || null })
        .eq("id", group.id);
      if (error) throw error;
      // Update capacities of existing members
      for (const l of group.layouts) {
        const cap = Math.max(1, Math.floor(Number(caps[l.id] ?? "1") || 1));
        if (cap !== l.capacity) {
          const footprint = 1 / cap;
          const { error: upErr } = await supabase.from("courts")
            .update({ capacity: cap, footprint }).eq("id", l.id);
          if (upErr) throw upErr;
        }
      }
      // Attach newly selected courts
      for (const id of Array.from(addSel)) {
        const cap = Math.max(1, Math.floor(Number(addCaps[id] ?? "1") || 1));
        const footprint = 1 / cap;
        const { error: upErr } = await supabase.from("courts")
          .update({ physical_court_id: group.id, capacity: cap, footprint }).eq("id", id);
        if (upErr) throw upErr;
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
            Editing the <b className="text-foreground">whole group</b> — group name, emoji, description, and which courts belong to this physical slab.
          </div>

          <Input label="Group name" value={name} onChange={setName} required />
          <div className="rounded-xl border border-border bg-background p-3">
            <EmojiPicker label="Group emoji" value={emoji} fallback="🏟️" onChange={setEmoji} hint="Shown on the map and in the courts table." />
          </div>
          <Textarea label="Description (optional)" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, house rules…" />

          <div className="rounded-xl border border-border p-3">
            <div className="text-sm font-semibold">Courts in this group</div>
            <p className="mt-1 text-xs text-muted-foreground">Adjust capacity (max simultaneous matches per hour) or detach a court from the group.</p>
            <div className="mt-3 grid gap-2">
              {group.layouts.length === 0 && <p className="text-xs text-muted-foreground">No courts assigned yet. Attach some below.</p>}
              {group.layouts.map((l) => (
                <div key={l.id} className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-2 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">{l.name}</div>
                    <div className="text-[11px] text-muted-foreground">{l.sport ?? "—"}</div>
                  </div>
                  <label className="text-[11px] text-muted-foreground">
                    Capacity
                    <input type="number" min={1} value={caps[l.id] ?? String(l.capacity)}
                      onChange={(e) => setCaps((c) => ({ ...c, [l.id]: e.target.value }))}
                      className="ml-1 w-16 rounded-md border border-input bg-background px-2 py-1 text-xs" />
                  </label>
                  <button type="button" onClick={() => removeMember(l.id)}
                    className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:border-destructive hover:text-destructive">
                    Detach
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-border p-3">
            <div className="text-sm font-semibold">Add courts to this group</div>
            <p className="mt-1 text-xs text-muted-foreground">Tick courts from this venue to attach onto this physical slab.</p>
            <div className="mt-3 grid gap-2">
              {eligible.length === 0 && <p className="text-xs text-muted-foreground">No other courts in this venue.</p>}
              {eligible.map((c) => {
                const checked = addSel.has(c.id);
                return (
                  <label key={c.id} className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-sm ${checked ? "border-primary bg-primary/5" : "border-border"}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleAdd(c.id, c.capacity)} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">{c.sports?.name ?? "—"}</div>
                    </div>
                    {checked && (
                      <label className="text-[11px] text-muted-foreground">
                        Capacity
                        <input type="number" min={1} value={addCaps[c.id] ?? "1"}
                          onChange={(e) => setAddCaps((v) => ({ ...v, [c.id]: e.target.value }))}
                          className="ml-1 w-16 rounded-md border border-input bg-background px-2 py-1 text-xs" />
                      </label>
                    )}
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

function BookingsSection({ venues }: { venues: Venue[] }) {
  const [venueFilter, setVenueFilter] = useState<number | "all">("all");
  const [status, setStatus] = useState<"all" | "upcoming" | "past" | "cancelled">("upcoming");
  const [payFilter, setPayFilter] = useState<"all" | "paid" | "unpaid" | "refunded">("all");

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
              </tr>
            </thead>
            <tbody>
              {bookingsQ.isLoading ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={5}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-muted-foreground" colSpan={5}>No bookings match these filters yet.</td></tr>
              ) : rows.map((r) => {
                const p = nameMap.get(r.user_id);
                return (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-3 whitespace-nowrap">{fmt(r.start_time)}<div className="text-[11px] text-muted-foreground">→ {new Date(r.end_time).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</div></td>
                    <td className="px-4 py-3">{r.courts?.venues?.name ?? "—"}<div className="text-[11px] text-muted-foreground">{r.courts?.name ?? `Court #${r.court_id}`}</div></td>
                    <td className="px-4 py-3">{p?.full_name || "Player"}<div className="text-[11px] text-muted-foreground">{p?.phone || r.user_id.slice(0, 8)}</div></td>
                    <td className="px-4 py-3">{stBadge(r.status)}</td>
                    <td className="px-4 py-3">{payBadge(r.payment_status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
    venues: { id: number; name: string; address: string | null } | null;
  } | null;
};

function PlayerDashboard({ userId, fullName, email }: { userId: string; fullName: string; email: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"upcoming" | "past" | "cancelled">("upcoming");

  const bookingsQ = useQuery({
    queryKey: ["player-bookings", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status, payment_status, created_at, courts(name, hourly_rate, map_emoji, images, sports(name), venues(id, name, address))")
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

  const shown = tab === "upcoming" ? upcoming.slice().sort((a, b) => a.start_time.localeCompare(b.start_time)) : tab === "past" ? past : cancelled;

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
        <Link to="/" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">Find a court</Link>
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
                <p className="text-xs text-muted-foreground">{fmtDate(nextUp.start_time)} · {fmtTime(nextUp.start_time)}–{fmtTime(nextUp.end_time)} · {nextUp.courts?.sports?.name}</p>
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
            {shown.map((b) => {
              const tx = txByBooking.get(b.id);
              const h = hours(b.start_time, b.end_time);
              const amount = tx?.amount != null ? Number(tx.amount) : (b.courts?.hourly_rate ?? 0) * h;
              const canCancel = tab === "upcoming" && b.payment_status !== "paid" && new Date(b.start_time) > now;
              return (
                <li key={b.id} className="overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-xl">{b.courts?.map_emoji ?? "🎾"}</div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{b.courts?.venues?.name ?? "Venue"} · <span className="text-muted-foreground">{b.courts?.name}</span></p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{b.courts?.sports?.name ?? "Sport"} · {h} hr{h > 1 ? "s" : ""}</p>
                        <p className="mt-1 text-sm">{fmtDate(b.start_time)}</p>
                        <p className="text-xs text-muted-foreground">{fmtTime(b.start_time)} – {fmtTime(b.end_time)}</p>
                        {b.courts?.venues?.address && <p className="mt-1 truncate text-[11px] text-muted-foreground">📍 {b.courts.venues.address}</p>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <p className="font-semibold text-primary">{peso(amount)}</p>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {payBadge(b.payment_status)}
                        {stBadge(b.status)}
                      </div>
                      {tx?.method && <p className="text-[10px] uppercase tracking-wider text-muted-foreground">via {tx.method}</p>}
                    </div>
                  </div>
                  {canCancel && (
                    <div className="mt-3 flex justify-end border-t border-border pt-3">
                      <button
                        onClick={() => { if (confirm("Cancel this booking?")) cancelMut.mutate(b.id); }}
                        disabled={cancelMut.isPending}
                        className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Cancel booking
                      </button>
                    </div>
                  )}
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
