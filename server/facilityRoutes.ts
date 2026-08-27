/**
 * /api/facilities — toilets, water, propane and the rest, from OpenStreetMap.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The phone used to ask Overpass itself, and it was the only thing in this app
 * that did. Everything else that reads OSM — the backroads layer, the road
 * network behind a spot's "could I drive here" — goes through the server. The
 * facility layer being the exception cost it three things, and the third is
 * the one that matters:
 *
 *   NO USER-AGENT. A browser cannot set one. Overpass asks for a descriptive
 *   agent in its usage policy and throttles anonymous traffic first, which is
 *   why every other caller here sends `USER_AGENT` and this one could not.
 *
 *   NO SHARED CACHE. Every phone paid for its own lookup of the same town.
 *   From here one answer serves everybody, at the edge as well as in memory.
 *
 *   A MIRROR THAT LIES BY OMISSION. The client's list ended with
 *   `overpass.osm.ch`, which this repo already documents twice — in
 *   `backroadRoutes.ts` and `roadNetwork.ts` — as Switzerland-only, answering
 *   for other continents with a fast, confident zero. When the two good
 *   mirrors were busy, which on a shared carrier IP is often, the Swiss one
 *   answered HTTP 200 with no elements, and the app drew that as a complete
 *   answer: "nobody has mapped toilets in this view", over a city full of
 *   them. That is the exact sentence this codebase forbids, arriving through a
 *   mirror list rather than through wording.
 *
 * So: same three mirrors as the backroads layer, same agent, same "an outage
 * is `ok: false`, never an empty answer" rule. What comes back is already
 * normalised — kind, name, position — so the phone does no tag archaeology.
 */
import type { Express, Request, Response } from 'express';
import { USER_AGENT } from './alertSources.js';
import { TtlCache } from '../shared/ttlCache.js';
import {
  selectorsFor, kindFromTags, isReachable
} from '../shared/facilityOsm.js';

/* Same three as `backroadRoutes.ts`, and NOT overpass.osm.ch — see above. */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/** How many we will hand over before the map becomes a wall of glyphs. */
const MAX_RESULTS = 250;

/**
 * The widest box worth asking about, in degrees.
 *
 * Overpass will refuse or time out on a continent, and a toilet drawn at
 * country zoom is a dot in the wrong state anyway. A box wider than this is
 * clamped around its centre and the answer is marked truncated, so the client
 * can say the screen holds more than is drawn.
 */
const MAX_BOX_DEGREES = 3.0;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface ApiFacility {
  id: string;
  kind: string;
  name: string | null;
  latitude: number;
  longitude: number;
  /** Opening hours as OSM records them, when it does. Never a promise. */
  hours: string | null;
  /** Whether OSM says it costs money. Absent far more often than not. */
  fee: boolean | null;
}

export interface FacilityScan {
  ok: boolean;
  facilities: ApiFacility[];
  truncated: boolean;
}

const EMPTY: FacilityScan = { ok: false, facilities: [], truncated: false };

/**
 * In-memory answers, keyed by the box and the kinds asked about.
 *
 * Ten minutes. A toilet does not appear or vanish faster than that, and on
 * Vercel this survives only as long as the warm function does — the real
 * caching is the `s-maxage` on the response, which is shared by everybody.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 120;
const cache = new TtlCache<FacilityScan>(CACHE_TTL_MS, CACHE_MAX);

const cacheGet = (key: string): FacilityScan | null => cache.get(key) ?? null;

const cacheSet = (key: string, scan: FacilityScan): void => {
  // Only real answers. Caching an outage turns a minute of Overpass being
  // busy into ten minutes of the map claiming there is nothing here.
  if (!scan.ok) return;
  cache.set(key, scan);
};

const parseKinds = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && /^[a-z_]+$/.test(k))
    .slice(0, 20);
};

/** Ask the mirrors in turn. Only every one of them failing is an outage. */
const askOverpass = async (
  query: string, timeoutMs: number
): Promise<OverpassElement[] | null> => {
  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { elements?: unknown };
      if (!Array.isArray(data?.elements)) continue;
      return data.elements as OverpassElement[];
    } catch {
      // Next mirror.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/** Turn Overpass elements into the flat shape the map draws. */
const normalise = (
  elements: OverpassElement[], wanted: Set<string>
): ApiFacility[] => {
  /* Keyed by id so a node and the way describing the same building do not both
     draw. OSM ids are unique per type, so the type is part of the key. */
  const found = new Map<string, ApiFacility>();

  for (const element of elements) {
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') continue;

    const tags = element.tags ?? {};
    const kind = kindFromTags(tags);
    /* A selector can drag in a neighbouring tag — `amenity=fuel` matches the
       propane query too. Only keep what was actually asked for. */
    if (!kind || !wanted.has(kind)) continue;
    if (!isReachable(tags)) continue;

    const id = `osm-${element.type}-${element.id}`;
    if (found.has(id)) continue;

    found.set(id, {
      id,
      kind,
      name: tags.name ?? null,
      latitude,
      longitude,
      hours: tags.opening_hours ?? null,
      fee: tags.fee === 'yes' ? true : tags.fee === 'no' ? false : null
    });
  }

  return [...found.values()];
};

const scanBox = async (
  south: number, west: number, north: number, east: number,
  kinds: string[], timeoutMs: number
): Promise<FacilityScan> => {
  const selectors = selectorsFor(kinds);
  if (selectors.length === 0) return { ok: true, facilities: [], truncated: false };

  /* Clamp around the centre rather than refusing outright: a slightly-too-big
     box still answers for the middle of the screen, which is where the camper
     is looking. Said out loud rather than drawn as if it were everything. */
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  const halfLat = Math.min((north - south) / 2, MAX_BOX_DEGREES / 2);
  const halfLon = Math.min((east - west) / 2, MAX_BOX_DEGREES / 2);
  const clamped =
    halfLat < (north - south) / 2 || halfLon < (east - west) / 2;

  const box = [
    (midLat - halfLat).toFixed(5), (midLon - halfLon).toFixed(5),
    (midLat + halfLat).toFixed(5), (midLon + halfLon).toFixed(5)
  ].join(',');

  const key = `${box}|${[...kinds].sort().join(',')}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const clauses = selectors.map((selector) => `${selector}(${box});`).join('');
  const query = `[out:json][timeout:20];(${clauses});out center ${MAX_RESULTS + 1};`;

  const elements = await askOverpass(query, timeoutMs);
  // An outage is `ok: false`. It is never an empty-but-confident answer.
  if (!elements) return EMPTY;

  const all = normalise(elements, new Set(kinds));
  const scan: FacilityScan = {
    ok: true,
    facilities: all.slice(0, MAX_RESULTS),
    truncated: clamped || all.length > MAX_RESULTS
  };
  cacheSet(key, scan);
  return scan;
};

export const registerFacilityRoutes = (app: Express): void => {
  /**
   * Every facility of the asked-for kinds inside a box.
   *
   *   /api/facilities?minLat=..&minLon=..&maxLat=..&maxLon=..&kinds=toilet,water
   *
   * A radius form is accepted too — `?lat=..&lon=..&radiusKm=..` — for the
   * "what is near this one spot" lookup on a dropped pin, which asks about a
   * circle rather than a screen. It is turned into a box here; Overpass is
   * asked once either way.
   */
  app.get('/api/facilities', async (req: Request, res: Response) => {
    const kinds = parseKinds(req.query.kinds);
    if (kinds.length === 0) {
      return res.status(400).json({
        ...EMPTY, message: 'kinds is required — a comma-separated list.'
      });
    }

    let south: number, west: number, north: number, east: number;

    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const radiusKm = Math.min(
        Math.max(parseFloat(req.query.radiusKm as string) || 5, 0.5),
        50
      );
      const dLat = radiusKm / 111;
      // Longitude degrees shrink towards the poles; at 60°N they are half a
      // degree of latitude, and a square box would be twice as wide as asked.
      const dLon = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.1));
      south = lat - dLat; north = lat + dLat;
      west = lon - dLon; east = lon + dLon;
    } else {
      const nums = ['minLat', 'minLon', 'maxLat', 'maxLon'].map((k) =>
        parseFloat(req.query[k] as string)
      );
      if (nums.some((n) => !Number.isFinite(n))) {
        return res.status(400).json({
          ...EMPTY,
          message: 'Give either lat/lon/radiusKm or minLat/minLon/maxLat/maxLon.'
        });
      }
      [south, west, north, east] = nums;
      if (north <= south || east <= west) {
        return res.status(400).json({ ...EMPTY, message: 'Box is inside out.' });
      }
    }

    // Ten seconds a mirror, three mirrors: inside Vercel's thirty-second cap
    // with room for the response, and somebody is watching a spinner.
    const scan = await scanBox(south, west, north, east, kinds, 10_000);

    /* Only a real answer is cached at the edge. A failed one gets `no-store`,
       so an Overpass outage lasting a minute does not become a day of every
       phone being told nobody has mapped a toilet here. */
    res.setHeader(
      'Cache-Control',
      scan.ok
        ? 'public, max-age=600, s-maxage=86400, stale-while-revalidate=86400'
        : 'no-store'
    );

    return res.json(scan);
  });
};
