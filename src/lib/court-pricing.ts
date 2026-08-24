// Time-based court pricing.
// A court has a base `hourly_rate` plus an optional list of rate rules.
// Each rule targets a set of weekdays and an hour window [start_hour, end_hour).
// Rules are evaluated in order; the LAST matching rule wins. No match -> base rate.
// This mirrors the SQL function public.court_rate_for_hour().

import { openHoursForDay, type HoursMap } from "@/lib/operating-hours";

export type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** The hours of `day` a player can actually book, or `null` for "every hour" when
 *  no schedule is supplied.
 *
 *  Every price below is derived from open hours only. A court open 6am–11pm whose
 *  rules cover exactly those hours never charges its base rate, so quoting that
 *  base — in a range, a rate card or the ₱/hr filter — advertises a price nobody
 *  can book. */
function bookableHours(day: DayKey, hours?: HoursMap | null): Set<number> | null {
  return hours ? openHoursForDay(hours, day) : null;
}

export const DAY_KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_LABELS: Record<DayKey, string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};
export const WEEKDAYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri"];
export const WEEKENDS: DayKey[] = ["sat", "sun"];

export type RateRule = {
  id: string;
  label?: string;
  days: DayKey[];
  start_hour: number;
  end_hour: number;
  rate: number;
};

export function normalizeRules(raw: unknown): RateRule[] {
  if (!Array.isArray(raw)) return [];
  const out: RateRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const days = Array.isArray(o.days)
      ? (o.days as unknown[]).filter((d): d is DayKey => DAY_KEYS.includes(d as DayKey))
      : [];
    const start = Number(o.start_hour);
    const end = Number(o.end_hour);
    const rate = Number(o.rate);
    if (days.length === 0 || !Number.isFinite(start) || !Number.isFinite(end) || !(rate > 0))
      continue;
    if (!(start >= 0 && end <= 24 && start < end)) continue;
    out.push({
      id: typeof o.id === "string" ? o.id : `${days.join("")}-${start}-${end}`,
      label: typeof o.label === "string" ? o.label : undefined,
      days,
      start_hour: Math.floor(start),
      end_hour: Math.ceil(end),
      rate,
    });
  }
  return out;
}

/** Rate for one hour slot on a given ISO date (yyyy-mm-dd) in local time. */
export function rateForHour(
  baseRate: number,
  rules: RateRule[],
  dateISO: string,
  hour: number,
): number {
  const day = DAY_KEYS[new Date(`${dateISO}T00:00:00`).getDay()];
  return rateForDayHour(baseRate, rules, day, hour);
}

export function rateForDayHour(
  baseRate: number,
  rules: RateRule[],
  day: DayKey,
  hour: number,
): number {
  let rate = Number(baseRate) || 0;
  for (const r of rules) {
    if (r.days.includes(day) && hour >= r.start_hour && hour < r.end_hour) rate = r.rate;
  }
  return rate;
}

/** Total for a set of hour indexes on a date. */
export function priceForHours(
  baseRate: number,
  rules: RateRule[],
  dateISO: string,
  hours: number[],
): number {
  return hours.reduce((sum, h) => sum + rateForHour(baseRate, rules, dateISO, h), 0);
}

/** Lowest rate a player could pay across the whole week (for "from ₱X" labels). */
export function minRate(baseRate: number, rules: RateRule[], hours?: HoursMap | null): number {
  let min: number | null = null;
  for (const d of DAY_KEYS) {
    const open = bookableHours(d, hours);
    for (let h = 0; h < 24; h++) {
      if (open && !open.has(h)) continue;
      const r = rateForDayHour(baseRate, rules, d, h);
      if (min == null || r < min) min = r;
    }
  }
  // Closed all week — quote the base rather than nothing.
  return min ?? (Number(baseRate) || 0);
}

export function maxRate(baseRate: number, rules: RateRule[], hours?: HoursMap | null): number {
  let max: number | null = null;
  for (const d of DAY_KEYS) {
    const open = bookableHours(d, hours);
    for (let h = 0; h < 24; h++) {
      if (open && !open.has(h)) continue;
      const r = rateForDayHour(baseRate, rules, d, h);
      if (max == null || r > max) max = r;
    }
  }
  return max ?? (Number(baseRate) || 0);
}

export function hasVariablePricing(
  baseRate: number,
  rules: RateRule[],
  hours?: HoursMap | null,
): boolean {
  return rules.length > 0 && minRate(baseRate, rules, hours) !== maxRate(baseRate, rules, hours);
}

/** Collapse a day's 24 hours into contiguous bands of equal price. */
export function rateBands(
  baseRate: number,
  rules: RateRule[],
  day: DayKey,
  hours?: HoursMap | null,
) {
  const open = bookableHours(day, hours);
  const bands: { start: number; end: number; rate: number }[] = [];
  // Closed hours end the current band rather than being priced — otherwise a
  // court shut at lunch would read as one unbroken window.
  let contiguous = false;
  for (let h = 0; h < 24; h++) {
    if (open && !open.has(h)) {
      contiguous = false;
      continue;
    }
    const r = rateForDayHour(baseRate, rules, day, h);
    const last = bands[bands.length - 1];
    if (contiguous && last && last.rate === r) last.end = h + 1;
    else bands.push({ start: h, end: h + 1, rate: r });
    contiguous = true;
  }
  return bands;
}

/** The Min/Max ₱/hr the explore filter is set to. `null` on a side means unbounded. */
export type PriceBounds = { min: number | null; max: number | null };

/** Does a single hour's rate sit inside the filter? The one predicate behind both
 *  the explore filter and the rate card's highlighting, so a lit band and an
 *  included venue can never disagree. */
export function rateInBounds(rate: number, bounds: PriceBounds) {
  if (bounds.min != null && rate < bounds.min) return false;
  if (bounds.max != null && rate > bounds.max) return false;
  return true;
}

/** Every distinct ₱/hr this court charges across the week, ascending.
 *
 *  Filtering on these rather than on the [cheapest, dearest] span matters: a court
 *  charging only ₱20 and ₱43 does *not* match "₱25–30", even though that span
 *  overlaps its range. Comparing the real rates keeps the rate card honest — a
 *  matched court always has at least one band to light up. */
export function distinctRates(
  baseRate: number,
  rules: RateRule[],
  hours?: HoursMap | null,
): number[] {
  const seen = new Set<number>();
  for (const day of DAY_KEYS)
    for (const b of rateBands(baseRate, rules, day, hours)) seen.add(b.rate);
  if (!seen.size) seen.add(Number(baseRate) || 0);
  return [...seen].sort((a, b) => a - b);
}

/** The rate card as rows to print: consecutive days whose bands are identical are
 *  folded into one row, so the usual weekday/weekend split renders as "Mon–Fri"
 *  and "Sat–Sun" while a court that prices Wednesday differently still shows it
 *  on its own line instead of being averaged away. */
export function rateCardGroups(baseRate: number, rules: RateRule[], hours?: HoursMap | null) {
  const week: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const signature = (bands: { start: number; end: number; rate: number }[]) =>
    bands.map((b) => `${b.start}-${b.end}-${b.rate}`).join("|");

  const runs: { days: DayKey[]; bands: ReturnType<typeof rateBands> }[] = [];
  for (const day of week) {
    const bands = rateBands(baseRate, rules, day, hours);
    const last = runs[runs.length - 1];
    if (last && signature(last.bands) === signature(bands)) last.days.push(day);
    else runs.push({ days: [day], bands });
  }

  // A day the court is shut has no bands at all — drop it rather than print an
  // empty row.
  return runs
    .filter((r) => r.bands.length > 0)
    .map(({ days, bands }) => ({
      label:
        days.length === 1
          ? DAY_LABELS[days[0]]
          : `${DAY_LABELS[days[0]]}–${DAY_LABELS[days[days.length - 1]]}`,
      days,
      bands,
    }));
}

/** Breakdown like [{ rate: 300, hours: 2 }, { rate: 450, hours: 3 }] sorted by rate. */
export function priceBreakdown(
  baseRate: number,
  rules: RateRule[],
  dateISO: string,
  hours: number[],
) {
  const map = new Map<number, number>();
  for (const h of hours) {
    const r = rateForHour(baseRate, rules, dateISO, h);
    map.set(r, (map.get(r) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([rate, count]) => ({ rate, hours: count }))
    .sort((a, b) => a.rate - b.rate);
}

export const peso = (n: number) =>
  `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function fmtHour12(h: number) {
  const hh = ((h % 24) + 24) % 24;
  const period = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:00 ${period}`;
}

/** Six sensible starter rows for the tenant "Quick setup" button. */
export function defaultRuleTemplate(baseRate: number): RateRule[] {
  const b = Math.max(1, Math.round(Number(baseRate) || 300));
  const mk = (
    label: string,
    days: DayKey[],
    start: number,
    end: number,
    rate: number,
  ): RateRule => ({
    id: `${label}-${start}-${end}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    days,
    start_hour: start,
    end_hour: end,
    rate,
  });
  return [
    mk("Weekday morning", WEEKDAYS, 6, 12, b),
    mk("Weekday afternoon", WEEKDAYS, 12, 17, Math.round(b * 1.2)),
    mk("Weekday evening", WEEKDAYS, 17, 23, Math.round(b * 1.5)),
    mk("Weekend morning", WEEKENDS, 6, 12, Math.round(b * 1.3)),
    mk("Weekend afternoon", WEEKENDS, 12, 17, Math.round(b * 1.4)),
    mk("Weekend evening", WEEKENDS, 17, 23, Math.round(b * 1.7)),
  ];
}

export function newRule(baseRate: number): RateRule {
  return {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: "",
    days: [...WEEKDAYS],
    start_hour: 6,
    end_hour: 12,
    rate: Math.max(1, Math.round(Number(baseRate) || 300)),
  };
}
