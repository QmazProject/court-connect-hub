/**
 * A manager's operational questions.
 *
 * Both queries here are single set-based RPCs across every venue the manager is
 * staff on. The scope is not passed in and cannot be widened by the caller: each
 * function resolves it from `auth.uid()` against the staff table, inside the
 * database. That is what replaced walking the first six venues court by court.
 *
 * Money is reported literally. CourtHub knows what it collected, what is still
 * pending and what was refunded; it does not know the venue's costs or the
 * provider's fees, so nothing here is called revenue or profit.
 */

import { supabase } from "@/integrations/supabase/client";
import { peso } from "@/lib/court-pricing";
import { fmtHour } from "@/lib/operating-hours";
import type { Ctx } from "./resolvers";
import type { Answer, AnswerBlock, AnswerRow, Chip } from "./types";
import { dateLabel } from "./when";

export type CourtDay = {
  venue_id: number;
  venue_name: string;
  court_id: number;
  court_name: string;
  sport: string;
  open_hours: number;
  booked_hours: number;
  held_hours: number;
  blocked_hours_count: number;
  past_hours: number;
  free_hours: number;
  free_hour_list: number[];
  booked_hour_list: number[];
  occupancy_pct: number | null;
};

export type Activity = {
  venue_id: number;
  venue_name: string;
  bookings_created: number;
  bookings_starting: number;
  cancelled_count: number;
  confirmed_count: number;
  pending_payment_count: number;
  unpaid_count: number;
  refund_pending_count: number;
  refund_settled_count: number;
  paid_amount: number;
  pending_amount: number;
  refunded_amount: number;
};

export async function courtDay(
  dateISO: string,
  hours: number[] | null,
  now: Date,
): Promise<CourtDay[]> {
  const { data, error } = await supabase.rpc("tenant_court_day", {
    _date: dateISO,
    _hours: hours,
    _now: now.toISOString(),
  });
  if (error) throw error;
  return (data ?? []) as unknown as CourtDay[];
}

export async function activity(from: Date, to: Date): Promise<Activity[]> {
  const { data, error } = await supabase.rpc("tenant_activity", {
    _from: from.toISOString(),
    _to: to.toISOString(),
  });
  if (error) throw error;
  return (data ?? []) as unknown as Activity[];
}

const text = (t: string): AnswerBlock => ({ kind: "text", text: t });
const note = (t: string): AnswerBlock => ({ kind: "note", text: t });
const answer = (
  intent: Answer["intent"],
  blocks: AnswerBlock[],
  chips: Chip[] = [],
  used: { venueIds?: number[]; courtIds?: number[] } = {},
): Answer => ({
  intent,
  blocks,
  chips,
  used: { venueIds: used.venueIds ?? [], courtIds: used.courtIds ?? [] },
});

function liveNote(at: Date): string {
  const t = at.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  return `Checked live availability just now (${t}).`;
}

/** "Which courts are free tonight?", "what is available 6-10 PM?" */
export async function resolveTenantSchedule(ctx: Ctx): Promise<Answer> {
  const p = ctx.parsed;
  const hours = p.when.hours.length > 0 ? p.when.hours : null;
  const rows = await courtDay(p.when.dateISO, hours, new Date(ctx.nowMs));
  if (rows.length === 0) {
    return answer(
      "my_schedule",
      [text("You are not listed as staff on any venue with active courts.")],
      [],
    );
  }

  const day = dateLabel(p.when.dateISO, ctx.todayISO);
  const scope = hours ? p.when.label : day;
  const free = rows.filter((r) => r.free_hours > 0);
  const full = rows.filter((r) => r.free_hours === 0 && r.open_hours > 0);
  const venues = new Set(rows.map((r) => r.venue_id));

  const shown: AnswerRow[] = [...free]
    .sort((a, b) => b.free_hours - a.free_hours)
    .slice(0, 6)
    .map((r) => ({
      title: `${r.venue_name} — ${r.court_name}`,
      detail: `${r.free_hours} free hour${r.free_hours === 1 ? "" : "s"}: ${r.free_hour_list.map(fmtHour).slice(0, 6).join(", ")}`,
      meta: r.sport || undefined,
      tone: "ok",
      nav: { kind: "venue", id: r.venue_id },
    }));

  const blocks: AnswerBlock[] = [
    text(
      free.length === 0
        ? `Every court across your ${venues.size} venue${venues.size === 1 ? "" : "s"} is booked ${scope}.`
        : `${free.length} of ${rows.length} courts have time free ${scope}, across ${venues.size} venue${venues.size === 1 ? "" : "s"}.`,
    ),
  ];
  if (shown.length > 0) blocks.push({ kind: "rows", rows: shown });
  if (full.length > 0)
    blocks.push(
      note(`Fully booked: ${full.map((r) => `${r.venue_name} ${r.court_name}`).join(", ")}.`),
    );
  if (free.length > shown.length)
    blocks.push(note(`Showing ${shown.length} of ${free.length} courts with free time.`));
  blocks.push(note(liveNote(new Date())));

  return answer(
    "my_schedule",
    blocks,
    [
      { label: "Occupancy", ask: `occupancy ${day}` },
      { label: "Today's bookings", ask: "how many bookings today" },
    ],
    { venueIds: [...venues], courtIds: rows.map((r) => r.court_id) },
  );
}

/** "What is today's occupancy?", "which court is busiest?" */
export async function resolveTenantOccupancy(ctx: Ctx): Promise<Answer> {
  const p = ctx.parsed;
  const rows = await courtDay(
    p.when.dateISO,
    p.when.hours.length > 0 ? p.when.hours : null,
    new Date(ctx.nowMs),
  );
  if (rows.length === 0) {
    return answer(
      "my_occupancy",
      [text("You are not listed as staff on any venue with active courts.")],
      [],
    );
  }

  const day = dateLabel(p.when.dateISO, ctx.todayISO);
  const t = p.text.toLowerCase();
  const byVenue = new Map<number, { name: string; booked: number; live: number }>();
  for (const r of rows) {
    const live = r.open_hours - r.past_hours - r.blocked_hours_count;
    const cur = byVenue.get(r.venue_id) ?? { name: r.venue_name, booked: 0, live: 0 };
    cur.booked += r.booked_hours + r.held_hours;
    cur.live += Math.max(0, live);
    byVenue.set(r.venue_id, cur);
  }

  /* "Which court is busiest" is a different question from "how full am I". */
  if (/\bbusiest\b|\bmost booked\b|\bmost popular\b/.test(t)) {
    const byCourt = [...rows].sort((a, b) => b.booked_hours - a.booked_hours);
    const top = byCourt[0];
    if (!top || top.booked_hours === 0) {
      return answer("my_occupancy", [text(`Nothing is booked across your courts ${day}.`)], [], {
        venueIds: [...byVenue.keys()],
      });
    }
    return answer(
      "my_occupancy",
      [
        text(
          `Busiest ${day}: ${top.venue_name} — ${top.court_name}, ${top.booked_hours} booked hour${top.booked_hours === 1 ? "" : "s"}.`,
        ),
        {
          kind: "rows",
          rows: byCourt.slice(0, 5).map((r) => ({
            title: `${r.venue_name} — ${r.court_name}`,
            detail: `${r.booked_hours} booked · ${r.free_hours} free`,
            meta: r.occupancy_pct == null ? undefined : `${r.occupancy_pct}% full`,
            tone: "ok",
            nav: { kind: "venue", id: r.venue_id },
          })),
        },
        note(liveNote(new Date())),
      ],
      [{ label: "Free courts", ask: `which courts are free ${day}` }],
      { venueIds: [...byVenue.keys()], courtIds: rows.map((r) => r.court_id) },
    );
  }

  const totalBooked = [...byVenue.values()].reduce((s, v) => s + v.booked, 0);
  const totalLive = [...byVenue.values()].reduce((s, v) => s + v.live, 0);
  const pct = totalLive === 0 ? null : Math.round((totalBooked / totalLive) * 100);

  return answer(
    "my_occupancy",
    [
      text(
        pct == null
          ? `No bookable hours are left ${day}.`
          : `${pct}% booked ${day} — ${totalBooked} of ${totalLive} bookable hours across ${byVenue.size} venue${byVenue.size === 1 ? "" : "s"}.`,
      ),
      {
        kind: "rows",
        rows: [...byVenue.entries()].map(([id, v]) => ({
          title: v.name,
          detail:
            v.live === 0
              ? "No bookable hours left."
              : `${v.booked} of ${v.live} hours taken (${Math.round((v.booked / v.live) * 100)}%).`,
          tone: v.live === 0 ? "off" : "ok",
          nav: { kind: "venue", id },
        })),
      },
      note("Counts only hours still ahead; past and manager-blocked hours are excluded."),
      note(liveNote(new Date())),
    ],
    [{ label: "Which court is busiest?", ask: `which court is busiest ${day}` }],
    { venueIds: [...byVenue.keys()], courtIds: rows.map((r) => r.court_id) },
  );
}

/** Bookings, cancellations, refunds and money over a window. */
export async function resolveTenantActivity(ctx: Ctx): Promise<Answer> {
  const p = ctx.parsed;
  const t = p.text.toLowerCase();
  const dayStart = new Date(`${p.when.dateISO}T00:00:00+08:00`);
  const wide = /\bweek\b/.test(t);
  const from = wide ? new Date(dayStart.getTime() - 6 * 86_400_000) : dayStart;
  const to = new Date(dayStart.getTime() + 86_400_000);
  const scope = wide ? "over the last 7 days" : dateLabel(p.when.dateISO, ctx.todayISO);

  const rows = await activity(from, to);
  if (rows.length === 0) {
    return answer("tenant_activity", [text("You are not listed as staff on any venue.")], []);
  }

  const sum = (k: keyof Activity) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const wantsMoney = /\bpayment|paid|revenue|sales|income|kita\b/.test(t);
  const wantsCancel = /\bcancel/.test(t);
  const wantsRefund = /\brefund/.test(t);
  const wantsUnpaid = /\bunpaid|pending\b/.test(t);

  const blocks: AnswerBlock[] = [];
  const chips: Chip[] = [];

  if (wantsCancel) {
    const n = sum("cancelled_count");
    blocks.push(
      text(
        n === 0
          ? `No bookings were cancelled ${scope}.`
          : `${n} booking${n === 1 ? " was" : "s were"} cancelled ${scope}.`,
      ),
    );
    if (n > 0) {
      blocks.push({
        kind: "rows",
        rows: rows
          .filter((r) => r.cancelled_count > 0)
          .map((r) => ({
            title: r.venue_name,
            detail: `${r.cancelled_count} cancelled`,
            meta:
              r.refund_pending_count > 0
                ? `${r.refund_pending_count} refund${r.refund_pending_count === 1 ? "" : "s"} still to settle`
                : undefined,
            tone: r.refund_pending_count > 0 ? "warn" : "off",
            nav: { kind: "venue", id: r.venue_id },
          })),
      });
      chips.push({ label: "Refunds to settle", ask: `any refunds ${scope}` });
    }
  } else if (wantsRefund) {
    const pending = sum("refund_pending_count");
    const settled = sum("refund_settled_count");
    const amount = sum("refunded_amount");
    blocks.push(
      text(
        pending === 0 && settled === 0
          ? `No refunds ${scope}.`
          : `${pending} refund${pending === 1 ? "" : "s"} still to settle, ${settled} already settled ${scope}.`,
      ),
    );
    if (amount > 0) blocks.push(note(`${peso(amount)} was refunded through CourtHub ${scope}.`));
    if (pending > 0) {
      blocks.push({
        kind: "rows",
        rows: rows
          .filter((r) => r.refund_pending_count > 0)
          .map((r) => ({
            title: r.venue_name,
            detail: `${r.refund_pending_count} awaiting settlement`,
            tone: "warn",
            nav: { kind: "venue", id: r.venue_id },
          })),
      });
    }
  } else if (wantsMoney) {
    const paid = sum("paid_amount");
    const pending = sum("pending_amount");
    const refunded = sum("refunded_amount");
    blocks.push(text(`${peso(paid)} collected through CourtHub ${scope}.`));
    blocks.push({
      kind: "rows",
      rows: [
        { title: "Collected", detail: peso(paid), meta: "settled payments", tone: "ok" },
        { title: "Pending", detail: peso(pending), meta: "started but not settled", tone: "warn" },
        { title: "Refunded", detail: peso(refunded), meta: "returned to players", tone: "off" },
      ],
    });
    /* The distinction §7 asks for: this is gross collected value, not net revenue. */
    blocks.push(
      note(
        "This is gross value CourtHub collected. It is not net revenue — CourtHub does not hold your costs or the payment provider's fees, and money settled at the venue is not counted here.",
      ),
    );
  } else if (wantsUnpaid) {
    const unpaid = sum("unpaid_count");
    const pendingCount = sum("pending_payment_count");
    blocks.push(text(`${unpaid} unpaid and ${pendingCount} awaiting payment ${scope}.`));
    blocks.push({
      kind: "rows",
      rows: rows
        .filter((r) => r.unpaid_count + r.pending_payment_count > 0)
        .map((r) => ({
          title: r.venue_name,
          detail: `${r.unpaid_count} unpaid · ${r.pending_payment_count} pending`,
          tone: "warn",
          nav: { kind: "venue", id: r.venue_id },
        })),
    });
  } else {
    const created = sum("bookings_created");
    const starting = sum("bookings_starting");
    blocks.push(
      text(
        `${starting} booked hour${starting === 1 ? "" : "s"} start ${scope}, and ${created} booking${created === 1 ? " was" : "s were"} made.`,
      ),
    );
    blocks.push({
      kind: "rows",
      rows: [...rows]
        .sort((a, b) => b.bookings_starting - a.bookings_starting)
        .slice(0, 6)
        .map((r) => ({
          title: r.venue_name,
          detail: `${r.bookings_starting} starting · ${r.bookings_created} made · ${r.cancelled_count} cancelled`,
          tone: "ok",
          nav: { kind: "venue", id: r.venue_id },
        })),
    });
    chips.push({ label: "Occupancy", ask: `occupancy ${scope}` });
    chips.push({ label: "Payments", ask: `what payments came in ${scope}` });
  }

  return answer("tenant_activity", blocks, chips, { venueIds: rows.map((r) => r.venue_id) });
}
