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
