/**
 * Turning a target into an answer, by reading rows.
 *
 * Each resolver ends by declaring the venue and court ids it touched. That list is
 * the contract: an answer may only talk about what is in it. There is no branch in
 * this file that produces a number from anywhere but a query result or a helper in
 * `src/lib` — which is what lets the thing be trusted without a model behind it.
 */

import { peso, rateCardGroups } from "@/lib/court-pricing";
import { formatKm, haversineKm } from "@/lib/geo";
import { describeWeek, describeWindow, fmtHour } from "@/lib/operating-hours";
import { searchPhPlaces } from "@/lib/ph-places";
import { zonedDateISO, zonedDayOfWeek } from "@/lib/tz";
import type { Catalog, CatalogCourt, CatalogVenue } from "./catalog";
import type { Parsed } from "./intents";
import { courtDaySlots, freeHours, joinHours, slotStateLabel, type SlotInfo } from "./slots";
import { suggestSport } from "./vocabulary";
import type { Answer, AnswerBlock, AnswerRow, AskContext, Chip, Origin } from "./types";
import { dateLabel } from "./when";

export type Ctx = {
  catalog: Catalog;
  parsed: Parsed;
  todayISO: string;
  nowMs: number;
  ask: AskContext;
};

const DAY_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** How many venues a broad question fans out over before it starts costing real time. */
const BROAD_VENUE_LIMIT = 6;
/** Courts read per venue when listing a venue's free times. */
const COURT_LIMIT = 12;

function answer(
  intent: Answer["intent"],
  blocks: AnswerBlock[],
  chips: Chip[] = [],
  used: { venueIds?: number[]; courtIds?: number[] } = {},
): Answer {
  return {
    intent,
    blocks,
    chips,
    used: { venueIds: used.venueIds ?? [], courtIds: used.courtIds ?? [] },
  };
}

const text = (t: string): AnswerBlock => ({ kind: "text", text: t });
const note = (t: string): AnswerBlock => ({ kind: "note", text: t });
const rows = (r: AnswerRow[]): AnswerBlock => ({ kind: "rows", rows: r });

/** "7:00 PM – 9:00 PM" for a contiguous hour list, or a single hour. */
function hourSpan(hours: number[]): string {
  if (hours.length === 0) return "";
  if (hours.length === 1) return fmtHour(hours[0]);
  return `${fmtHour(hours[0])} – ${fmtHour(hours[hours.length - 1] + 1)}`;
}

function venueChip(v: CatalogVenue): Chip {
  return { label: `Open ${v.name}`, nav: { kind: "venue", id: v.id } };
}

function isOpenOnDate(v: CatalogVenue, dateISO: string): boolean {
  const day = DAY_KEY[zonedDayOfWeek(dateISO)];
  const w = v.hours[day];
  return !!w && w !== "closed";
}

/** The court a "cheapest"/"price" question should quote, honouring a named sport. */
function courtsOf(v: CatalogVenue, sportSlug: string | null): CatalogCourt[] {
  const list = v.courts.filter((c) => !c.comingSoon);
  return sportSlug ? list.filter((c) => c.sportSlug === sportSlug) : list;
}

function notFound(what: string, catalog: Catalog): Answer {
  const names = catalog.venues.slice(0, 3).map((v) => v.name);
  return answer(
    "unknown",
    [
      text(`I could not find ${what} in the system.`),
      names.length > 0
        ? note(`Venues I do know: ${names.join(", ")}.`)
        : note("No active venues are listed yet."),
    ],
    names.map((n) => ({ label: n, ask: `tell me about ${n}` })),
  );
}

/* ---------------------------------------------------------------- *
 * Availability
 * ---------------------------------------------------------------- */

/** One named court, one named hour: the yes/no question, answered with the reason. */
export async function resolveSlotCheck(ctx: Ctx): Promise<Answer> {
  const { parsed, catalog, nowMs, todayISO } = ctx;
  const venue =
    parsed.venue ?? (parsed.court ? (catalog.byCourt.get(parsed.court.id)?.venue ?? null) : null);
  if (!venue) return notFound("that venue", catalog);

  const courts = parsed.court
    ? [parsed.court]
    : courtsOf(venue, parsed.sportSlug).slice(0, COURT_LIMIT);
  if (courts.length === 0) return notFound(`a court at ${venue.name}`, catalog);

  const wanted = parsed.when.hours;
  const day = dateLabel(parsed.when.dateISO, todayISO);
  const results = await Promise.all(
    courts.map(async (c) => ({
      court: c,
      slots: await courtDaySlots(c, venue, parsed.when.dateISO, nowMs),
    })),
  );

  const chips: Chip[] = [];
  const blocks: AnswerBlock[] = [];
  const answerRows: AnswerRow[] = [];
  let anyOpen = false;

  for (const { court, slots } of results) {
    const byHour = new Map(slots.map((s) => [s.hour, s]));
    const asked = wanted.map((h) => ({ hour: h, slot: byHour.get(h) }));
    const missing = asked.filter((a) => !a.slot);
    const free = asked.filter((a) => a.slot?.state === "open");
    const taken = asked.filter((a) => a.slot && a.slot.state !== "open");

    const venueNav = { kind: "venue" as const, id: venue.id };
    const bookNav = (hours: number[]) => ({
      kind: "court" as const,
      id: court.id,
      venueId: venue.id,
      date: parsed.when.dateISO,
      hours,
    });

    if (missing.length === asked.length) {
      answerRows.push({
        title: court.name,
        subtitle: venue.name,
        detail: `Closed at that hour — ${describeWindow(court.hours[DAY_KEY[zonedDayOfWeek(parsed.when.dateISO)]])} on ${day}.`,
        tone: "off",
        actions: [{ label: "View venue", emphasis: "ghost", nav: venueNav }],
      });
      continue;
    }

    if (free.length === asked.length - missing.length && free.length > 0) {
      anyOpen = true;
      const total = free.reduce((s, a) => s + (a.slot?.rate ?? 0), 0);
      answerRows.push({
        title: court.name,
        subtitle: venue.name,
        detail: `Free — ${peso(total)}${free.length > 1 ? ` for ${free.length} hours` : ""}.`,
        meta: court.sport,
        tone: "ok",
        actions: [
          { label: `Book ${hourSpan(wanted)}`, emphasis: "primary", nav: bookNav(wanted) },
          { label: "View venue", emphasis: "ghost", nav: venueNav },
        ],
      });
      chips.push({ label: `Book ${court.name}`, nav: bookNav(wanted) });
      continue;
    }

    /* Partly free is its own answer: it names the hours that ARE open and the reason
       the rest are not, so the player can act on the difference. */
    const why = taken[0]?.slot ? slotStateLabel(taken[0].slot.state) : "not open";
    const freeList = free.map((a) => a.hour);
    answerRows.push({
      title: court.name,
      subtitle: venue.name,
      detail:
        free.length > 0
          ? `Partly free — ${joinHours(free.map((a) => fmtHour(a.hour)))} open, the rest is ${why}.`
          : `Not available — ${why}.`,
      meta: court.sport,
      tone: free.length > 0 ? "warn" : "off",
      actions:
        free.length > 0
          ? [
              { label: `Book ${hourSpan(freeList)}`, emphasis: "primary", nav: bookNav(freeList) },
              { label: "View venue", emphasis: "ghost", nav: venueNav },
            ]
          : [{ label: "View venue", emphasis: "ghost", nav: venueNav }],
    });
  }

  const hourLabel =
    wanted.length === 1
      ? fmtHour(wanted[0])
      : `${fmtHour(wanted[0])} – ${fmtHour(wanted[wanted.length - 1] + 1)}`;
  blocks.push(text(`${venue.name}, ${day} at ${hourLabel}:`));
  blocks.push(rows(answerRows));

  if (!anyOpen) {
    /* A "no" is only useful with the nearest "yes" attached. */
    const alt = results
      .flatMap(({ court, slots }) => freeHours(slots).map((s) => ({ court, slot: s })))
      .filter((x) => x.slot.hour > (wanted[wanted.length - 1] ?? 0))
      .sort((a, b) => a.slot.hour - b.slot.hour)
      .slice(0, 3);
    if (alt.length > 0) {
      blocks.push(
        note(
          `Next free ${day}: ${alt.map((a) => `${fmtHour(a.slot.hour)} on ${a.court.name}`).join(", ")}.`,
        ),
      );
      chips.push({
        label: `Book ${fmtHour(alt[0].slot.hour)}`,
        nav: { kind: "court", id: alt[0].court.id },
      });
    } else {
      chips.push({ label: "Try tomorrow", ask: `what is free at ${venue.name} tomorrow` });
    }
  }
  if (parsed.when.assumedPm)
    blocks.push(note(`Read as ${hourLabel}. Say "am" if you meant the morning.`));

  return answer("slot_check", blocks, chips, {
    venueIds: [venue.id],
    courtIds: results.map((r) => r.court.id),
  });
}

/** Free times at one venue (or one court) on a date. */
export async function resolveAvailability(ctx: Ctx): Promise<Answer> {
  const { parsed, catalog, nowMs, todayISO } = ctx;
  const venue =
    parsed.venue ?? (parsed.court ? (catalog.byCourt.get(parsed.court.id)?.venue ?? null) : null);
  if (!venue) return resolveOpenNow(ctx);

  const dateISO = parsed.when.dateISO;
  const day = dateLabel(dateISO, todayISO);
  if (!isOpenOnDate(venue, dateISO)) {
    return answer(
      "availability",
      [text(`${venue.name} is closed ${day}.`), ...weekBlocks(venue)],
      [venueChip(venue), { label: "Try tomorrow", ask: `what is free at ${venue.name} tomorrow` }],
      { venueIds: [venue.id] },
    );
  }

  const courts = parsed.court
    ? [parsed.court]
    : courtsOf(venue, parsed.sportSlug).slice(0, COURT_LIMIT);
  if (courts.length === 0)
    return notFound(`a ${parsed.sportSlug ?? ""} court at ${venue.name}`.trim(), catalog);

  const band = parsed.when.precision === "band" ? new Set(parsed.when.hours) : null;
  const results = await Promise.all(
    courts.map(async (c) => ({ court: c, slots: await courtDaySlots(c, venue, dateISO, nowMs) })),
  );

  const answerRows: AnswerRow[] = [];
  for (const { court, slots } of results) {
    const open = freeHours(slots).filter((s) => !band || band.has(s.hour));
    answerRows.push({
      title: court.name,
      subtitle: venue.name,
      detail:
        open.length === 0
          ? "No free hours left."
          : joinHours(
              open.map((s) => fmtHour(s.hour)),
              5,
            ),
      meta: `${court.sport} · ${peso(court.minRate)}${court.maxRate !== court.minRate ? `–${peso(court.maxRate)}` : ""}/hr`,
      tone: open.length === 0 ? "off" : "ok",
      /* Booking is offered only where there is something to book, and it lands on
         the first free hour rather than an arbitrary one. */
      actions:
        open.length === 0
          ? [{ label: "View venue", emphasis: "ghost", nav: { kind: "venue", id: venue.id } }]
          : [
              {
                label: `Book ${fmtHour(open[0].hour)}`,
                emphasis: "primary",
                nav: {
                  kind: "court",
                  id: court.id,
                  venueId: venue.id,
                  date: dateISO,
                  hours: [open[0].hour],
                },
              },
              { label: "View venue", emphasis: "ghost", nav: { kind: "venue", id: venue.id } },
            ],
    });
  }

  const totalFree = results.reduce(
    (n, r) => n + freeHours(r.slots).filter((s) => !band || band.has(s.hour)).length,
    0,
  );
  const scope = band ? `${parsed.when.label}` : day;
  const blocks: AnswerBlock[] = [
    text(
      totalFree === 0
        ? `Nothing free at ${venue.name} ${scope}.`
        : `${totalFree} free hour${totalFree === 1 ? "" : "s"} at ${venue.name} ${scope}:`,
    ),
    rows(answerRows),
  ];
  if (courtsOf(venue, parsed.sportSlug).length > COURT_LIMIT) {
    blocks.push(
      note(
        `Showing the first ${COURT_LIMIT} courts of ${courtsOf(venue, parsed.sportSlug).length}.`,
      ),
    );
  }

  return answer(
    "availability",
    blocks,
    [venueChip(venue), { label: "Cheapest hour here", ask: `cheapest court at ${venue.name}` }],
    {
      venueIds: [venue.id],
      courtIds: results.map((r) => r.court.id),
    },
  );
}

/** "Who is open now" — hours first, then live free counts for the closest few. */
export async function resolveOpenNow(ctx: Ctx): Promise<Answer> {
  const { parsed, catalog, nowMs, todayISO, ask } = ctx;
  const dateISO = parsed.when.dateISO;
  const day = dateLabel(dateISO, todayISO);
  const band = parsed.when.hours.length > 0 ? new Set(parsed.when.hours) : null;

  let open = catalog.venues.filter((v) => isOpenOnDate(v, dateISO));
  if (parsed.sportSlug) open = open.filter((v) => courtsOf(v, parsed.sportSlug).length > 0);
  if (open.length === 0) {
    return answer(
      "open_now",
      [text(`No venue is open ${day}${parsed.sportSlug ? ` for ${parsed.sportSlug}` : ""}.`)],
      [{ label: "What about tomorrow?", ask: "what is open tomorrow" }],
    );
  }

  /* Closest first when we know where the player is — otherwise the list is arbitrary. */
  const origin = ask.origin ?? null;
  const ordered = origin
    ? open
        .filter((v) => v.lat != null && v.lng != null)
        .map((v) => ({
          v,
          km: haversineKm(origin, { lat: v.lat as number, lng: v.lng as number }),
        }))
        .sort((a, b) => a.km - b.km)
        .concat(open.filter((v) => v.lat == null || v.lng == null).map((v) => ({ v, km: NaN })))
    : open.map((v) => ({ v, km: NaN }));

  const shown = ordered.slice(0, BROAD_VENUE_LIMIT);
  const counted = await Promise.all(
    shown.map(async ({ v, km }) => {
      const courts = courtsOf(v, parsed.sportSlug).slice(0, COURT_LIMIT);
      const per = await Promise.all(courts.map((c) => courtDaySlots(c, v, dateISO, nowMs)));
      const free = per
        .flatMap((slots) => freeHours(slots))
        .filter((s) => !band || band.has(s.hour));
      const soonest = free.sort((a, b) => a.hour - b.hour)[0];
      return { v, km, freeCount: free.length, soonest, courtIds: courts.map((c) => c.id) };
    }),
  );

  const answerRows: AnswerRow[] = counted.map(({ v, km, freeCount, soonest }) => ({
    title: v.name,
    detail:
      freeCount === 0
        ? "Open, but fully booked."
        : `${freeCount} free hour${freeCount === 1 ? "" : "s"}${soonest ? `, next ${fmtHour(soonest.hour)}` : ""}.`,
    meta:
      [Number.isFinite(km) ? formatKm(km) : null, v.address].filter(Boolean).join(" · ") ||
      undefined,
    tone: freeCount === 0 ? "off" : "ok",
    nav: { kind: "venue", id: v.id },
  }));

  const blocks: AnswerBlock[] = [
    text(
      `${open.length} venue${open.length === 1 ? "" : "s"} open ${band ? parsed.when.label : day}${parsed.sportSlug ? ` for ${parsed.sportSlug}` : ""}:`,
    ),
    rows(answerRows),
  ];
  if (open.length > shown.length)
    blocks.push(note(`Showing the ${shown.length}${origin ? " closest" : ""} of ${open.length}.`));
  if (!origin)
    blocks.push(note("Turn on location and I can sort these by how far they are from you."));

  const chips: Chip[] = [];
  if (!origin) chips.push({ label: "Use my location", action: "locate" });
  chips.push({ label: "Cheapest per hour", ask: "cheapest court per hour" });

  return answer("open_now", blocks, chips, {
    venueIds: counted.map((c) => c.v.id),
    courtIds: counted.flatMap((c) => c.courtIds),
  });
}

/* ---------------------------------------------------------------- *
 * Pricing
 * ---------------------------------------------------------------- */

export function resolveCheapest(ctx: Ctx): Answer {
  const { parsed, catalog } = ctx;
  const pool = parsed.venue ? [parsed.venue] : catalog.venues;
  const entries = pool
    .flatMap((v) => courtsOf(v, parsed.sportSlug).map((c) => ({ v, c })))
    .sort((a, b) => a.c.minRate - b.c.minRate)
    .slice(0, 5);

  if (entries.length === 0) {
    return notFound(parsed.sportSlug ? `a ${parsed.sportSlug} court` : "any court", catalog);
  }

  const scope = parsed.venue ? ` at ${parsed.venue.name}` : "";
  const sport = parsed.sportSlug ? ` for ${parsed.sportSlug}` : "";
  const best = entries[0];

  return answer(
    "cheapest",
    [
      text(
        `Cheapest${sport}${scope}: ${best.c.name} at ${best.v.name}, ${peso(best.c.minRate)} per hour.`,
      ),
      rows(
        entries.map(({ v, c }) => ({
          title: c.name,
          subtitle: v.name,
          detail:
            c.maxRate !== c.minRate
              ? `${peso(c.minRate)} – ${peso(c.maxRate)} per hour, depending on the time.`
              : `${peso(c.minRate)} per hour, all week.`,
          meta: c.sport,
          tone: "ok",
          actions: [
            { label: "Book", emphasis: "primary", nav: { kind: "court", id: c.id, venueId: v.id } },
            { label: "View venue", emphasis: "ghost", nav: { kind: "venue", id: v.id } },
          ],
        })),
      ),
      note("Rates shown are the lowest and highest hour across the open week."),
    ],
    [
      { label: `Book ${best.c.name}`, nav: { kind: "court", id: best.c.id } },
      { label: "When is it free?", ask: `what is free at ${best.v.name} today` },
    ],
    { venueIds: [...new Set(entries.map((e) => e.v.id))], courtIds: entries.map((e) => e.c.id) },
  );
}

export function resolvePricing(ctx: Ctx): Answer {
  const { parsed, catalog } = ctx;
  if (!parsed.venue && !parsed.court) return resolveCheapest(ctx);
  const venue = parsed.venue ?? catalog.byCourt.get(parsed.court!.id)!.venue;
  const courts = parsed.court ? [parsed.court] : courtsOf(venue, parsed.sportSlug);
  if (courts.length === 0) return notFound(`a court at ${venue.name}`, catalog);

  const blocks: AnswerBlock[] = [text(`Rates at ${venue.name}:`)];
  blocks.push(
    rows(
      courts.slice(0, 8).map((c) => ({
        title: c.name,
        detail:
          c.maxRate !== c.minRate
            ? `${peso(c.minRate)} – ${peso(c.maxRate)} per hour`
            : `${peso(c.minRate)} per hour`,
        meta: [c.sport, c.isIndoor ? "indoor" : "outdoor", c.surface].filter(Boolean).join(" · "),
        tone: "ok",
        nav: { kind: "court", id: c.id },
      })),
    ),
  );

  /* One court asked about by name deserves its real rate card, not just the range —
     this is the same fold-identical-days grouping the court page prints. */
  if (courts.length === 1) {
    const card = rateCardGroups(courts[0].hourlyRate, courts[0].rules, courts[0].hours);
    const varying = card.some((g) => g.bands.length > 1) || card.length > 1;
    if (varying) {
      blocks.push(
        rows(
          card.map((g) => ({
            title: g.label,
            detail: g.bands
              .map((b) => `${fmtHour(b.start)}–${fmtHour(b.end)} ${peso(b.rate)}`)
              .join(" · "),
          })),
        ),
      );
    }
  }
  if (venue.fees.length > 0) {
    blocks.push(
      note(
        `Extra charges: ${venue.fees.map((f) => `${f.label} ${peso(Number(f.amount))}`).join(", ")}.`,
      ),
    );
  }
  if (venue.feesNotes) blocks.push(note(venue.feesNotes));

  return answer(
    "pricing",
    blocks,
    [venueChip(venue), { label: "Cheapest hour here", ask: `cheapest court at ${venue.name}` }],
    {
      venueIds: [venue.id],
      courtIds: courts.map((c) => c.id),
    },
  );
}

/* ---------------------------------------------------------------- *
 * Location
 * ---------------------------------------------------------------- */

/** Geocodes a typed landmark with the same free OSM lookup the map already uses. */
export async function geocodePlace(place: string): Promise<Origin | null> {
  const res = await searchPhPlaces(place, { limit: 1 });
  const hit = res.results[0];
  if (!hit) return null;
  return { lat: hit.lat, lng: hit.lng, label: hit.display || hit.label, source: "place" };
}

export async function resolveNearby(ctx: Ctx): Promise<Answer> {
  const { parsed, catalog, ask } = ctx;

  let origin = ask.origin ?? null;
  if (!origin && parsed.place) {
    origin = await geocodePlace(parsed.place);
    if (!origin) {
      return answer(
        "nearby",
        [
          text(`I could not find "${parsed.place}" on the map.`),
          note("Try a city, barangay or a well-known landmark — or turn on location instead."),
        ],
        [{ label: "Use my location", action: "locate" }],
      );
    }
  }

  if (!origin) {
    return answer(
      "nearby",
      [
        text("I need a starting point before I can measure anything."),
        note('Turn on location, or name a place — "courts near Ayala Center Cebu".'),
      ],
      [
        { label: "Use my location", action: "locate" },
        { label: "Near Cebu City", ask: "courts near Cebu City" },
      ],
    );
  }

  const mapped = catalog.venues.filter((v) => v.lat != null && v.lng != null);
  if (mapped.length === 0) {
    return answer(
      "nearby",
      [text("No venue has a location pinned yet, so I cannot measure distance.")],
      [],
    );
  }

  let ranked = mapped
    .map((v) => ({ v, km: haversineKm(origin!, { lat: v.lat as number, lng: v.lng as number }) }))
    .sort((a, b) => a.km - b.km);
  if (parsed.sportSlug) ranked = ranked.filter((r) => courtsOf(r.v, parsed.sportSlug).length > 0);
  if (parsed.venue) ranked = ranked.filter((r) => r.v.id === parsed.venue!.id);

  const shown = ranked.slice(0, 6);
  if (shown.length === 0)
    return notFound(`a ${parsed.sportSlug ?? ""} court near there`.trim(), catalog);

  return answer(
    "nearby",
    [
      text(`Closest to ${origin.label}:`),
      rows(
        shown.map(({ v, km }) => ({
          title: v.name,
          detail: v.address,
          meta: `${formatKm(km)} away${v.courts.length > 0 ? ` · from ${peso(Math.min(...v.courts.map((c) => c.minRate)))}/hr` : ""}`,
          tone: "ok",
          nav: { kind: "venue", id: v.id },
        })),
      ),
      note(
        origin.source === "gps"
          ? "Straight-line distance from your device's location, not driving distance."
          : `Straight-line distance from ${origin.label}, not driving distance.`,
      ),
    ],
    [
      {
        label: `What is free at ${shown[0].v.name}?`,
        ask: `what is free at ${shown[0].v.name} today`,
      },
      ...(origin.source === "place"
        ? [{ label: "Use my location", action: "locate" as const }]
        : []),
    ],
    { venueIds: shown.map((s) => s.v.id) },
  );
}

/* ---------------------------------------------------------------- *
 * Venue facts
 * ---------------------------------------------------------------- */

function weekBlocks(v: CatalogVenue): AnswerBlock[] {
  const week = describeWeek(v.hours);
  if (week.length === 0) return [];
  return [rows(week.map((w) => ({ title: w.days, detail: w.window })))];
}

function requireVenue(ctx: Ctx): CatalogVenue | Answer {
  const { parsed, catalog } = ctx;
  const venue =
    parsed.venue ?? (parsed.court ? (catalog.byCourt.get(parsed.court.id)?.venue ?? null) : null);
  if (venue) return venue;
  if (catalog.venues.length === 1) return catalog.venues[0];
  return answer(
    "unknown",
    [text("Which venue do you mean?")],
    catalog.venues
      .slice(0, 4)
      .map((v) => ({ label: v.name, ask: `${ctx.parsed.text} at ${v.name}` })),
  );
}

export function resolveHours(ctx: Ctx): Answer {
  const v = requireVenue(ctx);
  if ("intent" in v) return v;
  const today = isOpenOnDate(v, ctx.todayISO);
  const day = DAY_KEY[zonedDayOfWeek(ctx.todayISO)];
  return answer(
    "hours",
    [
      text(
        today
          ? `${v.name} is open today, ${describeWindow(v.hours[day])}.`
          : `${v.name} is closed today.`,
      ),
      ...weekBlocks(v),
      ...(v.hoursText ? [note(v.hoursText)] : []),
    ],
    [venueChip(v), { label: "What is free today?", ask: `what is free at ${v.name} today` }],
    { venueIds: [v.id] },
  );
}

export function resolveAmenities(ctx: Ctx): Answer {
  const v = requireVenue(ctx);
  if ("intent" in v) return v;
  const groups: AnswerRow[] = [];
  if (v.amenities.length) groups.push({ title: "Amenities", detail: v.amenities.join(", ") });
  if (v.facilityServices.length)
    groups.push({ title: "Facility services", detail: v.facilityServices.join(", ") });
  if (v.foodBeverages.length)
    groups.push({ title: "Food & drinks", detail: v.foodBeverages.join(", ") });
  const courtAmenities = [...new Set(v.courts.flatMap((c) => c.amenities))];
  if (courtAmenities.length)
    groups.push({ title: "On the courts", detail: courtAmenities.join(", ") });

  if (groups.length === 0) {
    return answer(
      "amenities",
      [text(`${v.name} has not listed any amenities yet.`)],
      [venueChip(v)],
      { venueIds: [v.id] },
    );
  }
  return answer(
    "amenities",
    [
      text(`What ${v.name} lists:`),
      rows(groups),
      ...(v.rules ? [note(`House rules: ${v.rules}`)] : []),
    ],
    [venueChip(v)],
    { venueIds: [v.id] },
  );
}

export function resolvePayment(ctx: Ctx): Answer {
  const v = requireVenue(ctx);
  if ("intent" in v) return v;
  const online = v.paymentMode && v.paymentMode !== "none";
  const blocks: AnswerBlock[] = [
    text(
      online
        ? `${v.name} takes online payment${v.paymentMode === "full" ? " in full when you book" : ""}, through PayMongo — GCash, Maya, GrabPay or a card.`
        : `${v.name} does not take online payment. You reserve here and settle at the venue.`,
    ),
  ];
  if (v.fees.length > 0) {
    blocks.push(rows(v.fees.map((f) => ({ title: f.label, detail: peso(Number(f.amount)) }))));
  }
  if (v.feesNotes) blocks.push(note(v.feesNotes));
  const voucherCourts = v.courts.filter((c) => c.voucherEnabled);
  if (voucherCourts.length > 0)
    blocks.push(note(`Vouchers are accepted on ${voucherCourts.map((c) => c.name).join(", ")}.`));

  return answer(
    "payment",
    blocks,
    [venueChip(v), { label: "Refund rules", ask: `refund policy at ${v.name}` }],
    { venueIds: [v.id] },
  );
}

export function resolveRefund(ctx: Ctx): Answer {
  const v = requireVenue(ctx);
  if ("intent" in v) return v;
  const h = v.refundCutoffHours;
  const blocks: AnswerBlock[] = [
    text(
      h > 0
        ? `At ${v.name} you can cancel for a refund up to ${h} hour${h === 1 ? "" : "s"} before your slot starts. Inside ${h} hour${h === 1 ? "" : "s"}, the booking is no longer refundable.`
        : `${v.name} has not set a refund window, so cancellations are settled with the venue directly.`,
    ),
  ];
  if (v.cancellationNotes) blocks.push(note(v.cancellationNotes));
  if (v.paymentMode === "none") {
    blocks.push(note("Nothing is charged online here, so cancelling costs you nothing up front."));
  }
  return answer(
    "refund",
    blocks,
    [venueChip(v), { label: "How do I pay?", ask: `payment methods at ${v.name}` }],
    { venueIds: [v.id] },
  );
}

export function resolveVenueInfo(ctx: Ctx): Answer {
  const v = requireVenue(ctx);
  if ("intent" in v) return v;
  const sports = [...new Set(v.courts.map((c) => c.sport).filter(Boolean))];
  const cheapest = v.courts.length > 0 ? Math.min(...v.courts.map((c) => c.minRate)) : null;
  const detail: AnswerRow[] = [
    { title: "Address", detail: v.address || "Not listed" },
    {
      title: "Courts",
      detail: v.courts.length === 0 ? "None listed" : `${v.courts.length} · ${sports.join(", ")}`,
    },
  ];
  if (cheapest != null) detail.push({ title: "From", detail: `${peso(cheapest)} per hour` });
  if (v.contactPhone) detail.push({ title: "Phone", detail: v.contactPhone });
  if (v.contactEmail) detail.push({ title: "Email", detail: v.contactEmail });

  return answer(
    "venue_info",
    [text(v.description ? `${v.name} — ${v.description}` : v.name), rows(detail)],
    [
      venueChip(v),
      { label: "Opening hours", ask: `opening hours at ${v.name}` },
      { label: "Amenities", ask: `amenities at ${v.name}` },
    ],
    { venueIds: [v.id] },
  );
}

/* ---------------------------------------------------------------- *
 * Tenant
 * ---------------------------------------------------------------- */

/** Free hours across every venue the manager is staff on. */
export async function resolveMySchedule(ctx: Ctx): Promise<Answer> {
  const { catalog, parsed, nowMs, todayISO } = ctx;
  if (catalog.venues.length === 0) {
    return answer("my_schedule", [text("You are not listed as staff on any venue yet.")], []);
  }
  const dateISO = parsed.when.dateISO;
  const day = dateLabel(dateISO, todayISO);
  const band = parsed.when.hours.length > 0 ? new Set(parsed.when.hours) : null;

  const perVenue = await Promise.all(
    catalog.venues.slice(0, BROAD_VENUE_LIMIT).map(async (v) => {
      if (!isOpenOnDate(v, dateISO))
        return { v, closed: true, free: [] as SlotInfo[], courtIds: [] as number[] };
      const courts = courtsOf(v, parsed.sportSlug).slice(0, COURT_LIMIT);
      const per = await Promise.all(courts.map((c) => courtDaySlots(c, v, dateISO, nowMs)));
      const free = per
        .flatMap((slots) => freeHours(slots))
        .filter((s) => !band || band.has(s.hour));
      return { v, closed: false, free, courtIds: courts.map((c) => c.id) };
    }),
  );

  return answer(
    "my_schedule",
    [
      text(`Your venues, ${band ? parsed.when.label : day}:`),
      rows(
        perVenue.map(({ v, closed, free }) => ({
          title: v.name,
          detail: closed
            ? "Closed."
            : free.length === 0
              ? "Fully booked."
              : `${free.length} free hour${free.length === 1 ? "" : "s"} — ${joinHours([...new Set(free.map((s) => fmtHour(s.hour)))], 5)}.`,
          tone: closed ? "off" : free.length === 0 ? "warn" : "ok",
          nav: { kind: "venue", id: v.id },
        })),
      ),
    ],
    [{ label: "How booked am I?", ask: `occupancy ${day}` }],
    { venueIds: perVenue.map((p) => p.v.id), courtIds: perVenue.flatMap((p) => p.courtIds) },
  );
}

/** Occupancy: booked hours against bookable hours, per venue. */
export async function resolveMyOccupancy(ctx: Ctx): Promise<Answer> {
  const { catalog, parsed, nowMs, todayISO } = ctx;
  if (catalog.venues.length === 0) {
    return answer("my_occupancy", [text("You are not listed as staff on any venue yet.")], []);
  }
  const dateISO = parsed.when.dateISO;
  const day = dateLabel(dateISO, todayISO);

  const perVenue = await Promise.all(
    catalog.venues.slice(0, BROAD_VENUE_LIMIT).map(async (v) => {
      const courts = courtsOf(v, parsed.sportSlug).slice(0, COURT_LIMIT);
      const per = await Promise.all(courts.map((c) => courtDaySlots(c, v, dateISO, nowMs)));
      const all = per.flat();
      /* Past hours are neither booked nor winnable, so counting them as either
         would make every evening look worse than it was. */
      const live = all.filter((s) => s.state !== "past" && s.state !== "blocked");
      const taken = live.filter(
        (s) => s.state === "booked" || s.state === "hold" || s.state === "other_sport",
      );
      return { v, total: live.length, taken: taken.length, courtIds: courts.map((c) => c.id) };
    }),
  );

  return answer(
    "my_occupancy",
    [
      text(`Occupancy ${day}, counting only hours still ahead:`),
      rows(
        perVenue.map(({ v, total, taken }) => ({
          title: v.name,
          detail:
            total === 0
              ? "No bookable hours left today."
              : `${taken} of ${total} hours taken (${Math.round((taken / total) * 100)}%).`,
          tone: total === 0 ? "off" : taken / total > 0.8 ? "ok" : "warn",
          nav: { kind: "venue", id: v.id },
        })),
      ),
    ],
    [{ label: "What is still free?", ask: `what is free ${day}` }],
    { venueIds: perVenue.map((p) => p.v.id), courtIds: perVenue.flatMap((p) => p.courtIds) },
  );
}

/* ---------------------------------------------------------------- *
 * Conversation
 * ---------------------------------------------------------------- */

const PLAYER_EXAMPLES = [
  "what is open tonight",
  "cheapest badminton court per hour",
  "is court 1 free tomorrow 7pm",
  "courts near me",
  "refund policy",
];

const TENANT_EXAMPLES = [
  "what is free at my venue tomorrow",
  "how booked am I tonight",
  "cheapest court I offer",
  "my refund rules",
];

export function resolveHelp(ctx: Ctx): Answer {
  const examples = ctx.ask.role === "tenant" ? TENANT_EXAMPLES : PLAYER_EXAMPLES;
  return answer(
    "help",
    [
      text(
        "I answer from this system's own data — opening hours, live court availability, rates, distance, payment and refund rules. I do not guess: if it is not in the system, I will say so.",
      ),
      rows(examples.map((e) => ({ title: e }))),
    ],
    examples.slice(0, 3).map((e) => ({ label: e, ask: e })),
  );
}

export function resolveGreeting(ctx: Ctx): Answer {
  const n = ctx.catalog.venues.length;
  const examples = ctx.ask.role === "tenant" ? TENANT_EXAMPLES : PLAYER_EXAMPLES;
  return answer(
    "greeting",
    [
      text(
        ctx.ask.role === "tenant"
          ? `Hello. I can see ${n} venue${n === 1 ? "" : "s"} you manage. Ask me about your schedule, your rates or your rules.`
          : `Hi. I know ${n} venue${n === 1 ? "" : "s"} — their hours, live court availability, rates and where they are.`,
      ),
    ],
    examples.slice(0, 3).map((e) => ({ label: e, ask: e })),
  );
}

export function resolveUnknown(ctx: Ctx): Answer {
  const examples = ctx.ask.role === "tenant" ? TENANT_EXAMPLES : PLAYER_EXAMPLES;
  const guess = ctx.parsed.venue;
  const blocks: AnswerBlock[] = [];

  /* Being told "I don't understand" is useless. Being told which single word was
     the problem, and what can still be done, is not. */
  if (ctx.parsed.unknownSport) {
    const suggestion = suggestSport(ctx.parsed.unknownSport, ctx.catalog);
    blocks.push(
      text(`CourtHub does not have a sport called "${ctx.parsed.unknownSport}".`),
      note(
        suggestion
          ? `Did you mean ${suggestion}? I can also list every sport CourtHub covers.`
          : `The sports currently listed are ${ctx.catalog.sports.map((s) => s.name).join(", ") || "none yet"}.`,
      ),
    );
    return answer("unknown", blocks, [
      ...(suggestion ? [{ label: `Show ${suggestion}`, ask: `${suggestion} courts tonight` }] : []),
      { label: "What is available tonight?", ask: "what is available tonight" },
    ]);
  }

  if (ctx.parsed.unknownAmenity) {
    blocks.push(
      text(
        `I do not recognise "${ctx.parsed.unknownAmenity}" as a CourtHub amenity, so I cannot filter on it.`,
      ),
      note("I can still show venues and what each one lists."),
    );
    return answer("unknown", blocks, [
      { label: "Show venues near me", action: "locate" },
      { label: "What is available tonight?", ask: "what is available tonight" },
    ]);
  }

  blocks.push(
    text(
      ctx.ask.role === "tenant"
        ? "I can check your venues: what is free, how booked you are, cancellations, payments and your rates."
        : "I can check live court availability, prices, venues near you, opening hours, amenities, payment methods, refund rules and your own bookings.",
    ),
  );
  if (guess) note(`I did recognise ${guess.name}.`);

  return answer(
    "unknown",
    blocks,
    guess
      ? [
          { label: `Hours at ${guess.name}`, ask: `opening hours at ${guess.name}` },
          { label: `What is free at ${guess.name}`, ask: `what is free at ${guess.name} today` },
        ]
      : examples.slice(0, 3).map((e) => ({ label: e, ask: e })),
  );
}
