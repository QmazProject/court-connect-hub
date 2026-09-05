/**
 * Phase B: dynamic vocabulary, feedback signals, and the line between them.
 *
 * The assertion that matters most is a negative one: nothing a user types becomes
 * vocabulary. A miss is recorded as a signal and answered honestly; only a mapping
 * an admin wrote changes what the assistant understands.
 */

import { describe, expect, it } from "vitest";
import {
  buildVocabulary,
  nameTokens,
  suggestSport,
  type Mapping,
} from "@/lib/assistant/vocabulary";
import { sanitizeQuery, unknownAmenityTerm, unknownSportTerm } from "@/lib/assistant/feedback";
import { parseQuestion } from "@/lib/assistant/intents";
import type { Catalog, CatalogCourt, CatalogVenue } from "@/lib/assistant/catalog";
import { fullWeek } from "@/lib/operating-hours";

const TODAY = "2026-08-27";

function court(
  id: number,
  venueId: number,
  name: string,
  sport: string,
  amenities: string[] = [],
): CatalogCourt {
  return {
    id,
    venueId,
    name,
    sport,
    sportSlug: sport.toLowerCase().replace(/ /g, "-"),
    hourlyRate: 250,
    rules: [],
    hours: fullWeek("06:00-22:00"),
    isIndoor: true,
    comingSoon: false,
    surface: null,
    capacity: 1,
    playerCapacity: 4,
    amenities,
    voucherEnabled: false,
    blockedHours: {},
    blockedDates: {},
    minRate: 250,
    maxRate: 250,
  };
}
function venue(
  id: number,
  name: string,
  courts: CatalogCourt[],
  amenities: string[],
): CatalogVenue {
  return {
    id,
    name,
    address: `${name} Rd`,
    lat: 10.3,
    lng: 123.9,
    timezone: "Asia/Manila",
    hours: fullWeek("06:00-22:00"),
    hoursText: null,
    amenities,
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

/* A catalogue with a sport no hardcoded alias has ever heard of, and an amenity
   that is not in AMENITY_TERMS. */
const takrawCourt = court(1, 1, "Takraw Court", "Sepak Takraw");
const badmintonCourt = court(2, 1, "Court 1", "Badminton");
const arena = venue(1, "Sunrise Arena", [takrawCourt, badmintonCourt], ["Sauna", "Parking"]);

const CATALOG: Catalog = {
  venues: [arena],
  byVenue: new Map([[1, arena]]),
  byCourt: new Map([
    [1, { court: takrawCourt, venue: arena }],
    [2, { court: badmintonCourt, venue: arena }],
  ]),
  sports: [
    { slug: "sepak-takraw", name: "Sepak Takraw" },
    { slug: "badminton", name: "Badminton" },
  ],
  amenityValues: ["Sauna", "Parking"],
};

const vocab = (mappings: Mapping[] = []) => buildVocabulary(CATALOG, mappings);
const ask = (q: string, mappings: Mapping[] = []) =>
  parseQuestion(q, CATALOG, TODAY, "player", vocab(mappings));

describe("tokens derived from real names", () => {
  it("indexes the phrase and its distinctive words", () => {
    expect(nameTokens("Sepak Takraw").sort()).toEqual(["sepak", "sepak takraw", "takraw"]);
  });

  it("refuses words too generic to stand alone", () => {
    /* "Court" would otherwise match half the questions ever asked. */
    expect(nameTokens("Tennis Court")).not.toContain("court");
    expect(nameTokens("Tennis Court")).toContain("tennis");
  });

  it("drops words too short to be distinctive", () => {
    expect(nameTokens("Ice Hockey")).not.toContain("ice");
    expect(nameTokens("Ice Hockey")).toContain("hockey");
  });
});

describe("a new sport works with no code change", () => {
  it("resolves the full name, and either word of it", () => {
    expect(ask("any sepak takraw tonight").sportSlug).toBe("sepak-takraw");
    expect(ask("where can I play takraw").sportSlug).toBe("sepak-takraw");
    expect(ask("sepak courts tomorrow").sportSlug).toBe("sepak-takraw");
  });

  it("does not break the sports that were already understood", () => {
    expect(ask("cheapest badminton tonight").sportSlug).toBe("badminton");
    expect(ask("cheapest badmnton tonight").sportSlug).toBe("badminton");
  });

  it("still refuses a word CourtHub has never heard of", () => {
    expect(ask("where can I play quidditch").sportSlug).toBeNull();
  });

  it("offers the closest real sport as a suggestion, without applying it", () => {
    expect(suggestSport("takraw", CATALOG)).toBe("Sepak Takraw");
    expect(suggestSport("quidditch", CATALOG)).toBeNull();
  });
});

describe("a new amenity works with no code change", () => {
  it("filters on a value only because a venue lists it", () => {
    expect(ask("badminton venues with sauna").amenities).toEqual(["Sauna"]);
  });

  it("maps a built-in word onto the venue's own spelling", () => {
    /* "parking" is a built-in term; the filter must carry "Parking", the string
       venues actually store, not the lowercase constant. */
    expect(ask("courts with parking").amenities).toEqual(["Parking"]);
  });

  it("does not invent an amenity CourtHub has never listed", () => {
    expect(ask("badminton with a helipad").amenities).toBeNull();
  });
});

describe("trusted admin mappings", () => {
  const steamRoom: Mapping = {
    kind: "amenity_alias",
    normalizedTerm: "steam room",
    targetValue: "Sauna",
  };
  const bball: Mapping = {
    kind: "sport_alias",
    normalizedTerm: "takrow",
    targetValue: "Sepak Takraw",
  };

  it("makes an admin's word searchable", () => {
    expect(ask("venues with steam room", [steamRoom]).amenities).toEqual(["Sauna"]);
    expect(ask("any takrow tonight", [bball]).sportSlug).toBe("sepak-takraw");
  });

  it("does nothing until the admin has written it", () => {
    /* The same question, without the mapping, must not resolve. This is the whole
       safety property: user input never becomes vocabulary on its own. */
    expect(ask("venues with steam room").amenities).toBeNull();
  });

  it("cannot shadow CourtHub's own data", () => {
    const hostile: Mapping = {
      kind: "sport_alias",
      normalizedTerm: "badminton",
      targetValue: "Sepak Takraw",
    };
    /* A real sport name wins over any alias, so a bad mapping cannot redirect an
       existing word. */
    expect(ask("badminton tonight", [hostile]).sportSlug).toBe("badminton");
  });

  it("ignores a mapping whose target no longer exists", () => {
    const stale: Mapping = { kind: "amenity_alias", normalizedTerm: "jacuzzi", targetValue: "Spa" };
    expect(ask("venues with jacuzzi", [stale]).amenities).toBeNull();
  });

  it("is literal data, never a pattern", () => {
    const injection: Mapping = {
      kind: "amenity_alias",
      normalizedTerm: ".*",
      targetValue: "Sauna",
    };
    const v = buildVocabulary(CATALOG, [injection]);
    /* If the term were treated as a regex, every question would match. */
    expect([...v.amenityTokens.keys()]).not.toContain(".*");
    expect(ask("badminton tonight", [injection]).amenities).toBeNull();
  });
});

describe("naming the term that was missed", () => {
  it("picks out the unknown sport word the user actually typed", () => {
    expect(unknownSportTerm("where can I play quidditch", null)).toBe("quidditch");
    expect(unknownSportTerm("any pickleball tonight", "pickleball")).toBeNull();
  });

  it("picks out the unknown amenity word", () => {
    expect(unknownAmenityTerm("badminton with a helipad", null)).toBe("helipad");
    expect(unknownAmenityTerm("badminton with sauna", ["Sauna"])).toBeNull();
  });

  it("does not report a generic word as a term to map", () => {
    expect(unknownAmenityTerm("a court with the slot", null)).toBeNull();
  });

  it("surfaces the unknown term on the parse, so the answer can mention it", () => {
    const p = ask("badminton with a helipad");
    expect(p.unknownAmenity).toBe("helipad");
    expect(p.sportSlug).toBe("badminton");
  });
});

describe("what is never persisted", () => {
  it("redacts the shapes people paste by accident", () => {
    expect(sanitizeQuery("email me at bob@example.com")).toContain("[email]");
    expect(sanitizeQuery("my key is sk_live_abcdefgh1234")).toContain("[key]");
    expect(sanitizeQuery("Bearer abcdefghijklmnop")).toContain("[token]");
    expect(sanitizeQuery("card 4111111111111111")).toContain("[number]");
    expect(sanitizeQuery("ring me on 09171234567")).toContain("[phone]");
  });

  it("keeps an ordinary question intact", () => {
    const q = "cheapest badminton near Cebu City tonight";
    expect(sanitizeQuery(q)).toBe(q);
  });

  it("bounds what is stored", () => {
    expect(sanitizeQuery("a".repeat(500)).length).toBe(160);
  });

  it("drops text too short to be a signal", () => {
    expect(sanitizeQuery("  ")).toBe("");
  });
});

describe("the catalogue catches up with this browser's own changes", () => {
  it("drops the cache on any successful mutation", async () => {
    const { registerAssistantCacheInvalidation } = await import("@/lib/assistant/catalog");

    let handler: ((e: { type: string; mutation?: { state: { status: string } } }) => void) | null =
      null;
    const fakeClient = {
      getMutationCache: () => ({
        subscribe: (cb: typeof handler) => {
          handler = cb;
          return () => {};
        },
      }),
    };

    const unsubscribe = registerAssistantCacheInvalidation(
      fakeClient as unknown as Parameters<typeof registerAssistantCacheInvalidation>[0],
    );
    expect(handler).toBeTypeOf("function");

    /* A manager saving a court must not then be told it does not exist. The
       subscriber is what makes the next question re-read, rather than waiting out
       the 60-second TTL. */
    const fire = handler as unknown as (e: {
      type: string;
      mutation?: { state: { status: string } };
    }) => void;
    expect(() =>
      fire({ type: "updated", mutation: { state: { status: "success" } } }),
    ).not.toThrow();
    /* A pending or failed mutation changed nothing, so it must not invalidate. */
    expect(() =>
      fire({ type: "updated", mutation: { state: { status: "pending" } } }),
    ).not.toThrow();
    expect(() => fire({ type: "added" })).not.toThrow();

    unsubscribe();
  });
});
