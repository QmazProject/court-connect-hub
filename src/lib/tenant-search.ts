/**
 * What the master search can reach for a tenant.
 *
 * Everything the dashboard's left rail, its sub-tabs and its "+ Create" buttons can
 * do, expressed as one flat list, plus the venues and courts that tenant actually
 * owns. The dashboard is one route whose panes are React state rather than URLs, so
 * a result cannot be a link — it calls the same setter the sidebar button calls,
 * which is why the actions come in as callbacks instead of being built here.
 *
 * `keywords` carries the weight. A tenant looking for where refunds live types
 * "refund", not "Transactions", and the panel's own labels are the one vocabulary
 * they have not learned yet.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  CalendarDays,
  LandPlot,
  Layers,
  LayoutDashboard,
  LogOut,
  MapPin,
  Receipt,
  Settings as SettingsIcon,
  TableProperties,
  TicketPercent,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { scrollToAnchor, useDebounced, type SearchEntry } from "@/lib/master-search";

export type TenantSectionKey =
  | "dashboard"
  | "calendar"
  | "bookings"
  | "courts"
  | "customers"
  | "team"
  | "transactions"
  | "vouchers"
  | "settings";

export type TenantCourtsTab = "venues" | "courts" | "groups";

/** Ids rendered by the Settings pane. Kept beside the entries that target them so
 *  the two are edited together. */
export const TENANT_ANCHORS = {
  account: "tenant-settings-account",
  payments: "tenant-settings-payments",
} as const;

/** Just enough of a venue to list one. The dashboard's own `Venue` is far wider and
 *  this module has no use for the rest of it. */
type VenueLite = { id: number; name: string; address?: string | null };

export type TenantSearchActions = {
  setSection: (s: TenantSectionKey) => void;
  setCourtsTab: (t: TenantCourtsTab) => void;
  openCreateVenue: () => void;
  openAddCourt: () => void;
  openCreateGroup: () => void;
  onSignOut: () => void;
};

/** Priority bands. Sections outrank their own tabs, tabs outrank the records inside
 *  them, so typing a venue's name still shows "Venues & Courts" above it. */
const P_SECTION = 100;
const P_TAB = 80;
const P_ACTION = 60;
const P_SETTING = 40;
const P_RECORD = 20;

function staticEntries(a: TenantSearchActions): SearchEntry[] {
  const goCourts = (tab: TenantCourtsTab) => () => {
    a.setSection("courts");
    a.setCourtsTab(tab);
  };

  return [
    // ---- Sections (the left rail) ----
    {
      id: "sec:dashboard",
      label: "Dashboard",
      group: "Go to",
      kind: "section",
      hint: "Overview, revenue and today's activity",
      icon: LayoutDashboard,
      priority: P_SECTION,
      keywords: ["home", "overview", "summary", "stats", "kpi", "revenue", "start"],
      run: () => a.setSection("dashboard"),
    },
    {
      id: "sec:calendar",
      label: "Calendar",
      group: "Go to",
      kind: "section",
      hint: "Day view of every court",
      icon: CalendarDays,
      priority: P_SECTION,
      keywords: ["schedule", "day", "timetable", "agenda", "slots", "availability"],
      run: () => a.setSection("calendar"),
    },
    {
      id: "sec:bookings",
      label: "Bookings",
      group: "Go to",
      kind: "section",
      hint: "Reservations, payment status and cancellations",
      icon: BookOpen,
      priority: P_SECTION,
      keywords: [
        "reservations",
        "orders",
        "upcoming",
        "past",
        "cancelled",
        "expired",
        "no show",
        "refund",
      ],
      run: () => a.setSection("bookings"),
    },
    {
      id: "sec:courts",
      label: "Venues & Courts",
      group: "Go to",
      kind: "section",
      hint: "Manage venues, courts and court groups",
      icon: LandPlot,
      priority: P_SECTION,
      keywords: ["venue", "court", "facility", "location", "site", "field", "pitch", "surface"],
      run: () => a.setSection("courts"),
    },
    {
      id: "sec:customers",
      label: "Customers",
      group: "Go to",
      kind: "section",
      hint: "Players who have booked your venues",
      icon: Users,
      priority: P_SECTION,
      keywords: ["players", "clients", "guests", "repeat", "phone", "contacts", "lifetime value"],
      run: () => a.setSection("customers"),
    },
    {
      id: "sec:team",
      label: "Team",
      group: "Go to",
      kind: "section",
      hint: "Staff, roles and permissions",
      icon: UserCog,
      priority: P_SECTION,
      keywords: ["staff", "employees", "invite", "roles", "permissions", "access"],
      run: () => a.setSection("team"),
    },
    {
      id: "sec:transactions",
      label: "Transactions",
      group: "Go to",
      kind: "section",
      hint: "Payments, refunds and payouts",
      icon: Receipt,
      priority: P_SECTION,
      keywords: [
        "payments",
        "paymongo",
        "gcash",
        "maya",
        "refund",
        "payout",
        "revenue",
        "receipts",
        "invoice",
        "failed",
      ],
      run: () => a.setSection("transactions"),
    },
    {
      id: "sec:vouchers",
      label: "Vouchers",
      group: "Go to",
      kind: "section",
      hint: "Discount codes and promos",
      icon: TicketPercent,
      priority: P_SECTION,
      keywords: ["discount", "promo", "coupon", "code", "percent", "offer", "campaign"],
      run: () => a.setSection("vouchers"),
    },
    {
      id: "sec:settings",
      label: "Settings",
      group: "Go to",
      kind: "section",
      hint: "Account, payment mode and refund policy",
      icon: SettingsIcon,
      priority: P_SECTION,
      keywords: ["preferences", "profile", "account", "config", "options"],
      run: () => a.setSection("settings"),
    },

    // ---- Sub-tabs inside Venues & Courts ----
    {
      id: "tab:venues",
      label: "Venues",
      group: "Venues & Courts",
      kind: "tab",
      hint: "The venues table",
      icon: MapPin,
      priority: P_TAB,
      keywords: ["venue list", "sites", "locations", "address", "branches"],
      run: goCourts("venues"),
    },
    {
      id: "tab:courts",
      label: "Courts",
      group: "Venues & Courts",
      kind: "tab",
      hint: "Every court, with rates and hours",
      icon: TableProperties,
      priority: P_TAB,
      keywords: ["court list", "rates", "pricing", "hourly", "indoor", "outdoor", "capacity"],
      run: goCourts("courts"),
    },
    {
      id: "tab:groups",
      label: "Court Groups",
      group: "Venues & Courts",
      kind: "tab",
      hint: "Shared surfaces that block each other",
      icon: Layers,
      priority: P_TAB,
      keywords: ["physical court", "surface", "shared", "conflict", "blocking", "multi sport"],
      run: goCourts("groups"),
    },

    // ---- Actions ----
    {
      id: "act:create-venue",
      label: "Create venue",
      group: "Actions",
      kind: "action",
      hint: "Add a new venue",
      icon: MapPin,
      priority: P_ACTION,
      keywords: ["new venue", "add venue", "add location", "add site", "register"],
      run: () => {
        a.setSection("courts");
        a.openCreateVenue();
      },
    },
    {
      id: "act:add-court",
      label: "Add court",
      group: "Actions",
      kind: "action",
      hint: "Add a court to one of your venues",
      icon: LandPlot,
      priority: P_ACTION,
      keywords: ["new court", "create court", "add field", "add pitch"],
      run: () => {
        a.setSection("courts");
        a.openAddCourt();
      },
    },
    {
      id: "act:create-group",
      label: "Create court group",
      group: "Actions",
      kind: "action",
      hint: "Link courts that share one physical surface",
      icon: Layers,
      priority: P_ACTION,
      keywords: ["new group", "physical court", "link courts", "shared surface"],
      run: () => {
        a.setSection("courts");
        a.openCreateGroup();
      },
    },
    {
      id: "act:sign-out",
      label: "Sign out",
      group: "Actions",
      kind: "action",
      hint: "End this session",
      icon: LogOut,
      priority: P_ACTION,
      keywords: ["log out", "logout", "exit", "leave"],
      run: a.onSignOut,
    },

    // ---- Settings cards ----
    {
      id: "set:account",
      label: "Account details",
      group: "Settings",
      kind: "setting",
      hint: "Your name, email and role",
      icon: UserCog,
      priority: P_SETTING,
      keywords: ["full name", "email", "profile", "rename"],
      run: () => {
        a.setSection("settings");
        scrollToAnchor(TENANT_ANCHORS.account);
      },
    },
    {
      id: "set:payments",
      label: "Payments & refunds",
      group: "Settings",
      kind: "setting",
      hint: "Payment mode and refund cutoff per venue",
      icon: Wallet,
      priority: P_SETTING,
      keywords: [
        "payment mode",
        "online",
        "onsite",
        "cutoff",
        "refund policy",
        "cancellation window",
      ],
      run: () => {
        a.setSection("settings");
        scrollToAnchor(TENANT_ANCHORS.payments);
      },
    },
  ];
}

/**
 * Static commands plus the tenant's own records.
 *
 * Venues arrive already loaded from the dashboard, so they cost nothing to search.
 * Courts are their own small query — id and name only, not the wide row the Courts
 * tab loads — held for a minute and asked for only once a query is two characters
 * long, so typing does not put a request behind every keystroke.
 */
export function useTenantSearchEntries({
  query,
  venues,
  actions,
}: {
  query: string;
  venues: VenueLite[];
  actions: TenantSearchActions;
}): { entries: SearchEntry[]; loading: boolean } {
  const debounced = useDebounced(query);
  const needle = debounced.trim();
  const venueIds = venues.map((v) => v.id);

  const courtsQ = useQuery({
    queryKey: ["master-search-courts", venueIds.join(",")],
    enabled: needle.length >= 2 && venueIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, venue_id, is_active, sports(name)")
        .in("venue_id", venueIds)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: number;
        name: string;
        venue_id: number;
        is_active: boolean | null;
        sports: { name: string } | null;
      }[];
    },
  });

  const entries = useMemo(() => {
    const base = staticEntries(actions);

    const venueEntries: SearchEntry[] = venues.map((v) => ({
      id: `venue:${v.id}`,
      label: v.name,
      group: "Your venues",
      kind: "venue",
      hint: v.address || "Venue",
      keywords: ["venue", "location", "site"],
      icon: MapPin,
      priority: P_RECORD,
      run: () => {
        actions.setSection("courts");
        actions.setCourtsTab("venues");
      },
    }));

    const venueName = new Map(venues.map((v) => [v.id, v.name]));
    const courtEntries: SearchEntry[] = (courtsQ.data ?? []).map((c) => ({
      id: `court:${c.id}`,
      label: c.name,
      group: "Your courts",
      kind: "court",
      hint: [venueName.get(c.venue_id), c.sports?.name, c.is_active === false ? "Inactive" : null]
        .filter(Boolean)
        .join(" · "),
      keywords: ["court", c.sports?.name ?? "", venueName.get(c.venue_id) ?? ""].filter(Boolean),
      icon: LandPlot,
      priority: P_RECORD,
      run: () => {
        actions.setSection("courts");
        actions.setCourtsTab("courts");
      },
    }));

    return [...base, ...venueEntries, ...courtEntries];
  }, [actions, venues, courtsQ.data]);

  return { entries, loading: courtsQ.isFetching };
}
