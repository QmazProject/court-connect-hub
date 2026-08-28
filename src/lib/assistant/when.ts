/**
 * Reading a day and a time out of a typed question.
 *
 * Bookings are stored one row per hour, so everything here resolves to a list of
 * whole hours on one venue-local calendar date. "7-9pm" is the two slots 7–8 and
 * 8–9, not the instant 9pm — which is why a range yields `[19, 20]`.
 *
 * Where the text is genuinely ambiguous the reading is still made, but recorded:
 * `assumedPm` and `assumedToday` are surfaced in the answer so a player can see
 * that "at 7" was taken as the evening and correct it in one tap.
 */

import { fmtHour } from "@/lib/operating-hours";
import { addZonedDays, zonedDayOfWeek } from "@/lib/tz";

/** day = no time named · band = part of day · slot = an explicit clock time. */
export type WhenPrecision = "day" | "band" | "slot";

export type When = {
  dateISO: string;
  /** Hours 0–23. Empty only when precision is "day". */
  hours: number[];
  precision: WhenPrecision;
  label: string;
  /** A bare hour was read as PM. */
  assumedPm: boolean;
  /** No day was named, so today was used. */
  assumedToday: boolean;
};

/** Latest hour a court is plausibly bookable, used to close an open-ended range. */
const DAY_END = 23;
/** Earliest, for "before 8". */
const DAY_START = 6;

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DOW_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Named stretches of the day, in venue-local hours. */
const BANDS: { re: RegExp; hours: number[]; name: string }[] = [
  { re: /\blate night\b/, hours: [22, 23], name: "late night" },
  { re: /\bearly morning\b|\bdawn\b/, hours: [5, 6, 7], name: "early morning" },
  { re: /\bmorning\b|\bumaga\b/, hours: [6, 7, 8, 9, 10, 11], name: "morning" },
  { re: /\b(lunch|noon|tanghali)\b/, hours: [11, 12, 13], name: "midday" },
  { re: /\bafternoon\b|\bhapon\b/, hours: [13, 14, 15, 16, 17], name: "afternoon" },
  {
    re: /\bevening\b|\btonight\b|\bmamaya\b|\bgabi\b/,
    hours: [17, 18, 19, 20, 21],
    name: "evening",
  },
  { re: /\bnight\b/, hours: [18, 19, 20, 21, 22], name: "night" },
];

function light(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampDay(n: number) {
  return Math.max(1, Math.min(31, n));
}

function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(clampDay(d)).padStart(2, "0")}`;
}

/**
 * Resolve a bare or suffixed hour to 0–23.
 *
 * With no am/pm the clock is genuinely ambiguous. 13–23 can only be a 24-hour
 * reading; 1–11 is taken as the evening because that is when courts are actually
 * played, and the caller is told so rather than the assumption being hidden.
 */
function to24(h: number, mer: string | undefined): { hour: number; assumedPm: boolean } {
  if (mer === "am") return { hour: h === 12 ? 0 : h, assumedPm: false };
  if (mer === "pm") return { hour: h === 12 ? 12 : h + 12, assumedPm: false };
  if (h === 0 || h >= 13) return { hour: h % 24, assumedPm: false };
  if (h === 12) return { hour: 12, assumedPm: false };
  return { hour: h + 12, assumedPm: true };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let h = a; h < b; h++) out.push(((h % 24) + 24) % 24);
  return out;
}

/** Extracts a calendar date, returning the text with the matched span removed. */
function takeDate(
  text: string,
  todayISO: string,
): { dateISO: string; rest: string; named: boolean } {
  const [y] = todayISO.split("-").map(Number);
  let rest = text;
  const cut = (re: RegExp) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };

  let m = cut(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { dateISO: iso(Number(m[1]), Number(m[2]), Number(m[3])), rest, named: true };

  /* "aug 30" / "august 30 2026" */
  m = cut(
    new RegExp(
      `\\b(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\s+(\\d{1,2})(?:\\s+(\\d{4}))?\\b`,
    ),
  );
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m![1]));
    return { dateISO: iso(m[3] ? Number(m[3]) : y, mi + 1, Number(m[2])), rest, named: true };
  }
  /* "30 aug" */
  m = cut(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\b`));
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m![2]));
    return { dateISO: iso(y, mi + 1, Number(m[1])), rest, named: true };
  }
  /* "8/30" — day-first when the first number cannot be a month. */
  m = cut(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 12
      ? { dateISO: iso(y, b, a), rest, named: true }
      : { dateISO: iso(y, a, b), rest, named: true };
  }

  /* "this weekend" resolves to the coming Saturday and the label says which day —
     a two-day span cannot be checked as one date, and quietly picking one is how
     someone ends up at the venue on the wrong morning. */
  if (cut(/\bnext weekend\b/)) {
    const d = (6 - zonedDayOfWeek(todayISO) + 7) % 7;
    return { dateISO: addZonedDays(todayISO, (d === 0 ? 7 : d) + 7), rest, named: true };
  }
  if (cut(/\bthis weekend\b|\bweekend\b/)) {
    const d = (6 - zonedDayOfWeek(todayISO) + 7) % 7;
    return { dateISO: addZonedDays(todayISO, d), rest, named: true };
  }
  if (cut(/\bday after tomorrow\b/))
    return { dateISO: addZonedDays(todayISO, 2), rest, named: true };
  if (cut(/\btomorrow\b|\btmr\b|\btmrw\b|\bbukas\b|\bugma\b/))
    return { dateISO: addZonedDays(todayISO, 1), rest, named: true };
  if (cut(/\byesterday\b|\bkahapon\b/))
    return { dateISO: addZonedDays(todayISO, -1), rest, named: true };
  if (/\blater today\b|\blater on\b/.test(rest)) return { dateISO: todayISO, rest, named: true };
  if (cut(/\btoday\b|\bngayon\b|\bkaron\b|\bnow\b|\bright now\b/))
    return { dateISO: todayISO, rest, named: true };
  /* "tonight" fixes the day as well as the band, so it is read here too but left in
     the text for the band matcher below. */
  if (/\btonight\b|\bmamaya\b/.test(rest)) return { dateISO: todayISO, rest, named: true };

  /* Weekday names. "next sat" only jumps a week when today already is Saturday —
     otherwise it means the same coming Saturday everyone else means. */
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(this |next |on )?(${DOW[i]}|${DOW_SHORT[i]})\\b`);
    const hit = rest.match(re);
    if (!hit) continue;
    rest = rest.replace(hit[0], " ");
    const todayDow = zonedDayOfWeek(todayISO);
    let delta = (i - todayDow + 7) % 7;
    if (hit[1]?.trim() === "next" && delta === 0) delta = 7;
    return { dateISO: addZonedDays(todayISO, delta), rest, named: true };
  }

  return { dateISO: todayISO, rest, named: false };
}

/** Extracts the hours named in the text, if any. */
function takeHours(text: string): {
  hours: number[];
  precision: WhenPrecision;
  assumedPm: boolean;
} {
  const rangeRe =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|til|till|hanggang)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/;
  const m = text.match(rangeRe);
  if (m) {
    /* "7-9pm": the suffix on the end governs the start too. */
    const endMer = m[6];
    const startMer = m[3] ?? endMer;
    const a = to24(Number(m[1]), startMer);
    let end = to24(Number(m[4]), endMer ?? m[3]);
    if (end.hour <= a.hour && !m[6] && Number(m[4]) < 12)
      end = { hour: end.hour + 12, assumedPm: true };
    const hours = range(a.hour, end.hour > a.hour ? end.hour : a.hour + 1);
    return { hours, precision: "slot", assumedPm: a.assumedPm || end.assumedPm };
  }

  /* "after 6", "from 7pm onwards" — open at the top, closed at the end of the day. */
  const after = text.match(
    /\b(?:after|from|starting)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?!\s*(?:-|to|until))|\b(\d{1,2})\s*(am|pm)?\s*onwards?\b/,
  );
  if (after) {
    const r = to24(Number(after[1] ?? after[4]), after[3] ?? after[5]);
    return { hours: range(r.hour, DAY_END + 1), precision: "band", assumedPm: r.assumedPm };
  }

  /* "before 8" — from the start of a normal playing day up to that hour. */
  const before = text.match(/\b(?:before|until|til|till|by)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (before) {
    const r = to24(Number(before[1]), before[3]);
    return {
      hours: range(DAY_START, Math.max(DAY_START + 1, r.hour)),
      precision: "band",
      assumedPm: r.assumedPm,
    };
  }

  /* "around 7" is an hour either side, reported as a window rather than treated as
     a booking for exactly 7. */
  /* "about" is deliberately absent: "how about 9pm?" is a continuation, not an
     approximation, and reading it as one turned a precise follow-up into a window. */
  const around = text.match(/\b(?:around|approx(?:imately)?|mga)\s*(\d{1,2})\s*(am|pm)?\b/);
  if (around) {
    const r = to24(Number(around[1]), around[2]);
    return {
      hours: range(Math.max(0, r.hour - 1), Math.min(24, r.hour + 2)),
      precision: "band",
      assumedPm: r.assumedPm,
    };
  }

  const single = text.match(/\b(?:at|by|around|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (single) {
    const r = to24(Number(single[1]), single[3]);
    return { hours: [r.hour], precision: "slot", assumedPm: r.assumedPm };
  }
  const h24 = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (h24) {
    const r = to24(Number(h24[1]), undefined);
    return { hours: [r.hour], precision: "slot", assumedPm: r.assumedPm };
  }
  const bare = text.match(/\b(?:at|by|around)\s+(\d{1,2})\b/);
  if (bare) {
    const r = to24(Number(bare[1]), undefined);
    return { hours: [r.hour], precision: "slot", assumedPm: r.assumedPm };
  }

  for (const b of BANDS) {
    if (b.re.test(text)) return { hours: b.hours, precision: "band", assumedPm: false };
  }
  return { hours: [], precision: "day", assumedPm: false };
}

/** "today", "tomorrow", else "Sat, 30 Aug". */
export function dateLabel(dateISO: string, todayISO: string): string {
  if (dateISO === todayISO) return "today";
  if (dateISO === addZonedDays(todayISO, 1)) return "tomorrow";
  if (dateISO === addZonedDays(todayISO, -1)) return "yesterday";
  const [, mo, d] = dateISO.split("-").map(Number);
  const dow = DOW_SHORT[zonedDayOfWeek(dateISO)];
  const mon = MONTHS[mo - 1].slice(0, 3);
  return `${dow[0].toUpperCase()}${dow.slice(1)}, ${d} ${mon[0].toUpperCase()}${mon.slice(1)}`;
}

/** "tomorrow 7:00 PM – 9:00 PM" */
export function describeWhen(w: When, todayISO: string): string {
  const day = dateLabel(w.dateISO, todayISO);
  if (w.precision === "day" || w.hours.length === 0) return day;
  const first = w.hours[0];
  const last = w.hours[w.hours.length - 1];
  if (w.hours.length === 1) return `${day} ${fmtHour(first)}`;
  return `${day} ${fmtHour(first)} – ${fmtHour(last + 1)}`;
}

/**
 * Always answers. `assumedToday` tells the caller nothing named a day, so an
 * intent that needs one explicitly (a slot check) can ask instead of guessing.
 */
/**
 * @param nowHour Venue-local hour right now. Used only to narrow "later today" to
 *   the hours actually still ahead; nothing else depends on it.
 */
export function parseWhen(text: string, todayISO: string, nowHour?: number): When {
  const t = light(text);
  const laterToday = /\blater today\b|\blater on\b/.test(t);
  const d = takeDate(t, todayISO);
  const h = takeHours(d.rest);
  if (laterToday && h.precision === "day" && nowHour != null) {
    h.hours = [];
    for (let x = Math.min(23, nowHour + 1); x <= DAY_END; x++) h.hours.push(x);
    h.precision = "band";
  }
  const w: When = {
    dateISO: d.dateISO,
    hours: h.hours,
    precision: h.precision,
    label: "",
    assumedPm: h.assumedPm,
    assumedToday: !d.named,
  };
  w.label = describeWhen(w, todayISO);
  return w;
}
