// Timezone helpers.
//
// Server code runs in UTC, so `new Date("2026-08-03T08:00:00")` there means
// 08:00 UTC — not 08:00 at the venue. Booking rows must always be stored as the
// UTC instant that corresponds to the chosen hour in the VENUE's timezone,
// otherwise a player picking 8 AM ends up occupying a completely different slot.

export const DEFAULT_TIMEZONE = "Asia/Manila";

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - instant.getTime();
}

/** The UTC instant for `dateISO` (YYYY-MM-DD) at `hour`:00 local to `timeZone`. */
export function zonedHourToUtc(dateISO: string, hour: number, timeZone = DEFAULT_TIMEZONE): Date {
  const naive = Date.UTC(
    Number(dateISO.slice(0, 4)),
    Number(dateISO.slice(5, 7)) - 1,
    Number(dateISO.slice(8, 10)),
    hour,
  );
  let ts = naive - tzOffsetMs(new Date(naive), timeZone);
  // Second pass settles DST boundaries (no-op for fixed-offset zones like PH).
  ts = naive - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Calendar date at an instant in the venue timezone. */
export function zonedDateISO(instant = new Date(), timeZone = DEFAULT_TIMEZONE): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Adds calendar days without involving the browser's local timezone. */
export function addZonedDays(dateISO: string, days: number): string {
  const date = new Date(`${dateISO}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Day of week for a date-only value: Sunday is 0, matching JS Date#getDay. */
export function zonedDayOfWeek(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay();
}

/** UTC bounds for a venue-local calendar date. */
export function zonedDayBoundsUtc(dateISO: string, timeZone = DEFAULT_TIMEZONE) {
  return {
    start: zonedHourToUtc(dateISO, 0, timeZone),
    end: zonedHourToUtc(addZonedDays(dateISO, 1), 0, timeZone),
  };
}

/** Venue-local hour for a stored UTC instant. */
export function zonedHour(instant: string | Date, timeZone = DEFAULT_TIMEZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0");
}
