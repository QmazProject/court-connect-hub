export type OwnBookingRow = {
  start_time: string;
  end_time: string;
  status: string;
  payment_status: string;
};

/**
 * Which hours of the day the signed-in player still holds, and how.
 *
 * Only `confirmed` and `pending` rows count. A `cancelled` or `expired` booking has
 * already been released back to everyone by the availability RPC, so treating it as
 * "yours" showed the owner a slot labelled "Your booking" and styled unclickable
 * while every other player could book it — the bug this rule exists to prevent.
 */
export function ownedSlots(
  rows: OwnBookingRow[],
  dayStartMs: number,
): Map<number, { kind: "hold" | "booking" }> {
  const map = new Map<number, { kind: "hold" | "booking" }>();
  for (const b of rows) {
    if (b.status !== "confirmed" && b.status !== "pending") continue;
    const startHr = Math.floor((new Date(b.start_time).getTime() - dayStartMs) / 3600000);
    const endHr = Math.ceil((new Date(b.end_time).getTime() - dayStartMs) / 3600000);
    const isHold = b.status === "pending" && b.payment_status !== "paid";
    for (let h = startHr; h < endHr; h++) {
      map.set(h, { kind: isHold ? "hold" : "booking" });
    }
  }
  return map;
}
