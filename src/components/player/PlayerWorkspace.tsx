/**
 * The player's workspace: next game, schedule, spending, sports and history.
 *
 * Lifted out of routes/_authenticated/dashboard.tsx, which is already ~6,900 lines and
 * costs minutes to transform on a /mnt/c checkout. Every number rendered here comes from
 * `@/lib/player-stats`, which is the single source of truth for what a booking cost, what
 * was actually paid, and who cancelled it — this file only decides how to show it.
 *
 * Section order follows what a player opens the page to find out: when am I playing,
 * where, what do I owe — then how active have I been, then what did I spend.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Heart,
  MapPin,
  Navigation,
  RotateCcw,
  Search as SearchIcon,
  Timer,
  Trophy,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { retryBookingPayment, cancelPendingBookings } from "@/lib/paymongo.functions";
import { groupBookingSessions, formatTimeRange, formatSessionLabel } from "@/lib/booking-groups";
import { PlayerShell } from "@/components/PlayerShell";
/* The ids the master search scrolls to. Imported rather than written out so the
   anchors and the entries that target them cannot drift apart. */
import { PLAYER_ANCHORS } from "@/lib/player-search";
import { PlayerSettingsView } from "@/components/player/PlayerSettingsView";
import { FavoriteButton } from "@/components/FavoriteButton";
import { useFavoriteCourts, type FavoriteCourt } from "@/lib/favorites";
/* Prices here are quoted the way the venue page quotes them — same helpers, same
   bookable-hours-only rule — so a favorite never advertises a rate the court itself
   does not show. `peso` comes from player-stats below; court-pricing exports one too
   and importing both would collide. */
import { normalizeRules, hasVariablePricing, minRate, maxRate } from "@/lib/court-pricing";
import { sportStyle } from "@/lib/sport-colors";
import { effectiveHours } from "@/lib/operating-hours";
import { BookingChat } from "@/components/BookingChat";
import {
  buildPlayerStats,
  indexTransactions,
  sessionPrice,
  sessionPaid,
  sessionRefunded,
  sessionBalance,
  sessionMethod,
  sessionState,
  classifyCancellation,
  countdownLabel,
  directionsUrl,
  icsForSession,
  humanHours,
  peso,
  pesoShort,
  dayKey,
  PERIODS,
  type PeriodKey,
  type PlayerBookingRow,
  type PlayerTransaction,
  type PlayerSession,
  type TxIndex,
} from "@/lib/player-stats";

const BOOKING_SELECT =
  "id, court_id, start_time, end_time, status, payment_status, refund_status, cancelled_at, cancelled_by, cancel_reason, unit_price, discount_amount, created_at, " +
  "courts(name, hourly_rate, map_emoji, images, sports(name), venues(id, name, address, latitude, longitude, is_active))";

const TX_SELECT =
  "id, booking_id, amount, status, method, paid_at, refunded_at, created_at, provider_ref";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const fmtDateShort = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });

// ===========================================================================
// Badges
// ===========================================================================

/** Payment state as the player experiences it, not as the column spells it.
 *  `refund_status` outranks `payment_status`: once a refund is moving, that is the
 *  thing the player is waiting on. */
function PaymentBadge({
  paymentStatus,
  refundStatus,
}: {
  paymentStatus: string;
  refundStatus?: string | null;
}) {
  let label = paymentStatus.replace("_", " ");
  let tone = "bg-secondary text-muted-foreground";

  if (refundStatus === "pending") {
    label = "Refund pending";
    tone = "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  } else if (refundStatus === "refunded" || paymentStatus === "refunded") {
    label = "Refunded";
    tone = "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  } else if (paymentStatus === "paid") {
    label = "Paid";
    tone = "bg-primary/15 text-primary";
  } else if (paymentStatus === "pending" || paymentStatus === "unpaid") {
    label = "Payment pending";
    tone = "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  } else if (paymentStatus === "failed") {
    label = "Payment failed";
    tone = "bg-destructive/10 text-destructive";
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
  );
}

function StatusBadge({ session, userId }: { session: PlayerSession; userId: string }) {
  const r = session.first;
  const state = sessionState(session, Date.now());

  if (state === "cancelled" || state === "expired") {
    const who = classifyCancellation(r, userId);
    const label =
      who === "player" ? "Cancelled by you" : who === "venue" ? "Cancelled by venue" : "Expired";
    // A venue cancellation is not the player's doing, so it does not get the
    // destructive red that reads as "you did something wrong".
    const tone =
      who === "venue"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : who === "player"
          ? "bg-muted text-muted-foreground"
          : "bg-muted text-muted-foreground";
    return (
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
    );
  }
  if (state === "completed") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
        Completed
      </span>
    );
  }
  const tone =
    r.status === "confirmed"
      ? "bg-primary/10 text-primary"
      : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {r.status === "confirmed" ? "Confirmed" : "Awaiting payment"}
    </span>
  );
}

// ===========================================================================
// Small primitives
// ===========================================================================

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "primary" | "warning";
}) {
  const rail =
    tone === "warning" ? "bg-amber-500" : tone === "primary" ? "bg-primary" : "bg-border";
  const chip =
    tone === "warning"
      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
      : tone === "primary"
        ? "bg-primary/12 text-primary"
        : "bg-secondary text-muted-foreground";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${rail}`} />
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${chip}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <p className="mt-2 font-cabinet text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl">
        {value}
      </p>
      {hint && <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SectionHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** Horizontal ranked bars. One hue, length carries the value — no legend needed. */
function RankedBars({
  rows,
  total,
  unit,
}: {
  rows: { key: string; label: string; sublabel?: string; amount: number; bookings: number }[];
  total: number;
  unit?: "money";
}) {
  if (rows.length === 0)
    return <p className="mt-3 text-xs text-muted-foreground">Nothing to show yet.</p>;
  const peak = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <ul className="mt-3 space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-semibold">{r.label}</span>
            <span className="shrink-0 font-display font-bold tabular-nums">
              {unit === "money" ? peso(r.amount) : r.amount}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${(r.amount / peak) * 100}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {r.bookings} {r.bookings === 1 ? "booking" : "bookings"}
              {total > 0 && ` · ${Math.round((r.amount / total) * 100)}%`}
            </span>
          </div>
          {r.sublabel && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{r.sublabel}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ===========================================================================
// Booking card — one session, used by Upcoming and History
// ===========================================================================

function BookingCard({
  session,
  idx,
  userId,
  highlight,
  focused,
  onPay,
  onCancel,
  onMessage,
  actions = true,
}: {
  session: PlayerSession;
  idx: TxIndex;
  userId: string;
  highlight?: boolean;
  /** Deep-linked from a reminder — scrolled to and ringed until the player moves on. */
  focused?: boolean;
  onPay?: (s: PlayerSession) => void;
  onCancel?: (s: PlayerSession) => void;
  onMessage?: (s: PlayerSession) => void;
  actions?: boolean;
}) {
  const r = session.first;
  const c = r.courts;
  const state = sessionState(session, Date.now());
  const price = sessionPrice(session);
  const paid = sessionPaid(session, idx);
  const refunded = sessionRefunded(session, idx);
  const balance = sessionBalance(session, idx);
  const method = sessionMethod(session, idx);
  const venueInactive = c?.venues?.is_active === false;
  const thumb = c?.images?.[0];
  const canPay = state === "upcoming" && r.status === "pending" && balance > 0;
  const canCancel = state === "upcoming";

  return (
    <li
      id={`booking-${session.first.id}`}
      className={`overflow-hidden rounded-2xl border bg-card shadow-sm transition hover:shadow-md ${
        focused
          ? "border-primary ring-2 ring-primary/40"
          : highlight
            ? "border-primary/50 ring-1 ring-primary/20"
            : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          {thumb ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-border"
            />
          ) : (
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-primary/10 text-2xl">
              {c?.map_emoji ?? "🎾"}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate font-display text-base font-bold leading-tight">
              {c?.venues?.name ?? "Venue"}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {c?.name}
              {c?.sports?.name ? ` · ${c.sports.name}` : ""} · {session.hours} hr
              {session.hours > 1 ? "s" : ""}
            </p>
            <p className="mt-1.5 text-sm font-semibold tabular-nums">
              {fmtDate(session.start_time)}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {formatTimeRange(session.start_time, session.end_time)}
              {session.ids.length > 1 ? ` · ${session.ids.length} slots` : ""}
            </p>
            {c?.venues?.address && (
              <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{c.venues.address}</span>
              </p>
            )}
          </div>
        </div>

        {/* Price, paid and refunded stay on separate lines — collapsing them is how a
            player ends up thinking a refund never arrived. */}
        <div className="flex flex-col items-end gap-1">
          <p className="font-cabinet text-xl font-bold tabular-nums">{peso(price)}</p>
          {paid > 0 && paid < price && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {peso(paid)} paid · {peso(balance)} due
            </p>
          )}
          {refunded > 0 && (
            <p className="text-[11px] font-semibold tabular-nums text-sky-700 dark:text-sky-300">
              {peso(refunded)} refunded
            </p>
          )}
          <div className="mt-0.5 flex flex-wrap justify-end gap-1.5">
            {venueInactive && (
              <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive ring-1 ring-destructive/30">
                Venue inactive
              </span>
            )}
            <StatusBadge session={session} userId={userId} />
            <PaymentBadge paymentStatus={r.payment_status} refundStatus={r.refund_status} />
          </div>
          {method && (
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              via {method.replace("_", " ")}
            </p>
          )}
        </div>
      </div>

      {r.cancel_reason && state !== "upcoming" && (
        <p className="mx-4 mb-3 rounded-lg bg-secondary/60 px-3 py-2 text-[11px] text-muted-foreground">
          {r.cancel_reason}
        </p>
      )}

      {actions && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-secondary/30 px-4 py-3">
          {c?.venues?.id && onMessage && (
            <button
              onClick={() => onMessage(session)}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold transition hover:border-primary hover:text-primary"
            >
              Message venue
            </button>
          )}
          {state !== "upcoming" && (
            <Link
              to="/courts/$courtId"
              params={{ courtId: String(r.court_id) }}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold transition hover:border-primary hover:text-primary"
            >
              <RotateCcw className="h-3 w-3" /> Book again
            </Link>
          )}
          {canPay && onPay && (
            <button
              onClick={() => onPay(session)}
              disabled={venueInactive}
              title={venueInactive ? "Venue is inactive — payment disabled" : undefined}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Pay {peso(balance)}
            </button>
          )}
          {canCancel && onCancel && (
            <button
              onClick={() => onCancel(session)}
              className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// ===========================================================================
// Next game
// ===========================================================================

function NextGame({
  session,
  idx,
  onPay,
  onCancel,
}: {
  session: PlayerSession;
  idx: TxIndex;
  onPay: (s: PlayerSession) => void;
  onCancel: (s: PlayerSession) => void;
}) {
  const r = session.first;
  const c = r.courts;
  const balance = sessionBalance(session, idx);
  const paid = sessionPaid(session, idx);
  const directions = directionsUrl(c);

  /* The countdown is the reason this card is the largest thing on the page, so it
     must not go stale on a tab left open. A minute is granular enough — the label
     never shows seconds. */
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const addToCalendar = () => {
    const blob = new Blob([icsForSession(session)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `booking-${r.id}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="relative overflow-hidden rounded-3xl border-2 border-[#b8f05a]/30 bg-linear-to-br from-[#0f4a40] via-[#0c3a33] to-[#09231f] text-white shadow-lg">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full opacity-[0.08]"
        style={{ background: "radial-gradient(circle, #b8f05a 0%, transparent 65%)" }}
      />
      <div className="relative p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#b8f05a]">
              Next game
            </p>
            {/* Biggest type on the page: the answer to "when am I playing". */}
            <p className="mt-2 font-cabinet text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {countdownLabel(session.start_time)}
            </p>
            <p className="mt-1.5 text-sm text-white/70 tabular-nums">
              {fmtDate(session.start_time)} ·{" "}
              {formatTimeRange(session.start_time, session.end_time)} · {session.hours} hr
              {session.hours > 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge session={session} userId={r.cancelled_by ?? ""} />
            <PaymentBadge paymentStatus={r.payment_status} refundStatus={r.refund_status} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-start gap-4 border-t border-white/10 pt-5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/10 text-2xl">
            {c?.map_emoji ?? "🎾"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg font-bold leading-tight">
              {c?.venues?.name ?? "Venue"}
            </p>
            <p className="mt-0.5 text-sm text-white/70">
              {c?.name}
              {c?.sports?.name ? ` · ${c.sports.name}` : ""}
            </p>
            {c?.venues?.address && (
              <p className="mt-1 flex items-start gap-1 text-xs text-white/55">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{c.venues.address}</span>
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="font-cabinet text-2xl font-bold tabular-nums">
              {peso(sessionPrice(session))}
            </p>
            {balance > 0 ? (
              <p className="text-xs font-semibold text-amber-300 tabular-nums">
                {peso(balance)} due
              </p>
            ) : (
              <p className="text-xs text-white/55 tabular-nums">{peso(paid)} paid</p>
            )}
          </div>
        </div>

        {balance > 0 && (
          <p className="mt-4 rounded-xl bg-amber-400/15 px-3 py-2 text-xs font-semibold text-amber-200">
            Your slot is only reserved once payment clears.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {balance > 0 && (
            <button
              onClick={() => onPay(session)}
              disabled={c?.venues?.is_active === false}
              className="rounded-full bg-[#b8f05a] px-4 py-2 text-sm font-bold text-[#102521] transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Pay {peso(balance)}
            </button>
          )}
          <Link
            to="/venues/$venueId"
            params={{ venueId: String(c?.venues?.id ?? "") }}
            className="rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-[#b8f05a]/60 hover:text-white"
          >
            View venue
          </Link>
          {directions && (
            <a
              href={directions}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-[#b8f05a]/60 hover:text-white"
            >
              <Navigation className="h-3.5 w-3.5" /> Directions
            </a>
          )}
          <button
            onClick={addToCalendar}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-[#b8f05a]/60 hover:text-white"
          >
            <CalendarPlus className="h-3.5 w-3.5" /> Add to calendar
          </button>
          <button
            onClick={() => onCancel(session)}
            className="rounded-full border border-red-400/40 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/15"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Upcoming schedule
// ===========================================================================

type WhenFilter = "all" | "today" | "week" | "month";

function UpcomingSection({
  sessions,
  idx,
  userId,
  focusBookingId,
  onPay,
  onCancel,
  onMessage,
}: {
  sessions: PlayerSession[];
  idx: TxIndex;
  userId: string;
  focusBookingId?: number;
  onPay: (s: PlayerSession) => void;
  onCancel: (s: PlayerSession) => void;
  onMessage: (s: PlayerSession) => void;
}) {
  const [when, setWhen] = useState<WhenFilter>("all");
  const [sport, setSport] = useState("all");
  const [venue, setVenue] = useState("all");

  const sports = useMemo(
    () =>
      Array.from(
        new Set(sessions.map((s) => s.first.courts?.sports?.name).filter(Boolean) as string[]),
      ).sort(),
    [sessions],
  );
  const venues = useMemo(
    () =>
      Array.from(
        new Set(sessions.map((s) => s.first.courts?.venues?.name).filter(Boolean) as string[]),
      ).sort(),
    [sessions],
  );

  const shown = useMemo(() => {
    const now = new Date();
    const today = dayKey(now);
    const endOfWeek = new Date(now);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    return sessions.filter((s) => {
      const start = new Date(s.start_time);
      if (when === "today" && dayKey(start) !== today) return false;
      if (when === "week" && start > endOfWeek) return false;
      if (when === "month" && start > endOfMonth) return false;
      if (sport !== "all" && s.first.courts?.sports?.name !== sport) return false;
      if (venue !== "all" && s.first.courts?.venues?.name !== venue) return false;
      return true;
    });
  }, [sessions, when, sport, venue]);

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-xs font-bold transition ${
      active
        ? "bg-primary text-primary-foreground"
        : "border border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
    }`;

  return (
    <section id={PLAYER_ANCHORS.upcoming} className="mt-8">
      <SectionHead
        title="Upcoming"
        sub={`${sessions.length} booking${sessions.length === 1 ? "" : "s"} ahead`}
        action={
          <Link
            to="/dashboard"
            search={{ view: "calendar" as const }}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold transition hover:border-primary hover:text-primary"
          >
            <CalendarDays className="h-3.5 w-3.5" /> Calendar view
          </Link>
        }
      />

      <div className="nice-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
        {(
          [
            ["all", "All"],
            ["today", "Today"],
            ["week", "This week"],
            ["month", "This month"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setWhen(k)} className={`shrink-0 ${chip(when === k)}`}>
            {l}
          </button>
        ))}
        {sports.length > 1 && (
          <select
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            aria-label="Filter by sport"
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold outline-none transition focus:border-primary"
          >
            <option value="all">All sports</option>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {venues.length > 1 && (
          <select
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            aria-label="Filter by venue"
            className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold outline-none transition focus:border-primary"
          >
            <option value="all">All venues</option>
            {venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border p-8 text-center">
          <p className="font-display text-sm font-bold">Nothing in this range</p>
          <p className="mt-1 text-xs text-muted-foreground">Try a wider filter, or book a court.</p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-3">
          {shown.map((s, i) => (
            <BookingCard
              key={s.key}
              session={s}
              idx={idx}
              userId={userId}
              highlight={i === 0 && when === "all" && sport === "all" && venue === "all"}
              focused={!!focusBookingId && s.ids.includes(focusBookingId)}
              onPay={onPay}
              onCancel={onCancel}
              onMessage={onMessage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ===========================================================================
// Spending
// ===========================================================================

function SpendingSection({
  stats,
  periodLabel,
}: {
  stats: ReturnType<typeof buildPlayerStats>;
  periodLabel: string;
}) {
  const { spend } = stats;
  const peak = Math.max(1, ...spend.months.map((m) => m.amount));

  return (
    <section id={PLAYER_ANCHORS.spending} className="mt-8">
      <SectionHead title="Your spending" sub={`Court bookings · ${periodLabel.toLowerCase()}`} />

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {/* Total + trend */}
        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5 lg:col-span-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Total spent
            </p>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-2 font-cabinet text-3xl font-bold tabular-nums">
            {peso(spend.thisPeriod)}
          </p>

          {spend.delta !== null ? (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-bold tabular-nums ${
                  spend.deltaAmount > 0
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-primary/15 text-primary"
                }`}
              >
                {spend.deltaAmount > 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {Math.abs(Math.round(spend.delta))}%
              </span>
              <span className="text-muted-foreground">
                {spend.deltaAmount > 0 ? "more" : "less"} than the period before (
                {peso(Math.abs(spend.deltaAmount))})
              </span>
            </p>
          ) : (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              No earlier period to compare against.
            </p>
          )}

          <div className="mt-4 flex h-20 items-end gap-1.5 border-t border-border pt-4">
            {spend.months.map((m, i) => (
              <div
                key={m.key}
                className="group flex flex-1 flex-col items-center gap-1.5"
                title={`${m.label}: ${peso(m.amount)}`}
              >
                <div className="flex w-full flex-1 items-end">
                  <div
                    className={`w-full rounded-t-md transition-all ${i === 5 ? "bg-primary" : "bg-primary/35 group-hover:bg-primary/60"}`}
                    style={{
                      height: `${Math.max(m.amount > 0 ? 8 : 3, (m.amount / peak) * 100)}%`,
                    }}
                  />
                </div>
                <span
                  className={`text-[9px] font-semibold uppercase ${i === 5 ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {m.label}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Last 6 months, regardless of the filter above.
          </p>

          {(spend.refunded > 0 || spend.pendingRefund > 0 || spend.outstanding > 0) && (
            <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-[11px]">
              {spend.outstanding > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Still to pay</dt>
                  <dd className="font-bold tabular-nums text-amber-700 dark:text-amber-300">
                    {peso(spend.outstanding)}
                  </dd>
                </div>
              )}
              {spend.refunded > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Refunded to you</dt>
                  <dd className="font-bold tabular-nums text-sky-700 dark:text-sky-300">
                    {peso(spend.refunded)}
                  </dd>
                </div>
              )}
              {spend.pendingRefund > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Refund pending</dt>
                  <dd className="font-bold tabular-nums text-sky-700 dark:text-sky-300">
                    {peso(spend.pendingRefund)}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </article>

        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-sm font-bold">Where it goes</h3>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <MapPin className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">By venue</p>
          <RankedBars rows={spend.byVenue.slice(0, 5)} total={spend.total} unit="money" />
        </article>

        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-sm font-bold">By sport</h3>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <Trophy className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">What you spend it playing</p>
          <RankedBars rows={spend.bySport.slice(0, 5)} total={spend.total} unit="money" />

          {spend.byCourt.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Top court
              </p>
              <p className="mt-1 truncate font-display text-sm font-bold">
                {spend.byCourt[0].label}
              </p>
              <p className="truncate text-[11px] tabular-nums text-muted-foreground">
                {spend.byCourt[0].sublabel} · {peso(spend.byCourt[0].amount)}
              </p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

// ===========================================================================
// Sports + favourites
// ===========================================================================

function SportsSection({ stats }: { stats: ReturnType<typeof buildPlayerStats> }) {
  const { sports, topSport, topVenue, topCourt, usualTime, avgSessionHours, avgPerBooking } = stats;

  return (
    <section id={PLAYER_ANCHORS.sports} className="mt-8">
      <SectionHead title="Your sports" sub="Worked out from the games you actually played" />

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Your #1 sport
          </p>
          {topSport ? (
            <>
              <p className="mt-2 font-cabinet text-2xl font-bold leading-none">{topSport.label}</p>
              <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                {Math.round(topSport.share)}% of your games · {topSport.bookings} session
                {topSport.bookings > 1 ? "s" : ""} · {topSport.hours} hr
                {topSport.hours > 1 ? "s" : ""}
              </p>
              <ul className="mt-4 space-y-2.5 border-t border-border pt-3">
                {sports.map((s) => (
                  <li key={s.key}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate font-semibold">{s.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {s.bookings} · {s.hours} hr{s.hours > 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${s.share}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Play a game and your sports will show up here.
            </p>
          )}
        </article>

        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Your home court
          </p>
          {topVenue ? (
            <>
              <p className="mt-2 truncate font-cabinet text-xl font-bold leading-tight">
                {topVenue.label}
              </p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {topVenue.bookings} booking{topVenue.bookings > 1 ? "s" : ""} · {topVenue.hours} hr
                {topVenue.hours > 1 ? "s" : ""} · {peso(topVenue.amount)} spent
              </p>
              {topCourt && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Most-used court
                  </p>
                  <p className="mt-1 truncate font-display text-sm font-bold">{topCourt.label}</p>
                  <p className="truncate text-[11px] tabular-nums text-muted-foreground">
                    {topCourt.sublabel} · {topCourt.bookings} booking
                    {topCourt.bookings > 1 ? "s" : ""}
                  </p>
                  <Link
                    to="/courts/$courtId"
                    params={{ courtId: topCourt.key }}
                    className="mt-3 inline-flex items-center gap-1 rounded-full bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground transition hover:opacity-90"
                  >
                    <RotateCcw className="h-3 w-3" /> Book again
                  </Link>
                </div>
              )}
            </>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Once you have played somewhere, it will show here.
            </p>
          )}
        </article>

        <article className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Your habits
          </p>
          <dl className="mt-3 space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Usual playing time</dt>
              <dd className="font-display font-bold">{usualTime ? usualTime.label : "—"}</dd>
            </div>
            {usualTime && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Typically</dt>
                <dd className="font-display font-bold tabular-nums">{usualTime.range}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Average session</dt>
              <dd className="font-display font-bold tabular-nums">{humanHours(avgSessionHours)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Average booking</dt>
              <dd className="font-display font-bold tabular-nums">{peso(avgPerBooking)}</dd>
            </div>
          </dl>

          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Days you play
            </p>
            <div className="mt-2 flex h-14 items-end gap-1">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => {
                const peak = Math.max(1, ...stats.byWeekday);
                return (
                  <div
                    key={i}
                    className="group flex flex-1 flex-col items-center gap-1"
                    title={`${stats.byWeekday[i]} game${stats.byWeekday[i] === 1 ? "" : "s"}`}
                  >
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className={`w-full rounded-t-md transition-all ${
                          stats.byWeekday[i] === peak && peak > 0
                            ? "bg-primary"
                            : "bg-primary/30 group-hover:bg-primary/50"
                        }`}
                        style={{
                          height: `${Math.max(stats.byWeekday[i] > 0 ? 12 : 5, (stats.byWeekday[i] / peak) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-[9px] font-bold text-muted-foreground">{d}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

// ===========================================================================
// Cancellations
// ===========================================================================

function CancellationSummary({
  stats,
  periodLabel,
}: {
  stats: ReturnType<typeof buildPlayerStats>;
  periodLabel: string;
}) {
  const { counts, spend } = stats;
  if (counts.cancelled === 0) return null;

  const rate =
    counts.completed + counts.cancelled > 0
      ? (counts.cancelled / (counts.completed + counts.cancelled)) * 100
      : 0;
  /* Only the player's own cancellations count towards a rate they might be judged
     on. A venue pulling a court, or a hold timing out, is not their behaviour. */
  const ownRate =
    counts.completed + counts.cancelledByPlayer > 0
      ? (counts.cancelledByPlayer / (counts.completed + counts.cancelledByPlayer)) * 100
      : 0;

  return (
    <section id={PLAYER_ANCHORS.insights} className="mt-8">
      <SectionHead title="Cancellations" sub={periodLabel.toLowerCase()} />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Cancelled
          </p>
          <p className="mt-2 font-cabinet text-3xl font-bold tabular-nums">{counts.cancelled}</p>
          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
            {Math.round(rate)}% of your bookings
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            By you
          </p>
          <p className="mt-2 font-cabinet text-3xl font-bold tabular-nums">
            {counts.cancelledByPlayer}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
            {Math.round(ownRate)}% own cancellation rate
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            By the venue
          </p>
          <p className="mt-2 font-cabinet text-3xl font-bold tabular-nums">
            {counts.cancelledByVenue}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">Not counted against you</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Refunds
          </p>
          <p className="mt-2 font-cabinet text-3xl font-bold tabular-nums">
            {pesoShort(spend.refunded)}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
            {spend.pendingRefund > 0 ? `${peso(spend.pendingRefund)} still pending` : "All settled"}
          </p>
        </div>
      </div>
      {counts.expired > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {counts.expired} unpaid hold{counts.expired > 1 ? "s" : ""} expired before payment — these
          are not cancellations.
        </p>
      )}
    </section>
  );
}

// ===========================================================================
// Insights — only statements the data can actually support
// ===========================================================================

function Insights({
  stats,
  periodLabel,
}: {
  stats: ReturnType<typeof buildPlayerStats>;
  periodLabel: string;
}) {
  const lines: string[] = [];
  const { topSport, topVenue, usualTime, spend, sessionsPlayed, hoursPlayed } = stats;

  if (topSport && topSport.bookings > 1) {
    lines.push(
      `You played ${topSport.label} ${topSport.bookings} times ${periodLabel.toLowerCase()} — ${Math.round(topSport.share)}% of your games.`,
    );
  }
  if (topVenue && topVenue.bookings > 1) {
    lines.push(`${topVenue.label} is your most visited venue, with ${topVenue.bookings} bookings.`);
  }
  if (spend.delta !== null && Math.abs(spend.deltaAmount) >= 1) {
    lines.push(
      spend.deltaAmount < 0
        ? `You spent ${peso(Math.abs(spend.deltaAmount))} less than the period before.`
        : `You spent ${peso(spend.deltaAmount)} more than the period before.`,
    );
  }
  if (usualTime && usualTime.count > 1) {
    lines.push(`Your usual playing time is ${usualTime.range.toLowerCase()}.`);
  }
  if (hoursPlayed > 0) {
    lines.push(
      `You have played ${humanHours(hoursPlayed)} across ${sessionsPlayed} session${sessionsPlayed > 1 ? "s" : ""}.`,
    );
  }
  if (spend.outstanding > 0) {
    lines.push(`You have ${peso(spend.outstanding)} still to pay on upcoming bookings.`);
  }

  if (lines.length === 0) return null;

  return (
    <section id={PLAYER_ANCHORS.cancellations} className="mt-8">
      <SectionHead title="Insights" sub="Worked out from your bookings — nothing estimated" />
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {lines.slice(0, 6).map((l) => (
          <li
            key={l}
            className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-3 text-xs"
          >
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ===========================================================================
// History
// ===========================================================================

type HistoryTab = "all" | "completed" | "cancelled";

function HistorySection({
  stats,
  idx,
  userId,
  focusBookingId,
  onMessage,
}: {
  stats: ReturnType<typeof buildPlayerStats>;
  idx: TxIndex;
  userId: string;
  focusBookingId?: number;
  onMessage: (s: PlayerSession) => void;
}) {
  const [tab, setTab] = useState<HistoryTab>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(6);

  const rows = useMemo(() => {
    const pool =
      tab === "completed"
        ? stats.completed
        : tab === "cancelled"
          ? stats.cancelled
          : [...stats.completed, ...stats.cancelled];
    const sorted = pool.slice().sort((a, b) => b.start_time.localeCompare(a.start_time));
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((s) => {
      const c = s.first.courts;
      return [c?.venues?.name, c?.name, c?.sports?.name, c?.venues?.address, fmtDate(s.start_time)]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(needle));
    });
  }, [tab, stats.completed, stats.cancelled, q]);

  if (!stats.hasAnyBooking) return null;

  return (
    <section id={PLAYER_ANCHORS.history} className="mt-8">
      <SectionHead title="Booking history" sub="Everything that already happened" />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full border border-border bg-card p-1">
          {(
            [
              ["all", "All"],
              ["completed", "Completed"],
              ["cancelled", "Cancelled"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              onClick={() => {
                setTab(k);
                setLimit(6);
              }}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${
                tab === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l}
              <span className="ml-1 tabular-nums opacity-70">
                {k === "all"
                  ? stats.completed.length + stats.cancelled.length
                  : k === "completed"
                    ? stats.completed.length
                    : stats.cancelled.length}
              </span>
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search venue, court, sport or date"
            aria-label="Search booking history"
            className="w-full rounded-full border border-border bg-background py-1.5 pl-8 pr-8 text-xs outline-none transition focus:border-primary"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border p-8 text-center">
          <p className="font-display text-sm font-bold">{q ? "No match" : "Nothing here yet"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {q
              ? `Nothing in your history matches "${q}".`
              : "Your completed and cancelled games will appear here."}
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-4 grid gap-3">
            {rows.slice(0, limit).map((s) => (
              <BookingCard
                key={s.key}
                session={s}
                idx={idx}
                userId={userId}
                onMessage={onMessage}
              />
            ))}
          </ul>
          {rows.length > limit && (
            <button
              onClick={() => setLimit((n) => n + 10)}
              className="mt-3 w-full rounded-xl border border-border bg-card py-2.5 text-xs font-bold transition hover:border-primary hover:text-primary"
            >
              Show {Math.min(10, rows.length - limit)} more · {rows.length - limit} remaining
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ===========================================================================
// Calendar view
// ===========================================================================

type CalMode = "month" | "week" | "day";

const CAL_MODES: { key: CalMode; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "day", label: "Day" },
];

const WEEKDAY_HEADS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const midnight = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d: Date) => addDays(midnight(d), -midnight(d).getDay());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Hours from that day's midnight. Doing the arithmetic in milliseconds rather than
 *  reading `getHours()` is what makes a session ending at midnight land on 24 instead
 *  of wrapping to 0 and drawing a block of negative height. */
function dayOffsets(session: PlayerSession) {
  const start = new Date(session.start_time);
  const base = midnight(start).getTime();
  const from = (new Date(session.start_time).getTime() - base) / 3_600_000;
  const to = Math.min(24, (new Date(session.end_time).getTime() - base) / 3_600_000);
  return { from, to: to <= from ? Math.min(24, from + 1) : to };
}

/** Sports have no slug on the player's booking rows, so the name stands in — the
 *  tenant calendar falls back to exactly the same key, which is what keeps one
 *  sport the same colour on both calendars. */
const styleOf = (s: PlayerSession) => sportStyle(s.first.courts?.sports?.name?.toLowerCase());

const isDeadSession = (s: PlayerSession) =>
  s.first.status === "cancelled" || s.first.status === "expired";

/** "7 PM", "7:30 PM" — the minutes only earn their space when they are not zero. */
const chipTime = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })
    .replace(":00", "");

/**
 * The player's calendar.
 *
 * Built on the tenant calendar's vocabulary — view pills, ‹ Today ›, sport-coloured
 * blocks on an hour grid, a now-line, and a list of the selected day underneath — so
 * a player who has seen a venue's calendar already knows how to read this one.
 *
 * What differs is the axis, because a player's question is different. A venue asks
 * "which of my courts is busy", so its columns are courts. A player asks "when am I
 * playing", so the columns are days: a month to see the shape of the month, a week
 * to see the shape of the week, a day when there is more than one game in it.
 *
 * The hour window is derived from the bookings on screen rather than fixed at 24
 * hours. Nobody books 3 AM, and a grid that devotes two thirds of its height to
 * hours no one plays is the reason a day view gets ignored; `Full 24h` is there for
 * the rare booking that falls outside the window.
 */
function CalendarView({
  rows,
  idx,
  userId,
}: {
  rows: PlayerBookingRow[];
  idx: TxIndex;
  userId: string;
}) {
  const [mode, setMode] = useState<CalMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => midnight(new Date()));
  const [selected, setSelected] = useState<string>(() => dayKey(new Date()));
  const [showCancelled, setShowCancelled] = useState(false);
  const [fullDay, setFullDay] = useState(false);

  /* The now-line and the "today" ring are wrong the moment the clock moves on, and a
     workspace tab lives for hours. A minute is as fine as anything here renders. */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const sessions = useMemo(() => groupBookingSessions(rows), [rows]);
  const visible = useMemo(
    () => (showCancelled ? sessions : sessions.filter((s) => !isDeadSession(s))),
    [sessions, showCancelled],
  );
  const cancelledCount = useMemo(() => sessions.filter(isDeadSession).length, [sessions]);

  const byDay = useMemo(() => {
    const m = new Map<string, PlayerSession[]>();
    for (const s of visible) {
      const k = dayKey(s.start_time);
      const list = m.get(k);
      if (list) list.push(s);
      else m.set(k, [s]);
    }
    for (const list of m.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    return m;
  }, [visible]);

  /* The period is what the summary counts and what "is the selected day still on
     screen" is judged against. It is the real month/week/day — not the 42 cells a
     month grid draws, which spill into the neighbouring months. */
  const [periodStart, periodEnd] = useMemo(() => {
    if (mode === "day") {
      const s = midnight(anchor);
      return [s, addDays(s, 1)] as const;
    }
    if (mode === "week") {
      const s = startOfWeek(anchor);
      return [s, addDays(s, 7)] as const;
    }
    const s = startOfMonth(anchor);
    return [s, new Date(s.getFullYear(), s.getMonth() + 1, 1)] as const;
  }, [mode, anchor]);

  const daysInView = useMemo(() => {
    if (mode === "day") return [midnight(anchor)];
    if (mode === "week") {
      const s = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(s, i));
    }
    // Six full weeks, always — a month grid that changes height between June and
    // July makes the whole page jump when you page through it.
    const first = startOfMonth(anchor);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [mode, anchor]);

  const periodSessions = useMemo(
    () =>
      visible.filter((s) => {
        const t = new Date(s.start_time).getTime();
        return t >= periodStart.getTime() && t < periodEnd.getTime();
      }),
    [visible, periodStart, periodEnd],
  );

  /* Paging to a month the selected day is not in would otherwise leave the list
     below the grid showing a day nobody can see. Prefer today, then the first day
     in view that actually has a booking, then the start of the period. */
  useEffect(() => {
    const within = (k: string) => {
      const t = new Date(`${k}T00:00:00`).getTime();
      return t >= periodStart.getTime() && t < periodEnd.getTime();
    };
    if (within(selected)) return;
    const todayKey = dayKey(new Date());
    if (within(todayKey)) {
      setSelected(todayKey);
      return;
    }
    const booked = daysInView
      .filter((d) => d >= periodStart && d < periodEnd)
      .map(dayKey)
      .find((k) => (byDay.get(k)?.length ?? 0) > 0);
    setSelected(booked ?? dayKey(periodStart));
  }, [selected, periodStart, periodEnd, daysInView, byDay]);

  /* Only the grid modes need an hour window, and only over the days they draw. */
  const gridSessions = useMemo(() => {
    if (mode === "month") return [];
    const keys = new Set(daysInView.map(dayKey));
    return visible.filter((s) => keys.has(dayKey(s.start_time)));
  }, [mode, daysInView, visible]);

  const [hourStart, hourEnd] = useMemo(() => {
    if (fullDay) return [0, 24] as const;
    let lo = 24;
    let hi = 0;
    for (const s of gridSessions) {
      const { from, to } = dayOffsets(s);
      lo = Math.min(lo, Math.floor(from));
      hi = Math.max(hi, Math.ceil(to));
    }
    // Nothing booked in view — an evening-weighted window, which is when courts
    // are actually played, beats a blank 24-hour column.
    if (lo >= hi) return [7, 22] as const;
    return [Math.max(0, lo - 1), Math.min(24, hi + 1)] as const;
  }, [gridSessions, fullDay]);

  const rowH = mode === "day" ? 56 : 44;
  const hours = Math.max(1, hourEnd - hourStart);
  const gridHeight = hours * rowH;

  const todayKey = dayKey(now);
  const nowOffset = now.getHours() + now.getMinutes() / 60;
  const nowVisible = nowOffset >= hourStart && nowOffset <= hourEnd;

  const nudge = (delta: number) => {
    if (mode === "month") setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
    else if (mode === "week") setAnchor((d) => addDays(d, delta * 7));
    else setAnchor((d) => addDays(d, delta));
  };
  const goToday = () => {
    const t = midnight(new Date());
    setAnchor(t);
    setSelected(dayKey(t));
  };

  const periodLabel =
    mode === "month"
      ? periodStart.toLocaleDateString("en-PH", { month: "long", year: "numeric" })
      : mode === "week"
        ? `${periodStart.toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${addDays(
            periodStart,
            6,
          ).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`
        : periodStart.toLocaleDateString("en-PH", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          });

  const live = periodSessions.filter((s) => !isDeadSession(s));
  const hoursBooked = live.reduce((n, s) => n + s.hours, 0);
  const due = live.reduce((n, s) => n + sessionBalance(s, idx), 0);
  const dayList = byDay.get(selected) ?? [];

  const selectDay = (d: Date) => {
    setSelected(dayKey(d));
    // Clicking into a neighbouring month's cell should follow it, not silently
    // select a day the grid is about to stop showing.
    if (mode === "month" && (d < periodStart || d >= periodEnd)) setAnchor(midnight(d));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Player workspace
          </p>
          <h1 className="mt-1 font-cabinet text-2xl font-bold tracking-tight sm:text-3xl">
            Your calendar
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every court you have booked, by {mode}. Pick a day to see the detail.
          </p>
        </div>
        <Link
          to="/explore"
          search={{}}
          className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90"
        >
          Find a court
        </Link>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-full border border-border bg-card">
            {CAL_MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                aria-pressed={mode === m.key}
                className={
                  "px-4 py-1.5 text-xs transition " +
                  (mode === m.key
                    ? "bg-foreground font-semibold text-background"
                    : "font-medium text-muted-foreground hover:bg-secondary")
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => nudge(-1)}
              aria-label={`Previous ${mode}`}
              className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:bg-secondary"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={goToday}
              className={
                "rounded-full px-4 py-1.5 text-xs font-semibold " +
                (dayKey(periodStart) <= todayKey && todayKey < dayKey(periodEnd)
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-card hover:bg-secondary")
              }
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => nudge(1)}
              aria-label={`Next ${mode}`}
              className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:bg-secondary"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="text-sm font-semibold sm:text-base">{periodLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode !== "month" && (
            <button
              type="button"
              onClick={() => setFullDay((v) => !v)}
              title="The grid trims itself to the hours you actually booked"
              className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold hover:bg-secondary"
            >
              {fullDay ? "Full 24h" : "Fitted hours"}
            </button>
          )}
          {cancelledCount > 0 && (
            <button
              type="button"
              onClick={() => setShowCancelled((v) => !v)}
              aria-pressed={showCancelled}
              className={
                "rounded-full px-3 py-1 text-[11px] font-semibold " +
                (showCancelled
                  ? "bg-foreground text-background"
                  : "border border-border bg-card hover:bg-secondary")
              }
            >
              Cancelled ({cancelledCount})
            </button>
          )}
        </div>
      </div>

      {/* What this period holds */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          icon={CalendarDays}
          label={mode === "month" ? "This month" : mode === "week" ? "This week" : "This day"}
          value={String(live.length)}
          hint={live.length === 1 ? "session" : "sessions"}
          tone="primary"
        />
        <StatTile
          icon={Timer}
          label="Court time"
          value={humanHours(hoursBooked)}
          hint="booked in view"
        />
        <StatTile
          icon={Wallet}
          label="Balance due"
          value={peso(due)}
          hint={due > 0 ? "still to pay" : "all settled"}
          tone={due > 0 ? "warning" : "neutral"}
        />
      </div>

      {/* Grid */}
      {mode === "month" ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="grid grid-cols-7 border-b border-border bg-secondary/40">
            {WEEKDAY_HEADS.map((d) => (
              <div
                key={d}
                className="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
              >
                <span className="hidden sm:inline">{d}</span>
                <span className="sm:hidden">{d[0]}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {daysInView.map((d, i) => {
              const k = dayKey(d);
              const list = byDay.get(k) ?? [];
              const outside = d < periodStart || d >= periodEnd;
              const isToday = k === todayKey;
              const isSel = k === selected;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => selectDay(d)}
                  aria-pressed={isSel}
                  className={
                    "min-h-22 border-border p-1.5 text-left align-top transition sm:min-h-28 sm:p-2 " +
                    (i % 7 === 0 ? "" : "border-l ") +
                    (i >= 7 ? "border-t " : "") +
                    (outside ? "bg-muted/30 " : "") +
                    (isSel ? "bg-primary/10 ring-2 ring-inset ring-primary " : "hover:bg-secondary/60")
                  }
                >
                  <span className="flex items-center justify-between">
                    <span
                      className={
                        "grid h-6 w-6 place-items-center rounded-full text-xs font-bold tabular-nums " +
                        (isToday
                          ? "bg-primary text-primary-foreground"
                          : outside
                            ? "text-muted-foreground/60"
                            : "text-foreground")
                      }
                    >
                      {d.getDate()}
                    </span>
                    {list.length > 0 && (
                      <span className="text-[9px] font-bold text-muted-foreground sm:hidden">
                        {list.length}
                      </span>
                    )}
                  </span>

                  {/* Phones do not have room for a chip; a row of dots still answers
                      "did I play that day, and at how many". */}
                  <span className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                    {list.slice(0, 4).map((s) => (
                      <span
                        key={s.key}
                        className={`h-1.5 w-1.5 rounded-full ${styleOf(s).dot} ${isDeadSession(s) ? "opacity-40" : ""}`}
                      />
                    ))}
                  </span>

                  <span className="mt-1 hidden flex-col gap-0.5 sm:flex">
                    {list.slice(0, 3).map((s) => {
                      const st = styleOf(s);
                      const dead = isDeadSession(s);
                      return (
                        <span
                          key={s.key}
                          title={`${formatSessionLabel(s.start_time, s.end_time)} · ${s.first.courts?.venues?.name ?? "Venue"} · ${s.first.courts?.name ?? ""}`}
                          className={`flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] font-semibold ${st.bg} ${st.text} ${dead ? "opacity-50 line-through" : ""}`}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} />
                          <span className="truncate">
                            {chipTime(s.start_time)} · {s.first.courts?.name ?? "Court"}
                          </span>
                        </span>
                      );
                    })}
                    {list.length > 3 && (
                      <span className="px-1 text-[10px] font-semibold text-muted-foreground">
                        +{list.length - 3} more
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card shadow-sm">
          <div className="nice-scroll max-h-[64vh] overflow-auto">
            <div className={mode === "week" ? "min-w-[38rem]" : "min-w-0"}>
              {/* Day headers */}
              <div className="sticky top-0 z-20 flex border-b border-border bg-card/95 backdrop-blur">
                <div className="sticky left-0 z-30 w-14 shrink-0 bg-card/95" />
                {daysInView.map((d) => {
                  const k = dayKey(d);
                  const isToday = k === todayKey;
                  const isSel = k === selected;
                  const count = (byDay.get(k) ?? []).length;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => selectDay(d)}
                      className={
                        "flex-1 border-l border-border px-2 py-2 text-center transition " +
                        (isSel ? "bg-primary/10" : "hover:bg-secondary/60")
                      }
                    >
                      <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {d.toLocaleDateString("en-PH", { weekday: "short" })}
                      </span>
                      <span
                        className={
                          "mx-auto mt-0.5 grid h-6 w-6 place-items-center rounded-full font-cabinet text-sm font-bold tabular-nums " +
                          (isToday ? "bg-primary text-primary-foreground" : "")
                        }
                      >
                        {d.getDate()}
                      </span>
                      <span className="mt-0.5 block text-[9px] font-semibold text-muted-foreground">
                        {count === 0 ? "—" : `${count} booked`}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Hour grid */}
              <div className="relative flex">
                <div className="sticky left-0 z-10 w-14 shrink-0 bg-card" style={{ height: gridHeight }}>
                  {Array.from({ length: hours }).map((_, i) => {
                    const h = hourStart + i;
                    const label = h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;
                    return (
                      <div key={h} style={{ height: rowH }} className="relative">
                        <span
                          className={`absolute right-2 whitespace-nowrap text-[10px] font-medium leading-none text-muted-foreground ${i === 0 ? "top-0.5" : "top-0 -translate-y-1/2"}`}
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {daysInView.map((d) => {
                  const k = dayKey(d);
                  const list = byDay.get(k) ?? [];
                  const isSel = k === selected;
                  return (
                    <div
                      key={k}
                      className={`relative flex-1 border-l border-border ${isSel ? "bg-primary/[0.04]" : ""}`}
                      style={{ height: gridHeight }}
                    >
                      {Array.from({ length: hours }).map((_, i) => (
                        <div
                          key={i}
                          style={{ top: i * rowH, height: rowH }}
                          className={`absolute inset-x-0 border-t ${(hourStart + i) % 6 === 0 ? "border-border" : "border-border/40"}`}
                        />
                      ))}

                      {list.map((s) => {
                        const { from, to } = dayOffsets(s);
                        const top = Math.max(0, (from - hourStart) * rowH);
                        const height = Math.max(
                          20,
                          (Math.min(to, hourEnd) - Math.max(from, hourStart)) * rowH - 3,
                        );
                        const st = styleOf(s);
                        const dead = isDeadSession(s);
                        const court = s.first.courts;
                        const range = formatTimeRange(s.start_time, s.end_time);
                        const roomy = height >= 46;
                        return (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => setSelected(k)}
                            title={`${range} · ${court?.venues?.name ?? "Venue"} · ${court?.name ?? ""} (${s.hours}h)`}
                            style={{ top, height }}
                            className={`absolute inset-x-1 flex flex-col justify-center overflow-hidden rounded-lg border px-1.5 py-0.5 text-left shadow-sm transition hover:brightness-95 ${st.bg} ${st.border} ${st.text} ${dead ? "opacity-50" : ""}`}
                          >
                            <span className="flex min-w-0 items-center gap-1 text-[11px] font-bold leading-tight">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} />
                              <span className="truncate">{court?.name ?? "Court"}</span>
                            </span>
                            {roomy && (
                              <>
                                <span className="truncate text-[10px] leading-tight opacity-80">
                                  {range}
                                </span>
                                <span className="truncate text-[10px] leading-tight opacity-70">
                                  {court?.venues?.name ?? "Venue"}
                                </span>
                              </>
                            )}
                          </button>
                        );
                      })}

                      {k === todayKey && nowVisible && (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-primary"
                          style={{ top: (nowOffset - hourStart) * rowH }}
                        >
                          <span className="absolute -left-0.5 -top-1 h-2 w-2 rounded-full bg-primary" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* The selected day, in full */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-bold">
            {new Date(`${selected}T00:00:00`).toLocaleDateString("en-PH", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            {selected === todayKey && (
              <span className="ml-2 rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                Today
              </span>
            )}
          </h2>
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
            {dayList.length} {dayList.length === 1 ? "booking" : "bookings"}
          </span>
        </div>

        {dayList.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border py-10 text-center">
            <p className="text-sm font-semibold">Nothing booked this day</p>
            <p className="mt-1 text-xs text-muted-foreground">Free to play — find a court and fill it.</p>
            <Link
              to="/explore"
              search={{}}
              className="mt-4 inline-flex rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:opacity-90"
            >
              Browse courts
            </Link>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {dayList.map((s) => (
              <CalendarDayRow key={s.key} session={s} idx={idx} userId={userId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One session on the selected day. The actions are the ones that only make sense
 *  from a calendar — get me there, put it in my phone — plus a way back to the
 *  booking card in My Bookings, where paying, messaging and cancelling live. */
function CalendarDayRow({
  session,
  idx,
  userId,
}: {
  session: PlayerSession;
  idx: TxIndex;
  userId: string;
}) {
  const court = session.first.courts;
  const st = styleOf(session);
  const dead = isDeadSession(session);
  const balance = sessionBalance(session, idx);
  const directions = directionsUrl(court);

  const addToCalendar = () => {
    const blob = new Blob([icsForSession(session)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `booking-${session.first.id}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <li className={`flex flex-wrap items-center justify-between gap-3 py-3 ${dead ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
        <div className="min-w-0">
          <p className="text-sm font-bold tabular-nums">
            {formatSessionLabel(session.start_time, session.end_time)}
            <span className="ml-2 text-xs font-medium text-muted-foreground">
              {session.hours}h
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">
              {court?.venues?.name ?? "Venue"}
            </span>
            {" · "}
            {court?.map_emoji ?? "🏟️"} {court?.name ?? "Court"}
            {court?.sports?.name ? ` · ${court.sports.name}` : ""}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge session={session} userId={userId} />
        {balance > 0 && !dead && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            {peso(balance)} due
          </span>
        )}
        {!dead && directions && (
          <a
            href={directions}
            target="_blank"
            rel="noreferrer"
            title="Directions"
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold hover:bg-secondary"
          >
            <Navigation className="h-3 w-3" /> Directions
          </a>
        )}
        {!dead && (
          <button
            type="button"
            onClick={addToCalendar}
            title="Download an .ics for this session"
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold hover:bg-secondary"
          >
            <CalendarPlus className="h-3 w-3" /> Add
          </button>
        )}
        <Link
          to="/dashboard"
          search={{ booking: session.first.id }}
          title="Open this booking in My Bookings"
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold hover:bg-secondary"
        >
          Details <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
    </li>
  );
}

// ===========================================================================
// Favorites
// ===========================================================================

/** One favorited court, shown with the venue it belongs to.
 *
 *  The whole tile is the link, and it lands on the venue page with `?court=` set —
 *  the same URL the venue's own "Book now" button produces, so a favorite drops the
 *  player straight into the booking panel for that court rather than at the top of
 *  a page they then have to search.
 *
 *  A court can be favorited and later retired, or its venue deactivated. That tile
 *  stops being a link and says so, rather than sending the player to a court they
 *  cannot book. The heart still works, so the list can be tidied. */
function FavoriteCourtTile({ court, userId }: { court: FavoriteCourt; userId: string }) {
  const venue = court.venues;
  const soon = !!court.coming_soon;
  const retired = !court.is_active || !venue || !venue.is_active;
  const image = court.images?.[0];

  const rules = normalizeRules(court.rate_rules);
  const hrs = effectiveHours(
    { inherit_venue_hours: court.inherit_venue_hours, operating_hours: court.operating_hours },
    venue?.operating_hours,
  );
  const base = Number(court.hourly_rate);
  const varies = hasVariablePricing(base, rules, hrs);
  const lo = varies ? minRate(base, rules, hrs) : base;

  const body = (
    <>
      <div className="relative">
        {image ? (
          <img src={image} alt={court.name} className={`h-36 w-full object-cover ${retired ? "grayscale" : ""}`} />
        ) : (
          <div className={`court-pattern h-36 ${retired ? "grayscale" : ""}`} />
        )}
        {(soon || retired) && (
          <span
            className={
              "absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow " +
              (retired ? "bg-muted-foreground" : "bg-amber-500")
            }
          >
            {retired ? "Unavailable" : "Coming soon"}
          </span>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1 font-medium text-secondary-foreground">
            {court.map_emoji && <span aria-hidden>{court.map_emoji}</span>}
            <span>{court.sports?.name ?? "Court"}</span>
          </span>
          <span className="font-semibold text-muted-foreground">
            {court.is_indoor ? "Indoor" : "Outdoor"}
          </span>
        </div>
        <h3 className="mt-2 truncate font-display text-xl font-bold tracking-tight">{court.name}</h3>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold text-foreground">{venue?.name ?? "Venue removed"}</span>
            {venue?.address && <span className="block truncate">{venue.address}</span>}
          </span>
        </p>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            {varies && (
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                from
              </span>
            )}
            <span className="font-display text-xl font-extrabold tabular-nums">{peso(lo)}</span>
            <span className="text-xs text-muted-foreground"> / hour</span>
          </div>
          {retired ? (
            <span className="text-xs font-semibold text-muted-foreground">Not bookable</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition group-hover:brightness-110">
              {soon ? "View court" : "Book again"}
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:shadow-md">
      <FavoriteButton
        courtId={court.id}
        courtName={court.name}
        userId={userId}
        className="absolute right-3 top-3"
      />
      {retired ? (
        <div className="block cursor-default">{body}</div>
      ) : (
        <Link
          to="/venues/$venueId"
          params={{ venueId: String(venue!.id) }}
          search={{ court: court.id }}
          className="block"
        >
          {body}
        </Link>
      )}
    </div>
  );
}

/** The Favorites pane: every court the player hearted, newest first, each with the
 *  venue it belongs to and a route straight back into booking it. */
function FavoritesView({ userId }: { userId: string }) {
  const favQ = useFavoriteCourts(userId);
  const rows = favQ.data ?? [];

  return (
    <div className="space-y-5">
      <SectionHead
        title="Favorites"
        sub={
          favQ.isLoading
            ? "Loading your saved courts…"
            : rows.length === 0
              ? "Courts you save show up here"
              : `${rows.length} saved court${rows.length === 1 ? "" : "s"} — tap one to book it again`
        }
        action={
          <Link
            to="/explore"
            search={{}}
            className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90"
          >
            Find a court
          </Link>
        }
      />

      {favQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl bg-secondary/50" />
          ))}
        </div>
      ) : favQ.isError ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Your favorites could not be loaded. Refresh the page to try again.
        </p>
      ) : rows.length === 0 ? (
        <div className="grid min-h-[45vh] place-items-center rounded-2xl border border-dashed border-border">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-primary">
              <Heart className="h-7 w-7" />
            </div>
            <h2 className="mt-5 font-cabinet text-xl font-bold tracking-tight">No favorites yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Open a venue and hover a court tile — the heart in its corner saves that court
              here, so booking it again is two clicks instead of a search.
            </p>
            <Link
              to="/explore"
              search={{}}
              className="mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90"
            >
              Browse venues
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <FavoriteCourtTile key={row.court_id} court={row.courts!} userId={userId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Workspace
// ===========================================================================

export function PlayerWorkspace({
  userId,
  fullName,
  email,
  avatarUrl,
  view,
  focusBookingId,
  openChatOnArrival,
}: {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  view: "bookings" | "calendar" | "favorites" | "settings";
  /** From `?booking=` on a reminder or message notification. */
  focusBookingId?: number;
  /** From `?chat=1` — a message notification wants the conversation open, not just
   *  the booking scrolled into view. */
  openChatOnArrival?: boolean;
}) {
  const qc = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [chat, setChat] = useState<{
    bookingId: number;
    venueId: number;
    title: string;
    subtitle: string;
  } | null>(null);

  const bookingsQ = useQuery({
    queryKey: ["player-bookings", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select(BOOKING_SELECT)
        .eq("user_id", userId)
        .order("start_time", { ascending: false })
        .limit(400);
      if (error) throw error;
      return (data as unknown as PlayerBookingRow[]) ?? [];
    },
  });

  const txQ = useQuery({
    queryKey: ["player-transactions", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select(TX_SELECT)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(800);
      if (error) throw error;
      return (data as unknown as PlayerTransaction[]) ?? [];
    },
  });

  const rows = useMemo(() => bookingsQ.data ?? [], [bookingsQ.data]);
  const txs = useMemo(() => txQ.data ?? [], [txQ.data]);
  const idx = useMemo(() => indexTransactions(txs), [txs]);
  const stats = useMemo(
    () => buildPlayerStats({ rows, transactions: txs, userId, period }),
    [rows, txs, userId, period],
  );

  // ---- Payment ----------------------------------------------------------
  const retryFn = useServerFn(retryBookingPayment);
  const cancelPendingFn = useServerFn(cancelPendingBookings);
  const [payFor, setPayFor] = useState<{ ids: number[]; amount: number; label: string } | null>(
    null,
  );
  const [payMethod, setPayMethod] = useState<"gcash" | "paymaya" | "grab_pay" | "qrph">("gcash");
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  const openPay = (s: PlayerSession) => {
    setPayFor({
      ids: s.ids,
      amount: sessionBalance(s, idx),
      label: `${s.first.courts?.venues?.name ?? ""} · ${s.first.courts?.name ?? ""}`,
    });
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

  /* Cancelling stamps `cancelled_by` with the player's own id. Without it the row is
     indistinguishable from an expired hold, and the cancellation summary would report
     the player's own cancellations as nobody's. */
  const cancelMut = useMutation({
    mutationFn: async (session: PlayerSession) => {
      const unpaid = sessionPaid(session, idx) === 0 && session.first.status === "pending";
      if (unpaid) {
        await cancelPendingFn({ data: { bookingIds: session.ids } });
        return;
      }
      const { error } = await supabase
        .from("bookings")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancelled_by: userId,
          cancel_reason: "Cancelled by player",
        })
        .in("id", session.ids)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["player-bookings", userId] });
      qc.invalidateQueries({ queryKey: ["player-transactions", userId] });
    },
  });

  const askCancel = (s: PlayerSession) => {
    const when = `${fmtDateShort(s.start_time)} · ${formatSessionLabel(s.start_time, s.end_time)}`;
    const paid = sessionPaid(s, idx);
    const note =
      paid > 0
        ? `\n\n${peso(paid)} has been paid. Any refund follows the venue's policy.`
        : "\n\nThis booking is not paid, so nothing will be charged.";
    if (confirm(`Cancel this booking?\n\n${when}${note}`)) cancelMut.mutate(s);
  };

  /* useCallback because the deep-link effect below depends on it; an unstable
     identity would re-run that effect on every render. */
  const openChat = useCallback((s: PlayerSession) => {
    const vId = s.first.courts?.venues?.id;
    if (!vId) return;
    setChat({
      bookingId: s.first.id,
      venueId: vId,
      title: s.first.courts?.venues?.name ?? "Venue",
      subtitle: `${fmtDate(s.start_time)} · ${formatSessionLabel(s.start_time, s.end_time)}`,
    });
  }, []);

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "All time";
  const loading = bookingsQ.isLoading || txQ.isLoading;

  /* A message notification wants the conversation itself. Opening it needs the
     session — the chat is keyed on the booking's venue — so this waits for the
     bookings query and then opens the session that contains the linked id. The ref
     makes it fire once per target: `stats` is rebuilt every render, and without it
     closing the chat would immediately reopen it. */
  const chatOpened = useRef<number | null>(null);
  useEffect(() => {
    if (!openChatOnArrival || !focusBookingId || loading) return;
    if (chatOpened.current === focusBookingId) return;
    const all = [...stats.upcoming, ...stats.completed, ...stats.cancelled];
    const session = all.find((s) => s.ids.includes(focusBookingId));
    if (!session) return;
    chatOpened.current = focusBookingId;
    openChat(session);
  }, [openChatOnArrival, focusBookingId, loading, stats, openChat]);

  /* A reminder deep-links to one booking. Scroll to it once the list it lives in has
     actually rendered — before the query settles there is nothing to scroll to. */
  useEffect(() => {
    if (!focusBookingId || loading) return;
    const el = document.getElementById(`booking-${focusBookingId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusBookingId, loading]);

  const shell = (children: React.ReactNode) => (
    <PlayerShell
      section={
        view === "calendar"
          ? "calendar"
          : view === "favorites"
            ? "favorites"
            : view === "settings"
              ? "settings"
              : "bookings"
      }
      mobileOpen={mobileOpen}
      setMobileOpen={setMobileOpen}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      userId={userId}
      fullName={fullName}
      avatarUrl={avatarUrl}
      onSignOut={async () => {
        await supabase.auth.signOut();
        window.location.href = "/";
      }}
    >
      {children}
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
      {payFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-bold">Complete payment</h3>
                <p className="mt-1 text-xs text-muted-foreground">{payFor.label}</p>
              </div>
              <button
                onClick={() => setPayFor(null)}
                className="rounded-lg p-1 hover:bg-muted"
                disabled={payBusy}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 rounded-xl bg-secondary/60 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {payFor.ids.length} hour{payFor.ids.length > 1 ? "s" : ""}
                </span>
                <span className="font-display font-bold tabular-nums">{peso(payFor.amount)}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                The full amount is collected online; your slot is held once it clears.
              </p>
            </div>
            <div className="mt-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Payment method
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(
                  [
                    { v: "gcash", l: "GCash" },
                    { v: "paymaya", l: "Maya" },
                    { v: "grab_pay", l: "GrabPay" },
                    { v: "qrph", l: "QR Ph" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.v}
                    onClick={() => setPayMethod(m.v)}
                    disabled={payBusy}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                      payMethod === m.v
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50"
                    }`}
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
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {payBusy ? "Redirecting…" : "Continue to pay"}
              </button>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              Your slot is only reserved after payment succeeds.
            </p>
          </div>
        </div>
      )}
    </PlayerShell>
  );

  /* Ahead of the loading and no-bookings gates below, like favorites: Settings owns
     its own queries, and a player with nothing booked still has a profile to edit. */
  if (view === "settings")
    return shell(
      <PlayerSettingsView
        userId={userId}
        fullName={fullName}
        email={email}
        avatarUrl={avatarUrl}
      />,
    );

  if (view === "calendar") return shell(<CalendarView rows={rows} idx={idx} userId={userId} />);

  /* Ahead of the loading and no-bookings gates below: favorites are their own query,
     and a player with no bookings yet can still have saved courts — sending them to
     the "no bookings yet" invitation instead would hide the list they asked for. */
  if (view === "favorites") return shell(<FavoritesView userId={userId} />);

  if (loading) {
    return shell(
      <div className="space-y-4">
        <div className="h-56 animate-pulse rounded-3xl bg-secondary/50" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-secondary/40" />
          ))}
        </div>
        <div className="h-40 animate-pulse rounded-2xl bg-secondary/40" />
      </div>,
    );
  }

  // A brand-new player gets an invitation, not a wall of zeroes.
  if (!stats.hasAnyBooking) {
    return shell(
      <div className="grid min-h-[60vh] place-items-center">
        <div className="max-w-sm text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-3xl">
            🎾
          </div>
          <h1 className="mt-5 font-cabinet text-2xl font-bold tracking-tight">No bookings yet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Find a court and schedule your first game. Your schedule, spending and stats all show up
            here once you do.
          </p>
          <Link
            to="/explore"
            search={{}}
            className="mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90"
          >
            Find a court
          </Link>
        </div>
      </div>,
    );
  }

  return shell(
    <div>
      {/* Greeting */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Player workspace
          </p>
          <h1 className="mt-1 font-cabinet text-2xl font-bold tracking-tight sm:text-3xl">
            Welcome back, {fullName || email.split("@")[0]}
          </h1>
        </div>
        <Link
          to="/explore"
          search={{}}
          className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90"
        >
          Find a court
        </Link>
      </div>

      {/* 1 — Next game */}
      <div id={PLAYER_ANCHORS.nextGame} className="mt-5">
        {stats.next ? (
          <NextGame session={stats.next} idx={idx} onPay={openPay} onCancel={askCancel} />
        ) : (
          <section className="rounded-3xl border border-dashed border-border p-8 text-center">
            <p className="font-display text-base font-bold">No upcoming games</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Book a court and it will appear here with a countdown.
            </p>
            <Link
              to="/explore"
              search={{}}
              className="mt-4 inline-flex rounded-full bg-primary px-5 py-2 text-sm font-bold text-primary-foreground hover:opacity-90"
            >
              Find a court
            </Link>
          </section>
        )}
      </div>

      {/* Money owed is the one thing worth interrupting for. */}
      {stats.spend.outstanding > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="font-medium text-amber-800 dark:text-amber-200">
            {peso(stats.spend.outstanding)} still to pay across your upcoming bookings. Slots are
            only reserved once payment clears.
          </p>
        </div>
      )}

      {/* 2 — Upcoming */}
      {stats.upcoming.length > 0 && (
        <UpcomingSection
          sessions={stats.upcoming}
          idx={idx}
          userId={userId}
          focusBookingId={focusBookingId}
          onPay={openPay}
          onCancel={askCancel}
          onMessage={openChat}
        />
      )}

      {/* 3 — Activity, with the period switcher that governs everything below */}
      <section id={PLAYER_ANCHORS.activity} className="mt-8">
        <SectionHead
          title="Your activity"
          sub="Totals below follow this period"
          action={
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as PeriodKey)}
              aria-label="Statistics period"
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold outline-none transition focus:border-primary"
            >
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          }
        />
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={CalendarDays}
            label="Upcoming"
            value={String(stats.counts.upcoming)}
            hint={stats.next ? countdownLabel(stats.next.start_time) : "Nothing booked"}
            tone="primary"
          />
          <StatTile
            icon={Trophy}
            label="Completed"
            value={String(stats.counts.completed)}
            hint={`${stats.sports.length} sport${stats.sports.length === 1 ? "" : "s"} played`}
          />
          <StatTile
            icon={Timer}
            label="Hours played"
            value={humanHours(stats.hoursPlayed)}
            hint={
              stats.sessionsPlayed ? `${humanHours(stats.avgSessionHours)} average` : "No games yet"
            }
          />
          <StatTile
            icon={stats.spend.outstanding > 0 ? AlertTriangle : Wallet}
            label="Total spent"
            value={pesoShort(stats.spend.thisPeriod)}
            hint={
              stats.spend.outstanding > 0
                ? `${peso(stats.spend.outstanding)} still due`
                : `${peso(stats.avgPerBooking)} per game`
            }
            tone={stats.spend.outstanding > 0 ? "warning" : "neutral"}
          />
        </div>
      </section>

      {/* Historical analytics stay hidden until a game has actually been played —
          charts full of zeroes are worse than no charts. */}
      {stats.hasHistory ? (
        <>
          <SpendingSection stats={stats} periodLabel={periodLabel} />
          <SportsSection stats={stats} />
          <Insights stats={stats} periodLabel={periodLabel} />
        </>
      ) : (
        <p className="mt-6 rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Your spending and sports breakdown unlock once you have played your first game.
        </p>
      )}

      <CancellationSummary stats={stats} periodLabel={periodLabel} />
      <HistorySection
        stats={stats}
        idx={idx}
        userId={userId}
        focusBookingId={focusBookingId}
        onMessage={openChat}
      />
      <div className="h-8" />
    </div>,
  );
}
