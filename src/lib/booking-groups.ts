// Bookings are stored one row per hour. These helpers merge consecutive hourly
// rows on the same court (and same player) into a single friendly "session"
// so UIs can show e.g. "5:00 PM – 10:00 PM · 5 hrs" instead of 5 line items.

export type HourlyBooking = {
  id: number;
  court_id: number;
  user_id?: string;
  start_time: string;
  end_time: string;
  status: string;
  payment_status?: string;
};

export type BookingSession<T extends HourlyBooking> = {
  key: string;
  ids: number[];
  items: T[];
  first: T;
  start_time: string;
  end_time: string;
  hours: number;
};

export function groupBookingSessions<T extends HourlyBooking>(rows: T[]): BookingSession<T>[] {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const k = [r.court_id, r.user_id ?? "", r.status, r.payment_status ?? ""].join("|");
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }

  const sessions: BookingSession<T>[] = [];
  for (const [k, arr] of buckets) {
    arr.sort((a, b) => a.start_time.localeCompare(b.start_time));
    let run: T[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      sessions.push({
        key: `${k}|${first.id}`,
        ids: run.map((r) => r.id),
        items: run,
        first,
        start_time: first.start_time,
        end_time: last.end_time,
        hours: Math.max(
          1,
          Math.round((new Date(last.end_time).getTime() - new Date(first.start_time).getTime()) / 3_600_000),
        ),
      });
      run = [];
    };
    for (const r of arr) {
      if (run.length === 0) {
        run = [r];
        continue;
      }
      const prevEnd = new Date(run[run.length - 1].end_time).getTime();
      if (new Date(r.start_time).getTime() === prevEnd) run.push(r);
      else {
        flush();
        run = [r];
      }
    }
    flush();
  }

  return sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("en-PH", TIME_OPTS);

export const formatDateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** e.g. "5:00 PM – 10:00 PM" */
export const formatTimeRange = (startIso: string, endIso: string) =>
  `${formatTime(startIso)} – ${formatTime(endIso)}`;

/** e.g. "5:00 PM – 10:00 PM · 5 hrs" */
export function formatSessionLabel(startIso: string, endIso: string) {
  const hrs = Math.max(1, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000));
  return `${formatTimeRange(startIso, endIso)} · ${hrs} hr${hrs > 1 ? "s" : ""}`;
}
