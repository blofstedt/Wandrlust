/**
 * What roads OpenStreetMap actually has near a point.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * A routing engine and the map underneath it do not see the same world. The
 * map draws every way OSM carries; the router drops the ones its profile has
 * no speed for, and — more often than not out here — keeps a track in its
 * graph but leaves it in a disconnected island it can never reach. Either way
 * the engine does the same thing: it snaps your destination onto whatever
 * piece of network it CAN reach, routes there, and says nothing.
 *
 * The visible result is a route that ends kilometres away, on the wrong side
 * of a ridge, while a perfectly ordinary forest road sits four hundred metres
 * from the pin — drawn on the very basemap the camper is looking at. "The road
 * mapping sucks, there are roads it isn't seeing" is exactly right, and the
 * router is never going to volunteer which ones.
 *
 * So this file asks OSM directly, and it exists to do two jobs:
 *
 *   1. GIVE THE ROUTER SOMEWHERE BETTER TO AIM. The nearest points on the
 *      nearest real roads become explicit waypoints to retry against, instead
 *      of leaving the choice to the engine's snapping.
 *
 *   2. SAY WHAT IS THERE EVEN WHEN NOTHING CAN BE ROUTED TO IT. "OpenStreetMap
 *      shows an unnamed track 300 m away, no router could find a way onto it"
 *      is a true and useful sentence. "The road ends 5.2 km short" on its own
 *      is true and useless.
 *
 * ---------------------------------------------------------------------------
 * THE THING IT WILL NOT DO
 * ---------------------------------------------------------------------------
 *
 * A road near the pin is a road near the pin. It is NOT a way in, not an
 * easement, not passable, not ungated, not legal to drive, and emphatically
 * not a route. Everything here is returned as a measured distance to a mapped
 * line, and every caller is expected to keep it phrased that way.
 *
 * Nothing throws. An Overpass outage comes back `ok: false` with no roads,
 * which callers treat as "we could not check" — never as "there is no road".
 */
import { metresBetween } from './beaconSources.js';
import { USER_AGENT } from './alertSources.js';

/* One User-Agent for the whole server, with a contact somebody can
   actually reach. See USER_AGENT in alertSources.ts. */
const UA = USER_AGENT;

/* overpass.osm.ch is deliberately absent: it is Switzerland-only and answers
   for other continents with a fast, confident zero. See the note on
   OVERPASS_MIRRORS in server/beaconSources.ts. */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/**
 * Roads a camper could conceivably arrive on.
 *
 * `track` leads deliberately — forest service roads, BLM two-tracks and the
 * spur you actually camp down are almost all tagged that way, and they are
 * precisely the class routing profiles throw away. Motorways and trunk roads
 * are excluded: nobody's approach to a dispersed site ends on an interstate,
 * and offering one as an "approach" would be worse than offering nothing.
 */
const DRIVEABLE =
  '^(track|unclassified|service|residential|living_street|tertiary|tertiary_link|' +
  'secondary|secondary_link|road)$';

/** How much of a way's shape we keep for drawing. Legible long before this. */
const MAX_LINE_POINTS = 220;

/** Two candidates closer together than this are the same approach. */
const CANDIDATE_SPACING_M = 300;

export interface ApproachRoad {
  /** OSM's name or ref, when it has one. Most tracks have neither. */
  name: string | null;
  /** The raw `highway` value — `track`, `service`, `unclassified`… */
  kind: string;
  /** Nearest point ON THE LINE to the point asked about. */
  lat: number;
  lon: number;
  /** Distance from the asked-about point to that nearest point, in km. */
  distanceKm: number;
  /** The stretch of the way near the point, for drawing. [lat, lon] pairs. */
  line: [number, number][];
  /**
   * True when OSM records something that stops a vehicle — a gate, a barrier,
   * seasonal access. Kept rather than filtered out, because "there is a road
   * and it has a gate on it" is more useful than silence.
   */
  gated: boolean;
}

export interface RoadScan {
  /** False means we could not check, which is not the same as "no roads". */
  ok: boolean;
  /** Nearest first. */
  roads: ApproachRoad[];
}

const EMPTY_SCAN: RoadScan = { ok: false, roads: [] };

interface OverpassWay {
  type: string;
  id?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Nearest point on a line, not nearest vertex                         */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS IS NOT JUST "CLOSEST VERTEX".
 *
 * Overpass returns a way as the points a mapper clicked, and on a road that
 * runs straight for two kilometres that can be two points. Measuring to the
 * nearer of those two answers "how far to the end of this road", which on a
 * long straight track can be over a kilometre out — while the road itself
 * passes a hundred metres from the pin. Projecting onto the SEGMENT gives the
 * distance a camper would actually walk, and gives the router a waypoint on
 * the road rather than at a bend somewhere up it.
 *
 * The projection is done in local metres — longitude scaled by cos(lat) — which
 * over a segment of road is exact enough that the error is far below the
 * precision anything downstream claims.
 */
const nearestOnSegment = (
  lat: number, lon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number
): { lat: number; lon: number } => {
  const kx = Math.cos((lat * Math.PI) / 180);
  const ax = (aLon - lon) * kx;
  const ay = aLat - lat;
  const bx = (bLon - lon) * kx;
  const by = bLat - lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  // A zero-length segment is a duplicated vertex; either end will do.
  if (lenSq === 0) return { lat: aLat, lon: aLon };

  // How far along AB the foot of the perpendicular falls, clamped to the
  // segment so a road that merely POINTS at the pin does not count as near it.
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));

  return { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t };
};

/** Does OSM record something on this way that stops a vehicle? */
const isGated = (tags: Record<string, string>): boolean =>
  tags.barrier === 'gate' ||
  tags.gate === 'yes' ||
  tags.access === 'permit' ||
  tags.access === 'destination' ||
  tags.motor_vehicle === 'permit' ||
  tags.motor_vehicle === 'destination' ||
  Boolean(tags.seasonal) ||
  tags.snowplowing === 'no';

/** Roads nobody may drive are not approaches, and are dropped outright. */
const isClosedToVehicles = (tags: Record<string, string>): boolean =>
  tags.access === 'private' || tags.access === 'no' ||
  tags.motor_vehicle === 'private' || tags.motor_vehicle === 'no' ||
  tags.vehicle === 'private' || tags.vehicle === 'no';

/**
 * Trim a way down to the stretch that matters.
 *
 * A 40 km forest road drawn end to end tells a camper nothing about the four
 * hundred metres they care about, and costs a few hundred kilobytes to say it.
 * Keep a window around the nearest vertex.
 */
const trimLine = (
  geometry: { lat: number; lon: number }[],
  nearIndex: number
): [number, number][] => {
  const half = Math.floor(MAX_LINE_POINTS / 2);
  const start = Math.max(0, nearIndex - half);
  return geometry
    .slice(start, start + MAX_LINE_POINTS)
    .map((p) => [p.lat, p.lon] as [number, number]);
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * Keyed on the destination alone, not the trip.
 *
 * Ten campers routing to the same pullout from ten towns all need the same
 * answer to "what roads are near it", and Overpass mirrors are a shared
 * resource that rate-limit people who forget that. Roads change on a timescale
 * of years, so six hours is conservative.
 */
interface CacheEntry { at: number; scan: RoadScan; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

/* ------------------------------------------------------------------ */

/**
 * Every driveable way OSM has within `radiusKm`, nearest point first.
 *
 * Candidates are spaced out: three points on the same long track are one
 * approach, and retrying a router against all three wastes the budget that
 * could have tried a genuinely different road.
 */
export const findApproachRoads = async (
  lat: number,
  lon: number,
  radiusKm: number,
  timeoutMs = 9_000
): Promise<RoadScan> => {
  const metres = Math.round(Math.max(0.3, Math.min(radiusKm, 8)) * 1000);
  // Three decimals is ~100 m — finer than the radius bucketing needs, coarse
  // enough that nudging a pin still hits the cache.
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${metres}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scan;

  const around = `(around:${metres},${lat.toFixed(5)},${lon.toFixed(5)})`;
  // `out geom` and not `out center`: a road is a line, and the centre of a
  // long forest road can be nowhere near the point that matters.
  const query =
    `[out:json][timeout:20];` +
    `way["highway"~"${DRIVEABLE}"]${around};` +
    `out geom 300;`;

  let ways: OverpassWay[] | null = null;

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

      ways = data.elements as OverpassWay[];
      break;
    } catch {
      // Next mirror. Only every mirror failing is an outage.
    } finally {
      clearTimeout(timer);
    }
  }

  // An outage is `ok: false`, never an empty-but-confident "no roads here".
  if (!ways) return EMPTY_SCAN;

  const found: ApproachRoad[] = [];

  for (const way of ways) {
    const tags = way.tags ?? {};
    const geometry = way.geometry ?? [];
    if (geometry.length < 2) continue;
    if (isClosedToVehicles(tags)) continue;

    let bestM = Infinity;
    let bestPoint: { lat: number; lon: number } | null = null;
    let bestIndex = 0;

    for (let i = 0; i < geometry.length - 1; i += 1) {
      const a = geometry[i];
      const b = geometry[i + 1];
      const point = nearestOnSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
      const m = metresBetween(lat, lon, point.lat, point.lon);
      if (m >= bestM) continue;
      bestM = m;
      bestPoint = point;
      bestIndex = i;
    }

    if (!bestPoint || bestM > metres) continue;

    found.push({
      name: tags.name?.trim() || tags.ref?.trim() || null,
      kind: tags.highway ?? 'road',
      lat: bestPoint.lat,
      lon: bestPoint.lon,
      distanceKm: Math.round((bestM / 1000) * 1000) / 1000,
      line: trimLine(geometry, bestIndex),
      gated: isGated(tags)
    });
  }

  found.sort((a, b) => a.distanceKm - b.distanceKm);

  // Thin out approaches that land on top of each other.
  const roads: ApproachRoad[] = [];
  for (const road of found) {
    const crowded = roads.some(
      (kept) => metresBetween(kept.lat, kept.lon, road.lat, road.lon) < CANDIDATE_SPACING_M
    );
    if (!crowded) roads.push(road);
    if (roads.length >= 8) break;
  }

  const scan: RoadScan = { ok: true, roads };

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), scan });

  return scan;
};
