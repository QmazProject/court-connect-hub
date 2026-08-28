/**
 * Session-local conversation state.
 *
 * What makes "which is cheapest?" answerable is not memory of the words — it is
 * that the previous turn left behind a *structured* target: a sport, a date, a set
 * of filters, an origin, and the rows that came back. A follow-up edits that
 * structure and re-runs the same deterministic query. There is nothing here a model
 * could hallucinate, because there is no free text in it.
 *
 * It lives in memory for one widget instance. `identity` is the guard: it is the
 * signed-in user and role, and any change to it throws the whole thing away, so one
 * account's bookings can never be the context another account's question resolves
 * against.
 */

import type { DiscoverOrder } from "./search";
import type { IntentKind, Origin, ResultRef } from "./types";

export type { ResultRef };

export type Conversation = {
  /** `${userId}:${role}`. Context is discarded the moment this changes. */
  identity: string | null;
  lastIntent: IntentKind | null;
  lastQuestion: string | null;
  sportSlug: string | null;
  dateISO: string | null;
  hours: number[] | null;
  minDuration: number | null;
  origin: Origin | null;
  minPrice: number | null;
  maxPrice: number | null;
  maxKm: number | null;
  amenities: string[] | null;
  payment: "online" | "venue" | null;
  order: DiscoverOrder | null;
  results: ResultRef[];
  selectedVenueId: number | null;
  selectedCourtId: number | null;
  offset: number;
  /** Set once the browser has refused, so the widget stops asking. */
  locationDenied: boolean;
};

export function newConversation(): Conversation {
  return {
    identity: null,
    lastIntent: null,
    lastQuestion: null,
    sportSlug: null,
    dateISO: null,
    hours: null,
    minDuration: null,
    origin: null,
    minPrice: null,
    maxPrice: null,
    maxKm: null,
    amenities: null,
    payment: null,
    order: null,
    results: [],
    selectedVenueId: null,
    selectedCourtId: null,
    offset: 0,
    locationDenied: false,
  };
}

export function identityOf(userId: string | undefined, role: string): string {
  return `${userId ?? "anon"}:${role}`;
}

/**
 * The privacy boundary. A different signed-in user, or the same user in a different
 * role, gets a blank conversation — never the previous one's venues, bookings or
 * selected court.
 */
export function forIdentity(conv: Conversation, identity: string): Conversation {
  if (conv.identity === identity) return conv;
  const fresh = newConversation();
  fresh.identity = identity;
  /* A denied location permission is a browser fact, not a user's private data, and
     re-prompting after a refusal is the thing §18 asks us not to do. */
  fresh.locationDenied = conv.locationDenied;
  return fresh;
}

/* ---------------------------------------------------------------- *
 * Recognising a follow-up
 * ---------------------------------------------------------------- */

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  one: 0,
  second: 1,
  "2nd": 1,
  two: 1,
  third: 2,
  "3rd": 2,
  three: 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  fifth: 4,
  "5th": 4,
  five: 4,
};

/** A phrase that only means something against the previous answer. */
const REFERENCE_RE =
  /\b(the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s+(one|court|venue|result|place)?\b|\b(that|this)\s+(one|court|venue|place)\b|\bcheapest\s+one\b|\bclosest\s+one\b|\bnearest\s+one\b/;

/** A question that carries no target of its own and leans on what came before. */
const CONTINUATION_RE =
  /^\s*(and|also|then)?\s*(how|what)\s+about\b|^\s*(and|also)\b|\b(instead|as well)\b|^\s*(only|just)\b|^\s*(does|do|is|are|can|will)\s+(it|they|that|this)\b|\bwhich\s+(is|one|are)\b|^\s*(show more|more)\b/;

export function looksLikeFollowUp(text: string): boolean {
  const t = text.toLowerCase().trim();
  return REFERENCE_RE.test(t) || CONTINUATION_RE.test(t);
}

export type ReferenceResult =
  { kind: "resolved"; ref: ResultRef } | { kind: "ambiguous"; reason: string } | { kind: "none" };

/**
 * Turn "the second one" into an actual court.
 *
 * Only ever resolves against rows the player was shown. With no previous list, or
 * an index past its end, it reports ambiguity so the caller can ask — guessing here
 * would put someone at the wrong venue.
 */
export function resolveReference(text: string, conv: Conversation): ReferenceResult {
  const t = text.toLowerCase();
  if (!REFERENCE_RE.test(t)) return { kind: "none" };

  if (conv.results.length === 0) {
    return {
      kind: "ambiguous",
      reason: 'I have not shown you a list yet, so there is no "first one" to point at.',
    };
  }

  if (/\bcheapest\s+one\b/.test(t)) {
    return {
      kind: "resolved",
      ref: [...conv.results].sort((a, b) => a.periodRate - b.periodRate)[0],
    };
  }
  if (/\b(closest|nearest)\s+one\b/.test(t)) {
    const withDistance = conv.results.filter((r) => r.distanceKm != null);
    if (withDistance.length === 0) {
      return {
        kind: "ambiguous",
        reason:
          "I do not have distances for those results — tell me where you are and I can rank them.",
      };
    }
    return {
      kind: "resolved",
      ref: [...withDistance].sort((a, b) => a.distanceKm! - b.distanceKm!)[0],
    };
  }
  if (/\blast\b/.test(t)) return { kind: "resolved", ref: conv.results[conv.results.length - 1] };

  /* "that court" with exactly one thing on screen is unambiguous; with several it
     is not, and the caller asks instead. */
  if (/\b(that|this)\s+(one|court|venue|place)\b/.test(t)) {
    if (conv.selectedCourtId) {
      const hit = conv.results.find((r) => r.courtId === conv.selectedCourtId);
      if (hit) return { kind: "resolved", ref: hit };
    }
    if (conv.results.length === 1) return { kind: "resolved", ref: conv.results[0] };
    return { kind: "ambiguous", reason: "Which of those do you mean?" };
  }

  const word = t.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/)?.[1];
  if (word && word in ORDINALS) {
    const i = ORDINALS[word];
    if (i < conv.results.length) return { kind: "resolved", ref: conv.results[i] };
    return {
      kind: "ambiguous",
      reason: `I only showed you ${conv.results.length} result${conv.results.length === 1 ? "" : "s"}.`,
    };
  }
  return { kind: "none" };
}

/** Did the player restate the ranking they want? */
export function orderOverride(text: string): DiscoverOrder | null {
  const t = text.toLowerCase();
  if (/\bcheapest\b|\bcheaper\b|\blowest price\b|\bpinakamura\b|\bmurang\b/.test(t)) return "price";
  if (/\bclosest\b|\bnearest\b|\bpinakamalapit\b|\bpinakaduol\b/.test(t)) return "distance";
  if (/\bearliest\b|\bsoonest\b/.test(t)) return "time";
  return null;
}

/* ---------------------------------------------------------------- *
 * Applying context to a freshly parsed question
 * ---------------------------------------------------------------- */

import type { Catalog } from "./catalog";
import type { Parsed } from "./intents";
import type { Answer } from "./types";

export type ContextOutcome = {
  parsed: Parsed;
  /** Set when a reference was used that cannot be resolved — ask, do not guess. */
  ambiguous: string | null;
};

/**
 * Fill the gaps in a follow-up from what the last turn established.
 *
 * Only gaps. Anything the player restated wins, so "actually near Ayala" replaces
 * the origin rather than being merged with it, and naming a venue clears a stale
 * selection. A question that stands on its own is returned untouched.
 */
export function applyContext(
  parsed: Parsed,
  conv: Conversation,
  catalog: Catalog,
  originFromSession: Origin | null,
): ContextOutcome {
  const text = parsed.text;
  const follow = looksLikeFollowUp(text);
  const next: Parsed = { ...parsed };
  let ambiguous: string | null = null;

  const ref = resolveReference(text, conv);
  if (ref.kind === "ambiguous") ambiguous = ref.reason;
  if (ref.kind === "resolved" && !next.venue && !next.court) {
    const hit = catalog.byCourt.get(ref.ref.courtId);
    if (hit) {
      next.court = hit.court;
      next.venue = hit.venue;
    } else {
      next.venue = catalog.byVenue.get(ref.ref.venueId) ?? null;
    }
  }

  /* "does it have parking?" names nothing at all, so the thing most recently talked
     about is the only sensible referent. */
  if (follow && !next.venue && !next.court && ref.kind === "none") {
    if (conv.selectedCourtId) {
      const hit = catalog.byCourt.get(conv.selectedCourtId);
      if (hit) {
        next.court = hit.court;
        next.venue = hit.venue;
      }
    } else if (conv.selectedVenueId) {
      next.venue = catalog.byVenue.get(conv.selectedVenueId) ?? null;
    }
  }

  if (follow) {
    if (!next.sportSlug && conv.sportSlug) next.sportSlug = conv.sportSlug;
    if (next.maxPrice == null && conv.maxPrice != null) next.maxPrice = conv.maxPrice;
    if (next.minPrice == null && conv.minPrice != null) next.minPrice = conv.minPrice;
    if (next.maxKm == null && conv.maxKm != null) next.maxKm = conv.maxKm;
    if (!next.amenities && conv.amenities) next.amenities = conv.amenities;
    if (!next.payment && conv.payment) next.payment = conv.payment;

    /* No day named: keep the day under discussion rather than silently jumping to
       today. No time named either: keep the window too. */
    if (next.when.assumedToday && conv.dateISO) {
      next.when = { ...next.when, dateISO: conv.dateISO, assumedToday: false };
      if (next.when.precision === "day" && conv.hours && conv.hours.length > 0) {
        next.when = { ...next.when, hours: conv.hours, precision: "slot" };
        next.minDuration = conv.hours.length;
      }
    }
  }

  /* An origin outlives a single question: "near SM Seaside" then "which is
     cheapest?" must not silently become a nationwide search. The live session
     origin wins when the player has just granted or changed it. */
  void originFromSession;

  return { parsed: next, ambiguous };
}

/** Record what this turn established, for the next one to lean on. */
export function remember(
  conv: Conversation,
  parsed: Parsed,
  answer: Answer,
  rows: ResultRef[],
  origin: Origin | null,
): void {
  conv.lastIntent = answer.intent;
  conv.lastQuestion = parsed.text;
  conv.sportSlug = parsed.sportSlug ?? conv.sportSlug;
  conv.dateISO = parsed.when.dateISO;
  conv.hours = parsed.when.hours.length > 0 ? parsed.when.hours : null;
  conv.minDuration = parsed.minDuration;
  conv.minPrice = parsed.minPrice;
  conv.maxPrice = parsed.maxPrice;
  conv.maxKm = parsed.maxKm;
  conv.amenities = parsed.amenities;
  conv.payment = parsed.payment;
  if (origin) conv.origin = origin;

  if (rows.length > 0) {
    conv.results = rows;
    conv.offset = answer.page?.shown ?? rows.length;
    /* The leading row becomes "it" until the player says otherwise. */
    conv.selectedCourtId = rows[0].courtId;
    conv.selectedVenueId = rows[0].venueId;
  }
  /* A question about one venue selects it, list or no list. */
  if (parsed.venue) conv.selectedVenueId = parsed.venue.id;
  if (parsed.court) conv.selectedCourtId = parsed.court.id;
}
