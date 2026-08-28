/**
 * A player's own bookings and spending.
 *
 * Every query here is filtered on the signed-in user's id, and RLS enforces the same
 * thing underneath — the filter is for correctness, the policy is the boundary. No
 * intent in this file can name another player, and none of them accepts a user id
 * from the question.
 */

import { supabase } from "@/integrations/supabase/client";
import { groupBookingSessions } from "@/lib/booking-groups";
import { peso } from "@/lib/court-pricing";
import { fmtHour } from "@/lib/operating-hours";
import { DEFAULT_TIMEZONE, zonedDateISO, zonedHour } from "@/lib/tz";
import type { Ctx } from "./resolvers";
import type { Answer, AnswerBlock, AnswerRow, Chip } from "./types";
import { dateLabel } from "./when";

type MyBooking = {
  id: number;
  court_id: number;
  user_id: string;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  refund_status: string | null;
  created_at: string;
  unit_price: number | null;
  courts: { name: string; venue_id: number; venues: { name: string } | null } | null;
};

const SELECT =
  "id, court_id, user_id, start_time, end_time, status, payment_status, refund_status, " +
  "created_at, unit_price, courts(name, venue_id, venues(name))";

async function myBookings(userId: string, fromISO: string, toISO: string): Promise<MyBooking[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select(SELECT)
    .eq("user_id", userId)
    .gte("start_time", fromISO)
    .lt("start_time", toISO)
    .order("start_time", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as MyBooking[];
}

function sessionRows(rows: MyBooking[], todayISO: string): AnswerRow[] {
  return groupBookingSessions(rows).map((s) => {
    const venue = s.first.courts?.venues?.name ?? "Venue";
    const court = s.first.courts?.name ?? "Court";
    const day = dateLabel(zonedDateISO(new Date(s.start_time), DEFAULT_TIMEZONE), todayISO);
    const from = zonedHour(s.start_time, DEFAULT_TIMEZONE);
    const state =
      s.first.status === "cancelled"
        ? "Cancelled"
        : s.first.payment_status === "paid"
          ? "Paid"
          : s.first.payment_status === "pending"
            ? "Payment pending"
            : "Unpaid";
    return {
      title: `${venue} — ${court}`,
      detail: `${day} ${fmtHour(from)} – ${fmtHour(from + s.hours)} · ${s.hours}h`,
      meta: state,
      tone:
        s.first.status === "cancelled" ? "off" : s.first.payment_status === "paid" ? "ok" : "warn",
      nav: { kind: "venue", id: s.first.courts?.venue_id ?? 0 },
    };
  });
}

const dayWindow = (dateISO: string) => ({
  from: new Date(`${dateISO}T00:00:00+08:00`).toISOString(),
  to: new Date(`${dateISO}T00:00:00+08:00`).toISOString(),
});

/** "What's my next booking?", "do I play tomorrow?", "this week?" */
export async function resolveMyBookings(ctx: Ctx): Promise<Answer> {
  const userId = ctx.ask.userId;
  if (!userId) {
    return answer("my_bookings", [text("Sign in and I can look up your bookings.")], []);
  }
  const t = ctx.parsed.text.toLowerCase();
  const now = new Date(ctx.nowMs);
  const wantsCancelled = /\bcancel/.test(t);
  const wantsWeek = /\bthis week\b|\bweek\b/.test(t);
  const named = !ctx.parsed.when.assumedToday;

  let fromISO: string;
  let toISO: string;
  let scope: string;
  if (named) {
    const d = ctx.parsed.when.dateISO;
    fromISO = new Date(`${d}T00:00:00+08:00`).toISOString();
    toISO = new Date(new Date(fromISO).getTime() + 86_400_000).toISOString();
    scope = dateLabel(d, ctx.todayISO);
  } else if (wantsWeek) {
    fromISO = now.toISOString();
    toISO = new Date(ctx.nowMs + 7 * 86_400_000).toISOString();
    scope = "the next 7 days";
  } else if (wantsCancelled) {
    fromISO = new Date(ctx.nowMs - 60 * 86_400_000).toISOString();
    toISO = new Date(ctx.nowMs + 60 * 86_400_000).toISOString();
    scope = "recently";
  } else {
    fromISO = now.toISOString();
    toISO = new Date(ctx.nowMs + 60 * 86_400_000).toISOString();
    scope = "coming up";
  }

  const all = await myBookings(userId, fromISO, toISO);
  const rows = wantsCancelled
    ? all.filter((b) => b.status === "cancelled")
    : all.filter((b) => b.status !== "cancelled" && b.status !== "expired");

  if (rows.length === 0) {
    return answer(
      "my_bookings",
      [
        text(
          wantsCancelled
            ? "You have no cancelled bookings in the last two months."
            : `You have no bookings ${scope}.`,
        ),
      ],
      [{ label: "Find a court", ask: "what is available tonight" }],
    );
  }

  const sessions = sessionRows(rows, ctx.todayISO);
  const nextOnly = /\bnext\b|\bsoon\b|\bstarting\b/.test(t) && !wantsWeek;
  const shown = nextOnly ? sessions.slice(0, 1) : sessions.slice(0, 5);
  const first = rows[0];

  const blocks: AnswerBlock[] = [
    text(
      nextOnly
        ? "Your next booking:"
        : `${sessions.length} booking${sessions.length === 1 ? "" : "s"} ${scope}:`,
    ),
    { kind: "rows", rows: shown },
  ];
  if (!nextOnly && sessions.length > shown.length) {
    blocks.push(note(`Showing ${shown.length} of ${sessions.length}.`));
  }

  const chips: Chip[] = [
    { label: "View booking", nav: { kind: "venue", id: first.courts?.venue_id ?? 0 } },
    { label: "How much have I spent?", ask: "how much have I spent this month" },
  ];
  return answer("my_bookings", blocks, chips, {
    venueIds: [...new Set(rows.map((r) => r.courts?.venue_id ?? 0).filter(Boolean))],
    courtIds: [...new Set(rows.map((r) => r.court_id))],
  });
}

/** "How much have I spent this month?" — from settled transactions only. */
export async function resolveMySpend(ctx: Ctx): Promise<Answer> {
  const userId = ctx.ask.userId;
  if (!userId)
    return answer("my_spend", [text("Sign in and I can total up what you have paid.")], []);

  const now = new Date(ctx.nowMs);
  const t = ctx.parsed.text.toLowerCase();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = /\byear\b/.test(t)
    ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
    : /\bweek\b/.test(t)
      ? new Date(ctx.nowMs - 7 * 86_400_000)
      : monthStart;
  const scope = /\byear\b/.test(t)
    ? "this year"
    : /\bweek\b/.test(t)
      ? "the last 7 days"
      : "this month";

  const { data, error } = await supabase
    .from("transactions")
    .select("amount, status, paid_at, venue_id")
    .eq("user_id", userId)
    .gte("paid_at", from.toISOString())
    .limit(500);
  if (error) throw error;

  const rows = (data ?? []) as {
    amount: number;
    status: string;
    paid_at: string | null;
    venue_id: number;
  }[];
  const paid = rows.filter((r) => r.status === "paid");
  const refunded = rows.filter((r) => r.status === "refunded");
  const total = paid.reduce((s, r) => s + Number(r.amount), 0);
  const back = refunded.reduce((s, r) => s + Number(r.amount), 0);

  const blocks: AnswerBlock[] = [
    text(
      paid.length === 0
        ? `You have not paid for anything through CourtHub ${scope}.`
        : `You have paid ${peso(total)} through CourtHub ${scope}, across ${paid.length} payment${paid.length === 1 ? "" : "s"}.`,
    ),
  ];
  if (back > 0) blocks.push(note(`${peso(back)} of that was refunded.`));
  blocks.push(
    note("This counts payments CourtHub processed. Anything settled at the venue is not included."),
  );
  return answer(
    "my_spend",
    blocks,
    [{ label: "My bookings", ask: "what bookings do I have this week" }],
    {
      venueIds: [...new Set(rows.map((r) => r.venue_id))],
    },
  );
}

/* Small local helpers, mirroring the shapes used elsewhere. */
function answer(
  intent: Answer["intent"],
  blocks: AnswerBlock[],
  chips: Chip[] = [],
  used: { venueIds?: number[]; courtIds?: number[] } = {},
): Answer {
  return {
    intent,
    blocks,
    chips,
    used: { venueIds: used.venueIds ?? [], courtIds: used.courtIds ?? [] },
  };
}
const text = (t: string): AnswerBlock => ({ kind: "text", text: t });
const note = (t: string): AnswerBlock => ({ kind: "note", text: t });
void dayWindow;
