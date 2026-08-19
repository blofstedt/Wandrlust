/**
 * What the app can work out about a coordinate without asking a human.
 *
 * Two jobs, one Overpass round trip:
 *
 *   1. BUILD A NAME. Not invent one — build it, from the nearest named thing
 *      OpenStreetMap already knows about plus what kind of place this is.
 *      "Manti-La Sal National Forest Pullout", "Moab Rest Area".
 *
 *   2. SWEEP FOR FACILITIES within 5 km — showers, restrooms, fuel — so the
 *      report form can skip the questions it can already answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO LANGUAGE MODEL IN HERE
 * ---------------------------------------------------------------------------
 *
 * Generating the name with an LLM was considered and rejected. A model would
 * add an API key, a per-request cost, a second or two of latency, and — the
 * part that actually rules it out — the ability to produce a confident name
 * for a place it knows nothing about. "Sunset Ridge Dispersed Camping" is a
 * lovely name and a liability if there is no ridge and no sunset, because a
 * camper reads a name as a claim about the place.
 *
 * Everything below is a lookup and a string join. It can return nothing, which
 * is an honest outcome the caller handles; it cannot return something made up.
 * That trade is the whole reason this file is boring.
 *
 * Nothing here throws. Every export resolves to a result object.
 */
import { metresBetween } from './beaconSources.js';
import { USER_AGENT } from './alertSources.js';

/* One User-Agent for the whole server, with a contact somebody can
   actually reach. See USER_AGENT in alertSources.ts. */
const UA = USER_AGENT;

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

/** How far out we look for facilities. Mirrored by POI_RADIUS_M on the client. */
export const POI_RADIUS_M = 5000;

/**
 * How far out "what am I standing on" reaches.
 *
 * One constant for both halves on purpose. The query asked within 150 m
 * while the classification loop below accepted anything within 200 m, so
 * the band between the two could only ever be filled by a feature some
 * other query happened to return — a gap that is invisible until you
 * wonder why a pullout 180 m away never named anything.
 */
const SITE_RADIUS_M = 200;

/** How far out we look for something to name the place after. */
const NAME_RADIUS_M = 3000;

/** How far out we look for the nearest town. Rural gaps get wide. */
const TOWN_RADIUS_M = 25000;

export type PoiKind = 'shower' | 'restroom' | 'fuel';

export interface NearbyPoi {
  kind: PoiKind;
  name: string;
  metresAway: number;
}

export interface SpotContextResult {
  ok: boolean;
  name: string;
  nameBasis?: string;
  nearestTown?: string;
  pois: NearbyPoi[];
  poiLookupFailed: boolean;
  note?: string;
}

interface OverpassElement {
  type: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const centreOf = (el: OverpassElement): [number, number] | null => {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  return typeof lat === 'number' && typeof lon === 'number' ? [lat, lon] : null;
};

/* ------------------------------------------------------------------ */
/* Title case                                                          */
/* ------------------------------------------------------------------ */

/**
 * Small words stay lowercase unless they lead.
 *
 * OSM names arrive in every case convention there is — "BUREAU OF LAND
 * MANAGEMENT", "gemini bridges", "Rest Area". Left alone they make the map
 * look like it was assembled by three different people, which is precisely the
 * complaint this whole change exists to fix.
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'de', 'del', 'des', 'du', 'for',
  'in', 'la', 'las', 'le', 'los', 'nor', 'of', 'on', 'or', 'the', 'to', 'via'
]);

/** Acronyms that must stay shouting. */
const KEEP_UPPER = new Set(['BLM', 'USFS', 'NF', 'SP', 'NP', 'RV', 'ATV', 'OHV', 'US', 'USA']);

export const titleCase = (input: string): string => {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return words
    .map((word, i) => {
      const bare = word.replace(/[^a-z0-9]/gi, '');
      if (KEEP_UPPER.has(bare.toUpperCase())) return bare.toUpperCase();
      if (i > 0 && i < words.length - 1 && MINOR_WORDS.has(word)) return word;

      // Hyphenated and apostrophed parts each get their own capital:
      // "manti-la sal" → "Manti-La Sal", "o'brien" → "O'Brien".
      return word.replace(/(^|[-'’])([a-z])/g, (_m, sep, letter) => sep + letter.toUpperCase());
    })
    .join(' ');
};

/* ------------------------------------------------------------------ */
/* The query                                                           */
/* ------------------------------------------------------------------ */

const buildQuery = (lat: number, lon: number): string => {
  const at = (r: number) => `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;

  // Facilities. `amenity=shower` is rare in the wild, so campgrounds and
  // sports centres tagged `shower=yes` count too — a camper does not care
  // which OSM tag got used, only whether they can get clean.
  const pois = [
    `node["amenity"="shower"]${at(POI_RADIUS_M)};`,
    `way["amenity"="shower"]${at(POI_RADIUS_M)};`,
    `node["shower"="yes"]${at(POI_RADIUS_M)};`,
    `way["shower"="yes"]${at(POI_RADIUS_M)};`,
    `node["amenity"="toilets"]${at(POI_RADIUS_M)};`,
    `way["amenity"="toilets"]${at(POI_RADIUS_M)};`,
    `node["amenity"="fuel"]${at(POI_RADIUS_M)};`,
    `way["amenity"="fuel"]${at(POI_RADIUS_M)};`
  ].join('');

  // Things worth naming a spot after, nearest wins.
  const named = [
    `way["boundary"="protected_area"]["name"]${at(NAME_RADIUS_M)};`,
    `relation["boundary"="protected_area"]["name"]${at(NAME_RADIUS_M)};`,
    `way["leisure"~"^(park|nature_reserve)$"]["name"]${at(NAME_RADIUS_M)};`,
    `node["natural"~"^(peak|ridge|spring|water)$"]["name"]${at(NAME_RADIUS_M)};`,
    `way["waterway"~"^(river|stream)$"]["name"]${at(NAME_RADIUS_M)};`,
    `way["highway"="rest_area"]["name"]${at(NAME_RADIUS_M)};`,
    `node["tourism"="camp_site"]["name"]${at(NAME_RADIUS_M)};`
  ].join('');

  // What kind of place the coordinate itself sits on. Tight radius — this is
  // "what am I standing on", not "what is in the area".
  const here = [
    `node["amenity"~"^(parking|parking_space)$"]${at(SITE_RADIUS_M)};`,
    `way["amenity"~"^(parking|parking_space)$"]${at(SITE_RADIUS_M)};`,
    `way["highway"~"^(rest_area|services|track|unclassified|service)$"]${at(SITE_RADIUS_M)};`,
    `node["highway"~"^(passing_place|turning_circle)$"]${at(SITE_RADIUS_M)};`,
    `node["tourism"="camp_site"]${at(SITE_RADIUS_M)};`,
    `way["tourism"="camp_site"]${at(SITE_RADIUS_M)};`
  ].join('');

  const towns = `node["place"~"^(city|town|village|hamlet)$"]["name"]${at(TOWN_RADIUS_M)};`;

  return `[out:json][timeout:12];(${pois}${named}${here}${towns});out center tags;`;
};

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const poiKindOf = (tags: Record<string, string>): PoiKind | null => {
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'shower' || tags.shower === 'yes') return 'shower';
  if (tags.amenity === 'toilets') return 'restroom';
  return null;
};

/** A readable fallback when a facility has no name, which most do not. */
const POI_FALLBACK: Record<PoiKind, string> = {
  shower: 'Shower',
  restroom: 'Restroom',
  fuel: 'Gas station'
};

/**
 * What kind of place this is, in a camper's words.
 *
 * Ordered most specific first — a campsite that is also tagged as parking
 * should read "Campsite", not "Parking".
 */
const placeKind = (tags: Record<string, string>): string | null => {
  if (tags.tourism === 'camp_site') return 'Campsite';
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'Rest Area';
  if (tags.highway === 'passing_place') return 'Passing Place';
  if (tags.highway === 'turning_circle') return 'Turnaround';
  if (tags.highway === 'track') return 'Track Pullout';
  if (tags.amenity === 'parking' || tags.amenity === 'parking_space') return 'Pullout';
  if (tags.highway === 'unclassified' || tags.highway === 'service') return 'Roadside Spot';
  return null;
};

/**
 * The land agency, from the operator tag, shortened.
 *
 * Only used as a naming ingredient. The authoritative land-ownership answer
 * comes from `boundaryService` on the client and is not this file's business.
 */
const agencyShort = (tags: Record<string, string>): string | null => {
  const operator = (tags.operator ?? '').toLowerCase();
  if (!operator) return null;
  if (operator.includes('bureau of land management') || operator === 'blm') return 'BLM';
  if (operator.includes('forest service')) return 'National Forest';
  if (operator.includes('national park')) return 'National Park';
  if (operator.includes('state park')) return 'State Park';
  return null;
};

/** Names longer than this get unreadable on a map pin and in a list row. */
const MAX_NAME = 46;

/* ------------------------------------------------------------------ */

export const fetchSpotContext = async (
  lat: number,
  lon: number,
  timeoutMs = 12_000
): Promise<SpotContextResult> => {
  const query = buildQuery(lat, lon);

  let elements: OverpassElement[] | null = null;

  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { elements?: unknown };
      if (!Array.isArray(data?.elements)) continue;

      elements = data.elements as OverpassElement[];
      break;
    } catch {
      // Next mirror. Only every mirror failing is an outage.
    } finally {
      clearTimeout(timer);
    }
  }

  if (!elements) {
    /**
     * The honest failure. `poiLookupFailed` is what stops the report sheet
     * from telling a camper "no restroom nearby" when the truth is "we could
     * not check" — it makes the sheet ask instead.
     */
    return {
      ok: false,
      name: '',
      pois: [],
      poiLookupFailed: true,
      note: 'Could not reach OpenStreetMap, so nothing could be looked up here.'
    };
  }

  /* ---- Facilities: nearest of each kind ---- */
  const bestPoi = new Map<PoiKind, NearbyPoi>();

  for (const el of elements) {
    const tags = el.tags ?? {};
    const kind = poiKindOf(tags);
    if (!kind) continue;

    const centre = centreOf(el);
    if (!centre) continue;

    const metresAway = Math.round(metresBetween(lat, lon, centre[0], centre[1]));
    if (metresAway > POI_RADIUS_M) continue;

    const existing = bestPoi.get(kind);
    if (existing && existing.metresAway <= metresAway) continue;

    bestPoi.set(kind, {
      kind,
      name: tags.name ? titleCase(tags.name) : POI_FALLBACK[kind],
      metresAway
    });
  }

  /* ---- The name ---- */
  let kindHere: string | null = null;
  let agency: string | null = null;
  let nearestNamed: { name: string; metres: number } | null = null;
  let nearestTown: { name: string; metres: number } | null = null;

  for (const el of elements) {
    const tags = el.tags ?? {};
    const centre = centreOf(el);
    if (!centre) continue;
    const metres = metresBetween(lat, lon, centre[0], centre[1]);

    // What we are standing on.
    if (metres <= SITE_RADIUS_M) {
      kindHere = kindHere ?? placeKind(tags);
    }

    // Towns.
    if (tags.place && tags.name && metres <= TOWN_RADIUS_M) {
      if (!nearestTown || metres < nearestTown.metres) {
        nearestTown = { name: titleCase(tags.name), metres };
      }
      continue;
    }

    // Something to name it after. Facilities are excluded — "Chevron Pullout"
    // names the spot after a petrol station a mile away, which is worse than
    // no name at all.
    if (tags.name && !poiKindOf(tags) && metres <= NAME_RADIUS_M) {
      agency = agency ?? agencyShort(tags);
      if (!nearestNamed || metres < nearestNamed.metres) {
        nearestNamed = { name: titleCase(tags.name), metres };
      }
    }
  }

  /**
   * Assemble. Named land wins over the town, because "Gemini Bridges Pullout"
   * tells a camper where they are and "Moab Pullout" could be any of two
   * hundred places within an hour's drive.
   */
  const anchor = nearestNamed?.name ?? nearestTown?.name ?? null;
  const kind = kindHere ?? 'Dispersed Spot';

  let name = '';
  let nameBasis: string | undefined;

  if (anchor) {
    // Do not repeat a word the anchor already carries: "Willow Springs
    // Campsite Campsite" is exactly the sort of thing that looks generated.
    const anchorLower = anchor.toLowerCase();
    const kindWords = kind.toLowerCase().split(' ');
    const repeats = kindWords.some((w) => anchorLower.includes(w));

    name = repeats ? anchor : `${anchor} ${kind}`;

    // The agency is a nice-to-have, dropped first when space runs out.
    if (agency && !name.toUpperCase().includes(agency.toUpperCase())) {
      const withAgency = repeats ? `${anchor} ${agency}` : `${anchor} ${agency} ${kind}`;
      if (withAgency.length <= MAX_NAME) name = withAgency;
    }

    nameBasis = nearestNamed
      ? `Named after ${nearestNamed.name}, the closest named land on OpenStreetMap.`
      : `Named after ${nearestTown?.name}, the nearest town.`;
  } else {
    // Nothing named anywhere near. Rather than invent something evocative,
    // say what it is and let the coordinates do the identifying.
    name = kind;
    nameBasis = 'Nothing named nearby on OpenStreetMap, so this is just what it is.';
  }

  if (name.length > MAX_NAME) name = `${name.slice(0, MAX_NAME - 1).trimEnd()}…`;

  return {
    ok: true,
    name,
    nameBasis,
    nearestTown: nearestTown?.name,
    pois: [...bestPoi.values()].sort((a, b) => a.metresAway - b.metresAway),
    poiLookupFailed: false
  };
};
