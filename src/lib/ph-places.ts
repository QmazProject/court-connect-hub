/**
 * Philippine place lookup on top of OpenStreetMap Nominatim.
 *
 * Nominatim is a free, shared service. Its usage policy is respected here by:
 *  - serialising requests with at least `MIN_REQUEST_INTERVAL_MS` between them,
 *  - caching responses so repeated/edited queries do not re-hit the API,
 *  - keeping `limit` modest and sending `countrycodes=ph`,
 *  - identifying the app via the browser's automatic Referer header (browsers
 *    forbid setting User-Agent from fetch; callers on Node should set one).
 *
 * What this module does NOT do: guarantee that every Philippine place exists.
 * Coverage is whatever OpenStreetMap contains. This code improves *recall and
 * ranking over that data*; it cannot invent places OSM has never mapped.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
/**
 * Photon is an OSM-backed *autocomplete* geocoder. Nominatim will not complete
 * partial business names — "SM Seaside" returns the road inside the mall, never
 * the mall — because it geocodes complete addresses rather than suggesting
 * as-you-type. Photon indexes the same OSM data for prefix search, so it is
 * used strictly as a fallback when Nominatim comes back empty or approximate.
 */
const PHOTON_ENDPOINT = "https://photon.komoot.io/api/";
/** Philippines bounding box, to keep Photon's unrestricted index in-country. */
const PH_BBOX = "116.9,4.6,126.6,21.1";
const MIN_REQUEST_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 120;

export type PhPlace = {
  id: string;
  /** Primary name, e.g. "Ayala Center Cebu". */
  label: string;
  /**
   * Full "Barangay · City · Province · Region" hierarchy. Retained for internal
   * use and debugging; suggestions render `display` instead.
   */
  context: string;
  /**
   * What the dropdown shows, e.g. "Looc, Dumanjug, Cebu" or "Cebu City".
   * Region is omitted unless it is the only thing separating two results.
   */
  display: string;
  /** `display` minus the leading label, so the UI can style the two halves. */
  displaySuffix: string;
  /** Friendly place type: Province, City, Barangay, Landmark, Road… */
  kind: string;
  lat: number;
  lng: number;
  /** Full Nominatim display_name, kept verbatim. */
  displayName: string;
  region?: string;
  province?: string;
  city?: string;
  barangay?: string;
  postcode?: string;
  /** Raw OSM classification, useful for debugging/analytics. */
  osmType?: string;
  osmId?: number;
  osmCategory?: string;
  osmValue?: string;
  /**
   * True only when a road is standing in for what looks like a place/landmark
   * query — i.e. we did not find the thing asked for. Callers should surface
   * this rather than present it as the intended location.
   */
  approximate: boolean;
  /**
   * How much of `score` came from the name matching the query (0 = the name
   * contributed nothing and the hit is riding on proximity alone).
   */
  nameScore: number;
  /** True when this hit came from a relaxed fallback query rather than the original. */
  viaFallback: boolean;
  score: number;
};

export type PhSearchResult = {
  results: PhPlace[];
  /** The string actually sent to Nominatim. */
  usedQuery: string;
  /** Set when normalisation rewrote the user's input (e.g. "QC"). */
  normalizedFrom?: string;
  /** True when the primary query was exhausted and a relaxed one was tried. */
  fallbackUsed: boolean;
  /** Human-readable explanation when the answer is not a clean exact match. */
  note?: string;
};

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/** Whole-string aliases, keyed by punctuation-stripped lowercase input. */
const FULL_ALIASES: Record<string, string> = {
  // Regions — Roman and Arabic numerals both appear in everyday use.
  "region i": "Ilocos Region",
  "region 1": "Ilocos Region",
  "region ii": "Cagayan Valley",
  "region 2": "Cagayan Valley",
  "region iii": "Central Luzon",
  "region 3": "Central Luzon",
  "region iv a": "Calabarzon",
  "region iva": "Calabarzon",
  "region 4a": "Calabarzon",
  "region iv b": "Mimaropa",
  "region ivb": "Mimaropa",
  "region 4b": "Mimaropa",
  "region iv": "Calabarzon",
  "region 4": "Calabarzon",
  "region v": "Bicol Region",
  "region 5": "Bicol Region",
  "region vi": "Western Visayas",
  "region 6": "Western Visayas",
  "region vii": "Central Visayas",
  "region 7": "Central Visayas",
  "region viii": "Eastern Visayas",
  "region 8": "Eastern Visayas",
  "region ix": "Zamboanga Peninsula",
  "region 9": "Zamboanga Peninsula",
  "region x": "Northern Mindanao",
  "region 10": "Northern Mindanao",
  "region xi": "Davao Region",
  "region 11": "Davao Region",
  "region xii": "Soccsksargen",
  "region 12": "Soccsksargen",
  "region xiii": "Caraga",
  "region 13": "Caraga",
  ncr: "Metro Manila",
  "national capital region": "Metro Manila",
  car: "Cordillera Administrative Region",
  barmm: "Bangsamoro Autonomous Region in Muslim Mindanao",
  armm: "Bangsamoro Autonomous Region in Muslim Mindanao",

  // Common city shorthands.
  qc: "Quezon City",
  gensan: "General Santos City",
  "gen santos": "General Santos City",
  "gen santos city": "General Santos City",
  cdo: "Cagayan de Oro",
  bgc: "Bonifacio Global City",
  "the fort": "Bonifacio Global City",
  bacoor: "Bacoor",
  samal: "Island Garden City of Samal",
  igacos: "Island Garden City of Samal",
};

/**
 * Token-level rewrites applied after full-alias matching. "barangay"/"brgy"
 * maps to empty because OSM stores the bare name ("Lahug", not "Barangay
 * Lahug"), so keeping the word actively hurts matching.
 */
const TOKEN_ALIASES: Record<string, string> = {
  barangay: "",
  brgy: "",
  bgy: "",
  brgys: "",
  sta: "santa",
  sto: "santo",
  mt: "mount",
  natl: "national",
  intl: "international",
  univ: "university",
  hosp: "hospital",
  paranaque: "parañaque",
  "las pinas": "las piñas",
};

/**
 * Fold a name for comparison: drop diacritics, punctuation and dash variants so
 * "Osmena" matches "Osmeña", "Cebu IT Park" matches "Cebu I.T. Park", and
 * "Mactan-Cebu" matches "Mactan–Cebu" (en dash).
 */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip punctuation/diacritic noise for alias matching only. */
function aliasKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .replace(/[-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonicalise a user query: expand well-known Philippine shorthands, fix
 * punctuation/casing noise, and rewrite "City of X" to "X City".
 */
export function normalizePhQuery(raw: string): { query: string; changed: boolean } {
  const original = raw.trim().replace(/\s+/g, " ");
  if (!original) return { query: "", changed: false };

  const key = aliasKey(original);
  if (FULL_ALIASES[key]) {
    const mapped = FULL_ALIASES[key];
    return { query: mapped, changed: aliasKey(mapped) !== key };
  }

  // Rewrite each comma-separated segment independently so
  // "QC, Metro Manila" and "City of Cebu, Cebu" both normalise.
  const segments = original.split(",").map((seg) => {
    const segKey = aliasKey(seg);
    if (FULL_ALIASES[segKey]) return FULL_ALIASES[segKey];

    // "City of Cebu" -> "Cebu City"; "Municipality of Dumanjug" -> "Dumanjug".
    const cityOf = segKey.match(/^city of (.+)$/);
    if (cityOf) return `${titleCase(cityOf[1])} City`;
    const muniOf = segKey.match(/^(?:municipality|province) of (.+)$/);
    if (muniOf) return titleCase(muniOf[1]);

    const tokens = segKey.split(" ").filter(Boolean);
    const rewritten = tokens.map((t) => TOKEN_ALIASES[t] ?? t).filter(Boolean);
    if (!rewritten.length) return "";
    // Only re-title-case when a token actually changed, so we do not mangle
    // deliberate capitalisation like "Mactan-Cebu".
    const tokensChanged = rewritten.some((t, i) => t !== tokens[i]);
    return tokensChanged ? titleCase(rewritten.join(" ")) : seg.trim();
  });

  const query = segments
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  return { query, changed: aliasKey(query) !== key };
}

function titleCase(s: string): string {
  return s.replace(/\b[\p{L}]/gu, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ *
 * Classification + ranking
 * ------------------------------------------------------------------ */

const KIND_BY_ADDRESSTYPE: Record<string, string> = {
  region: "Region",
  state: "Province",
  province: "Province",
  county: "Province",
  city: "City",
  town: "Town",
  municipality: "Municipality",
  village: "Village",
  hamlet: "Village",
  suburb: "Barangay",
  quarter: "Barangay",
  neighbourhood: "Barangay",
  island: "Island",
  road: "Road",
  highway: "Road",
  aeroway: "Airport",
  railway: "Station",
  amenity: "Landmark",
  shop: "Shop",
  commercial: "Landmark",
  building: "Building",
  tourism: "Landmark",
  leisure: "Landmark",
  office: "Office",
  healthcare: "Healthcare",
  industrial: "Industrial",
  residential: "Subdivision",
  landuse: "Area",
  place: "Place",
  man_made: "Landmark",
  natural: "Natural",
  waterway: "Waterway",
  harbour: "Port",
  port: "Port",
};

/**
 * OSM's `type` value is more specific than `addresstype`, so it gives a better
 * label for the POI categories people actually search for.
 */
const KIND_BY_OSM_VALUE: Record<string, string> = {
  school: "School",
  college: "School",
  university: "University",
  kindergarten: "School",
  hospital: "Hospital",
  clinic: "Clinic",
  doctors: "Clinic",
  pharmacy: "Pharmacy",
  townhall: "Government",
  government: "Government",
  public_building: "Government",
  courthouse: "Government",
  police: "Government",
  fire_station: "Government",
  post_office: "Government",
  aerodrome: "Airport",
  terminal: "Terminal",
  ferry_terminal: "Port",
  harbour: "Port",
  port: "Port",
  marina: "Port",
  bus_station: "Terminal",
  mall: "Mall",
  marketplace: "Market",
  supermarket: "Supermarket",
  stadium: "Stadium",
  sports_centre: "Sports Centre",
  pitch: "Sports Venue",
  park: "Park",
  church: "Church",
  place_of_worship: "Church",
  hotel: "Hotel",
  resort: "Resort",
  bank: "Bank",
  residential: "Subdivision",
  neighbourhood: "Subdivision",
  industrial: "Industrial",
};

const AREA_TYPES = new Set([
  "region",
  "state",
  "province",
  "county",
  "city",
  "town",
  "municipality",
  "village",
  "hamlet",
  "suburb",
  "quarter",
  "neighbourhood",
]);

const ROAD_TYPES = new Set(["road", "highway"]);

const STREET_HINT =
  /\b(street|st|road|rd|avenue|ave|highway|hwy|blvd|boulevard|drive|dr|lane|ln|corner|cor|extension|ext)\b/i;

/** Does the query read like the user is after a street/address? */
export function looksLikeStreetQuery(q: string): boolean {
  return STREET_HINT.test(q) || /\d+\s/.test(q.trim());
}

type NomRow = {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  display_name: string;
  name?: string;
  addresstype?: string;
  category?: string;
  class?: string;
  type?: string;
  importance?: number;
  address?: Record<string, string>;
  lat: string;
  lon: string;
};

/** Great-circle distance in km, for proximity-biased ranking. */
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildContext(
  label: string,
  a: Record<string, string>,
): {
  context: string;
  parts: Pick<PhPlace, "region" | "province" | "city" | "barangay" | "postcode">;
} {
  const barangay = a.suburb || a.quarter || a.neighbourhood || undefined;
  const city = a.city || a.town || a.municipality || a.village || undefined;
  // Nominatim maps PH provinces onto `state`. Highly urbanised cities sit
  // directly under the region and carry no `state` at all.
  const province = a.state || a.province || undefined;
  const region = a.region || undefined;
  const postcode = a.postcode || undefined;

  const seen = new Set([label.toLowerCase()]);
  const context = [barangay, city, province, region]
    .filter((v): v is string => !!v)
    .filter((v) => {
      const k = v.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(" · ");

  return { context, parts: { region, province, city, barangay, postcode } };
}

function toPlace(
  r: NomRow,
  query: string,
  viaFallback: boolean,
  near?: { lat: number; lng: number } | null,
): PhPlace {
  const addressType = (r.addresstype || r.type || "").toLowerCase();
  const label = (r.name || r.display_name.split(",")[0] || "").trim() || r.display_name;
  const a = r.address ?? {};
  const { context, parts } = buildContext(label, a);

  const nameFolded = fold(label);
  // Compare against the whole query *and* its first segment: in
  // "Poblacion, Dumanjug, Cebu" the place being named is only "Poblacion",
  // the rest is context that will be checked separately.
  const queryFolded = fold(query);
  const firstSegment = fold(query.split(",")[0] ?? query);

  const nameScore = (q: string) => {
    if (!q) return 0;
    if (nameFolded === q) return -100;
    if (nameFolded.startsWith(q)) return -50;
    if (nameFolded.includes(q)) return -20;
    const qTokens = q.split(" ").filter((t) => t.length > 2);
    const hit = qTokens.filter((t) => nameFolded.includes(t)).length;
    return qTokens.length ? -Math.round((hit / qTokens.length) * 25) : 0;
  };
  const nameMatch = Math.min(nameScore(queryFolded), nameScore(firstSegment));
  let score = nameMatch;

  // Reward hits whose administrative context also matches the trailing
  // segments, so "Lahug, Cebu City" prefers the Lahug that is in Cebu City.
  const contextTokens = query
    .split(",")
    .slice(1)
    .map((s) => fold(s))
    .filter(Boolean);
  if (contextTokens.length) {
    const haystack = fold(
      [a.city, a.town, a.municipality, a.state, a.region].filter(Boolean).join(" "),
    );
    const matched = contextTokens.filter((t) => haystack.includes(t)).length;
    score -= Math.round((matched / contextTokens.length) * 35);
  }

  if (AREA_TYPES.has(addressType)) score -= 30;
  if (addressType === "island") score -= 10;
  if (ROAD_TYPES.has(addressType) && !looksLikeStreetQuery(query)) score += 60;

  // Proximity to what the user is currently looking at. This is what makes
  // "looc" surface the Looc in Dumanjug when the map is over Dumanjug, the way
  // Google biases suggestions to the current viewport. It decays with distance
  // so far-away namesakes still appear, just lower down.
  if (near) {
    const d = haversineKm(near, { lat: Number(r.lat), lng: Number(r.lon) });
    score -= Math.round(70 * Math.exp(-d / 60));
  }

  // Nominatim's own prominence, as a tiebreaker only.
  score -= Math.round((r.importance ?? 0) * 20);

  return {
    id: String(r.place_id),
    label,
    context,
    // Administrative types win (a city named "Park" is still a city);
    // otherwise the specific OSM value beats the coarse addresstype.
    kind: AREA_TYPES.has(addressType)
      ? (KIND_BY_ADDRESSTYPE[addressType] ?? "Place")
      : (KIND_BY_OSM_VALUE[(r.type ?? "").toLowerCase()] ??
        KIND_BY_ADDRESSTYPE[addressType] ??
        (addressType ? "Landmark" : "Place")),
    lat: Number(r.lat),
    lng: Number(r.lon),
    displayName: r.display_name,
    ...parts,
    osmType: r.osm_type,
    osmId: r.osm_id,
    osmCategory: r.category ?? r.class,
    osmValue: r.type,
    approximate: ROAD_TYPES.has(addressType) && !looksLikeStreetQuery(query),
    nameScore: nameMatch,
    viaFallback,
    score,
    // Filled in by assignDisplayNames once the whole result list is known.
    display: label,
    displaySuffix: "",
  };
}

/* ------------------------------------------------------------------ *
 * Suggestion display — Google-Maps-style minimal context
 * ------------------------------------------------------------------ */

/**
 * Words that carry no distinguishing information when comparing a context part
 * against a place name, so "Cebu City" counts as already present in
 * "Ayala Center Cebu".
 */
const GENERIC_PLACE_WORDS = new Set([
  "city",
  "municipality",
  "province",
  "town",
  "of",
  "the",
  "poblacion",
]);

function distinctiveTokens(s: string): string[] {
  return fold(s)
    .split(" ")
    .filter((t) => t && !GENERIC_PLACE_WORDS.has(t));
}

/**
 * True when every distinguishing word of `part` already appears in the text we
 * are about to show, so repeating it adds nothing.
 */
function isRedundant(part: string, against: string[]): boolean {
  const tokens = distinctiveTokens(part);
  if (!tokens.length) return true;
  const shown = new Set(
    against
      .map((a) => fold(a))
      .join(" ")
      .split(" ")
      .filter(Boolean),
  );
  return tokens.every((t) => shown.has(t));
}

/** The default, shortest useful context: city then province, skipping repeats. */
function baseParts(p: PhPlace): string[] {
  const parts: string[] = [];
  if (p.city && !isRedundant(p.city, [p.label])) parts.push(p.city);
  if (p.province && !isRedundant(p.province, [p.label, ...parts])) parts.push(p.province);
  return parts;
}

function compose(label: string, parts: string[], kind?: string): string {
  const head = parts.length ? `${label}, ${parts.join(", ")}` : label;
  return kind ? `${head} (${kind})` : head;
}

/**
 * Assign each suggestion the shortest label that stays unambiguous *within this
 * result list*. Everything starts at city/province level with no region; only a
 * colliding group escalates, and only as far as it must — barangay, then
 * region, then the place type. This is why "Central Visayas" never appears for
 * a normal search but "Cebu (Island)" can still be told apart from "Cebu".
 */
function assignDisplayNames(places: PhPlace[]): PhPlace[] {
  const groups = new Map<string, PhPlace[]>();
  for (const p of places) {
    const key = compose(p.label, baseParts(p));
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }

  const withDisplay = new Map<PhPlace, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      withDisplay.set(group[0], compose(group[0].label, baseParts(group[0])));
      continue;
    }

    // Progressively richer variants; take the first that separates the group.
    // `i` is the rank within the group, so the strongest match can stay bare
    // while only its weaker namesakes carry a qualifier — "Cebu" and
    // "Cebu (Island)", the way Google leaves the prominent one unadorned.
    const variants: ((p: PhPlace, i: number) => string)[] = [
      (p) => compose(p.label, baseParts(p)),
      (p) =>
        compose(
          p.label,
          p.barangay && !isRedundant(p.barangay, [p.label])
            ? [p.barangay, ...baseParts(p)]
            : baseParts(p),
        ),
      (p) =>
        compose(
          p.label,
          p.region && !isRedundant(p.region, [p.label])
            ? [...baseParts(p), p.region]
            : baseParts(p),
        ),
      (p, i) => compose(p.label, baseParts(p), i === 0 ? undefined : p.kind),
      (p, i) =>
        compose(
          p.label,
          p.region ? [...baseParts(p), p.region] : baseParts(p),
          i === 0 ? undefined : p.kind,
        ),
    ];

    const chosen =
      variants.find((v) => new Set(group.map(v)).size === group.length) ??
      variants[variants.length - 1];
    group.forEach((p, i) => withDisplay.set(p, chosen(p, i)));
  }

  return places.map((p) => {
    const display = withDisplay.get(p) ?? p.label;
    return {
      ...p,
      display,
      displaySuffix: display.startsWith(p.label) ? display.slice(p.label.length) : display,
    };
  });
}

/**
 * Collapse hits that are the same destination: same name within the same
 * city/province. Deliberately keyed on administrative area rather than
 * coordinates so that the five different "San Jose" municipalities survive
 * while a mall's dozen mapped nodes collapse to one.
 *
 * `kind` is deliberately NOT part of the key: OSM often carries one barangay as
 * both `village` and `suburb`, which would otherwise render as two identical
 * rows. Genuinely different places (Cebu the province vs Cebu City vs Cebu the
 * island) already differ in their administrative fields.
 */
function dedupe(places: PhPlace[]): PhPlace[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = [
      p.label.toLowerCase(),
      (p.city ?? "").toLowerCase(),
      (p.province ?? "").toLowerCase(),
      (p.region ?? "").toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Rate-limited, cached transport
 * ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; rows: NomRow[] }>();
let gate: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialise every outbound call and space them per Nominatim's policy. */
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  gate = run.catch(() => undefined);
  return run;
}

async function fetchRows(query: string, signal?: AbortSignal): Promise<NomRow[]> {
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: "30",
    addressdetails: "1",
    countrycodes: "ph",
    "accept-language": "en",
  });

  const rows = await schedule(async () => {
    const res = await fetch(`${ENDPOINT}?${params}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as NomRow[]) : [];
  });

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Build progressively looser variants of a query for fallback attempts. */
function relaxations(query: string): string[] {
  const out: string[] = [];
  const segs = query
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Drop the broadest trailing qualifier: "Poblacion, Dumanjug, Cebu" -> "Poblacion, Dumanjug".
  if (segs.length > 1) out.push(segs.slice(0, -1).join(", "));
  // Keep only the most specific part: "... " -> "Poblacion".
  if (segs.length > 2) out.push(segs[0]);
  // Shed generic suffixes that OSM often omits from the mapped name.
  const stripped = query.replace(/\b(city|municipality|province|barangay)\b/gi, "").trim();
  if (stripped && stripped.toLowerCase() !== query.toLowerCase()) out.push(stripped);

  return [...new Set(out)].filter((s) => s.length >= 3);
}

/**
 * Photon's `type` describes the feature's administrative level; translate it to
 * the Nominatim `addresstype` vocabulary so scoring, kind resolution and
 * display all keep working off a single representation.
 */
const PHOTON_TYPE_TO_ADDRESSTYPE: Record<string, string> = {
  country: "country",
  state: "region",
  county: "state",
  city: "city",
  district: "suburb",
  locality: "village",
  street: "road",
  house: "building",
};

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    type?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
};

/**
 * Photon's `type` is a coarse bucket and lies about POIs — it calls a shopping
 * mall a "locality", which would wrongly earn it the administrative-area
 * ranking bonus. Trust `type` only for genuine place/boundary features and
 * otherwise classify from the OSM tags, matching Nominatim's `addresstype`.
 */
function photonAddressType(p: NonNullable<PhotonFeature["properties"]>): string {
  const key = (p.osm_key ?? "").toLowerCase();
  const value = (p.osm_value ?? "").toLowerCase();
  const type = (p.type ?? "").toLowerCase();
  if (key === "highway") return "road";
  if (key === "place" || key === "boundary") return PHOTON_TYPE_TO_ADDRESSTYPE[type] ?? value;
  return value || PHOTON_TYPE_TO_ADDRESSTYPE[type] || "";
}

/**
 * Reshape a Photon feature into the Nominatim row shape. Everything downstream
 * — scoring, proximity, dedupe, display — then treats both sources identically.
 */
function photonToRow(f: PhotonFeature): NomRow | null {
  const p = f.properties ?? {};
  const coords = f.geometry?.coordinates;
  if (!coords || !p.name) return null;

  const addressType = photonAddressType(p);

  return {
    place_id: Number(p.osm_id ?? 0),
    osm_type: p.osm_type === "N" ? "node" : p.osm_type === "W" ? "way" : "relation",
    osm_id: p.osm_id,
    // Photon's county is the province and its state is the PH region.
    display_name: [p.name, p.district, p.city, p.county, p.state, "Philippines"]
      .filter(Boolean)
      .join(", "),
    name: p.name,
    addresstype: addressType,
    category: p.osm_key,
    type: p.osm_value,
    importance: 0,
    address: {
      ...(p.district ? { suburb: p.district } : {}),
      ...(p.city ? { city: p.city } : {}),
      ...(p.county ? { state: p.county } : {}),
      ...(p.state ? { region: p.state } : {}),
      ...(p.postcode ? { postcode: p.postcode } : {}),
    },
    lat: String(coords[1]),
    lon: String(coords[0]),
  };
}

/**
 * Query Photon for autocomplete-style matches. Shares the global rate-limit
 * gate and cache with Nominatim, and never throws — a failure here just means
 * the Nominatim result stands.
 */
async function fetchPhotonRows(
  query: string,
  signal?: AbortSignal,
  near?: { lat: number; lng: number } | null,
): Promise<NomRow[]> {
  const key = `photon:${query.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const params = new URLSearchParams({ q: query, limit: "15", lang: "en", bbox: PH_BBOX });
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lng));
  }

  let rows: NomRow[] = [];
  try {
    rows = await schedule(async () => {
      const res = await fetch(`${PHOTON_ENDPOINT}?${params}`, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { features?: PhotonFeature[] };
      return (json.features ?? [])
        .filter((f) => (f.properties?.countrycode ?? "PH").toUpperCase() === "PH")
        .map(photonToRow)
        .filter((r): r is NomRow => r !== null);
    });
  } catch {
    return [];
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/**
 * When the query names a place precisely, businesses that merely sit *inside*
 * that place should not crowd the list. Searching "Ayala Center Cebu" surfaces
 * KFC and McDonald's because they are metres from the map centre — their score
 * is almost entirely the proximity bonus, with the name contributing nothing.
 *
 * So: only when an exact/prefix match exists (the "anchor") do we push down
 * hits whose *name* barely matched. This is query-aware, not a business filter:
 * searching "KFC Cebu" produces no anchor (no result is named "KFC Cebu"), so
 * every KFC keeps its ranking. Demoted entries are pushed below, never removed.
 */
const ANCHOR_NAME_SCORE = -50; // exact or prefix match on the name
const WEAK_NAME_SCORE = -25; // worse than a substring match
const INSIDE_PENALTY = 80;

function demoteWeakNameMatches(places: PhPlace[]): PhPlace[] {
  const hasAnchor = places.some((p) => p.nameScore <= ANCHOR_NAME_SCORE);
  if (!hasAnchor) return places;
  return places
    .map((p) => (p.nameScore > WEAK_NAME_SCORE ? { ...p, score: p.score + INSIDE_PENALTY } : p))
    .sort((a, b) => a.score - b.score);
}

/** True when a ranked list contains something we would call a real match. */
function hasStrongMatch(places: PhPlace[]): boolean {
  const top = places[0];
  return !!top && !top.approximate && top.score <= -40;
}

export async function searchPhPlaces(
  rawQuery: string,
  opts: {
    signal?: AbortSignal;
    limit?: number;
    /** Bias results toward this point (typically the map's current centre). */
    near?: { lat: number; lng: number } | null;
  } = {},
): Promise<PhSearchResult> {
  const { signal, limit = 10, near } = opts;
  const { query, changed } = normalizePhQuery(rawQuery);
  if (query.length < 3) {
    return { results: [], usedQuery: query, fallbackUsed: false };
  }

  const rank = (rows: NomRow[], q: string, viaFallback: boolean) =>
    dedupe(rows.map((r) => toPlace(r, q, viaFallback, near)).sort((a, b) => a.score - b.score));

  const primary = rank(await fetchRows(query, signal), query, false);

  let results = primary;
  let fallbackUsed = false;
  let note: string | undefined;

  // Nominatim cannot complete partial names, so when it returns nothing solid
  // — or only a road standing in for a place — ask Photon, which indexes the
  // same OSM data for as-you-type search.
  if (!hasStrongMatch(primary) || primary[0]?.approximate) {
    const alt = rank(await fetchPhotonRows(query, signal, near), query, true);
    const best = alt[0];
    const beatsPrimary =
      !!best &&
      (!primary.length ||
        (primary[0].approximate && !best.approximate) ||
        best.score < primary[0].score);
    if (beatsPrimary) {
      results = dedupe([...alt, ...primary]).sort((a, b) => a.score - b.score);
      fallbackUsed = true;
      note = undefined;
    }
  }

  // Only reach for a looser query when the primary one genuinely under-delivers.
  if (!fallbackUsed && !hasStrongMatch(primary)) {
    for (const relaxed of relaxations(query)) {
      if (signal?.aborted) break;
      const alt = rank(await fetchRows(relaxed, signal), relaxed, true);
      if (!alt.length) continue;
      const better = !primary.length || (alt[0]?.score ?? 0) < (primary[0]?.score ?? 0);
      if (better) {
        results = dedupe([...alt, ...primary]).sort((a, b) => a.score - b.score);
        fallbackUsed = true;
        note = `No exact match for "${query}" — showing results for "${relaxed}".`;
        break;
      }
    }
  }

  if (!fallbackUsed && results[0]?.approximate) {
    note =
      "No landmark or place matched exactly; the closest road/area match is shown and marked approximate.";
  }
  if (!results.length) {
    note = `No Philippine location in OpenStreetMap matched "${query}".`;
  }

  return {
    results: assignDisplayNames(demoteWeakNameMatches(results).slice(0, limit)),
    usedQuery: query,
    normalizedFrom: changed ? rawQuery.trim() : undefined,
    fallbackUsed,
    note,
  };
}
