## Goal

Let a tenant set different hourly rates per time-of-day and per day-type (weekday vs weekend) for each court, and have players see the correct per-hour price and total everywhere.

## Concept

Keep `courts.hourly_rate` as the **base rate** (fallback, and what shows as "from ₱X"). Add an optional list of **rate rules** on top of it. Each rule = *which days* + *which hour window* + *rate per hour*.

Example for one court:

```text
Weekday (Mon–Fri)   06:00–12:00   ₱250/hr
Weekday (Mon–Fri)   12:00–17:00   ₱300/hr
Weekday (Mon–Fri)   17:00–23:00   ₱450/hr
Weekend (Sat–Sun)   06:00–17:00   ₱400/hr
Weekend (Sat–Sun)   17:00–23:00   ₱550/hr
Any hour not covered by a rule → base rate
```

Rules are resolved **per hour slot**, so a 5–10 PM booking can legitimately mix rates; the total is the sum of each hour's rate. This is the only correct model since slots are stored hourly.

## Database

Add one column to `courts`:
- `rate_rules jsonb not null default '[]'` — array of `{ id, label, days: ["mon".."sun"], start_hour: 0-23, end_hour: 1-24, rate: number }`

No new table needed; rules are small, always read with the court, and edited as a whole. Add a DB helper `court_rate_for_hour(court_id, ts)` and `court_price_for_hours(court_id, hours[])` so pricing is computed server-side from one source of truth.

## Tenant side (create / edit court panel)

New "Pricing" block under the existing rate field:
- Base rate per hour (existing `hourly_rate`) — labelled "Default rate, used for any hour without a rule".
- Toggle: **Use time-based pricing**.
- When on: a compact rule list, each row = day-type selector (Weekdays / Weekends / Custom day chips), time window (start/end hour selects), rate input, delete.
- "Quick setup" button that seeds 6 common rows (weekday AM/PM/evening + weekend AM/PM/evening) so tenants aren't building from scratch.
- Live preview strip: a 24-hour bar for a sample weekday and weekend showing the resolved ₱ per hour, so overlaps/gaps are obvious.
- Validation: `start_hour < end_hour`, rate > 0, at least one day selected, and warn (not block) on overlapping windows — later rule wins, shown in the preview.

## Player side

- Venue list / court card: show **"from ₱250/hr"** (minimum across base + rules) instead of a single flat number, when rules exist.
- Court booking sheet header: show a small "Rates vary by time" chip that opens the rate table (weekday/weekend columns).
- Availability grid: each selectable hour chip shows its own price under the time.
- Selection summary: per-segment breakdown, e.g. `5:00 PM – 10:00 PM · 5 hrs · ₱2,250` with a tooltip/expander listing `2h × ₱300 + 3h × ₱450`.
- Checkout drawer: same breakdown above the voucher/discount lines.

## Server / correctness

- `startBookingCheckout` and `retryBookingPayment` in `src/lib/paymongo.functions.ts` stop doing `hourly_rate × hours` and instead call the DB pricing helper with the exact selected hours; the voucher preview then runs on that authoritative amount.
- Store the resolved per-hour price on each booking row (new `unit_price numeric` column) so historical bookings, receipts, transactions and tenant reports stay accurate even if the tenant changes rates later.
- All player-facing prices are display-only; the charged amount is always recomputed server-side.

## Technical notes

- Migration: `courts.rate_rules jsonb`, `bookings.unit_price numeric`, plus `court_price_for_hours` SQL function (stable, `search_path = public`). Existing courts keep working with an empty rule array.
- Shared TS helper `src/lib/court-pricing.ts` mirroring the SQL resolution for UI display (`rateForHour`, `priceForHours`, `minRate`, `rateTable`) so tenant preview, player grid and summary all agree.
- Day matching uses the venue's timezone, consistent with how availability is already computed.
