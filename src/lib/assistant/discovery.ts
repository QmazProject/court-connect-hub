/**
 * Broad questions: "what is available tonight", "cheapest badminton near me
 * 7-9 PM under P300".
 *
 * All of them are the same query with different filters and a different sort, so
 * they share one resolver. The database decides *which* courts qualify across the
 * whole catalogue; this file decides how to say it, and shows only the best few.
 */

import { peso } from "@/lib/court-pricing";
import { fmtHour } from "@/lib/operating-hours";
import type { Catalog, CatalogCourt, CatalogVenue } from "./catalog";
import type { Parsed } from "./intents";
import type { Ctx } from "./resolvers";
import {
  defaultParams,
  discover,
  rankReason,
  type DiscoverOrder,
  type DiscoverParams,
  type DiscoverRow,
} from "./search";
import type { Answer, AnswerBlock, AnswerRow, Chip, IntentKind, RowAction } from "./types";
import { dateLabel } from "./when";

/** How many results a chat message shows before "Show more". */
export const PAGE_SIZE = 4;

/** Ranking follows the question: a price question sorts on price, and so on. */
export function orderFor(parsed: Parsed): DiscoverOrder {
  if (parsed.intent === "cheapest" || parsed.maxPrice != null || parsed.minPrice != null)
    return "price";
  if (parsed.intent === "nearby" || parsed.maxKm != null) return "distance";
  if (parsed.intent === "open_now" || parsed.intent === "availability") return "time";
  return "relevance";
}

export function paramsFor(ctx: Ctx, offset = 0): DiscoverParams {
  const { parsed, ask } = ctx;
  return defaultParams({
    dateISO: parsed.when.dateISO,
    now: new Date(ctx.nowMs),
    hours:
      parsed.when.precision === "slot" && parsed.when.hours.length > 0 ? parsed.when.hours : null,
    minDuration: parsed.minDuration,
    sportSlug: parsed.sportSlug,
    venueIds: parsed.venue ? [parsed.venue.id] : null,
    /* The authorisation boundary. The server re-derives it from auth.uid(); this
       only tells it to. */
    tenantScope: ask.role === "tenant",
    origin: ask.origin ? { lat: ask.origin.lat, lng: ask.origin.lng } : null,
    maxKm: parsed.maxKm,
    minPrice: parsed.minPrice,
    maxPrice: parsed.maxPrice,
    payment: parsed.payment,
    amenities: parsed.amenities,
    order: orderFor(parsed),
    limit: PAGE_SIZE,
    offset,
  });
}

function label(
  catalog: Catalog,
  row: DiscoverRow,
): { court: CatalogCourt | null; venue: CatalogVenue | null } {
  const hit = catalog.byCourt.get(row.courtId);
  return {
    court: hit?.court ?? null,
    venue: hit?.venue ?? catalog.byVenue.get(row.venueId) ?? null,
  };
}

/** "7:00 PM – 9:00 PM" for the block the search actually priced. */
function blockLabel(row: DiscoverRow): string {
  return `${fmtHour(row.runStart)} – ${fmtHour(row.runStart + row.runLength)}`;
}

function rowFor(ctx: Ctx, row: DiscoverRow, hours: number[] | null): AnswerRow {
  const { court, venue } = label(ctx.catalog, row);
  const slotHours = hours ?? Array.from({ length: row.runLength }, (_, i) => row.runStart + i);
  const price =
    row.runLength > 1
      ? `${peso(row.periodRate)}/hr · ${peso(row.periodTotal)} total`
      : `${peso(row.periodRate)}/hr`;

  const meta = [
    court?.sport,
    row.distanceKm != null ? `${row.distanceKm.toFixed(1)} km away` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  /* The court leads because that is what gets booked, but a court name on its own
     ("Court 2") does not tell anyone where to turn up — so the venue sits directly
     underneath it rather than being folded into the same line. */
  const actions: RowAction[] = [];
  if (ctx.ask.role === "player") {
    actions.push({
      label: `Book ${blockLabel(row)}`,
      emphasis: "primary",
      nav: {
        kind: "court",
        id: row.courtId,
        venueId: row.venueId,
        date: ctx.parsed.when.dateISO,
        hours: slotHours,
      },
    });
  }
  actions.push({
    label: "View venue",
    emphasis: "ghost",
    nav: { kind: "venue", id: row.venueId },
  });

  return {
    title: court?.name ?? `Court #${row.courtId}`,
    subtitle: venue?.name,
    detail: `${blockLabel(row)} · ${price}`,
    meta: meta || undefined,
    tone: "ok",
    actions,
  };
}

/** What was asked for, in one phrase, so the answer restates the question. */
function scopeLabel(ctx: Ctx): string {
  const p = ctx.parsed;
  const bits: string[] = [];
  if (p.sportSlug) bits.push(p.sportSlug);
  bits.push("courts");
  if (p.when.precision === "slot" && p.when.hours.length > 0) {
    bits.push(
      `${dateLabel(p.when.dateISO, ctx.todayISO)} ${fmtHour(p.when.hours[0])}–${fmtHour(
        p.when.hours[p.when.hours.length - 1] + 1,
      )}`,
    );
  } else {
    bits.push(p.when.precision === "band" ? p.when.label : dateLabel(p.when.dateISO, ctx.todayISO));
  }
  if (p.maxPrice != null) bits.push(`under ${peso(p.maxPrice)}/hr`);
  if (p.maxKm != null) bits.push(`within ${p.maxKm} km`);
  if (p.amenities) bits.push(`with ${p.amenities.join(" and ")}`);
  if (p.payment === "online") bits.push("paying through CourtHub");
  return bits.join(" ");
}

/**
 * When nothing matched, relax one constraint at a time and report what that would
 * have found — so a dead end still tells the player where to go next.
 */
async function alternatives(ctx: Ctx): Promise<{ blocks: AnswerBlock[]; chips: Chip[] }> {
  const p = ctx.parsed;
  const blocks: AnswerBlock[] = [];
  const chips: Chip[] = [];
  const found: string[] = [];

  const probe = async (over: Partial<DiscoverParams>) => {
    const res = await discover({ ...paramsFor(ctx), ...over, limit: 1, offset: 0 }, ctx.catalog);
    return res.total;
  };

  if (p.when.precision === "slot" && p.when.hours.length > 0) {
    const anyTime = await probe({ hours: null, minDuration: p.when.hours.length });
    if (anyTime > 0) {
      found.push(
        `${anyTime} court${anyTime === 1 ? "" : "s"} free for ${p.when.hours.length}h at another time that day`,
      );
      chips.push({
        label: "Any time that day",
        ask: `${p.sportSlug ?? ""} courts ${dateLabel(p.when.dateISO, ctx.todayISO)}`.trim(),
      });
    }
  }
  if (p.maxKm != null) {
    const wider = await probe({ maxKm: p.maxKm * 2 });
    if (wider > 0) {
      found.push(`${wider} within ${p.maxKm * 2} km`);
      chips.push({
        label: `Expand to ${p.maxKm * 2} km`,
        ask: `${p.text} within ${p.maxKm * 2} km`,
      });
    }
  }
  if (p.maxPrice != null) {
    const dearer = await probe({ maxPrice: null });
    if (dearer > 0) {
      found.push(`${dearer} if the price cap is lifted`);
      chips.push({
        label: "Any price",
        ask: p.text.replace(/\b(under|below|less than)\s*(?:php|p|₱)?\s*\d+/i, "").trim(),
      });
    }
  }

  if (found.length > 0) blocks.push({ kind: "rows", rows: found.map((f) => ({ title: f })) });
  else
    blocks.push({
      kind: "note",
      text: "Nothing close matched either. Try another day, or widen the area.",
    });
  return { blocks, chips };
}

export async function resolveDiscovery(ctx: Ctx, offset = 0): Promise<Answer> {
  const p = ctx.parsed;
  const params = paramsFor(ctx, offset);
  const res = await discover(params, ctx.catalog);
  const isTenant = ctx.ask.role === "tenant";

  const meta = {
    dateISO: params.dateISO,
    hours: params.hours ?? undefined,
    order: params.order,
    availabilityCheckedAt: res.checkedAt.toISOString(),
    originLabel: ctx.ask.origin?.label,
    degraded: res.degraded,
    rankReason: res.rows[0] ? rankReason(res.rows[0], params.order, params.hours) : undefined,
    /* Carried, not scraped back out of the rendered text: the next turn resolves
       "the second one" against exactly what was shown. */
    results: res.rows.map((r, i) => {
      const named = label(ctx.catalog, r);
      return {
        rank: offset + i,
        courtId: r.courtId,
        venueId: r.venueId,
        label:
          named.court && named.venue
            ? `${named.venue.name} — ${named.court.name}`
            : `Court #${r.courtId}`,
        periodRate: r.periodRate,
        distanceKm: r.distanceKm,
        runStart: r.runStart,
        runLength: r.runLength,
      };
    }),
  };

  if (res.rows.length === 0) {
    const alt = await alternatives(ctx);
    return {
      intent: p.intent,
      blocks: [
        { kind: "text", text: `No ${scopeLabel(ctx)} came back free.` },
        ...alt.blocks,
        { kind: "note", text: liveNote(res.degraded, res.checkedAt) },
      ],
      chips: alt.chips,
      used: { venueIds: [], courtIds: [] },
      meta,
    };
  }

  const shownTo = offset + res.rows.length;
  const headline = isTenant
    ? `${res.total} of your courts ${res.total === 1 ? "is" : "are"} free — ${scopeLabel(ctx)}.`
    : `${res.total} ${scopeLabel(ctx)} available.`;

  const blocks: AnswerBlock[] = [
    { kind: "text", text: offset > 0 ? `More ${scopeLabel(ctx)}:` : headline },
    { kind: "rows", rows: res.rows.map((r) => rowFor(ctx, r, params.hours)) },
    { kind: "note", text: liveNote(res.degraded, res.checkedAt) },
  ];
  if (res.degraded && res.scanned != null) {
    blocks.push({
      kind: "note",
      text: `Server-side search is not available yet, so only the ${res.scanned} nearest venues were checked. Apply the assistant search migration to search every venue.`,
    });
  }

  const chips: Chip[] = [];
  const top = res.rows[0];
  if (!isTenant) {
    chips.push({
      label: `Book ${blockLabel(top)}`,
      nav: {
        kind: "court",
        id: top.courtId,
        venueId: top.venueId,
        date: params.dateISO,
        hours: params.hours ?? Array.from({ length: top.runLength }, (_, i) => top.runStart + i),
      },
    });
  }
  if (shownTo < res.total)
    chips.push({ label: `Show more (${res.total - shownTo} left)`, action: "more" });
  if (meta.rankReason) chips.push({ label: "Why this one?", action: "why" });
  if (params.order !== "price") chips.push({ label: "Cheapest", ask: `cheapest ${p.text}` });
  if (params.order !== "distance" && ctx.ask.origin)
    chips.push({ label: "Closest", ask: `${p.text} near me` });
  if (!ctx.ask.origin) chips.push({ label: "Use my location", action: "locate" });

  return {
    intent: p.intent,
    blocks,
    chips,
    used: {
      venueIds: [...new Set(res.rows.map((r) => r.venueId))],
      courtIds: res.rows.map((r) => r.courtId),
    },
    page: { offset, limit: PAGE_SIZE, total: res.total, shown: shownTo },
    meta,
  };
}

/** §8: say live when it was live, and say cached when it was not. */
function liveNote(degraded: boolean, at: Date): string {
  const t = at.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  return degraded
    ? `Availability checked just now (${t}); venue details come from a short-lived cache.`
    : `Checked live availability just now (${t}). Slots are not held until you book.`;
}

/** "Why this one?" — cites only what the ordering actually used. */
export function whyChip(answer: Answer): Chip | null {
  return answer.meta?.rankReason ? { label: "Why this one?", ask: "why this one" } : null;
}

export const DISCOVERY_INTENTS: IntentKind[] = ["open_now", "availability", "cheapest", "nearby"];
