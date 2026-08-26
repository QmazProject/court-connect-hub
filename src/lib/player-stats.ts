/**
 * Derived statistics for the player workspace.
 *
 * Everything here is pure: rows in, numbers out. The dashboard renders it, but the
 * rules live here so there is exactly one answer to "what did this booking cost"
 * and "who cancelled it" — the same answer the tenant side already gives.
 *
 * Three money values are deliberately kept apart, because conflating them is how a
 * dashboard ends up lying to someone about a refund:
 *
 *   price    — what the booking costs:  unit_price - discount_amount
 *   paid     — what actually reached the venue: transactions with status 'paid'
 *   refunded — what came back:                  transactions with status 'refunded'
 *
 * A refunded transaction is flipped from 'paid' to 'refunded' by the refund path, so
 * `paid` is already net of refunds and must not be reduced again.
 */

import { groupBookingSessions, type BookingSession } from "./booking-groups";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type PlayerCourt = {
  name: string;
  hourly_rate: number;
  map_emoji: string | null;
  images: string[] | null;
  sports: { name: string } | null;
  venues: {
    id: number;
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    is_active: boolean;
  } | null;
};

export type PlayerBookingRow = {
  id: number;
  court_id: number;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  refund_status: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  unit_price: number | null;
  discount_amount: number | null;
  created_at: string;
  courts: PlayerCourt | null;
};

export type PlayerTransaction = {
  id: string;
  booking_id: number;
  amount: number;
  status: string;
  method: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
  provider_ref: string | null;
};

export type PlayerSession = BookingSession<PlayerBookingRow>;

/** Why a booking is no longer happening. Venue cancellations are never counted
 *  against the player, and an unpaid hold that timed out is neither party's doing. */
export type CancelledBy = "player" | "venue" | "expired";

export type SessionState = "upcoming" | "completed" | "cancelled" | "expired";

export type PeriodKey = "month" | "last_month" | "3months" | "year" | "all";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "3months", label: "Last 3 months" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** What one hourly row costs. Mirrors the tenant bookings table exactly:
 *  `unit_price - discount_amount`, falling back to the court's current rate only
 *  when the row predates unit_price (the same fallback the checkout uses). */
export function rowPrice(row: PlayerBookingRow): number {
  const unit = row.unit_price ?? row.courts?.hourly_rate ?? 0;
  return Math.max(0, Number(unit) - Number(row.discount_amount ?? 0));
}

export function sessionPrice(session: PlayerSession): number {
  return session.items.reduce((sum, r) => sum + rowPrice(r), 0);
}

export type TxIndex = Map<number, PlayerTransaction[]>;

export function indexTransactions(txs: PlayerTransaction[]): TxIndex {
  const map: TxIndex = new Map();
  for (const t of txs) {
    const list = map.get(t.booking_id);
    if (list) list.push(t);
    else map.set(t.booking_id, [t]);
  }
  return map;
}

const sumTx = (list: PlayerTransaction[] | undefined, status: string) =>
  (list ?? []).reduce((sum, t) => (t.status === status ? sum + Number(t.amount || 0) : sum), 0);

/** Money that actually reached the venue for this session. */
export function sessionPaid(session: PlayerSession, idx: TxIndex): number {
  return session.ids.reduce((sum, id) => sum + sumTx(idx.get(id), "paid"), 0);
}

/** Money returned to the player for this session. */
export function sessionRefunded(session: PlayerSession, idx: TxIndex): number {
  return session.ids.reduce((sum, id) => sum + sumTx(idx.get(id), "refunded"), 0);
}

/** Still owed. Never negative: a partial refund or a rounded transaction can land
 *  fractionally above the price, and showing "-₱0.50 due" would be worse than
 *  showing nothing owed. */
export function sessionBalance(session: PlayerSession, idx: TxIndex): number {
  return Math.max(0, sessionPrice(session) - sessionPaid(session, idx));
}

/** The payment method the player actually used, if any transaction records one. */
export function sessionMethod(session: PlayerSession, idx: TxIndex): string | null {
  for (const id of session.ids) {
    const hit = (idx.get(id) ?? []).find(
      (t) => t.method && (t.status === "paid" || t.status === "refunded"),
    );
    if (hit?.method) return hit.method;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Attribute a cancellation.
 *
 *  `staff_cancel_bookings` stamps `cancelled_by` with the staff member's uid, and the
 *  player's own cancel stamps their own. Rows cancelled by the expiry jobs leave it
 *  NULL and explain themselves in `cancel_reason` — those are the ones that must not
 *  be blamed on anybody. The reason-text check also rescues player cancellations made
 *  before `cancelled_by` was written on that path. */
export function classifyCancellation(row: PlayerBookingRow, userId: string): CancelledBy {
  if (row.status === "expired") return "expired";
  if (row.cancelled_by) return row.cancelled_by === userId ? "player" : "venue";
  const reason = (row.cancel_reason ?? "").toLowerCase();
  if (reason.includes("cancelled by player")) return "player";
  if (reason.includes("expired")) return "expired";
  return "expired";
}

export function sessionState(session: PlayerSession, nowMs: number): SessionState {
  const r = session.first;
  if (r.status === "expired") return "expired";
  if (r.status === "cancelled") return "cancelled";
  return new Date(session.end_time).getTime() < nowMs ? "completed" : "upcoming";
}

/** Upcoming means: not cancelled, not expired, and it has not finished yet. */
export function isUpcoming(session: PlayerSession, nowMs: number) {
  return sessionState(session, nowMs) === "upcoming";
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Inclusive start of a period, or null for "all time". Uses local calendar
 *  boundaries so "this month" means what the player's calendar says. */
export function periodStart(period: PeriodKey, now: Date): Date | null {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  switch (period) {
    case "month":
      d.setDate(1);
      return d;
    case "last_month":
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return d;
    case "3months":
      d.setDate(1);
      d.setMonth(d.getMonth() - 2);
      return d;
    case "year":
      d.setMonth(0, 1);
      return d;
    case "all":
      return null;
  }
}

/** Exclusive end. Only "last month" ends before now. */
export function periodEnd(period: PeriodKey, now: Date): Date | null {
  if (period !== "last_month") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function inWindow(iso: string, start: Date | null, end: Date | null) {
  const t = new Date(iso).getTime();
  if (start && t < start.getTime()) return false;
  if (end && t >= end.getTime()) return false;
  return true;
}

/** Local calendar day, YYYY-MM-DD. en-CA because it sorts and compares as a string;
 *  the raw ISO would bucket by UTC and push a 9pm Manila booking to the next day. */
export const dayKey = (iso: string | Date) =>
  (typeof iso === "string" ? new Date(iso) : iso).toLocaleDateString("en-CA");

export const monthKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export type Breakdown = {
  key: string;
  label: string;
  sublabel?: string;
  amount: number;
  bookings: number;
  hours: number;
};

export type PlayerStats = {
  /** Sessions in play order, newest first, with state already resolved. */
  sessions: PlayerSession[];
  upcoming: PlayerSession[];
  completed: PlayerSession[];
  cancelled: PlayerSession[];
  next: PlayerSession | null;

  counts: {
    upcoming: number;
    completed: number;
    cancelled: number;
    cancelledByPlayer: number;
    cancelledByVenue: number;
    expired: number;
  };

  hoursPlayed: number;
  sessionsPlayed: number;
  avgSessionHours: number;
  avgPerBooking: number;

  spend: {
    total: number;
    refunded: number;
    pendingRefund: number;
    outstanding: number;
    byVenue: Breakdown[];
    byCourt: Breakdown[];
    bySport: Breakdown[];
    months: { key: string; label: string; amount: number }[];
    thisPeriod: number;
    prevPeriod: number;
    delta: number | null;
    deltaAmount: number;
  };

  sports: (Breakdown & { share: number })[];
  topSport: (Breakdown & { share: number }) | null;
  topVenue: Breakdown | null;
  topCourt: Breakdown | null;

  /** Most common start-hour band, for "your usual playing time". */
  usualTime: { label: string; range: string; count: number } | null;
  byWeekday: number[];

  hasAnyBooking: boolean;
  hasHistory: boolean;
};

const BANDS = [
  { label: "Morning", range: "5 AM – 11 AM", from: 5, to: 11 },
  { label: "Midday", range: "11 AM – 3 PM", from: 11, to: 15 },
  { label: "Evening", range: "3 PM – 8 PM", from: 15, to: 20 },
  { label: "Late", range: "8 PM – 5 AM", from: 20, to: 29 },
];

function bandFor(hour: number) {
  const h = hour < 5 ? hour + 24 : hour;
  return BANDS.find((b) => h >= b.from && h < b.to) ?? BANDS[3];
}

/* Sessions first, then hours, then money, then name. Without the full chain a tie —
   two sports played once each — resolves on Map insertion order, so the player's
   "#1 sport" could change between renders with no booking having changed. */
function byPopularity(a: Breakdown, b: Breakdown) {
  return (
    b.bookings - a.bookings ||
    b.hours - a.hours ||
    b.amount - a.amount ||
    a.label.localeCompare(b.label)
  );
}

function bump(
  map: Map<string, Breakdown>,
  key: string,
  label: string,
  sublabel: string | undefined,
  amount: number,
  hours: number,
) {
  const cur = map.get(key) ?? { key, label, sublabel, amount: 0, bookings: 0, hours: 0 };
  cur.amount += amount;
  cur.bookings += 1;
  cur.hours += hours;
  map.set(key, cur);
}

export function buildPlayerStats({
  rows,
  transactions,
  userId,
  now = new Date(),
  period = "all",
}: {
  rows: PlayerBookingRow[];
  transactions: PlayerTransaction[];
  userId: string;
  now?: Date;
  period?: PeriodKey;
}): PlayerStats {
  const nowMs = now.getTime();
  const idx = indexTransactions(transactions);

  // Group every row once. Sessions — not hourly rows — are the unit a player thinks
  // in: one Saturday afternoon is one game, not five bookings.
  const all = groupBookingSessions(rows).sort((a, b) => b.start_time.localeCompare(a.start_time));

  const start = periodStart(period, now);
  const end = periodEnd(period, now);
  /* Upcoming is never filtered by period — "this month" must not hide the game the
     player has on the 3rd of next month, which is the single thing the page exists
     to answer. Only the historical aggregates respect the window. */
  const inPeriod = (s: PlayerSession) => inWindow(s.start_time, start, end);

  const upcoming: PlayerSession[] = [];
  const completed: PlayerSession[] = [];
  const cancelled: PlayerSession[] = [];
  let cancelledByPlayer = 0;
  let cancelledByVenue = 0;
  let expired = 0;

  for (const s of all) {
    const state = sessionState(s, nowMs);
    if (state === "upcoming") {
      upcoming.push(s);
      continue;
    }
    if (!inPeriod(s)) continue;
    if (state === "completed") {
      completed.push(s);
      continue;
    }
    cancelled.push(s);
    const who = classifyCancellation(s.first, userId);
    if (who === "player") cancelledByPlayer += 1;
    else if (who === "venue") cancelledByVenue += 1;
    else expired += 1;
  }

  upcoming.sort((a, b) => a.start_time.localeCompare(b.start_time));

  const hoursPlayed = completed.reduce((sum, s) => sum + s.hours, 0);
  const sessionsPlayed = completed.length;

  // ---- Money -------------------------------------------------------------
  // Attribution walks bookings, not raw transactions, because sport and court only
  // exist on the booking. Venue is on both and they agree.
  const byVenue = new Map<string, Breakdown>();
  const byCourt = new Map<string, Breakdown>();
  const bySport = new Map<string, Breakdown>();

  let total = 0;
  let refunded = 0;
  let pendingRefund = 0;
  let outstanding = 0;

  const spendSessions = all.filter((s) => sessionState(s, nowMs) !== "upcoming" && inPeriod(s));
  for (const s of spendSessions) {
    const paid = sessionPaid(s, idx);
    const back = sessionRefunded(s, idx);
    total += paid;
    refunded += back;
    if (s.first.refund_status === "pending") pendingRefund += paid;

    const c = s.first.courts;
    if (paid > 0) {
      const venueName = c?.venues?.name ?? "Unknown venue";
      bump(
        byVenue,
        String(c?.venues?.id ?? venueName),
        venueName,
        c?.venues?.address ?? undefined,
        paid,
        s.hours,
      );
      bump(
        byCourt,
        String(s.first.court_id),
        c?.name ?? `Court #${s.first.court_id}`,
        venueName,
        paid,
        s.hours,
      );
      const sport = c?.sports?.name;
      if (sport) bump(bySport, sport, sport, undefined, paid, s.hours);
    }
  }

  // Outstanding is about the future: money owed on games still to be played.
  for (const s of upcoming) outstanding += sessionBalance(s, idx);

  // Six months of spend for the trend, regardless of the selected period — a
  // one-month window cannot show a trend.
  const spendByMonth = new Map<string, number>();
  for (const t of transactions) {
    if (t.status !== "paid") continue;
    const d = new Date(t.paid_at ?? t.created_at);
    spendByMonth.set(monthKey(d), (spendByMonth.get(monthKey(d)) ?? 0) + Number(t.amount || 0));
  }
  const anchor = new Date(now);
  anchor.setDate(1);
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() - (5 - i));
    return {
      key: monthKey(d),
      label: d.toLocaleDateString("en-PH", { month: "short" }),
      amount: spendByMonth.get(monthKey(d)) ?? 0,
    };
  });

  /* Period-over-period. Compared like-for-like: the window immediately before the
     selected one, same length. "All time" has nothing to compare against. */
  let thisPeriod = 0;
  let prevPeriod = 0;
  if (start) {
    const span = (end ?? now).getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - span);
    for (const t of transactions) {
      if (t.status !== "paid") continue;
      const when = t.paid_at ?? t.created_at;
      if (inWindow(when, start, end)) thisPeriod += Number(t.amount || 0);
      else if (inWindow(when, prevStart, start)) prevPeriod += Number(t.amount || 0);
    }
  } else {
    thisPeriod = total;
  }
  const delta = start && prevPeriod > 0 ? ((thisPeriod - prevPeriod) / prevPeriod) * 100 : null;

  // ---- Patterns ----------------------------------------------------------
  const bandCount = new Map<string, number>();
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const s of completed) {
    const d = new Date(s.start_time);
    byWeekday[d.getDay()] += 1;
    const band = bandFor(d.getHours());
    bandCount.set(band.label, (bandCount.get(band.label) ?? 0) + 1);
  }
  const topBandEntry = Array.from(bandCount).sort((a, b) => b[1] - a[1])[0];
  const usualTime = topBandEntry
    ? {
        label: topBandEntry[0],
        range: BANDS.find((b) => b.label === topBandEntry[0])!.range,
        count: topBandEntry[1],
      }
    : null;

  /* Sports are counted over completed sessions — the spec's "sport with the highest
     number of completed bookings" — so money and sessions can legitimately disagree
     when a cheap sport is played often. Both are shown. */
  const sportSessions = new Map<string, Breakdown>();
  for (const s of completed) {
    const name = s.first.courts?.sports?.name;
    if (!name) continue;
    bump(sportSessions, name, name, undefined, sessionPaid(s, idx), s.hours);
  }
  const sportTotal = Array.from(sportSessions.values()).reduce((sum, x) => sum + x.bookings, 0);
  const sports = Array.from(sportSessions.values())
    .map((x) => ({ ...x, share: sportTotal ? (x.bookings / sportTotal) * 100 : 0 }))
    .sort(byPopularity);

  const rank = (m: Map<string, Breakdown>) => Array.from(m.values()).sort(byPopularity);
  const venuesRanked = rank(byVenue);
  const courtsRanked = rank(byCourt);

  // Favourites go by completed sessions, so a single expensive visit does not
  // outrank the court the player actually lives on.
  const venueVisits = new Map<string, Breakdown>();
  const courtVisits = new Map<string, Breakdown>();
  for (const s of completed) {
    const c = s.first.courts;
    const venueName = c?.venues?.name ?? "Unknown venue";
    bump(
      venueVisits,
      String(c?.venues?.id ?? venueName),
      venueName,
      c?.venues?.address ?? undefined,
      sessionPaid(s, idx),
      s.hours,
    );
    bump(
      courtVisits,
      String(s.first.court_id),
      c?.name ?? `Court #${s.first.court_id}`,
      venueName,
      sessionPaid(s, idx),
      s.hours,
    );
  }

  return {
    sessions: all,
    upcoming,
    completed,
    cancelled,
    next: upcoming[0] ?? null,
    counts: {
      upcoming: upcoming.length,
      completed: completed.length,
      cancelled: cancelled.length,
      cancelledByPlayer,
      cancelledByVenue,
      expired,
    },
    hoursPlayed,
    sessionsPlayed,
    avgSessionHours: sessionsPlayed ? hoursPlayed / sessionsPlayed : 0,
    avgPerBooking: sessionsPlayed ? total / sessionsPlayed : 0,
    spend: {
      total,
      refunded,
      pendingRefund,
      outstanding,
      byVenue: venuesRanked.sort((a, b) => b.amount - a.amount),
      byCourt: courtsRanked.sort((a, b) => b.amount - a.amount),
      bySport: Array.from(bySport.values()).sort((a, b) => b.amount - a.amount),
      months,
      thisPeriod,
      prevPeriod,
      delta,
      deltaAmount: thisPeriod - prevPeriod,
    },
    sports,
    topSport: sports[0] ?? null,
    topVenue: rank(venueVisits)[0] ?? null,
    topCourt: rank(courtVisits)[0] ?? null,
    usualTime,
    byWeekday,
    hasAnyBooking: all.length > 0,
    hasHistory: sessionsPlayed > 0,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by the workspace
// ---------------------------------------------------------------------------

export const peso = (n: number) =>
  `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Tiles have room for four digits. ₱18,450.00 wraps a 320px tile; ₱18.4k does not. */
export const pesoShort = (n: number) =>
  n >= 1_000_000
    ? `₱${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `₱${(n / 1_000).toFixed(1)}k`
      : `₱${Math.round(n).toLocaleString("en-PH")}`;

/** "1h 55m" — the spec's average-session format. */
export function humanHours(hours: number) {
  if (!hours) return "0h";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "Today at 6:00 PM" / "Tomorrow" / "In 3 days" — calendar-day based, so a booking
 *  at 1 AM tomorrow reads "Tomorrow" rather than "in 4 hours". */
export function countdownLabel(startIso: string, now: Date = new Date()) {
  const start = new Date(startIso);
  const diffMs = start.getTime() - now.getTime();
  const time = start.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  if (diffMs <= 0) return "Happening now";

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round(
    (new Date(start).setHours(0, 0, 0, 0) - startOfToday.getTime()) / 86_400_000,
  );

  if (days === 0) {
    const mins = Math.round(diffMs / 60_000);
    if (mins < 60) return `Starting in ${mins} min`;
    return `Today at ${time}`;
  }
  if (days === 1) return `Tomorrow at ${time}`;
  if (days < 7) return `In ${days} days`;
  if (days < 14) return "Next week";
  return start.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

/** Google Maps link for the venue — coordinates when we have them, address otherwise. */
export function directionsUrl(court: PlayerCourt | null): string | null {
  const v = court?.venues;
  if (!v) return null;
  if (v.latitude != null && v.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${v.latitude},${v.longitude}`;
  }
  if (v.address)
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.address)}`;
  return null;
}

/** A downloadable .ics for one session. Built inline rather than fetched so it works
 *  offline and needs no endpoint. */
export function icsForSession(session: PlayerSession): string {
  const c = session.first.courts;
  const stamp = (iso: string) =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const title = `${c?.sports?.name ?? "Court booking"} · ${c?.venues?.name ?? "Venue"}`;
  const location = c?.venues?.address ?? c?.venues?.name ?? "";
  const escape = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CourtHub//Player Booking//EN",
    "BEGIN:VEVENT",
    `UID:booking-${session.first.id}@courthub`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(session.start_time)}`,
    `DTEND:${stamp(session.end_time)}`,
    `SUMMARY:${escape(title)}`,
    `DESCRIPTION:${escape(`${c?.name ?? "Court"} · ${session.hours} hour${session.hours > 1 ? "s" : ""}`)}`,
    `LOCATION:${escape(location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
