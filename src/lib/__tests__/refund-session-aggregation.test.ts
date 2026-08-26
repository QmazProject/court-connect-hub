/**
 * Refund notification accuracy.
 *
 * The bug this guards: cancelBookingsWithRefund() updated `bookings` one row at a
 * time, each its own transaction, so a three-hour refund produced a notification
 * built from whichever hourly row committed first — "₱500, 6–7 PM" for a ₱1,500,
 * 6–9 PM refund. The fix batches that update, so the session walk sees every
 * refunded row at once.
 *
 * These model the SQL session walk (booking_session_anchor / booking_session_span)
 * over the row states the two write patterns produce, and assert what the venue would
 * be told. They test the semantics the migration depends on; executing the SQL itself
 * still requires a database (see supabase/tests/).
 */

import { describe, expect, it } from "vitest";

type Row = {
  id: number;
  court_id: number;
  user_id: string;
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
  refund_status: string;
  unit_price: number;
  discount_amount: number;
};

/** booking_session_anchor(): walk back while the previous hour matches on player,
 *  court, adjacency, status and payment_status. */
function anchor(rows: Row[], id: number): number {
  let cur = rows.find((r) => r.id === id)!;
  let min = cur.id;
  for (;;) {
    const prev = rows.find(
      (p) =>
        p.user_id === cur.user_id &&
        p.court_id === cur.court_id &&
        p.end_time === cur.start_time &&
        p.status === cur.status &&
        p.payment_status === cur.payment_status,
    );
    if (!prev) break;
    min = Math.min(min, prev.id);
    cur = prev;
  }
  return min;
}

/** booking_session_span(): walk forward from the anchor under the same rule. */
function span(rows: Row[], a: number) {
  let cur = rows.find((r) => r.id === a)!;
  const seen = [cur];
  for (;;) {
    const next = rows.find(
      (n) =>
        n.user_id === cur.user_id &&
        n.court_id === cur.court_id &&
        n.start_time === cur.end_time &&
        n.status === cur.status &&
        n.payment_status === cur.payment_status,
    );
    if (!next) break;
    seen.push(next);
    cur = next;
  }
  return {
    starts_at: seen[0].start_time,
    ends_at: seen[seen.length - 1].end_time,
    slots: seen.length,
    total: seen.reduce((t, r) => t + (r.unit_price - r.discount_amount), 0),
  };
}

/** One notification per distinct anchor among the rows that just changed. */
function notificationsFor(rows: Row[], changedIds: number[]) {
  const anchors = [...new Set(changedIds.map((id) => anchor(rows, id)))];
  return anchors.map((a) => ({ anchor: a, ...span(rows, a) }));
}

const hour = (h: number) => `2026-08-28T${String(h).padStart(2, "0")}:00:00.000Z`;

function paidRow(id: number, h: number, over: Partial<Row> = {}): Row {
  return {
    id,
    court_id: 2,
    user_id: "player-a",
    start_time: hour(h),
    end_time: hour(h + 1),
    status: "cancelled",
    payment_status: "paid",
    refund_status: "none",
    unit_price: 500,
    discount_amount: 0,
    ...over,
  };
}

const refund = (r: Row): Row => ({ ...r, payment_status: "refunded", refund_status: "refunded" });

describe("full refund of a multi-row session", () => {
  const original = [paidRow(1, 18), paidRow(2, 19), paidRow(3, 20)];

  it("BATCHED update (the fix) -> ONE notification with the whole span and total", () => {
    const rows = original.map(refund);
    const notes = notificationsFor(rows, [1, 2, 3]);

    expect(notes).toHaveLength(1);
    expect(notes[0].slots).toBe(3);
    expect(notes[0].starts_at).toBe(hour(18));
    expect(notes[0].ends_at).toBe(hour(21));
    expect(notes[0].total).toBe(1500);
  });

  it("ROW-BY-ROW update (the old bug) -> the first commit describes only one hour", () => {
    // Reproduces the defect: at the moment row 1 commits, rows 2 and 3 are still
    // 'paid', so the walk cannot see them. The dedupe key then suppresses the later,
    // more complete notifications. This is what the batching change removes.
    const afterFirstCommit = [refund(original[0]), original[1], original[2]];
    const firstNote = notificationsFor(afterFirstCommit, [1])[0];

    expect(firstNote.slots).toBe(1);
    expect(firstNote.ends_at).toBe(hour(19)); // 6–7 PM, not 6–9 PM
    expect(firstNote.total).toBe(500); // ₱500, not ₱1,500

    // Same anchor as the batched case, so the dedupe key collides and the accurate
    // one never replaces it — hence the self-correcting ON CONFLICT DO UPDATE.
    expect(firstNote.anchor).toBe(notificationsFor(original.map(refund), [1, 2, 3])[0].anchor);
  });
});

describe("partial refund", () => {
  it("describes only the refunded portion, not the original booking", () => {
    // 6–9 PM booked; only 7–9 PM refunded.
    const rows = [paidRow(1, 18), refund(paidRow(2, 19)), refund(paidRow(3, 20))];
    const notes = notificationsFor(rows, [2, 3]);

    expect(notes).toHaveLength(1);
    expect(notes[0].slots).toBe(2);
    expect(notes[0].starts_at).toBe(hour(19));
    expect(notes[0].ends_at).toBe(hour(21));
    expect(notes[0].total).toBe(1000);
  });

  it("does not sum the un-refunded hour into the amount", () => {
    const rows = [paidRow(1, 18), refund(paidRow(2, 19)), refund(paidRow(3, 20))];
    expect(notificationsFor(rows, [2, 3])[0].total).not.toBe(1500);
  });
});

describe("two separate bookings on the same court and day", () => {
  it("stay independent -> two refund notifications", () => {
    const rows = [refund(paidRow(1, 9)), refund(paidRow(2, 19)), refund(paidRow(3, 20))];
    const notes = notificationsFor(rows, [1, 2, 3]);

    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.slots).sort()).toEqual([1, 2]);
  });
});

describe("idempotency", () => {
  it("replaying the same refund resolves to the same anchor, so the key collides", () => {
    const rows = [paidRow(1, 18), paidRow(2, 19), paidRow(3, 20)].map(refund);
    const first = notificationsFor(rows, [1, 2, 3]);
    const replay = notificationsFor(rows, [1, 2, 3]);

    expect(replay).toEqual(first);
    // Every row of the session agrees on the key, however many times it is processed.
    expect(new Set([1, 2, 3].map((id) => anchor(rows, id))).size).toBe(1);
  });
});

describe("different players and courts are never merged", () => {
  it("keeps a second player's adjacent hour separate", () => {
    const rows = [refund(paidRow(1, 18)), refund(paidRow(2, 19, { user_id: "player-b" }))];
    expect(notificationsFor(rows, [1, 2])).toHaveLength(2);
  });

  it("keeps another court's adjacent hour separate", () => {
    const rows = [refund(paidRow(1, 18)), refund(paidRow(2, 19, { court_id: 7 }))];
    expect(notificationsFor(rows, [1, 2])).toHaveLength(2);
  });
});
