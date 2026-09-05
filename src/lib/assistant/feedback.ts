/**
 * Recording what the assistant could not answer.
 *
 * Three rules shape this file.
 *
 *   1. A miss is a signal, never a meaning. Nothing written here changes what the
 *      assistant understands — only an admin reviewing it can do that.
 *   2. The user's answer comes first. Every call is best-effort and swallows its
 *      own errors: analytics must never be the reason a player fails to see the
 *      courts that were free.
 *   3. Identity is not collected. No id, no email, no coordinates — the shape of
 *      the question is what an admin needs, and it is all that is sent.
 *
 * Understanding a question and finding nothing is not a failure of understanding.
 * Those are separate categories, because they lead an admin to do different things.
 */

import { supabase } from "@/integrations/supabase/client";
import { fold } from "./normalize";

export type FeedbackCategory =
  | "unknown_intent"
  | "unsupported_question"
  /** Nothing in CourtHub offers this at all. */
  | "zero_inventory"
  /** It exists, but every slot in the window is taken. */
  | "no_available_slots"
  /** Understood, filtered, nothing left. */
  | "zero_results"
  | "unknown_sport_term"
  | "unknown_amenity_term"
  | "ambiguous_venue"
  | "ambiguous_court"
  | "location_not_found"
  | "missing_venue_data"
  | "missing_policy_data"
  | "missing_payment_data";

export type FeedbackInput = {
  category: FeedbackCategory;
  query: string;
  sportTerm?: string | null;
  amenityTerm?: string | null;
  locationTerm?: string | null;
  resolvedIntent?: string | null;
  resultCount?: number | null;
};

/** Matches the cap the database enforces, so nothing oversized crosses the wire. */
export const MAX_QUERY_LEN = 160;

/**
 * Strip the shapes people paste by accident before anything leaves the browser.
 *
 * The database sanitises again — this is not the only guard — but a secret that is
 * never transmitted is better than one redacted on arrival. It does not claim to
 * detect every secret; it removes the ones that recur.
 */
export function sanitizeQuery(raw: string): string {
  return raw
    .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, "[key]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{8,}\b/gi, "[token]")
    .replace(/\b\d{13,19}\b/g, "[number]")
    .replace(/\b(\+?63|0)9\d{9}\b/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

/**
 * Fire and forget, but not carelessly: the promise is awaited internally so a
 * rejection cannot escape as an unhandled rejection, and the result is discarded so
 * the caller never waits on it.
 */
export function recordFeedback(input: FeedbackInput): void {
  const query = sanitizeQuery(input.query ?? "");
  if (query.length < 2) return;

  void (async () => {
    try {
      await supabase.rpc("record_assistant_feedback", {
        _category: input.category,
        _query: query,
        _sport_term: input.sportTerm ?? null,
        _amenity_term: input.amenityTerm ?? null,
        _location_term: input.locationTerm ?? null,
        _resolved_intent: input.resolvedIntent ?? null,
        _result_count: input.resultCount ?? null,
      });
    } catch {
      /* The migration may not be applied, the network may be down, the user may be
         offline. None of that is worth a word to the player. */
    }
  })();
}

/* ---------------------------------------------------------------- *
 * Spotting the term that was not understood
 * ---------------------------------------------------------------- */

/** Words that follow "with"/"has" but are never an amenity request. */
const NOT_AN_AMENITY = new Set([
  "a",
  "an",
  "the",
  "me",
  "my",
  "you",
  "it",
  "us",
  "them",
  "court",
  "courts",
  "venue",
  "venues",
  "slot",
  "slots",
  "time",
  "times",
  "price",
  "prices",
]);

/**
 * "badminton with a sauna" -> "sauna", when nothing in the catalogue matched.
 *
 * Only ever returns a word the question actually contained. Guessing a different
 * word here would put a term in front of an admin that no one ever typed.
 */
export function unknownAmenityTerm(text: string, matched: string[] | null): string | null {
  if (matched && matched.length > 0) return null;
  const f = fold(text);
  const m = f.match(/\b(?:with|has|have|offering|that has)\s+(?:a|an|the)?\s*([a-z][a-z ]{2,30})/);
  if (!m) return null;
  const candidate = m[1]
    .split(" ")
    .filter((w) => w.length > 2 && !NOT_AN_AMENITY.has(w))
    .slice(0, 2)
    .join(" ")
    .trim();
  return candidate.length >= 3 ? candidate : null;
}

/** "where can I play takraw" -> "takraw", when no sport matched. */
export function unknownSportTerm(text: string, matchedSlug: string | null): string | null {
  if (matchedSlug) return null;
  const f = fold(text);
  const m =
    f.match(/\b(?:play|playing)\s+([a-z][a-z ]{2,24})/) ??
    f.match(
      /\b(?:any|find|book)\s+([a-z]{4,20})\s+(?:court|courts|venue|venues|tonight|tomorrow|today)\b/,
    ) ??
    f.match(/\b([a-z]{4,20})\s+(?:court|courts)\b/);
  if (!m) return null;
  const candidate = m[1].split(" ")[0].trim();
  if (NOT_AN_AMENITY.has(candidate)) return null;
  return candidate.length >= 4 ? candidate : null;
}
