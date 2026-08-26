/**
 * The tenant notification triggers decide "how many notifications is one booking?"
 * in SQL, using booking_session_anchor() / booking_session_span(). The app answers
 * the same question in TypeScript, in groupBookingSessions(). If those two ever
 * disagree, a venue gets one notification per hour, or one notification for two
 * unrelated bookings.
 *
 * There is no Postgres in this environment, so this re-implements the SQL recursive
 * CTEs exactly — same join conditions, same ordering — and asserts the two agree on
 * generated inputs. It tests the *semantics* the migration relies on, not the
 * migration itself; running the SQL is still required (see supabase/tests/).
 */

import { describe, expect, it } from "vitest";
import { groupBookingSessions, type HourlyBooking } from "@/lib/booking-groups";

type Row = HourlyBooking & { unit_price?: number; discount_amount?: number };

/** Mirror of booking_session_anchor(): walk backwards while the previous hour is the
 *  same player, court, status and payment_status; return the lowest id seen. */
function sqlAnchor(rows: Row[], bookingId: number): number {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cur = byId.get(bookingId)!;
  let min = cur.id;
  for (;;) {
    const prev = rows.find(
      (p) =>
        p.user_id === cur.user_id &&
        p.court_id === cur.court_id &&
        p.end_time === cur.start_time &&
        p.status === cur.status &&
        (p.payment_status ?? null) === (cur.payment_status ?? null),
    );
    if (!prev) break;
    min = Math.min(min, prev.id);
    cur = prev;
  }
  return min;
}

/** Mirror of booking_session_span(): walk forward from the anchor under the same rule. */
function sqlSpan(rows: Row[], anchor: number) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cur = byId.get(anchor)!;
  const seen: Row[] = [cur];
  for (;;) {
    const next = rows.find(
      (n) =>
        n.user_id === cur.user_id &&
        n.court_id === cur.court_id &&
        n.start_time === cur.end_time &&
        n.status === cur.status &&
        (n.payment_status ?? null) === (cur.payment_status ?? null),
    );
    if (!next) break;
    seen.push(next);
    cur = next;
  }
  return {
    starts_at: seen.reduce((a, r) => (r.start_time < a ? r.start_time : a), seen[0].start_time),
    ends_at: seen.reduce((a, r) => (r.end_time > a ? r.end_time : a), seen[0].end_time),
    slots: seen.length,
    total: seen.reduce((a, r) => a + ((r.unit_price ?? 0) - (r.discount_amount ?? 0)), 0),
  };
}

const hour = (h: number) => `2026-08-28T${String(h).padStart(2, "0")}:00:00.000Z`;

function row(id: number, h: number, over: Partial<Row> = {}): Row {
  return {
    id,
    court_id: 1,
    user_id: "player-a",
    start_time: hour(h),
    end_time: hour(h + 1),
    status: "confirmed",
    payment_status: "paid",
    unit_price: 400,
    discount_amount: 0,
    ...over,
  };
}

describe("SQL session semantics match groupBookingSessions", () => {
  it("collapses a contiguous three-hour booking to ONE session", () => {
    const rows = [row(1, 18), row(2, 19), row(3, 20)];
    const sessions = groupBookingSessions(rows);
    expect(sessions).toHaveLength(1);

    // Every hourly row must resolve to the same anchor — that is what makes the
    // per-row trigger emit one notification instead of three.
    const anchors = new Set(rows.map((r) => sqlAnchor(rows, r.id)));
    expect(anchors.size).toBe(1);
    expect([...anchors][0]).toBe(1);

    const span = sqlSpan(rows, 1);
    expect(span.slots).toBe(3);
    expect(span.starts_at).toBe(hour(18));
    expect(span.ends_at).toBe(hour(21));
    expect(span.total).toBe(1200);
  });

  it("keeps two NON-contiguous bookings on the same court and day separate", () => {
    // The regression this guards: a (player, court, day) key — which the booking
    // reminders use — would merge these and silently drop the second notification.
    const rows = [row(1, 9), row(2, 19), row(3, 20)];
    const sessions = groupBookingSessions(rows);
    expect(sessions).toHaveLength(2);

    expect(sqlAnchor(rows, 1)).toBe(1);
    expect(sqlAnchor(rows, 2)).toBe(2);
    expect(sqlAnchor(rows, 3)).toBe(2);
    expect(new Set(rows.map((r) => sqlAnchor(rows, r.id))).size).toBe(2);
  });

  it("splits a PARTIALLY cancelled booking so the notification describes only the cancelled hour", () => {
    const rows = [row(1, 18), row(2, 19, { status: "cancelled" }), row(3, 20)];
    expect(groupBookingSessions(rows)).toHaveLength(3);

    const span = sqlSpan(rows, sqlAnchor(rows, 2));
    expect(span.slots).toBe(1);
    expect(span.starts_at).toBe(hour(19));
    expect(span.ends_at).toBe(hour(20));
  });

  it("does not merge different players or different courts", () => {
    const rows = [row(1, 18), row(2, 19, { user_id: "player-b" }), row(3, 19, { court_id: 2 })];
    expect(sqlAnchor(rows, 2)).toBe(2);
    expect(sqlAnchor(rows, 3)).toBe(3);
  });

  it("agrees with groupBookingSessions on randomised inputs", () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let trial = 0; trial < 300; trial++) {
      const rows: Row[] = [];
      let id = 1;
      for (let h = 6; h < 22; h++) {
        if (rand() < 0.45) continue;
        rows.push(
          row(id++, h, {
            court_id: rand() < 0.3 ? 2 : 1,
            user_id: rand() < 0.25 ? "player-b" : "player-a",
            status: rand() < 0.2 ? "cancelled" : "confirmed",
          }),
        );
      }
      if (rows.length === 0) continue;

      const sessions = groupBookingSessions(rows);
      const anchors = new Set(rows.map((r) => sqlAnchor(rows, r.id)));

      // One anchor per session: the SQL produces exactly as many notifications as
      // the UI shows sessions.
      expect(anchors.size).toBe(sessions.length);

      // And each anchor's forward span must equal that session's span.
      for (const a of anchors) {
        const span = sqlSpan(rows, a);
        const match = sessions.find((s) => s.ids.includes(a));
        expect(match, `no session contains anchor ${a}`).toBeTruthy();
        expect(span.slots).toBe(match!.ids.length);
        expect(span.starts_at).toBe(match!.start_time);
        expect(span.ends_at).toBe(match!.end_time);
      }
    }
  });
});
