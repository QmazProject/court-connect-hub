/**
 * What one hour on one court actually is, right now.
 *
 * The states and the order they are tested in are copied deliberately from
 * CourtBookingPanel: if the assistant said "free" where the booking screen says
 * "booked", the player would find out only after tapping through. Both read the
 * same `get_court_availability` RPC and apply the same precedence, so the two
 * screens cannot disagree.
 */

import { supabase } from "@/integrations/supabase/client";
import type { CatalogCourt, CatalogVenue } from "./catalog";
import { DAY_KEYS, rateForHour } from "@/lib/court-pricing";
import { openHoursForDate } from "@/lib/operating-hours";
import { zonedDayBoundsUtc, zonedDayOfWeek, zonedHour, zonedHourToUtc } from "@/lib/tz";

export type SlotState =
  /** Bookable. */
  | "open"
  /** The hour has already started. */
  | "past"
  /** Someone else holds every unit of capacity. */
  | "booked"
  /** Held while another player completes payment. */
  | "hold"
  /** The shared physical court is in use by a different sport. */
  | "other_sport"
  /** Closed by the manager for this weekday or this exact date. */
  | "blocked";

export type SlotInfo = {
  hour: number;
  state: SlotState;
  remaining: number;
  capacity: number;
  rate: number;
};

export function slotStateLabel(state: SlotState): string {
  switch (state) {
    case "open":
      return "free";
    case "past":
      return "already past";
    case "booked":
      return "booked by another player";
    case "hold":
      return "on hold while someone pays";
    case "other_sport":
      return "in use by another sport on the same floor";
    case "blocked":
      return "closed by the venue";
  }
}

type AvailRow = {
  hour_start: string;
  remaining: number;
  blocked_by_other_sport: boolean;
  held_for_payment: boolean;
};

/**
 * Live per-hour state for one court on one venue-local date.
 *
 * Deliberately not cached: a slot's value is that it is current, and the whole
 * feature is worthless if it answers from a minute-old picture.
 */
export async function courtDaySlots(
  court: CatalogCourt,
  venue: CatalogVenue,
  dateISO: string,
  nowMs: number,
): Promise<SlotInfo[]> {
  const tz = venue.timezone;
  const bounds = zonedDayBoundsUtc(dateISO, tz);
  const { data, error } = await supabase.rpc("get_court_availability", {
    _court_id: court.id,
    _from: bounds.start.toISOString(),
    _to: bounds.end.toISOString(),
  });
  if (error) throw error;

  const byHour = new Map<number, AvailRow>();
  for (const row of (data ?? []) as AvailRow[]) byHour.set(zonedHour(row.hour_start, tz), row);

  const capacity = Math.max(1, court.capacity || 1);
  const dow = DAY_KEYS[zonedDayOfWeek(dateISO)];
  const blocked = new Set<number>(court.blockedDates[dateISO] ?? court.blockedHours[dow] ?? []);
  const open = openHoursForDate(court.hours, dateISO);

  const out: SlotInfo[] = [];
  for (let h = 0; h < 24; h++) {
    if (!open.has(h)) continue;
    const info = byHour.get(h);
    const remaining = info?.remaining ?? capacity;
    const rate = rateForHour(court.hourlyRate, court.rules, dateISO, h);

    /* Precedence matches the booking grid: a blocked hour reads as closed even if
       the RPC still shows capacity, and "past" outranks everything a player could
       otherwise be told to go and book. */
    let state: SlotState;
    if (blocked.has(h)) state = "blocked";
    else if (zonedHourToUtc(dateISO, h, tz).getTime() < nowMs) state = "past";
    else if (info?.blocked_by_other_sport) state = "other_sport";
    else if (remaining <= 0) state = "booked";
    else if (info?.held_for_payment) state = "hold";
    else state = "open";

    out.push({ hour: h, state, remaining, capacity, rate });
  }
  return out;
}

/** Free hours only, in clock order. */
export function freeHours(slots: SlotInfo[]): SlotInfo[] {
  return slots.filter((s) => s.state === "open");
}

/** "7:00 PM, 8:00 PM and 3 more" — used everywhere a slot list is summarised. */
export function joinHours(labels: string[], max = 4): string {
  if (labels.length === 0) return "none";
  if (labels.length <= max) {
    return labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  }
  return `${labels.slice(0, max).join(", ")} and ${labels.length - max} more`;
}
