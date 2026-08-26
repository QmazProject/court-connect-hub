/**
 * Master search — the ranking engine behind the field beside the notification bell.
 *
 * Both roles get the same box, but the box knows nothing about either of them: a role
 * hands it a flat list of `SearchEntry`, and this module decides what a typed query
 * means. Keeping the scoring here rather than in the component is what lets the tenant
 * registry (sections, tabs, drawers, live venues and courts) and the player registry
 * (routes, in-page anchors, their own bookings and favorites) stay independent lists
 * that neither needs to know the other exists.
 *
 * The scoring is deliberately plain — position of the match, weighted by which field
 * it landed in — because a search over a few hundred labelled commands does not need
 * anything cleverer, and a rule you can predict is a rule a user learns.
 */

import { useEffect, useState } from "react";
import type React from "react";

/** What kind of thing a result is. Only used for the icon tint and the group heading. */
export type SearchEntryKind =
  "section" | "tab" | "action" | "setting" | "venue" | "court" | "booking" | "favorite";

export type SearchEntry = {
  /** Stable and unique across the whole registry — cmdk keys items by it, and
   *  recents are stored by it. */
  id: string;
  label: string;
  /** Heading this result sits under. Groups render in first-appearance order. */
  group: string;
  /** Second line: where this lands you, or what the thing is. */
  hint?: string;
  /** Matched but never shown — synonyms for what the panel calls something.
   *  "payout" should find Transactions even though no label says payout. */
  keywords?: string[];
  kind?: SearchEntryKind;
  icon?: React.ComponentType<{ className?: string }>;
  /** Higher sorts first when the query is empty, and breaks ties when it isn't.
   *  Navigation outranks live data: a court called "Dashboard" should not bury
   *  the Dashboard section. */
  priority?: number;
  run: () => void;
};

const clean = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Does every character of `term` appear in `hay`, in order? Lets "vnc" reach
 *  "Venues & Courts" without the term being a substring of anything. */
function isSubsequence(term: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < term.length; j++) {
    if (hay[j] === term[i]) i++;
  }
  return i === term.length;
}

/** How well one typed word matches one field. Position carries the weight: a field
 *  that starts with the term is a far better answer than one that merely contains it
 *  somewhere in the middle. */
function termScore(term: string, hay: string): number {
  if (!hay) return 0;
  const i = hay.indexOf(term);
  if (i === 0) return hay.length === term.length ? 120 : 90;
  if (i > 0) return hay[i - 1] === " " ? 70 : 40;
  return isSubsequence(term, hay) ? 15 : 0;
}

type Prepared = {
  entry: SearchEntry;
  label: string;
  keywords: string;
  hint: string;
  group: string;
};

function prepare(entry: SearchEntry): Prepared {
  return {
    entry,
    label: clean(entry.label),
    keywords: clean((entry.keywords ?? []).join(" ")),
    hint: clean(entry.hint ?? ""),
    group: clean(entry.group),
  };
}

/** Fields are weighted so a hit on the visible label always beats the same hit on a
 *  hidden synonym, which in turn beats one on the subtitle. */
function entryScore(terms: string[], p: Prepared): number {
  let total = 0;
  for (const term of terms) {
    const best = Math.max(
      termScore(term, p.label),
      termScore(term, p.keywords) * 0.75,
      termScore(term, p.hint) * 0.5,
      termScore(term, p.group) * 0.4,
    );
    /* Every word has to land somewhere. "court group" must not match an entry that
       only knows the word "court", or two-word queries would never narrow anything. */
    if (best <= 0) return 0;
    total += best;
  }
  /* Among equally-matched entries the shortest label is the most likely answer —
     "Courts" over "Court Groups" for the query "court". */
  return total + Math.max(0, 20 - p.label.length / 2);
}

export function rankEntries(query: string, entries: SearchEntry[], limit = 14): SearchEntry[] {
  const q = clean(query);
  if (!q) {
    return entries
      .slice()
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, limit);
  }
  const terms = q.split(" ").filter(Boolean);
  const scored: { entry: SearchEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = entryScore(terms, prepare(entry));
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.entry.priority ?? 0) - (a.entry.priority ?? 0));
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Bucket ranked results under their headings, keeping the order the ranking put
 *  them in — the group of the best result comes first. */
export function groupEntries(entries: SearchEntry[]): { group: string; items: SearchEntry[] }[] {
  const out: { group: string; items: SearchEntry[] }[] = [];
  const byGroup = new Map<string, SearchEntry[]>();
  for (const e of entries) {
    let bucket = byGroup.get(e.group);
    if (!bucket) {
      bucket = [];
      byGroup.set(e.group, bucket);
      out.push({ group: e.group, items: bucket });
    }
    bucket.push(e);
  }
  return out;
}

/** Holds a value back until it stops changing. Only the queries that hit the network
 *  wait on this; matching the static registry stays instant on every keystroke. */
export function useDebounced<T>(value: T, ms = 220): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

/** Scroll to a section after a result navigates to the view that contains it. The
 *  target usually does not exist yet — the route still has to render, and on the
 *  player side its bookings query has to settle — so this keeps looking for about
 *  two seconds rather than firing once into an empty document. */
export function scrollToAnchor(id: string, frames = 120) {
  if (typeof window === "undefined") return;
  let left = frames;
  const step = () => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (left-- > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
