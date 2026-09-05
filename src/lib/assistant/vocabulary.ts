/**
 * What words the assistant knows, and where they come from.
 *
 * Three sources, in this order of authority:
 *
 *   1. CourtHub's own data — the sport names and amenity strings that actually
 *      exist. Adding a "Sepak Takraw" court makes "sepak takraw" askable with no
 *      deployment, and the words inside a multi-word name become askable too.
 *   2. Trusted admin mappings — rows an admin wrote after reviewing a real miss.
 *      "car park" means "Parking" because a person decided it does.
 *   3. The small built-in alias list, kept for the shorthand that predates any of
 *      this.
 *
 * What is deliberately absent is a fourth source: anything a user typed. An unknown
 * word is recorded as a signal and answered honestly; it never becomes vocabulary
 * on its own. That is the difference between a system that improves and one that
 * can be poisoned by whoever types the most.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Catalog } from "./catalog";
import { fold } from "./normalize";

export type MappingKind = "sport_alias" | "amenity_alias";
export type Mapping = { kind: MappingKind; normalizedTerm: string; targetValue: string };

/** Words too generic to stand for a sport or an amenity on their own. */
const NON_DISTINCTIVE = new Set([
  "court",
  "courts",
  "sport",
  "sports",
  "club",
  "center",
  "centre",
  "hall",
  "room",
  "area",
  "field",
  "the",
  "and",
  "of",
  "for",
  "with",
  "indoor",
  "outdoor",
  "hub",
]);

/**
 * The words of a name that can stand for it.
 *
 * "Sepak Takraw" yields "sepak takraw", "sepak" and "takraw". "Table Tennis" yields
 * the phrase and "table"/"tennis" — but "table" is not distinctive enough to be
 * safe on its own, so short and generic parts are dropped.
 */
export function nameTokens(name: string): string[] {
  const full = fold(name);
  if (!full) return [];
  const out = new Set<string>([full]);
  for (const word of full.split(" ")) {
    if (word.length < 4) continue;
    if (NON_DISTINCTIVE.has(word)) continue;
    out.add(word);
  }
  return [...out];
}

const TTL_MS = 60_000;
let cache: { at: number; value: Promise<Mapping[]> } | null = null;

/** Admin-reviewed vocabulary. Cached briefly; an admin's own browser clears it. */
export function loadMappings(): Promise<Mapping[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const value = (async (): Promise<Mapping[]> => {
    const { data, error } = await supabase.rpc("get_active_assistant_mappings");
    /* Vocabulary is an enhancement. If it cannot be read the assistant still works
       on CourtHub's own data, so this never throws into an answer. */
    if (error) return [];
    return (data ?? []).map((r) => ({
      kind: r.kind as MappingKind,
      normalizedTerm: r.normalized_term,
      targetValue: r.target_value,
    }));
  })();

  cache = { at: now, value };
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

/** Called after an admin saves a mapping, so their next question uses it. */
export function invalidateAssistantMappings(): void {
  cache = null;
}

export type Vocabulary = {
  /** Folded token -> sport slug. */
  sportTokens: Map<string, string>;
  /** Folded token -> the amenity string as venues actually spell it. */
  amenityTokens: Map<string, string>;
  /** Every amenity value in the catalogue, for listing rather than matching. */
  amenityValues: string[];
};

/**
 * Build the lookup for one question.
 *
 * Later sources do not overwrite earlier ones: a real sport name always wins over
 * an alias, so an admin mapping cannot shadow CourtHub's own data by accident.
 */
export function buildVocabulary(catalog: Catalog, mappings: Mapping[]): Vocabulary {
  const sportTokens = new Map<string, string>();
  const amenityTokens = new Map<string, string>();

  for (const sport of catalog.sports) {
    for (const token of nameTokens(sport.name)) {
      if (!sportTokens.has(token)) sportTokens.set(token, sport.slug);
    }
    const slug = fold(sport.slug);
    if (slug && !sportTokens.has(slug)) sportTokens.set(slug, sport.slug);
  }

  for (const value of catalog.amenityValues) {
    for (const token of nameTokens(value)) {
      if (!amenityTokens.has(token)) amenityTokens.set(token, value);
    }
  }

  for (const m of mappings) {
    const term = fold(m.normalizedTerm);
    if (!term) continue;
    if (m.kind === "sport_alias") {
      const target = catalog.sports.find((s) => fold(s.name) === fold(m.targetValue));
      if (target && !sportTokens.has(term)) sportTokens.set(term, target.slug);
    } else {
      const target = catalog.amenityValues.find((a) => fold(a) === fold(m.targetValue));
      /* The mapping's own target text is used when the catalogue no longer lists it,
         so a renamed amenity degrades to "no match" rather than to a wrong match. */
      if (target && !amenityTokens.has(term)) amenityTokens.set(term, target);
    }
  }

  return { sportTokens, amenityTokens, amenityValues: catalog.amenityValues };
}

/** The closest real sport name to an unrecognised word, for an admin suggestion. */
export function suggestSport(term: string, catalog: Catalog): string | null {
  const t = fold(term);
  if (t.length < 3) return null;
  for (const sport of catalog.sports) {
    if (nameTokens(sport.name).some((tok) => tok.includes(t) || t.includes(tok))) {
      return sport.name;
    }
  }
  return null;
}
