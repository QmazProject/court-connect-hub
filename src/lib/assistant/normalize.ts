/**
 * Turning a typed question into something matchable.
 *
 * The vocabulary here is the whole reason this works without a model: players ask
 * for the same dozen things in a few dozen phrasings, and those phrasings are
 * enumerable. Anything not enumerated falls through to `unknown`, which asks rather
 * than guesses — a wrong guess about a booking is worse than an admission.
 */

import { fold } from "@/lib/ph-places";

export { fold };

/** Words that carry no intent and only dilute token overlap when matching names. */
const STOP = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "am",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "will",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "it",
  "its",
  "there",
  "here",
  "what",
  "whats",
  "which",
  "who",
  "how",
  "when",
  "where",
  "any",
  "some",
  "of",
  "for",
  "to",
  "at",
  "in",
  "on",
  "by",
  "with",
  "and",
  "or",
  "please",
  "pls",
  "show",
  "tell",
  "give",
  "want",
  "need",
  "looking",
  "look",
  "find",
  "get",
  "know",
  "about",
  "much",
  "many",
  "have",
  "has",
  "be",
  "been",
  "that",
  "this",
  "these",
  "those",
  "if",
  "so",
]);

/**
 * Shorthand players actually type, mapped to the words the classifier scores on.
 * Filipino terms are included because this is a Philippine product and "magkano"
 * is a more natural way to ask a price here than "how much".
 */
const SYNONYMS: Record<string, string> = {
  // price
  // Tagalog/Cebuano ask this far more naturally than "how much".
  pila: "price",
  tagpila: "price",
  pilay: "price",
  magkanong: "price",
  magkano: "price",
  presyo: "price",
  bayad: "price",
  rate: "price",
  rates: "price",
  cost: "price",
  costs: "price",
  pricing: "price",
  fee: "price",
  charge: "price",
  mura: "cheapest",
  murang: "cheapest",
  cheap: "cheapest",
  cheaper: "cheapest",
  lowest: "cheapest",
  budget: "cheapest",
  affordable: "cheapest",
  // availability
  naa: "available",
  pwede: "available",
  bakanteng: "available",
  free: "available",
  vacant: "available",
  open: "available",
  slot: "available",
  slots: "available",
  availability: "available",
  bakante: "available",
  libre: "available",
  reserve: "book",
  booking: "book",
  bookings: "book",
  taken: "booked",
  occupied: "booked",
  full: "booked",
  puno: "booked",
  // location
  duol: "near",
  pinakaduol: "near",
  pinakamalapit: "near",
  asa: "location",
  malapit: "near",
  nearby: "near",
  nearest: "near",
  closest: "near",
  close: "near",
  around: "near",
  distance: "far",
  km: "far",
  kilometer: "far",
  kilometre: "far",
  location: "location",
  address: "location",
  directions: "location",
  saan: "location",
  where: "location",
  // payment
  mudawat: "payment",
  tumatanggap: "payment",
  magbayad: "payment",
  gcash: "payment",
  paymaya: "payment",
  maya: "payment",
  card: "payment",
  cash: "payment",
  pay: "payment",
  paying: "payment",
  paymongo: "payment",
  online: "payment",
  downpayment: "payment",
  deposit: "payment",
  // refund
  refunds: "refund",
  cancel: "refund",
  cancelled: "refund",
  cancellation: "refund",
  cancelling: "refund",
  canceling: "refund",
  "money-back": "refund",
  // facilities
  amenity: "amenities",
  facility: "amenities",
  facilities: "amenities",
  parking: "amenities",
  shower: "amenities",
  showers: "amenities",
  aircon: "amenities",
  airconditioned: "amenities",
  locker: "amenities",
  lockers: "amenities",
  wifi: "amenities",
  canteen: "amenities",
  food: "amenities",
  drinks: "amenities",
  restroom: "amenities",
  cr: "amenities",
  // hours
  hours: "hours",
  schedule: "hours",
  opening: "hours",
  closes: "hours",
  closing: "hours",
  "24/7": "hours",
  // time words the date parser also reads, kept so the classifier still sees them
  tmr: "tomorrow",
  tom: "tomorrow",
  bukas: "tomorrow",
  ngayon: "today",
  mamaya: "tonight",
  // courts
  court: "court",
  courts: "court",
  venue: "venue",
  venues: "venue",
  gym: "venue",
  place: "venue",
  places: "venue",
  facilityname: "venue",
};

/** Sport words a player might type that are not the row's exact name. */
export const SPORT_ALIASES: Record<string, string> = {
  bball: "basketball",
  hoops: "basketball",
  basket: "basketball",
  bad: "badminton",
  badmin: "badminton",
  shuttle: "badminton",
  volley: "volleyball",
  vball: "volleyball",
  pickle: "pickleball",
  padel: "padel",
  tennis: "tennis",
  futsal: "futsal",
  football: "football",
  soccer: "football",
  "table tennis": "table tennis",
  pingpong: "table tennis",
  "ping pong": "table tennis",
};

export function tokens(text: string): string[] {
  return fold(text)
    .replace(/[^a-z0-9:/ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Folded tokens with stop-words dropped and shorthand expanded. */
export function keywords(text: string): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    const mapped = SYNONYMS[t] ?? t;
    if (STOP.has(mapped)) continue;
    out.push(mapped);
  }
  return out;
}

/**
 * Edit distance, capped: it stops as soon as the answer cannot be within `max`.
 *
 * Bounded on purpose. Two edits covers the typos people actually make
 * ("badmnton", "picklebal") and is short enough that it cannot quietly turn one
 * real word into a different real one.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** How many edits a word of this length may absorb before a match becomes a guess. */
export function typoBudget(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * How well a query matches a candidate name, 0–1.
 *
 * Whole-phrase containment scores highest so "smash arena" beats a venue that
 * merely shares the word "arena"; below that it is token overlap weighted by how
 * much of the *candidate* was matched, which stops a one-word hit on a long name
 * from outranking an exact short one.
 */
export function nameScore(query: string, candidate: string): number {
  const q = fold(query);
  const c = fold(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) && q.length >= 3) return 0.9 - Math.min(0.2, (c.length - q.length) / 100);
  if (q.includes(c) && c.length >= 3) return 0.85;

  const qt = new Set(tokens(q).filter((t) => !STOP.has(t)));
  const ct = tokens(c).filter((t) => !STOP.has(t));
  if (qt.size === 0 || ct.length === 0) return 0;

  let hit = 0;
  for (const t of ct) {
    if (qt.has(t)) hit += 1;
    /* Prefix credit so "badmin" reaches "badminton" and "arena" reaches "arenas". */
    else if (
      t.length >= 4 &&
      [...qt].some((x) => x.length >= 4 && (x.startsWith(t) || t.startsWith(x)))
    )
      hit += 0.6;
  }
  if (hit === 0) return 0;
  let score = (hit / ct.length) * 0.6 + (hit / qt.size) * 0.2;

  /* People shorten a venue to its first distinctive word — "northgate" for
     "Northgate Sports Hub" — and plain overlap punishes that, because the two words
     it did not say count against it. Matching the leading token is the signal that
     separates it from a passing hit on a generic word like "sports". */
  if (ct[0].length >= 4 && qt.has(ct[0])) score += 0.35;

  /* Capped below the containment tiers above, so an exact name still wins. */
  return Math.min(0.85, score);
}
