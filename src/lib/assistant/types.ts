/**
 * A local assistant: no model, no API key, no per-message cost.
 *
 * Every answer here is assembled from rows this system already stores. The engine
 * classifies the question, resolves it with the same queries and helpers the screens
 * use, and renders the result through a template. It has no path by which it could
 * state a price, a free slot or an amenity it did not read — when nothing resolves,
 * it says so and offers something it *can* answer instead.
 *
 * `used` is what makes that checkable rather than a claim: every answer carries the
 * venue and court ids it was built from.
 */

export type AssistantRole = "player" | "tenant";

export type IntentKind =
  /** "hi" — greet and show what it can do. */
  | "greeting"
  /** "what can you do" */
  | "help"
  /** "who is open now", "any court free tonight" */
  | "open_now"
  /** "what times are free at X on Saturday" */
  | "availability"
  /** "is Court 2 free tomorrow 7pm" — one named slot, answered yes/past/closed/booked. */
  | "slot_check"
  /** "cheapest court per hour" */
  | "cheapest"
  /** "how much is Court 2" */
  | "pricing"
  /** "what is near me", "courts near Ayala Center Cebu" */
  | "nearby"
  /** "how do I pay", "do they take gcash" */
  | "payment"
  /** "what if I cancel" */
  | "refund"
  /** "is there parking", "what amenities" */
  | "amenities"
  /** "where is X", "contact number", "what is X like" */
  | "venue_info"
  /** "what time do they open" */
  | "hours"
  /** player: "what is my next booking", "do I play tomorrow" */
  | "my_bookings"
  /** player: "how much have I spent this month" */
  | "my_spend"
  /** tenant: "any cancellations today", "what came in today" */
  | "tenant_activity"
  /** tenant: "what is free at my venue tomorrow" */
  | "my_schedule"
  /** tenant: "how booked am I tonight" */
  | "my_occupancy"
  | "unknown";

/** Where a row or chip leads. Resolved to a route by the widget, never a raw href. */
export type Nav = {
  kind: "venue" | "court";
  id: number;
  /** For a court: which venue page hosts its booking panel. */
  venueId?: number;
  /** Open the real booking panel on this day with these hours already picked. The
   *  panel re-checks them before selecting anything — this is a suggestion, and
   *  discovery never holds a slot. */
  date?: string;
  hours?: number[];
};

/** A tappable follow-up under an answer. */
export type Chip = {
  label: string;
  /** Re-ask the engine with this text. */
  ask?: string;
  /** Navigate instead of asking. */
  nav?: Nav;
  /** locate = ask for a position and re-run; more = next page; why = explain the
   *  ranking of the result that led. */
  action?: "locate" | "more" | "why";
};

/** A small button under a result. Each one is a real route, never a re-ask. */
export type RowAction = {
  label: string;
  nav: Nav;
  /** primary = the obvious thing to do with this row; ghost = the secondary route. */
  emphasis?: "primary" | "ghost";
};

export type AnswerRow = {
  title: string;
  /** Which venue a court belongs to. A court name alone ("Court 2") says nothing
   *  about where to turn up, so results that name a court must name its venue. */
  subtitle?: string;
  detail?: string;
  meta?: string;
  /** ok = bookable, warn = needs attention, off = closed/past/taken. */
  tone?: "ok" | "warn" | "off";
  /** Whole-row navigation, for rows with no explicit actions. */
  nav?: Nav;
  actions?: RowAction[];
};

export type AnswerBlock =
  | { kind: "text"; text: string }
  | { kind: "rows"; rows: AnswerRow[] }
  /** Secondary line — an assumption made, or a caveat on the data. */
  | { kind: "note"; text: string };

/** One row the player was actually shown, in the order they saw it. What "the
 *  second one" resolves against. */
export type ResultRef = {
  rank: number;
  courtId: number;
  venueId: number;
  label: string;
  periodRate: number;
  distanceKm: number | null;
  runStart: number;
  runLength: number;
};

/** Not all of this is shown. It exists so an answer can be audited and tested. */
export type AnswerMeta = {
  dateISO?: string;
  hours?: number[];
  order?: string;
  /** When live availability was actually read. Absent for catalogue-only answers. */
  availabilityCheckedAt?: string;
  originLabel?: string;
  /** The server search was unavailable and the capped client path ran. */
  degraded?: boolean;
  /** Why the leading result led — only criteria that were actually applied. */
  rankReason?: string;
  /** The rows as shown, so the next turn can resolve "the first one". */
  results?: ResultRef[];
};

export type Answer = {
  intent: IntentKind;
  blocks: AnswerBlock[];
  chips: Chip[];
  /** Exactly the rows this answer was built from. Nothing outside it may be stated. */
  used: { venueIds: number[]; courtIds: number[] };
  /** Set when more matches exist than this page showed. */
  page?: { offset: number; limit: number; total: number; shown: number };
  meta?: AnswerMeta;
};

/** Where the player is answering "near me" from — GPS, or a landmark they typed. */
export type Origin = { lat: number; lng: number; label: string; source: "gps" | "place" };

export type AskContext = {
  role: AssistantRole;
  userId?: string;
  origin?: Origin | null;
  /** Injectable so the resolvers and their tests agree on "now". */
  now?: Date;
};
