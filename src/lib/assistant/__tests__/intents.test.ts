/**
 * What the classifier understands.
 *
 * These are the phrasings the feature is for. The important assertions are the
 * negative ones: an unrecognised question must land on `unknown` rather than on a
 * confident wrong answer, and a generic court name must not pull an unrelated
 * question onto some venue's "Court 1".
 */

import { describe, expect, it } from "vitest";
import { parseQuestion } from "@/lib/assistant/intents";
import type { Catalog, CatalogCourt, CatalogVenue } from "@/lib/assistant/catalog";
import { fullWeek } from "@/lib/operating-hours";

const TODAY = "2026-08-27";

function court(
  id: number,
  venueId: number,
  name: string,
  sport: string,
  rate: number,
): CatalogCourt {
  return {
    id,
    venueId,
    name,
    sport,
    sportSlug: sport.toLowerCase(),
    hourlyRate: rate,
    rules: [],
    hours: fullWeek("06:00-22:00"),
    isIndoor: true,
    comingSoon: false,
    surface: "hardcourt",
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

function venue(id: number, name: string, courts: CatalogCourt[]): CatalogVenue {
  return {
    id,
    name,
    address: `${name} Road`,
    lat: 10.3,
    lng: 123.9,
    timezone: "Asia/Manila",
    hours: fullWeek("06:00-22:00"),
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

const smash = venue(1, "Smash Arena", [
  court(11, 1, "Court 1", "Badminton", 300),
  court(12, 1, "Court 2", "Badminton", 350),
  court(13, 1, "Center Court", "Basketball", 900),
]);
const northgate = venue(2, "Northgate Sports Hub", [court(21, 2, "Court 1", "Basketball", 800)]);

const CATALOG: Catalog = {
  venues: [smash, northgate],
  byVenue: new Map([
    [1, smash],
    [2, northgate],
  ]),
  byCourt: new Map([
    [11, { court: smash.courts[0], venue: smash }],
    [12, { court: smash.courts[1], venue: smash }],
    [13, { court: smash.courts[2], venue: smash }],
    [21, { court: northgate.courts[0], venue: northgate }],
  ]),
  sports: [
    { slug: "badminton", name: "Badminton" },
    { slug: "basketball", name: "Basketball" },
  ],
};

const askAs = (role: "player" | "tenant") => (q: string) => parseQuestion(q, CATALOG, TODAY, role);
const player = askAs("player");
const tenant = askAs("tenant");

describe("intent", () => {
  it("greets and explains itself", () => {
    expect(player("hi").intent).toBe("greeting");
    expect(player("kumusta").intent).toBe("greeting");
    expect(player("what can you do").intent).toBe("help");
  });

  it("separates the price questions", () => {
    expect(player("cheapest badminton court").intent).toBe("cheapest");
    expect(player("pinakamura na court").intent).toBe("cheapest");
    expect(player("how much is court 2 at smash arena").intent).toBe("pricing");
    expect(player("magkano sa smash arena").intent).toBe("pricing");
  });

  it("tells a browse from a single yes-or-no slot question", () => {
    expect(player("what is free at smash arena on saturday").intent).toBe("availability");
    expect(player("is court 1 free tomorrow 7pm at smash arena").intent).toBe("slot_check");
    expect(player("whats open tonight").intent).toBe("open_now");
  });

  it("reads location questions", () => {
    expect(player("courts near me").intent).toBe("nearby");
    expect(player("how far is smash arena").intent).toBe("nearby");
    expect(player("badminton near Ayala Center Cebu").intent).toBe("nearby");
  });

  it("reads the policy and facility questions", () => {
    expect(player("refund policy at smash arena").intent).toBe("refund");
    expect(player("what if i cancel").intent).toBe("refund");
    expect(player("how do i pay").intent).toBe("payment");
    expect(player("do they accept gcash").intent).toBe("payment");
    expect(player("is there parking at smash arena").intent).toBe("amenities");
    expect(player("what time do they open").intent).toBe("hours");
  });

  it("refuses to guess", () => {
    expect(player("asdfgh").intent).toBe("unknown");
    expect(player("what is the meaning of life").intent).toBe("unknown");
  });
});

describe("entities", () => {
  it("finds the venue by name inside a sentence", () => {
    expect(player("how much is court 2 at smash arena").venue?.id).toBe(1);
    expect(player("what is free at northgate sports hub").venue?.id).toBe(2);
  });

  it("does not confuse two venues", () => {
    expect(player("is smash arena open").venue?.id).toBe(1);
    expect(player("is northgate open").venue?.id).toBe(2);
  });

  it("finds a numbered court within the named venue", () => {
    const p = player("is court 2 free at smash arena tomorrow 7pm");
    expect(p.court?.id).toBe(12);
  });

  it("never matches a generic court name on its own", () => {
    /* "Court 1" exists at both venues and carries no information — a question that
       merely contains the word must not land on one of them. */
    expect(player("cheapest badminton court").court).toBeNull();
    expect(player("any court tonight").court).toBeNull();
  });

  it("finds the sport, including shorthand", () => {
    expect(player("cheapest badminton court").sportSlug).toBe("badminton");
    expect(player("any bball tonight").sportSlug).toBe("basketball");
  });

  it("separates 'near me' from a named landmark", () => {
    expect(player("courts near me").wantsMyLocation).toBe(true);
    expect(player("courts near me").place).toBeNull();
    expect(player("courts near Ayala Center Cebu").place).toBe("ayala center cebu");
    expect(player("courts near Ayala Center Cebu").wantsMyLocation).toBe(false);
  });

  it("carries the parsed time through to the target", () => {
    const p = player("is court 1 free at smash arena tomorrow 7-9pm");
    expect(p.when.dateISO).toBe("2026-08-28");
    expect(p.when.hours).toEqual([19, 20]);
  });
});

describe("role", () => {
  it("reads an unqualified availability question as the tenant's own schedule", () => {
    expect(tenant("what is free tomorrow").intent).toBe("my_schedule");
    expect(player("what is free tomorrow").intent).toBe("open_now");
  });

  it("gives occupancy to tenants only", () => {
    expect(tenant("how booked am i tonight").intent).toBe("my_occupancy");
    expect(player("how booked am i tonight").intent).toBe("availability");
  });

  it("still lets a tenant ask about one of their venues by name", () => {
    expect(tenant("what is free at smash arena tomorrow").intent).toBe("availability");
  });
});
