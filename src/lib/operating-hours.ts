// Operating hours: the venue is the host, courts inherit unless overridden.
//
// A schedule is { mon: "08:00-17:00", ... } with one window per weekday.
// "00:00-24:00" means open all day. A window whose end is <= its start runs
// past midnight (e.g. "18:00-02:00" = 6 PM until 2 AM the next morning), so
// the open hours of a calendar date also include yesterday's spillover.
//
// This mirrors the SQL functions public.parse_hours_window() and
// public.court_is_open().

export type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type HoursMap = Record<string, string>;

export const HOUR_DAY_KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const HOUR_DAY_LABELS: Record<DayKey, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
};

export const ALL_DAY = "00:00-24:00";
export const CLOSED = "closed";

export function fullWeek(window = ALL_DAY): HoursMap {
  return Object.fromEntries(HOUR_DAY_KEYS.map((d) => [d, window])) as HoursMap;
}

export function normalizeHours(raw: unknown): HoursMap {
  const out = fullWeek();
  if (!raw || typeof raw !== "object") return out;
  for (const d of HOUR_DAY_KEYS) {
    const v = (raw as Record<string, unknown>)[d];
    if (typeof v === "string" && v.trim()) out[d] = v.trim();
  }
  return out;
}

/** [startHour, endHour]; endHour <= startHour means it wraps past midnight. */
export function parseWindow(raw: string | undefined | null): [number, number] | null {
  if (!raw) return [0, 24];
  const t = raw.trim();
  if (t === CLOSED) return null;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return [0, 24];
  const s = Math.max(0, Math.min(24, parseInt(m[1], 10)));
  const e = Math.max(0, Math.min(24, parseInt(m[3], 10)));
  if (s === e) return [0, 24];
  return [s, e];
}

export function makeWindow(start: number, end: number) {
  const p = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `${p(start)}-${p(end === 24 ? 24 : end)}`;
}

export function isOvernight(raw: string | undefined | null) {
  const w = parseWindow(raw);
  return !!w && w[1] < w[0];
}

export function isAllDay(raw: string | undefined | null) {
  const w = parseWindow(raw);
  return !!w && w[0] === 0 && w[1] === 24;
}

export function isClosed(raw: string | undefined | null) {
  return parseWindow(raw) === null;
}

function dayKeyOf(dateISO: string): DayKey {
  return HOUR_DAY_KEYS[new Date(`${dateISO}T00:00:00`).getDay()];
}

function prevDayKey(day: DayKey): DayKey {
  const i = HOUR_DAY_KEYS.indexOf(day);
  return HOUR_DAY_KEYS[(i + 6) % 7];
}

/** The hours (0–23) a court is open on a given weekday, including yesterday's overnight tail. */
export function openHoursForDay(hours: HoursMap, day: DayKey): Set<number> {
  const open = new Set<number>();

  const w = parseWindow(hours[day]);
  if (w) {
    if (w[1] > w[0]) for (let h = w[0]; h < w[1]; h++) open.add(h);
    else for (let h = w[0]; h < 24; h++) open.add(h); // runs into tomorrow
  }

  const wp = parseWindow(hours[prevDayKey(day)]);
  if (wp && wp[1] < wp[0]) for (let h = 0; h < wp[1]; h++) open.add(h); // yesterday's tail

  return open;
}

/** The hours (0–23) a court is open on a given calendar date, in venue-local time. */
export function openHoursForDate(hours: HoursMap, dateISO: string): Set<number> {
  return openHoursForDay(hours, dayKeyOf(dateISO));
}

/** Effective schedule for a court: its own only when it opts out of the venue's. */
export function effectiveHours(
  court: { inherit_venue_hours?: boolean | null; operating_hours?: unknown },
  venueHours: unknown,
): HoursMap {
  const inherit = court.inherit_venue_hours !== false;
  return normalizeHours(inherit ? venueHours : court.operating_hours);
}

export function fmtHour(h: number) {
  const hh = ((h % 24) + 24) % 24;
  const period = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:00 ${period}`;
}

/** "8:00 AM – 5:00 PM", "Open 24 hours", "Closed", "6:00 PM – 2:00 AM (next day)" */
export function describeWindow(raw: string | undefined | null) {
  const w = parseWindow(raw);
  if (!w) return "Closed";
  if (w[0] === 0 && w[1] === 24) return "Open 24 hours";
  const label = `${fmtHour(w[0])} – ${fmtHour(w[1])}`;
  return w[1] < w[0] ? `${label} (next day)` : label;
}

/** Compact weekly summary, grouping consecutive days that share a window. */
export function describeWeek(hours: HoursMap): { days: string; window: string }[] {
  const order: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const out: { days: string; window: string }[] = [];
  let runStart = 0;
  for (let i = 1; i <= order.length; i++) {
    const same = i < order.length && hours[order[i]] === hours[order[runStart]];
    if (same) continue;
    const a = order[runStart];
    const b = order[i - 1];
    const short = (d: DayKey) => HOUR_DAY_LABELS[d].slice(0, 3);
    out.push({
      days: runStart === i - 1 ? short(a) : `${short(a)}–${short(b)}`,
      window: describeWindow(hours[a]),
    });
    runStart = i;
  }
  return out;
}
