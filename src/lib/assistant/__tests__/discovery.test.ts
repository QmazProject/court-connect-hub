/**
 * Broad discovery.
 *
 * What these prove is the *client contract*: one server call for a broad question,
 * the right filters on it, and no per-court fan-out. What they cannot prove is the
 * SQL — `search_available_courts` lives in a migration and there is no database in
 * this environment, so the RPC is stubbed here. The fallback path, which is real
 * TypeScript, is exercised for the availability and pricing rules it implements.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

const { discover, defaultParams, compareBy, rankReason, FALLBACK_VENUE_CAP } =
  await import("@/lib/assistant/search");
const { fullWeek } = await import("@/lib/operating-hours");
const { zonedHourToUtc } = await import("@/lib/tz");
type Catalog = Awaited<typeof import("@/lib/assistant/catalog")> extends never ? never : never;

const DATE = "2026-09-05";
const TZ = "Asia/Manila";
/* 6am local, so the whole evening is still ahead. */
const NOW = zonedHourToUtc(DATE, 6, TZ);

type AnyCourt = Record<string, unknown>;
type AnyVenue = Record<string, unknown>;

function court(
  id: number,
  venueId: number,
  name: string,
  rate: number,
  rules: unknown[] = [],
): AnyCourt {
  return {
    id,
    venueId,
    name,
    sport: "Badminton",
    sportSlug: "badminton",
    hourlyRate: rate,
    rules,
    hours: fullWeek("06:00-23:00"),
    isIndoor: true,
    comingSoon: false,
    surface: null,
    capacity: 1,
    playerCapacity: 4,
    amenities: [],
    voucherEnabled: false,
    blockedHours: {},
    blockedDates: {},
    minRate: rate,
    maxRate: rate,
  };
}

function venue(id: number, name: string, courts: AnyCourt[], lat = 10.3, lng = 123.9): AnyVenue {
  return {
    id,
    name,
    address: `${name} St`,
    lat,
    lng,
    timezone: TZ,
    hours: fullWeek("06:00-23:00"),
    hoursText: null,
    amenities: ["Parking"],
    facilityServices: [],
    foodBeverages: [],
    fees: [],
    feesNotes: null,
    paymentMode: "full",
    refundCutoffHours: 24,
    cancellationNotes: null,
    rules: null,
    description: null,
    contactPhone: null,
    contactEmail: null,
    mapEmoji: null,
    courts,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function catalogOf(venues: AnyVenue[]): any {
  const byCourt = new Map<number, unknown>();
  for (const v of venues)
    for (const c of v.courts as AnyCourt[]) byCourt.set(c.id as number, { court: c, venue: v });
  return {
    venues,
    byVenue: new Map(venues.map((v) => [v.id as number, v])),
    byCourt,
    sports: [{ slug: "badminton", name: "Badminton" }],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Availability rows shaped like the RPC, for the fallback path. */
function availRows(freeHours: number[], allHours: number[]) {
  return allHours.map((h) => ({
    hour_start: zonedHourToUtc(DATE, h, TZ).toISOString(),
    remaining: freeHours.includes(h) ? 1 : 0,
    blocked_by_other_sport: false,
    held_for_payment: false,
  }));
}

const base = () => defaultParams({ dateISO: DATE, now: NOW });

beforeEach(() => {
  /* Braces on purpose: an arrow that *returns* the mock is treated by Vitest as a
     cleanup hook and called with no arguments at teardown, which lands inside the
     implementation under test. */
  rpc.mockReset();
});

describe("server-side discovery", () => {
  it("asks the database once, whatever the size of the catalogue", async () => {
    const venues = Array.from({ length: 12 }, (_, i) =>
      venue(i + 1, `Venue ${i + 1}`, [court(100 + i, i + 1, "Court 1", 250)]),
    );
    rpc.mockResolvedValue({ data: [], error: null });

    await discover(base(), catalogOf(venues));

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("search_available_courts");
    /* The specific regression this replaces: one availability call per court. */
    expect(rpc.mock.calls.filter((c) => c[0] === "get_court_availability")).toHaveLength(0);
  });

  it("returns a venue far down the catalogue — there is no six-venue horizon", async () => {
    const venues = Array.from({ length: 12 }, (_, i) =>
      venue(i + 1, `Venue ${i + 1}`, [court(100 + i, i + 1, "Court 1", 250)]),
    );
    rpc.mockResolvedValue({
      data: [
        {
          court_id: 109,
          venue_id: 10,
          free_hours: [19, 20],
          free_hour_count: 2,
          run_start: 19,
          run_length: 2,
          period_total: 500,
          period_rate: 250,
          distance_km: 8.2,
          total_matches: 1,
        },
      ],
      error: null,
    });

    const res = await discover(base(), catalogOf(venues));
    expect(res.degraded).toBe(false);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].venueId).toBe(10);
    expect(res.total).toBe(1);
  });

  it("sends every filter the question carried", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await discover(
      {
        ...base(),
        hours: [19, 20],
        sportSlug: "badminton",
        origin: { lat: 10.3, lng: 123.9 },
        maxKm: 5,
        maxPrice: 300,
        payment: "online",
        amenities: ["parking"],
        tenantScope: true,
        order: "price",
        limit: 4,
        offset: 8,
      },
      catalogOf([]),
    );
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args._hours).toEqual([19, 20]);
    expect(args._sport_slug).toBe("badminton");
    expect(args._max_km).toBe(5);
    expect(args._max_price).toBe(300);
    expect(args._payment).toBe("online");
    expect(args._amenities).toEqual(["parking"]);
    expect(args._tenant_scope).toBe(true);
    expect(args._order).toBe("price");
    expect(args._limit).toBe(4);
    expect(args._offset).toBe(8);
  });

  it("scopes a tenant search on the server, never by trimming in the browser", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await discover({ ...base(), tenantScope: true }, catalogOf([]));
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    /* The venue list is a narrowing filter only. Authorisation is _tenant_scope,
       which the function resolves from auth.uid() against the staff table. */
    expect(args._tenant_scope).toBe(true);
    expect(args._venue_ids).toBeNull();
  });
});

describe("fallback when the migration is not applied yet", () => {
  const dispatch =
    (perCourt: Record<number, number[]>, open: number[]) =>
    (name: string, a: Record<string, unknown>) => {
      if (name === "search_available_courts") {
        return Promise.resolve({
          data: null,
          error: { code: "PGRST202", message: "Could not find the function" },
        });
      }
      const id = a._court_id as number;
      return Promise.resolve({ data: availRows(perCourt[id] ?? [], open), error: null });
    };
  const OPEN = Array.from({ length: 17 }, (_, i) => i + 6); // 6..22

  it("falls back, still answers, and admits it only saw part of the catalogue", async () => {
    const venues = Array.from({ length: 12 }, (_, i) =>
      venue(i + 1, `Venue ${i + 1}`, [court(100 + i, i + 1, "Court 1", 250)]),
    );
    const free: Record<number, number[]> = {};
    for (let i = 0; i < 12; i++) free[100 + i] = [19, 20];
    rpc.mockImplementation((n: string, a: Record<string, unknown>) => dispatch(free, OPEN)(n, a));

    const res = await discover({ ...base(), hours: [19, 20] }, catalogOf(venues));
    expect(res.degraded).toBe(true);
    expect(res.scanned).toBe(FALLBACK_VENUE_CAP);
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it("requires the WHOLE requested range, not merely part of it", async () => {
    /* Court 200 is free 7-8 but booked 8-9; court 201 is free for both. */
    const venues = [
      venue(1, "Split", [court(200, 1, "Court A", 250), court(201, 1, "Court B", 250)]),
    ];
    rpc.mockImplementation((n: string, a: Record<string, unknown>) =>
      dispatch({ 200: [19], 201: [19, 20] }, OPEN)(n, a),
    );

    const res = await discover({ ...base(), hours: [19, 20] }, catalogOf(venues));
    const ids = res.rows.map((r) => r.courtId);
    expect(ids).toContain(201);
    expect(ids).not.toContain(200);
  });

  it("prices the hours actually asked for, not the advertised minimum", async () => {
    /* Court A is cheaper on paper (200 base) but charges 400 in the evening.
       Court B is a flat 250. For 7-9 PM, B is the cheaper booking. */
    const evening = [{ id: "pm", days: ["sat"], start_hour: 18, end_hour: 23, rate: 400 }];
    const venues = [
      venue(1, "Rate Test", [
        court(300, 1, "Court A", 200, evening),
        court(301, 1, "Court B", 250),
      ]),
    ];
    rpc.mockImplementation((n: string, a: Record<string, unknown>) =>
      dispatch({ 300: [19, 20], 301: [19, 20] }, OPEN)(n, a),
    );

    const res = await discover({ ...base(), hours: [19, 20], order: "price" }, catalogOf(venues));
    expect(res.rows[0].courtId).toBe(301);
    expect(res.rows[0].periodTotal).toBe(500);
    const a = res.rows.find((r) => r.courtId === 300)!;
    expect(a.periodTotal).toBe(800);
  });

  it("ranks by distance when that is what was asked", async () => {
    const near = venue(1, "Near", [court(400, 1, "Court 1", 250)], 10.31, 123.91);
    const far = venue(2, "Far", [court(401, 2, "Court 1", 250)], 10.6, 124.2);
    rpc.mockImplementation((n: string, a: Record<string, unknown>) =>
      dispatch({ 400: [19, 20], 401: [19, 20] }, OPEN)(n, a),
    );

    const res = await discover(
      { ...base(), hours: [19, 20], order: "distance", origin: { lat: 10.3, lng: 123.9 } },
      catalogOf([far, near]),
    );
    expect(res.rows[0].courtId).toBe(400);
    expect(res.rows[0].distanceKm!).toBeLessThan(res.rows[1].distanceKm!);
  });

  it("keeps a tenant's search inside the venues it was given", async () => {
    const mine = venue(1, "Mine", [court(500, 1, "Court 1", 250)]);
    const theirs = venue(2, "Theirs", [court(501, 2, "Court 1", 250)]);
    rpc.mockImplementation((n: string, a: Record<string, unknown>) =>
      dispatch({ 500: [19, 20], 501: [19, 20] }, OPEN)(n, a),
    );

    /* The catalogue a tenant is handed is already staff-scoped; the fallback must
       not reach outside it. The server path is scoped again in SQL. */
    const res = await discover(
      { ...base(), hours: [19, 20], tenantScope: true },
      catalogOf([mine]),
    );
    expect(res.rows.map((r) => r.venueId)).toEqual([1]);
    expect(res.rows.some((r) => r.venueId === 2)).toBe(false);
    void theirs;
  });
});

describe("ordering and explanation", () => {
  const row = (over: Partial<Record<string, number | null>>) =>
    ({
      courtId: 1,
      venueId: 1,
      freeHours: [19, 20],
      freeHourCount: 2,
      runStart: 19,
      runLength: 2,
      periodTotal: 500,
      periodRate: 250,
      distanceKm: 2,
      ...over,
    }) as Parameters<ReturnType<typeof compareBy>>[0];

  it("sorts on the axis the question named", () => {
    const cheap = row({ courtId: 1, periodRate: 200, distanceKm: 9 });
    const close = row({ courtId: 2, periodRate: 400, distanceKm: 1 });
    expect([close, cheap].sort(compareBy("price"))[0].courtId).toBe(1);
    expect([cheap, close].sort(compareBy("distance"))[0].courtId).toBe(2);
  });

  it("only cites criteria the ordering actually used", () => {
    const r = row({});
    expect(rankReason(r, "price", [19, 20])).toContain("cheapest");
    expect(rankReason(r, "price", [19, 20])).not.toContain("closest");
    expect(rankReason(r, "distance", [19, 20])).toContain("closest");
    expect(rankReason(r, "distance", [19, 20])).not.toContain("cheapest");
    expect(rankReason(r, "price", [19, 20])).toContain("whole 2-hour block");
  });
});

describe("privacy and dead ends", () => {
  it("reports a taken slot without ever naming who took it", async () => {
    const { slotStateLabel } = await import("@/lib/assistant/slots");
    for (const state of ["booked", "hold", "other_sport", "past", "blocked", "open"] as const) {
      const label = slotStateLabel(state);
      expect(label).not.toMatch(/@|name|email|phone/i);
    }
    expect(slotStateLabel("booked")).toBe("booked by another player");
    expect(slotStateLabel("hold")).toBe("on hold while someone pays");
  });

  it("never asks the availability RPC for anything identifying", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await discover({ ...base(), hours: [19, 20] }, catalogOf([]));
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    /* The whole argument surface: dates, filters, paging. No user identity anywhere,
       and nothing that could be used to ask about one. */
    expect(Object.keys(args).some((k) => /user|player|email|phone|name/i.test(k))).toBe(false);
  });

  it("offers a real alternative instead of dead-ending on no results", async () => {
    const { resolveDiscovery } = await import("@/lib/assistant/discovery");
    const { parseQuestion } = await import("@/lib/assistant/intents");
    const cat = catalogOf([venue(1, "Only", [court(900, 1, "Court 1", 250)])]);

    /* Nothing matches the 5 km cap; widening finds one. */
    let call = 0;
    rpc.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ data: [], error: null });
      return Promise.resolve({
        data: [
          {
            court_id: 900,
            venue_id: 1,
            free_hours: [19, 20],
            free_hour_count: 2,
            run_start: 19,
            run_length: 2,
            period_total: 500,
            period_rate: 250,
            distance_km: 7.4,
            total_matches: 1,
          },
        ],
        error: null,
      });
    });

    const parsed = parseQuestion("badminton courts within 5 km tonight", cat, DATE, "player");
    const answer = await resolveDiscovery({
      catalog: cat,
      parsed,
      todayISO: DATE,
      nowMs: NOW.getTime(),
      ask: { role: "player", origin: { lat: 10.3, lng: 123.9, label: "you", source: "gps" } },
    });

    expect(answer.blocks[0]).toMatchObject({ kind: "text" });
    expect((answer.blocks[0] as { text: string }).text).toContain("came back free");
    /* The point of the test: it found something to offer rather than stopping. */
    expect(answer.chips.length).toBeGreaterThan(0);
    expect(answer.chips.some((c) => /expand|any price|any time/i.test(c.label))).toBe(true);
  });
});
