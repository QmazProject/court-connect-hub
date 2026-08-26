/**
 * What the master search can reach for a player.
 *
 * The player side is routed, not stateful, so most results are a navigation: the four
 * rail destinations, and the sections *inside* the bookings workspace, which is one
 * long scroll rather than a set of tabs. Those land through `scrollToAnchor` against
 * ids added to each section in `PlayerWorkspace`.
 *
 * The records a player can search are their own: the bookings and favorites already
 * in the cache — `useFavoriteCourts` is the same query the Favorites view runs, so
 * searching costs nothing extra — plus active venues, which is the only part that
 * has to ask the network per query.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BellRing,
  BookOpen,
  CalendarDays,
  Clock,
  Heart,
  LandPlot,
  LineChart,
  LogOut,
  MapPin,
  Settings as SettingsIcon,
  Sparkles,
  Trophy,
  UserCircle,
  Wallet,
  XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFavoriteCourts } from "@/lib/favorites";
import { scrollToAnchor, useDebounced, type SearchEntry } from "@/lib/master-search";

/** Ids rendered by `PlayerWorkspace`. Kept here beside the entries that target them
 *  so the two lists are edited together. */
export const PLAYER_ANCHORS = {
  nextGame: "player-next-game",
  upcoming: "player-upcoming",
  activity: "player-activity",
  spending: "player-spending",
  sports: "player-sports",
  insights: "player-insights",
  cancellations: "player-cancellations",
  history: "player-history",
} as const;

const P_SECTION = 100;
const P_ANCHOR = 70;
const P_ACTION = 60;
const P_RECORD = 20;

export function usePlayerSearchEntries({
  userId,
  query,
  onSignOut,
}: {
  userId: string | undefined;
  query: string;
  onSignOut?: () => void;
}): { entries: SearchEntry[]; loading: boolean } {
  const navigate = useNavigate();
  const debounced = useDebounced(query);
  const needle = debounced.trim();
  /* This shell wraps Explore too, where most players never open the search. Holding
     the record queries until something is actually typed keeps the page load exactly
     as cheap as it was; from the first keystroke on, both are cached for a minute. */
  const engaged = needle.length > 0;

  /* Slimmer than the workspace's own booking query — a label and an id is all a
     result needs, and this list is only for matching. */
  const bookingsQ = useQuery({
    queryKey: ["master-search-bookings", userId],
    enabled: engaged && !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, start_time, status, courts(name, sports(name), venues(name))")
        .eq("user_id", userId!)
        .order("start_time", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: number;
        start_time: string;
        status: string;
        courts: {
          name: string;
          sports: { name: string } | null;
          venues: { name: string } | null;
        } | null;
      }[];
    },
  });

  /* `useFavoriteCourts` gates on the id it is given, so withholding it is how this
     stays idle. Once engaged the key matches the Favorites view's, and the two share
     one cached result rather than fetching it twice. */
  const favoritesQ = useFavoriteCourts(engaged ? userId : undefined);

  /* PostgREST's `or` takes its filters as one comma-separated string, so a comma or a
     bracket typed into the box would be read as filter syntax rather than as text, and
     `%`/`_` are ilike wildcards. Strip all four: this is a search box, and none of them
     narrow anything a player would be looking for. */
  const safeNeedle = needle
    .replace(/[,()%_\\*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  const venuesQ = useQuery({
    queryKey: ["master-search-venues", safeNeedle],
    enabled: safeNeedle.length >= 2,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address")
        .eq("is_active", true)
        .or(`name.ilike.%${safeNeedle}%,address.ilike.%${safeNeedle}%`)
        .limit(6);
      if (error) throw error;
      return (data ?? []) as { id: number; name: string; address: string | null }[];
    },
  });

  const entries = useMemo(() => {
    const toDashboard = (search: Record<string, unknown>, anchor?: string) => () => {
      navigate({ to: "/dashboard", search: search as never });
      if (anchor) scrollToAnchor(anchor);
    };

    const base: SearchEntry[] = [
      // ---- Rail destinations ----
      {
        id: "sec:explore",
        label: "Explore",
        group: "Go to",
        kind: "section",
        hint: "Find courts on the map",
        icon: MapPin,
        priority: P_SECTION,
        keywords: ["map", "search courts", "nearby", "find a court", "book", "venues", "discover"],
        run: () => navigate({ to: "/explore", search: {} as never }),
      },
      {
        id: "sec:favorites",
        label: "Favorites",
        group: "Go to",
        kind: "section",
        hint: "Courts you saved",
        icon: Heart,
        priority: P_SECTION,
        keywords: ["saved", "shortlist", "hearts", "liked", "bookmarks"],
        run: toDashboard({ view: "favorites" }),
      },
      {
        id: "sec:bookings",
        label: "My Bookings",
        group: "Go to",
        kind: "section",
        hint: "Your workspace: games, spending and stats",
        icon: BookOpen,
        priority: P_SECTION,
        keywords: ["reservations", "games", "workspace", "dashboard", "home"],
        run: toDashboard({}),
      },
      {
        id: "sec:calendar",
        label: "Calendar",
        group: "Go to",
        kind: "section",
        hint: "Your games by date",
        icon: CalendarDays,
        priority: P_SECTION,
        keywords: ["schedule", "month", "dates", "agenda", "timetable"],
        run: toDashboard({ view: "calendar" }),
      },

      // ---- Sections inside the bookings workspace ----
      {
        id: "anchor:next",
        label: "Next game",
        group: "In my workspace",
        kind: "section",
        hint: "The countdown to your next booking",
        icon: Clock,
        priority: P_ANCHOR,
        keywords: ["countdown", "soon", "today", "coming up"],
        run: toDashboard({}, PLAYER_ANCHORS.nextGame),
      },
      {
        id: "anchor:upcoming",
        label: "Upcoming games",
        group: "In my workspace",
        kind: "section",
        hint: "Everything still to play, with payment status",
        icon: CalendarDays,
        priority: P_ANCHOR,
        keywords: ["scheduled", "future", "unpaid", "pay", "cancel", "message venue"],
        run: toDashboard({}, PLAYER_ANCHORS.upcoming),
      },
      {
        id: "anchor:activity",
        label: "Your activity",
        group: "In my workspace",
        kind: "section",
        hint: "Counts, hours played and total spent",
        icon: Trophy,
        priority: P_ANCHOR,
        keywords: ["stats", "totals", "hours", "completed", "period"],
        run: toDashboard({}, PLAYER_ANCHORS.activity),
      },
      {
        id: "anchor:spending",
        label: "Your spending",
        group: "In my workspace",
        kind: "section",
        hint: "What you paid, by month and venue",
        icon: Wallet,
        priority: P_ANCHOR,
        keywords: ["money", "paid", "cost", "budget", "outstanding", "due", "expenses"],
        run: toDashboard({}, PLAYER_ANCHORS.spending),
      },
      {
        id: "anchor:sports",
        label: "Your sports",
        group: "In my workspace",
        kind: "section",
        hint: "Top sport, venue, court and usual playing time",
        icon: LandPlot,
        priority: P_ANCHOR,
        keywords: ["breakdown", "favourite sport", "top venue", "usual time"],
        run: toDashboard({}, PLAYER_ANCHORS.sports),
      },
      {
        id: "anchor:insights",
        label: "Insights",
        group: "In my workspace",
        kind: "section",
        hint: "What your booking history says about you",
        icon: Sparkles,
        priority: P_ANCHOR,
        keywords: ["highlights", "summary", "trends", "observations"],
        run: toDashboard({}, PLAYER_ANCHORS.insights),
      },
      {
        id: "anchor:cancellations",
        label: "Cancellations",
        group: "In my workspace",
        kind: "section",
        hint: "Cancelled games and what came back",
        icon: XCircle,
        priority: P_ANCHOR,
        keywords: ["refund", "refunded", "cancelled", "money back"],
        run: toDashboard({}, PLAYER_ANCHORS.cancellations),
      },
      {
        id: "anchor:history",
        label: "Booking history",
        group: "In my workspace",
        kind: "section",
        hint: "Every game you have played",
        icon: LineChart,
        priority: P_ANCHOR,
        keywords: ["past", "completed", "previous", "receipts", "archive"],
        run: toDashboard({}, PLAYER_ANCHORS.history),
      },

      // ---- Settings ----
      {
        id: "sec:settings",
        label: "Settings",
        group: "Go to",
        kind: "section",
        hint: "Profile picture, name and notifications",
        icon: SettingsIcon,
        priority: P_SECTION,
        keywords: ["account", "preferences", "profile", "options", "config"],
        run: toDashboard({ view: "settings" }),
      },
      {
        id: "set:profile",
        label: "Profile picture",
        group: "Settings",
        kind: "setting",
        hint: "Upload or change your photo",
        icon: UserCircle,
        priority: P_ANCHOR,
        keywords: ["avatar", "photo", "image", "picture", "upload", "display picture", "dp"],
        run: toDashboard({ view: "settings" }),
      },
      {
        id: "set:name",
        label: "Change your name",
        group: "Settings",
        kind: "setting",
        hint: "The name venues see on your bookings",
        icon: UserCircle,
        priority: P_ANCHOR,
        keywords: ["full name", "rename", "display name"],
        run: toDashboard({ view: "settings" }),
      },
      {
        id: "set:notifications",
        label: "Notification settings",
        group: "Settings",
        kind: "setting",
        hint: "Email, this device, and what gets sent",
        icon: BellRing,
        priority: P_ANCHOR,
        keywords: [
          "notifications",
          "push",
          "alerts",
          "email",
          "reminders",
          "mute",
          "turn off",
          "unsubscribe",
          "quiet",
          "bell",
        ],
        run: toDashboard({ view: "settings" }),
      },

      // ---- Actions ----
      {
        id: "act:find-court",
        label: "Find a court",
        group: "Actions",
        kind: "action",
        hint: "Open Explore and book",
        icon: MapPin,
        priority: P_ACTION,
        keywords: ["book", "new booking", "reserve", "play", "search"],
        run: () => navigate({ to: "/explore", search: {} as never }),
      },
    ];

    if (onSignOut) {
      base.push({
        id: "act:sign-out",
        label: "Sign out",
        group: "Actions",
        kind: "action",
        hint: "End this session",
        icon: LogOut,
        priority: P_ACTION,
        keywords: ["log out", "logout", "exit", "leave"],
        run: onSignOut,
      });
    }

    const bookingEntries: SearchEntry[] = (bookingsQ.data ?? []).map((b) => {
      const when = new Date(b.start_time).toLocaleDateString("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const venue = b.courts?.venues?.name ?? "Booking";
      return {
        id: `booking:${b.id}`,
        label: `${venue}${b.courts?.name ? ` · ${b.courts.name}` : ""}`,
        group: "My bookings",
        kind: "booking",
        hint: [when, b.courts?.sports?.name, b.status].filter(Boolean).join(" · "),
        keywords: ["booking", `#${b.id}`, b.courts?.sports?.name ?? "", b.status].filter(Boolean),
        icon: BookOpen,
        priority: P_RECORD,
        /* `?booking=` is what a reminder notification uses, and the workspace already
           scrolls that booking into view — reuse it rather than inventing a second
           way to point at the same card. */
        run: () => navigate({ to: "/dashboard", search: { booking: b.id } as never }),
      };
    });

    const favoriteEntries: SearchEntry[] = (favoritesQ.data ?? []).map((f) => ({
      id: `favorite:${f.court_id}`,
      label: f.courts?.name ?? "Saved court",
      group: "My favorites",
      kind: "favorite",
      hint:
        [f.courts?.venues?.name, f.courts?.sports?.name].filter(Boolean).join(" · ") ||
        "Saved court",
      keywords: [
        "favorite",
        "saved",
        f.courts?.venues?.name ?? "",
        f.courts?.sports?.name ?? "",
      ].filter(Boolean),
      icon: Heart,
      priority: P_RECORD,
      run: toDashboard({ view: "favorites" }),
    }));

    const venueEntries: SearchEntry[] = (venuesQ.data ?? []).map((v) => ({
      id: `venue:${v.id}`,
      label: v.name,
      group: "Venues",
      kind: "venue",
      hint: v.address || "Open the venue page",
      keywords: ["venue", "book", "courts"],
      icon: MapPin,
      priority: P_RECORD,
      run: () => navigate({ to: "/venues/$venueId", params: { venueId: String(v.id) } as never }),
    }));

    return [...base, ...bookingEntries, ...favoriteEntries, ...venueEntries];
  }, [navigate, onSignOut, bookingsQ.data, favoritesQ.data, venuesQ.data]);

  return { entries, loading: venuesQ.isFetching };
}
