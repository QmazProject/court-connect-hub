/**
 * Phase 2: follow-ups, local language, and the opening-hours rule.
 *
 * The context tests are pure — no database, no mocks — because the whole point of
 * the design is that a follow-up is a *structured edit* of the previous target
 * rather than a re-reading of the words.
 */

import { describe, expect, it } from "vitest";
import {
  applyContext,
  forIdentity,
  identityOf,
  looksLikeFollowUp,
  newConversation,
  remember,
  resolveReference,
  type Conversation,
} from "@/lib/assistant/context";
import { parseQuestion } from "@/lib/assistant/intents";
import type { Catalog, CatalogCourt, CatalogVenue } from "@/lib/assistant/catalog";
import { editDistance, typoBudget } from "@/lib/assistant/normalize";
import { parseWhen } from "@/lib/assistant/when";
import { fullWeek, isClosed, openHoursForDate, parseWindow } from "@/lib/operating-hours";
import type { Answer, ResultRef } from "@/lib/assistant/types";

const TODAY = "2026-08-27"; // Thursday

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
function venue(id: number, name: string, courts: CatalogCourt[]): CatalogVenue {
  return {
    id,
    name,
    address: `${name} Rd`,
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
const north = venue(1, "Northgate Sports Hub", [court(11, 1, "Court A", "Badminton", 250)]);
const cebu = venue(2, "Cebu Sports Center", [court(21, 2, "Court B", "Badminton", 300)]);
const central = venue(3, "Central Courts", [court(31, 3, "Court C", "Badminton", 200)]);

const CATALOG: Catalog = {
  venues: [north, cebu, central],
  byVenue: new Map([
    [1, north],
    [2, cebu],
    [3, central],
  ]),
  byCourt: new Map([
    [11, { court: north.courts[0], venue: north }],
    [21, { court: cebu.courts[0], venue: cebu }],
    [31, { court: central.courts[0], venue: central }],
  ]),
  sports: [
    { slug: "badminton", name: "Badminton" },
    { slug: "pickleball", name: "Pickleball" },
  ],
};

const refs: ResultRef[] = [
  {
    rank: 0,
    courtId: 11,
    venueId: 1,
    label: "Northgate Sports Hub — Court A",
    periodRate: 250,
    distanceKm: 1.8,
    runStart: 19,
    runLength: 2,
  },
  {
    rank: 1,
    courtId: 21,
    venueId: 2,
    label: "Cebu Sports Center — Court B",
    periodRate: 300,
    distanceKm: 3.1,
    runStart: 19,
    runLength: 2,
  },
  {
    rank: 2,
    courtId: 31,
    venueId: 3,
    label: "Central Courts — Court C",
    periodRate: 200,
    distanceKm: 9.4,
    runStart: 19,
    runLength: 2,
  },
];

/** A conversation as it stands after "badminton near Cebu City tonight" answered. */
function afterFirstTurn(): Conversation {
  const conv = newConversation();
  conv.identity = "player-1:player";
  const parsed = parseQuestion("badminton courts near Cebu City tonight", CATALOG, TODAY, "player");
  const answer: Answer = {
    intent: "nearby",
    blocks: [],
    chips: [],
    used: { venueIds: [1, 2, 3], courtIds: [11, 21, 31] },
    meta: { results: refs },
  };
  remember(conv, parsed, answer, refs, {
    lat: 10.3,
    lng: 123.9,
    label: "Cebu City",
    source: "place",
  });
  return conv;
}

describe("follow-up detection", () => {
  it("knows a continuation from a standalone question", () => {
    expect(looksLikeFollowUp("which is cheapest?")).toBe(true);
    expect(looksLikeFollowUp("how about tomorrow?")).toBe(true);
    expect(looksLikeFollowUp("does it have parking?")).toBe(true);
    expect(looksLikeFollowUp("the first one")).toBe(true);
    expect(looksLikeFollowUp("what badminton courts are near me tonight")).toBe(false);
  });
});

describe("resolving references", () => {
  it("resolves an ordinal against what was shown", () => {
    const conv = afterFirstTurn();
    const r = resolveReference("is the second one available tomorrow?", conv);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.ref.courtId).toBe(21);
  });

  it("resolves cheapest and closest from the shown rows, not globally", () => {
    const conv = afterFirstTurn();
    const cheap = resolveReference("book the cheapest one", conv);
    const close = resolveReference("how far is the closest one", conv);
    expect(cheap.kind === "resolved" && cheap.ref.courtId).toBe(31);
    expect(close.kind === "resolved" && close.ref.courtId).toBe(11);
  });

  it("asks instead of guessing when there is no list", () => {
    const r = resolveReference("is the second one available?", newConversation());
    expect(r.kind).toBe("ambiguous");
  });

  it("asks instead of guessing past the end of the list", () => {
    const conv = afterFirstTurn();
    const r = resolveReference("the fifth one", conv);
    expect(r.kind).toBe("ambiguous");
  });
});

describe("the conversation in the brief", () => {
  it("'which is cheapest?' keeps the sport and the place", () => {
    const conv = afterFirstTurn();
    const raw = parseQuestion("which is cheapest?", CATALOG, TODAY, "player");
    const { parsed } = applyContext(raw, conv, CATALOG, null);
    expect(parsed.intent).toBe("cheapest");
    expect(parsed.sportSlug).toBe("badminton");
    expect(conv.origin?.label).toBe("Cebu City");
  });

  it("'how about the first one tomorrow at 8' moves the day and the hour", () => {
    const conv = afterFirstTurn();
    const raw = parseQuestion("how about the first one tomorrow at 8", CATALOG, TODAY, "player");
    const { parsed } = applyContext(raw, conv, CATALOG, null);
    expect(parsed.court?.id).toBe(11);
    expect(parsed.venue?.id).toBe(1);
    expect(parsed.when.dateISO).toBe("2026-08-28");
    expect(parsed.when.hours).toEqual([20]);
  });

  it("'does it have parking?' stays on the venue under discussion", () => {
    const conv = afterFirstTurn();
    const raw = parseQuestion("does it have parking?", CATALOG, TODAY, "player");
    const { parsed } = applyContext(raw, conv, CATALOG, null);
    expect(parsed.intent).toBe("amenities");
    expect(parsed.venue?.id).toBe(1);
  });

  it("keeps the day under discussion when a follow-up names only a time", () => {
    const conv = afterFirstTurn();
    conv.dateISO = "2026-08-29";
    const raw = parseQuestion("how about 9pm?", CATALOG, TODAY, "player");
    const { parsed } = applyContext(raw, conv, CATALOG, null);
    expect(parsed.when.dateISO).toBe("2026-08-29");
    expect(parsed.when.hours).toEqual([21]);
  });
});

describe("context is per identity", () => {
  it("throws everything away when the signed-in user changes", () => {
    const conv = afterFirstTurn();
    expect(conv.results).toHaveLength(3);
    const next = forIdentity(conv, identityOf("player-2", "player"));
    expect(next.results).toHaveLength(0);
    expect(next.selectedCourtId).toBeNull();
    expect(next.selectedVenueId).toBeNull();
    expect(next.origin).toBeNull();
  });

  it("throws it away on a role change for the same person too", () => {
    const conv = afterFirstTurn();
    const next = forIdentity(conv, identityOf("player-1", "tenant"));
    expect(next.results).toHaveLength(0);
  });

  it("keeps the same context for the same identity", () => {
    const conv = afterFirstTurn();
    expect(forIdentity(conv, "player-1:player").results).toHaveLength(3);
  });

  it("remembers a refused location so the browser is not asked again", () => {
    const conv = afterFirstTurn();
    conv.locationDenied = true;
    expect(forIdentity(conv, identityOf("player-2", "player")).locationDenied).toBe(true);
  });
});

describe("time language", () => {
  it("reads the new vague periods and pins them to real hours", () => {
    expect(parseWhen("this evening", TODAY).hours).toEqual([17, 18, 19, 20, 21]);
    expect(parseWhen("tomorrow morning", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("tomorrow morning", TODAY).hours).toEqual([6, 7, 8, 9, 10, 11]);
    expect(parseWhen("this afternoon", TODAY).hours).toEqual([13, 14, 15, 16, 17]);
  });

  it("reads open-ended and approximate times", () => {
    expect(parseWhen("after 6", TODAY).hours[0]).toBe(18);
    expect(parseWhen("after 6pm", TODAY).hours).toContain(23);
    expect(parseWhen("7pm onwards", TODAY).hours[0]).toBe(19);
    expect(parseWhen("before 8", TODAY).hours[0]).toBe(6);
    expect(parseWhen("before 8", TODAY).hours).not.toContain(20);
    expect(parseWhen("around 7", TODAY).hours).toEqual([18, 19, 20]);
  });

  it("narrows 'later today' to the hours still ahead", () => {
    const w = parseWhen("later today", TODAY, 15);
    expect(w.dateISO).toBe(TODAY);
    expect(w.hours[0]).toBe(16);
    expect(w.hours).not.toContain(15);
  });

  it("reads weekends as one named day rather than a vague span", () => {
    expect(parseWhen("this weekend", TODAY).dateISO).toBe("2026-08-29");
    expect(parseWhen("next weekend", TODAY).dateISO).toBe("2026-09-05");
    expect(parseWhen("next saturday", TODAY).dateISO).toBe("2026-08-29");
  });
});

describe("Filipino and Cebuano", () => {
  const ask = (q: string) => parseQuestion(q, CATALOG, TODAY, "player");

  it("reads price questions", () => {
    expect(ask("magkano badminton?").intent).toBe("pricing");
    expect(ask("tagpila per hour?").intent).toBe("pricing");
    expect(ask("pila ang court?").intent).toBe("pricing");
  });

  it("reads nearness questions", () => {
    expect(ask("asa pinakaduol?").intent).toBe("nearby");
    expect(ask("saan pinakamalapit?").intent).toBe("nearby");
  });

  it("reads availability, amenity and payment questions", () => {
    /* With no venue, sport or clock time named, "is anything free right now" is a
       browse of what is open — which is the same discovery answer. */
    expect(ask("bakante ba karon?").intent).toBe("open_now");
    expect(ask("naa pay available?").intent).toBe("open_now");
    expect(ask("bakante ba sa Northgate?").intent).toBe("availability");
    expect(ask("naa parking?").intent).toBe("amenities");
    expect(ask("pwede gcash?").intent).toBe("payment");
  });

  it("reads Cebuano and Tagalog day words", () => {
    expect(parseWhen("ugma", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("bukas", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("mamaya", TODAY).dateISO).toBe(TODAY);
    expect(parseWhen("karon", TODAY).dateISO).toBe(TODAY);
  });
});

describe("typo tolerance", () => {
  it("measures edits within a bound and gives up past it", () => {
    expect(editDistance("badmnton", "badminton", 2)).toBe(1);
    expect(editDistance("picklebal", "pickleball", 2)).toBe(1);
    expect(editDistance("basketball", "badminton", 2)).toBeGreaterThan(2);
  });

  it("gives short words no slack at all", () => {
    expect(typoBudget("cat")).toBe(0);
    expect(typoBudget("court")).toBe(1);
    expect(typoBudget("badminton")).toBe(2);
  });

  it("reaches the sport through a typo", () => {
    expect(parseQuestion("cheapest badmnton court", CATALOG, TODAY, "player").sportSlug).toBe(
      "badminton",
    );
    expect(parseQuestion("any picklebal tonight", CATALOG, TODAY, "player").sportSlug).toBe(
      "pickleball",
    );
  });

  it("still refuses to fuzzy-match a generic court name onto a venue", () => {
    const p = parseQuestion("is court 1 available?", CATALOG, TODAY, "player");
    expect(p.court).toBeNull();
    expect(p.venue).toBeNull();
  });
});

describe("opening hours: the rule the SQL now mirrors", () => {
  it("treats a literal 'closed' as closed, never as open all day", () => {
    expect(parseWindow("closed")).toBeNull();
    expect(isClosed("closed")).toBe(true);
    const hours = { ...fullWeek("06:00-22:00"), sat: "closed" };
    /* 2026-08-29 is a Saturday. */
    expect(openHoursForDate(hours, "2026-08-29").size).toBe(0);
    expect(openHoursForDate(hours, "2026-08-28").size).toBeGreaterThan(0);
  });

  it("keeps an unparseable window open, which is the existing behaviour", () => {
    expect(parseWindow("whenever")).toEqual([0, 24]);
  });

  it("handles an overnight window on both sides of midnight", () => {
    const hours = fullWeek("18:00-02:00");
    const open = openHoursForDate(hours, "2026-08-28");
    /* The evening it opens... */
    expect(open.has(18)).toBe(true);
    expect(open.has(23)).toBe(true);
    /* ...and the small hours carried over from the night before. */
    expect(open.has(0)).toBe(true);
    expect(open.has(1)).toBe(true);
    /* But not the middle of the day. */
    expect(open.has(12)).toBe(false);
    expect(open.has(2)).toBe(false);
  });
});
