/**
 * One entry point: a question in, an answer out.
 *
 * The dispatch is a plain switch because that is the honest shape of the thing —
 * a fixed set of questions this system can answer about itself. Adding a capability
 * means adding a resolver and the phrases that reach it, not retraining anything.
 */

import { DEFAULT_TIMEZONE, zonedDateISO } from "@/lib/tz";
import { loadCatalog, staffVenueIds, type Catalog } from "./catalog";
import { parseQuestion, type Parsed } from "./intents";
import {
  geocodePlace,
  resolveAmenities,
  resolveAvailability,
  resolveCheapest,
  resolveGreeting,
  resolveHelp,
  resolveHours,
  resolveMyOccupancy,
  resolveMySchedule,
  resolveNearby,
  resolveOpenNow,
  resolvePayment,
  resolvePricing,
  resolveRefund,
  resolveSlotCheck,
  resolveUnknown,
  resolveVenueInfo,
  type Ctx,
} from "./resolvers";
import {
  applyContext,
  forIdentity,
  identityOf,
  newConversation,
  remember,
  type Conversation,
  type ResultRef,
} from "./context";
import { resolveDiscovery } from "./discovery";
import { recordFeedback } from "./feedback";
import { buildVocabulary, loadMappings } from "./vocabulary";
import { resolveMyBookings, resolveMySpend } from "./personal";
import { resolveTenantActivity, resolveTenantOccupancy, resolveTenantSchedule } from "./tenant";
import type { Answer, AskContext } from "./types";

async function catalogFor(ctx: AskContext): Promise<Catalog> {
  if (ctx.role === "tenant" && ctx.userId) return loadCatalog(await staffVenueIds(ctx.userId));
  return loadCatalog();
}

export type AskOptions = {
  /** Page offset for a repeated broad question. "Show more" needs no stored state:
   *  the same text, parsed deterministically, further along. */
  offset?: number;
  /** Session-local conversation. Mutated in place; the widget owns the object. */
  conversation?: Conversation;
};

export async function ask(
  question: string,
  ctx: AskContext,
  opts: AskOptions = {},
): Promise<Answer> {
  const trimmed = question.trim();
  if (!trimmed) return resolveHelp({ ask: ctx } as Ctx);

  const now = ctx.now ?? new Date();
  const catalog = await catalogFor(ctx);
  const todayISO = zonedDateISO(now, DEFAULT_TIMEZONE);

  /* The privacy boundary: a different signed-in user, or the same user in a
     different role, never inherits the previous conversation. */
  const conv = forIdentity(
    opts.conversation ?? newConversation(),
    identityOf(ctx.userId, ctx.role),
  );
  if (opts.conversation) Object.assign(opts.conversation, conv);

  /* Trusted vocabulary: CourtHub's own sport and amenity words, plus whatever an
     admin has reviewed and mapped. Never anything a user simply asserted. */
  const vocab = buildVocabulary(catalog, await loadMappings());
  const raw = parseQuestion(trimmed, catalog, todayISO, ctx.role, vocab);
  const { parsed, ambiguous } = applyContext(raw, conv, catalog, ctx.origin ?? null);
  if (ambiguous) {
    return {
      intent: "unknown",
      blocks: [{ kind: "text", text: ambiguous }],
      chips: conv.results
        .slice(0, 3)
        .map((r) => ({ label: r.label, ask: `${trimmed} at ${r.label}` })),
      used: { venueIds: [], courtIds: [] },
    };
  }

  /* A location established earlier in the conversation still applies. */
  const askCtx: AskContext = { ...ctx, origin: ctx.origin ?? conv.origin ?? null };
  const resolverCtx: Ctx = { catalog, parsed, todayISO, nowMs: now.getTime(), ask: askCtx };
  const offset = Math.max(0, opts.offset ?? 0);

  const answer = await route(parsed.intent, resolverCtx, askCtx, offset);
  remember(conv, parsed, answer, answer.meta?.results ?? [], askCtx.origin ?? null);
  reportMiss(trimmed, parsed, answer);
  return answer;
}

/**
 * Turn an unsatisfying answer into an admin-reviewable signal.
 *
 * The categories are kept apart on purpose. "I did not understand you" and "I
 * understood you and there is nothing" are different problems: the first is a
 * vocabulary gap an admin can close with a mapping, the second is inventory. Rolling
 * them together would make the Insights page useless for either.
 */
function reportMiss(question: string, parsed: Parsed, answer: Answer): void {
  const shared = { query: question, resolvedIntent: answer.intent };

  if (answer.intent === "unknown") {
    /* Before calling it unintelligible, see whether one specific word was the
       problem — those are the ones an admin can actually fix. */
    const sport = parsed.unknownSport;
    if (sport) {
      recordFeedback({ ...shared, category: "unknown_sport_term", sportTerm: sport });
      return;
    }
    const amenity = parsed.unknownAmenity;
    if (amenity) {
      recordFeedback({ ...shared, category: "unknown_amenity_term", amenityTerm: amenity });
      return;
    }
    recordFeedback({ ...shared, category: "unknown_intent" });
    return;
  }

  /* An amenity word the catalogue does not have, in a question that otherwise
     worked. Worth recording even though the player got an answer. */
  const strayAmenity = parsed.unknownAmenity;
  if (strayAmenity) {
    recordFeedback({ ...shared, category: "unknown_amenity_term", amenityTerm: strayAmenity });
  }

  if (answer.intent === "nearby" && answer.meta?.originLabel == null && parsed.place) {
    recordFeedback({ ...shared, category: "location_not_found", locationTerm: parsed.place });
    return;
  }

  const total = answer.page?.total;
  if (total === 0) {
    /* Nothing came back. Which of the two reasons it was depends on whether
       CourtHub has the sport at all — an admin acts differently on each. */
    const category =
      parsed.sportSlug == null && parsed.amenities == null && parsed.maxPrice == null
        ? "no_available_slots"
        : "zero_results";
    recordFeedback({
      ...shared,
      category,
      sportTerm: parsed.sportSlug,
      locationTerm: parsed.place ?? answer.meta?.originLabel ?? null,
      resultCount: 0,
    });
  }
}

async function route(
  intent: Parsed["intent"],
  resolverCtx: Ctx,
  askCtx: AskContext,
  offset: number,
): Promise<Answer> {
  const parsed = resolverCtx.parsed;
  switch (intent) {
    case "greeting":
      return resolveGreeting(resolverCtx);
    case "help":
      return resolveHelp(resolverCtx);
    case "slot_check":
      return resolveSlotCheck(resolverCtx);
    /* A named venue keeps the per-court view; anything broader goes to the database,
       which can see the whole catalogue rather than the first few venues. */
    case "availability":
      return parsed.venue || parsed.court
        ? resolveAvailability(resolverCtx)
        : resolveDiscovery(resolverCtx, offset);
    case "open_now":
      return resolveDiscovery(resolverCtx, offset);
    /* "Cheapest" means the cheapest one actually bookable, at the real rate for
       those hours — a live-availability question, not a catalogue one. */
    case "cheapest":
      return resolveDiscovery(resolverCtx, offset);
    case "pricing":
      return resolvePricing(resolverCtx);
    /* With no position there is nothing to measure from, so that path still asks for
       one. Once it has one, distance is just another ordering. */
    case "nearby":
      return askCtx.origin || parsed.place
        ? resolveNearbyDiscovery(resolverCtx, offset)
        : resolveNearby(resolverCtx);
    case "payment":
      return resolvePayment(resolverCtx);
    case "refund":
      return resolveRefund(resolverCtx);
    case "amenities":
      return resolveAmenities(resolverCtx);
    case "hours":
      return resolveHours(resolverCtx);
    case "venue_info":
      return resolveVenueInfo(resolverCtx);
    case "my_bookings":
      return resolveMyBookings(resolverCtx);
    case "my_spend":
      return resolveMySpend(resolverCtx);
    /* The set-based tenant RPCs ship in the Phase 2 migration. Until it is applied
       these fall back to the older per-court walk, which still answers — capped,
       and saying so — rather than failing outright. */
    case "tenant_activity":
      return withTenantFallback(
        () => resolveTenantActivity(resolverCtx),
        () => resolveMySchedule(resolverCtx),
      );
    case "my_schedule":
      return withTenantFallback(
        () => resolveTenantSchedule(resolverCtx),
        () => resolveMySchedule(resolverCtx),
      );
    case "my_occupancy":
      return withTenantFallback(
        () => resolveTenantOccupancy(resolverCtx),
        () => resolveMyOccupancy(resolverCtx),
      );
    default:
      return resolveUnknown(resolverCtx);
  }
}

/** PostgREST's "function is not in the schema cache" shapes. */
function missingFunction(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("could not find the function") || m.includes("does not exist");
}

async function withTenantFallback(
  primary: () => Promise<Answer>,
  fallback: () => Promise<Answer>,
): Promise<Answer> {
  try {
    return await primary();
  } catch (e) {
    if (!missingFunction(e)) throw e;
    const answer = await fallback();
    answer.blocks.push({
      kind: "note",
      text: "Server-side tenant aggregates are not available yet, so this covers only the first few venues. Apply the Phase 2 assistant migration to cover them all.",
    });
    return answer;
  }
}

/** Resolves a typed landmark to a point, then ranks the catalogue around it. */
async function resolveNearbyDiscovery(ctx: Ctx, offset: number): Promise<Answer> {
  if (!ctx.ask.origin && ctx.parsed.place) {
    const origin = await geocodePlace(ctx.parsed.place);
    if (!origin) return resolveNearby(ctx);
    return resolveDiscovery({ ...ctx, ask: { ...ctx.ask, origin } }, offset);
  }
  return resolveDiscovery(ctx, offset);
}
