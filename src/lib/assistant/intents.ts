/**
 * Deciding what a question is asking, and about what.
 *
 * Two passes. Phrases score first because a whole phrase is far less ambiguous than
 * its words — "what time do they open" is about opening hours, though "open" on its
 * own is a word about availability. Loose keywords then add on top.
 *
 * Nothing here invents an answer. The output is a target (which venue, which court,
 * which hours) that a resolver then goes and reads. When the score stays under
 * `MIN_SCORE` the intent is `unknown`, and the engine asks instead of guessing.
 */

import type { Catalog, CatalogCourt, CatalogVenue } from "./catalog";
import { SPORT_ALIASES, editDistance, fold, keywords, nameScore, typoBudget } from "./normalize";
import type { AssistantRole, IntentKind } from "./types";
import { parseWhen, type When } from "./when";

export type Parsed = {
  intent: IntentKind;
  score: number;
  text: string;
  venue: CatalogVenue | null;
  court: CatalogCourt | null;
  sportSlug: string | null;
  when: When;
  /** A landmark or city typed after "near". */
  place: string | null;
  /** "near me" — the answer needs the browser's position. */
  wantsMyLocation: boolean;
  /** "under P300/hr" — a ceiling on the rate for the hours actually asked about. */
  maxPrice: number | null;
  minPrice: number | null;
  /** "within 5 km" */
  maxKm: number | null;
  /** "with parking and showers" — matched against stored venue/court lists only. */
  amenities: string[] | null;
  /** online = the venue takes payment through CourtHub; venue = settle on site. */
  payment: "online" | "venue" | null;
  /** "a 2-hour slot" — how long a block must be when no exact hours were named. */
  minDuration: number;
};

/** Below this, the engine offers suggestions rather than an answer. */
export const MIN_SCORE = 2;

const PHRASES: { re: RegExp; intent: IntentKind; weight: number }[] = [
  {
    re: /^\s*(hi|hello|hey|yo|sup|kumusta|kamusta|good (morning|afternoon|evening))\b/,
    intent: "greeting",
    weight: 6,
  },
  {
    re: /\bwhat can you do\b|\bwhat do you know\b|\bhow do you work\b|\bhelp me\b|^\s*help\b/,
    intent: "help",
    weight: 6,
  },

  {
    re: /\bnear me\b|\baround me\b|\bclosest to me\b|\bnearest to me\b|\bmalapit sa akin\b/,
    intent: "nearby",
    weight: 6,
  },
  { re: /\bhow far\b|\bhow many km\b|\bdistance to\b/, intent: "nearby", weight: 6 },
  { re: /\b(near|nearest|closest|around|malapit sa)\b/, intent: "nearby", weight: 3 },

  {
    re: /\bcheapest\b|\blowest (price|rate)\b|\bmost affordable\b|\bpinakamura\b/,
    intent: "cheapest",
    weight: 6,
  },
  {
    re: /\bhow much\b|\bmagkano\b|\bwhat.{0,6}(the )?(price|rate)\b|\bprice list\b|\brate card\b/,
    intent: "pricing",
    weight: 5,
  },

  { re: /\bwhat time\b.{0,20}\b(open|close|opens|closes)\b/, intent: "hours", weight: 6 },
  {
    re: /\bopen(ing)? hours?\b|\bbusiness hours\b|\bschedule\b|\banong oras.{0,12}(bukas|sarado)\b/,
    intent: "hours",
    weight: 6,
  },
  {
    re: /\bopen (today|tomorrow|now|tonight)\b|\bwho is open\b|\bwhats open\b|\bwhat is open\b/,
    intent: "open_now",
    weight: 5,
  },

  {
    re: /\b(refund|cancellation) policy\b|\bwhat if i cancel\b|\bcan i cancel\b|\bmakukuha ko ba.{0,12}pera\b/,
    intent: "refund",
    weight: 6,
  },
  { re: /\bhow (do|can) i pay\b|\bpayment (method|option|mode)/, intent: "payment", weight: 6 },
  { re: /\b(do|does) (they|you|it) (accept|take)\b/, intent: "payment", weight: 4 },

  {
    re: /\bhow booked\b|\boccupancy\b|\butili[sz]ation\b|\bhow full\b/,
    intent: "my_occupancy",
    weight: 6,
  },

  /* A player asking about their own bookings. First person is required: "my next
     booking" is personal, "how many bookings today" is a manager's question. */
  {
    re: /\bmy (next |upcoming |last )?(booking|bookings|game|games|reservation|reservations)\b|\bwhen (do|am) i (play|playing)\b|\bdo i have a (booking|game)\b|\bwhat am i playing\b|\bdid i (already )?cancel\b|\bwhich booking is next\b|\bwhat.{0,3}s starting soon\b/,
    intent: "my_bookings",
    weight: 6,
  },
  {
    re: /\bhow much (have|did) i (spent|spend|pay|paid)\b|\bmy spending\b|\bhow much did i pay\b/,
    intent: "my_spend",
    weight: 6,
  },

  /* A manager's operational questions. */
  {
    re: /\bhow many bookings\b|\bany cancellation|\bcancellations\b|\bany refund|\bfailed refund|\bwhat payments\b|\brevenue\b|\bsales (today|this week)\b|\bunpaid\b|\bpending bookings?\b|\bhow many booked hours\b/,
    intent: "tenant_activity",
    weight: 6,
  },

  /* Filipino and Cebuano forms of the same handful of questions. These are the
     phrasings CourtHub actually receives; they are mapped, never translated. */
  { re: /\b(magkano|pila|tagpila|pilay|magkanong)\b/, intent: "pricing", weight: 5 },
  { re: /\b(pinakamura|pinakabarato)\b/, intent: "cheapest", weight: 6 },
  {
    re: /\b(malapit sa akin|malapit sakin|duol nako|duol nakoa|asa pinakaduol|saan pinakamalapit|pinakamalapit|pinakaduol)\b/,
    intent: "nearby",
    weight: 6,
  },
  {
    re: /\b(bakante|available ba|naa pa|naa pay|naa bay|may bakante|open pa|bukas pa)\b/,
    intent: "availability",
    weight: 5,
  },
  {
    re: /\b(may parking|naa parking|naa bay parking|may shower|naa shower)\b/,
    intent: "amenities",
    weight: 6,
  },
  {
    re: /\b(pwede gcash|mudawat|tumatanggap|pwede maya|pwede card)\b/,
    intent: "payment",
    weight: 6,
  },
];

/** Canonical keywords produced by the normaliser, and what they suggest. */
const SIGNALS: { intent: IntentKind; words: string[]; weight: number }[] = [
  { intent: "refund", words: ["refund"], weight: 3 },
  { intent: "payment", words: ["payment"], weight: 3 },
  { intent: "amenities", words: ["amenities"], weight: 3 },
  { intent: "hours", words: ["hours"], weight: 2.5 },
  { intent: "cheapest", words: ["cheapest"], weight: 3 },
  { intent: "pricing", words: ["price"], weight: 2.5 },
  { intent: "nearby", words: ["near", "far"], weight: 3 },
  { intent: "availability", words: ["available", "book", "booked"], weight: 2.5 },
  {
    intent: "venue_info",
    words: [
      "location",
      "contact",
      "phone",
      "email",
      "details",
      "indoor",
      "outdoor",
      "surface",
      "rules",
    ],
    weight: 2,
  },
];

function matchVenue(text: string, catalog: Catalog): CatalogVenue | null {
  let best: CatalogVenue | null = null;
  let bestScore = 0;
  for (const v of catalog.venues) {
    const s = nameScore(text, v.name);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return bestScore >= 0.45 ? best : null;
}

/** "court 2", "court b", or a court whose own name is distinctive enough to match. */
function matchCourt(
  text: string,
  catalog: Catalog,
  venue: CatalogVenue | null,
): CatalogCourt | null {
  const pool = venue ? venue.courts : catalog.venues.flatMap((v) => v.courts);
  const f = fold(text);

  const numbered = f.match(/\bcourt\s*([0-9]+|[a-z])\b/);
  if (numbered) {
    const want = `court ${numbered[1]}`;
    const hit = pool.find((c) => fold(c.name) === want || fold(c.name).endsWith(` ${numbered[1]}`));
    if (hit) return hit;
  }

  let best: CatalogCourt | null = null;
  let bestScore = 0;
  for (const c of pool) {
    /* "Court 1" carries no information on its own — only distinctive names are
       matched loosely, or every question would land on some venue's Court 1. */
    if (/^court\s*[0-9a-z]?$/i.test(c.name.trim())) continue;
    const s = nameScore(text, c.name);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

function matchSport(text: string, catalog: Catalog): string | null {
  const f = ` ${fold(text)} `;
  for (const [alias, canonical] of Object.entries(SPORT_ALIASES)) {
    if (f.includes(` ${alias} `)) {
      const hit = catalog.sports.find((s) => fold(s.name) === canonical || s.slug === canonical);
      if (hit) return hit.slug;
    }
  }
  for (const s of catalog.sports) {
    if (f.includes(` ${fold(s.name)} `) || f.includes(` ${fold(s.slug)} `)) return s.slug;
  }

  /* Typo tolerance, sports only. A sport name is a small closed vocabulary, so a
     near miss is almost certainly the word. Venue names get no such leniency —
     there the same slack could send someone to a different business. */
  for (const token of f.split(" ")) {
    const budget = typoBudget(token);
    if (budget === 0) continue;
    for (const sp of catalog.sports) {
      const name = fold(sp.name);
      if (editDistance(token, name, budget) <= budget) return sp.slug;
    }
    for (const [alias, canonical] of Object.entries(SPORT_ALIASES)) {
      if (typoBudget(alias) === 0) continue;
      if (editDistance(token, alias, budget) <= budget) {
        const hit = catalog.sports.find(
          (sp) => fold(sp.name) === canonical || sp.slug === canonical,
        );
        if (hit) return hit.slug;
      }
    }
  }
  return null;
}

const ME = /^(me|my location|my place|here|us|akin|amin)$/;

/** Whatever the player typed after "near" — a city, a mall, a street. */
function matchPlace(text: string): { place: string | null; wantsMyLocation: boolean } {
  const f = fold(text);
  const m = f.match(
    /\b(?:near(?:est)?|closest to|close to|around|beside|next to|malapit sa|far (?:is|from|to)|distance to)\s+(.+)$/,
  );
  if (!m) return { place: null, wantsMyLocation: /\bnear me\b|\baround me\b/.test(f) };

  /* Trailing time and intent words are not part of a place name. */
  const cleaned = m[1]
    .replace(/\b(today|tonight|tomorrow|now|later|this|next)\b.*$/, "")
    .replace(
      /\b(court|courts|venue|venues|available|open|price|cheapest|badminton|basketball|tennis|volleyball|pickleball|futsal|padel)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || ME.test(cleaned)) return { place: null, wantsMyLocation: true };
  return { place: cleaned, wantsMyLocation: false };
}

/** Amenity words worth searching for, mapped to what venues actually store. */
const AMENITY_TERMS: Record<string, string> = {
  parking: "parking",
  shower: "shower",
  showers: "shower",
  wifi: "wifi",
  aircon: "air",
  airconditioned: "air",
  locker: "locker",
  lockers: "locker",
  canteen: "canteen",
  food: "food",
  drinks: "drink",
  restroom: "restroom",
  toilet: "restroom",
  shop: "shop",
};

/** Only a ceiling the user stated in money terms — never a bare number, or "court 2"
 *  would read as a two-peso cap. */
function matchPrice(f: string): { minPrice: number | null; maxPrice: number | null } {
  const between = f.match(
    /\bbetween\s*(?:php|p|₱)?\s*(\d{2,6})\s*(?:and|to|-)\s*(?:php|p|₱)?\s*(\d{2,6})/,
  );
  if (between) {
    const a = Number(between[1]);
    const b = Number(between[2]);
    return { minPrice: Math.min(a, b), maxPrice: Math.max(a, b) };
  }
  const under = f.match(
    /\b(?:under|below|less than|at most|max|maximum|not more than|cheaper than)\s*(?:php|p|₱)?\s*(\d{2,6})/,
  );
  if (under) return { minPrice: null, maxPrice: Number(under[1]) };
  const orLess = f.match(/(?:php|p|₱)\s*(\d{2,6})\s*(?:or less|and below|or below|pababa)/);
  if (orLess) return { minPrice: null, maxPrice: Number(orLess[1]) };
  const over = f.match(/\b(?:over|above|at least|more than)\s*(?:php|p|₱)?\s*(\d{2,6})/);
  if (over) return { minPrice: Number(over[1]), maxPrice: null };
  return { minPrice: null, maxPrice: null };
}

function matchDistance(f: string): number | null {
  const m = f.match(
    /\b(?:within|inside|under|less than|max)\s*(\d{1,3}(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?)\b/,
  );
  if (m) return Number(m[1]);
  const n = f.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?)\b/);
  return n ? Number(n[1]) : null;
}

function matchAmenities(f: string): string[] | null {
  const found = new Set<string>();
  for (const [word, term] of Object.entries(AMENITY_TERMS)) {
    if (new RegExp(`\\b${word}\\b`).test(f)) found.add(term);
  }
  return found.size > 0 ? [...found] : null;
}

function matchPayment(f: string): "online" | "venue" | null {
  if (/\b(gcash|maya|paymaya|grabpay|card|paymongo|online payment|pay online)\b/.test(f)) {
    return "online";
  }
  if (/\b(pay at the venue|pay on site|pay onsite|walk in|cash only|bayad sa venue)\b/.test(f)) {
    return "venue";
  }
  return null;
}

/** "a 2-hour slot", "for 3 hours". */
function matchDuration(f: string, hours: number[]): number {
  if (hours.length > 0) return hours.length;
  const m = f.match(/\b(\d{1,2})\s*-?\s*(?:hours?|hrs?|oras)\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) return n;
  }
  return 1;
}

export function parseQuestion(
  text: string,
  catalog: Catalog,
  todayISO: string,
  role: AssistantRole,
): Parsed {
  const f = fold(text);
  const kws = new Set(keywords(text));
  const scores = new Map<IntentKind, number>();
  const add = (i: IntentKind, w: number) => scores.set(i, (scores.get(i) ?? 0) + w);

  for (const p of PHRASES) if (p.re.test(f)) add(p.intent, p.weight);
  for (const s of SIGNALS) {
    for (const w of s.words) if (kws.has(w)) add(s.intent, s.weight);
  }

  const venue = matchVenue(text, catalog);
  const court = matchCourt(text, catalog, venue);
  const sportSlug = matchSport(text, catalog);
  const when = parseWhen(text, todayISO);
  const { place, wantsMyLocation } = matchPlace(text);

  /* Naming a venue is itself a weak signal that the question is about that venue. */
  if ((venue || court) && scores.size === 0) add("venue_info", 2);

  let intent: IntentKind = "unknown";
  let score = 0;
  for (const [k, v] of scores) {
    if (v > score) {
      score = v;
      intent = k;
    }
  }
  if (score < MIN_SCORE) intent = "unknown";

  /* A named court plus a named hour is not a browse — it is one yes-or-no question,
     and it deserves the answer that distinguishes "past" from "taken" from "closed". */
  if (
    (intent === "availability" || intent === "open_now") &&
    when.precision === "slot" &&
    (court || venue)
  ) {
    intent = "slot_check";
  } else if (
    intent === "availability" &&
    !venue &&
    !court &&
    !sportSlug &&
    when.precision !== "slot"
  ) {
    intent = "open_now";
  }

  /* The tenant catalog is already restricted to their venues, so an unqualified
     availability question is about their own schedule. */
  if (
    role === "tenant" &&
    (intent === "open_now" || intent === "availability") &&
    !venue &&
    !court
  ) {
    intent = "my_schedule";
  }
  if (role === "player" && intent === "my_occupancy") intent = "availability";
  /* A player has no venue operations; the nearest sensible reading of "how many
     bookings today" from them is their own diary. */
  if (role === "player" && intent === "tenant_activity") intent = "my_bookings";
  /* And a manager asking about payments or cancellations means their venues, not a
     personal booking history. */
  if (role === "tenant" && intent === "my_bookings" && !/\bmy\b/.test(f))
    intent = "tenant_activity";

  const { minPrice, maxPrice } = matchPrice(f);
  const filters = {
    minPrice,
    maxPrice,
    maxKm: matchDistance(f),
    amenities: matchAmenities(f),
    payment: matchPayment(f),
    minDuration: matchDuration(f, when.hours),
  };

  /* A location question that named no place and no venue still needs a position. */
  if (intent === "nearby" && !place && !venue) {
    return {
      intent,
      score,
      text,
      venue,
      court,
      sportSlug,
      when,
      place: null,
      wantsMyLocation: true,
      ...filters,
    };
  }

  return {
    intent,
    score,
    text,
    venue,
    court,
    sportSlug,
    when,
    place,
    wantsMyLocation,
    ...filters,
  };
}
