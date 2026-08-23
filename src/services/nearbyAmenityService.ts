import { distanceKm, distanceToLineKm } from '../utils/geo';
import type { FacilityKind, MapFacility, NearbyFacility, NearbyFacilityKind } from '../types';
import { FACILITY, FACILITY_KINDS } from '../config/facilities';
import { TtlCache } from '../utils/ttlCache';

export { FACILITY_LABEL, FACILITY_GLYPH, FACILITY_COLOR } from '../config/facilities';

/**
 * The nearest toilet, shower, tap, dump station, fuel pump, trailhead,
 * fishing spot, boat ramp or bin to a spot.
 *
 * WHY OPENSTREETMAP. It is the only source covering the continental US and
 * Canada that is free to query, has no key, and lets anybody correct it. Every
 * commercial POI set that covers this ground either bans the use or bills per
 * lookup, and neither survives a camper opening the app with no signal budget.
 *
 * WHAT ITS COVERAGE ACTUALLY MEANS, because this is the part it would be easy
 * to lie about. A pit toilet on a forest road is mapped when a volunteer has
 * walked past it, and nowhere else. So:
 *
 *   something found  → somebody mapped one there, at some point. Not that it
 *                      is open, maintained, unlocked, or still standing.
 *   nothing found    → nobody has mapped one within the radius. NOT "there is
 *                      no toilet within 5 km" — the emptiest country is also
 *                      the least surveyed, which is exactly where a camper is.
 *
 * Both of those get said out loud wherever the results are drawn. Nothing here
 * ever returns a "no facilities" fact, only an empty list.
 *
 * Never throws: mirrors are tried in turn and a total failure is an empty
 * result with `ok: false`, which the UI shows as "couldn't check" rather than
 * as "nothing nearby".
 */

/**
 * The only Overpass call left in the browser: the road fallback below, for
 * when our own `/api/roads/nearest` cannot answer.
 *
 * `overpass.osm.ch` USED TO BE THE THIRD ENTRY AND IS NOT ANY MORE. It is
 * Switzerland-only — `server/backroadRoutes.ts` and `server/roadNetwork.ts`
 * both say so — and it answers for other continents with a fast, confident
 * zero. A mirror that returns HTTP 200 and nothing is worse than one that
 * fails: a failure is "couldn't check", and an empty success is this app
 * saying there is nothing there.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/**
 * How far out we look, in km.
 *
 * Five, because that is roughly the distance at which a camper stops thinking
 * "I'll walk over" and starts thinking "I'll drive in the morning", and both of
 * those are still the same spot's facilities. Past it they belong to the next
 * town and are not a property of where you are sleeping.
 */
export const FACILITY_RADIUS_KM = 5;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Every kind that OpenStreetMap can actually answer for. */
const OSM_KINDS = FACILITY_KINDS.filter((kind) => FACILITY[kind].osm.length > 0);

export interface NearbyFacilityResult {
  /** False when every mirror failed — "couldn't check", never "nothing here". */
  ok: boolean;
  /** The nearest of each kind found, closest kind first. At most one per kind. */
  facilities: NearbyFacility[];
}

const EMPTY: NearbyFacilityResult = { ok: false, facilities: [] };

/**
 * THE SHAPE THE SERVER HANDS BACK. See `server/facilityRoutes.ts`.
 */
interface ApiFacility {
  id: string;
  kind: string;
  name: string | null;
  latitude: number;
  longitude: number;
  hours: string | null;
  fee: boolean | null;
}

interface ApiFacilityScan {
  ok?: boolean;
  facilities?: ApiFacility[];
  truncated?: boolean;
}

/**
 * OUR OWN API, NOT OVERPASS — and this is the fix for "the toilets stopped
 * working".
 *
 * Asking Overpass from the phone was the only OSM read in this app that did
 * not go through the server, and it cost three things: no `User-Agent` (a
 * browser cannot set one, and Overpass throttles anonymous traffic first), no
 * cache anybody else benefits from, and a mirror list ending in
 * `overpass.osm.ch` — which this repo documents twice over as Switzerland-only,
 * answering for other continents with a fast, confident zero. When the two good
 * mirrors were busy, that third one returned HTTP 200 and no elements, and the
 * app drew it as a complete answer: nobody has mapped a toilet in this town.
 *
 * A failure is still `ok: false` and still reads as "couldn't check". What is
 * gone is the third mirror's version, which read as "there are none".
 */
const requestFacilities = async (
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<ApiFacilityScan | null> => {
  try {
    const res = await fetch(`/api/facilities?${new URLSearchParams(params)}`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as ApiFacilityScan;
    return Array.isArray(data?.facilities) ? data : null;
  } catch {
    return null;
  }
};

export const fetchNearbyFacilities = async (
  latitude: number,
  longitude: number,
  radiusKm = FACILITY_RADIUS_KM,
  signal?: AbortSignal
): Promise<NearbyFacilityResult> => {
  const scan = await requestFacilities({
    lat: latitude.toFixed(5),
    lon: longitude.toFixed(5),
    radiusKm: String(radiusKm),
    kinds: OSM_KINDS.join(',')
  }, signal);

  if (!scan?.ok || !scan.facilities) return EMPTY;

  /* The server answers for a BOX around the point, because that is the one
     shape Overpass is fast at. The circle is applied here — a facility in the
     corner of that box can be half again the radius away, and "within 5 km"
     has to mean it. */
  const nearest = new Map<NearbyFacilityKind, NearbyFacility>();

  for (const row of scan.facilities) {
    const kind = row.kind as NearbyFacilityKind;
    if (!FACILITY[kind]) continue;

    const km = distanceKm(latitude, longitude, row.latitude, row.longitude);
    if (km > radiusKm) continue;

    const existing = nearest.get(kind);
    if (existing && existing.distanceKm <= km) continue;

    nearest.set(kind, {
      id: row.id,
      kind,
      name: row.name?.trim() || undefined,
      latitude: row.latitude,
      longitude: row.longitude,
      distanceKm: Math.round(km * 10) / 10,
      /** Free unless OSM says otherwise; undefined when nobody said. */
      fee: row.fee ?? undefined
    });
  }

  return {
    ok: true,
    facilities: [...nearest.values()].sort((a, b) => a.distanceKm - b.distanceKm)
  };
};

/* ------------------------------------------------------------------ *
 * The nearest driveable road
 * ------------------------------------------------------------------ */
/**
 * WHY THIS EXISTS, AND WHAT IT REFUSES TO SAY.
 *
 * Public-land polygons used to be painted across the map, which is a lot of
 * colour saying very little: a wash over half a state does not tell a camper
 * where they could actually put a van. The other tempting answer — computing
 * "drive-up spots" for every parcel in the country and dropping pins on them —
 * is worse, because a pin on a map is a promise, and the only thing that data
 * can honestly support is "there is a road here".
 *
 * So this is that, and only that, asked about ONE point the camper has already
 * tapped: what is the nearest track a vehicle could use? It is a hint about
 * access, not a campsite. The chip it produces says the distance and nothing
 * about legality, surface, gates, seasonal closures, or whether the road ever
 * widens into somewhere you could stop.
 *
 * Never throws; a failure is `null`, which draws no chip at all rather than
 * "no road nearby".
 */

/**
 * Roads worth mentioning to somebody looking for dispersed camping.
 *
 * Tracks and unclassified/service roads are what forest and BLM roads are
 * tagged as. Motorways, trunks and primaries are excluded on purpose: you
 * cannot camp off an interstate, and a chip pointing at one is noise.
 */
const DRIVEABLE_HIGHWAY = /^(track|unclassified|service|residential|tertiary)$/;

/** How far out we look for a road, in km. Past this it is not "access". */
export const ROAD_RADIUS_KM = 2;

interface OverpassWay extends OverpassElement {
  geometry?: { lat: number; lon: number }[];
}

/**
 * OUR OWN API FIRST, AND THIS IS THE FIX FOR "IT WORKS SOMETIMES".
 *
 * `/api/roads/nearest` runs the good version of this query — filtered on the
 * server side of Overpass rather than after the results arrive, bounded by a
 * real timeout per mirror, and cached across every camper who asks about the
 * same pullout. See the note on the route itself for what each of those was
 * costing when the phone asked Overpass directly.
 *
 * Returns `undefined` when our API could not answer at all, which is different
 * from it answering that nothing is mapped — the caller falls through to asking
 * Overpass itself in the first case and stops in the second.
 */
const nearestRoadFromApi = async (
  latitude: number,
  longitude: number,
  radiusKm: number,
  signal?: AbortSignal
): Promise<NearbyFacility | null | undefined> => {
  try {
    const params = new URLSearchParams({
      lat: latitude.toFixed(5),
      lon: longitude.toFixed(5),
      radiusKm: String(radiusKm)
    });
    const res = await fetch(`/api/roads/nearest?${params}`, { signal });
    if (!res.ok) return undefined;

    const data = await res.json();
    // `ok: false` is "we could not check". Try the direct route rather than
    // reporting an empty answer the server never made.
    if (data?.ok !== true) return undefined;

    const road = data.road;
    if (!road || typeof road.lat !== 'number' || typeof road.lon !== 'number') return null;

    return {
      id: `road-${road.lat.toFixed(5)},${road.lon.toFixed(5)}`,
      kind: 'road',
      name: typeof road.name === 'string' && road.name.trim() ? road.name.trim() : undefined,
      latitude: road.lat,
      longitude: road.lon,
      distanceKm: Math.round((road.distanceKm ?? 0) * 100) / 100,
      line: Array.isArray(road.line) ? road.line : []
    };
  } catch {
    return undefined;
  }
};

/**
 * How long one Overpass mirror gets before we move to the next.
 *
 * There used to be no limit at all on the direct path, so a mirror having a bad
 * minute left the map showing "Looking for the track…" until it timed out on
 * its own — which reads as the app having hung. Nine seconds is longer than a
 * healthy mirror needs and short enough that all three can still be tried.
 */
const OVERPASS_TIMEOUT_MS = 9000;

export interface NearestRoadResult {
  /**
   * False when nothing could be checked — our API down, every Overpass mirror
   * refusing, no signal.
   *
   * THIS IS NOT A COSMETIC DISTINCTION. The map used to get a bare `null` for
   * both outcomes and print "No mapped track within 2 km — OpenStreetMap has
   * nothing here", which is a confident statement about the ground made out of
   * a failed request. A camper reading that decides there is no way in.
   */
  ok: boolean;
  /** Null with `ok: true` means nobody has mapped one. That much is true. */
  road: NearbyFacility | null;
}

export const findNearestDriveableRoad = async (
  latitude: number,
  longitude: number,
  radiusKm = ROAD_RADIUS_KM,
  signal?: AbortSignal
): Promise<NearestRoadResult> => {
  const viaApi = await nearestRoadFromApi(latitude, longitude, radiusKm, signal);
  if (viaApi !== undefined) return { ok: true, road: viaApi };
  if (signal?.aborted) return { ok: false, road: null };

  const metres = Math.round(radiusKm * 1000);
  const around = `(around:${metres},${latitude.toFixed(5)},${longitude.toFixed(5)})`;
  /*
   * FILTERED IN THE QUERY, NOT AFTER IT ARRIVES.
   *
   * This used to ask for every `highway` in the radius and drop the wrong kinds
   * once they were here, under `out geom 120`. Overpass fills that cap in its
   * own order rather than by distance, so anywhere with a couple of hundred
   * mapped ways in two kilometres — which is anywhere with houses — the track
   * beside the pin simply did not come back, and the app said there was nothing
   * mapped while a road sat plainly on the screen underneath it. Asking only
   * for the kinds we would keep is what makes the cap stop deciding.
   *
   * `out geom` rather than `out center`: a road is a line, and the centre of a
   * 20 km forest road can be nowhere near the point that matters.
   */
  const query =
    `[out:json][timeout:15];\n` +
    `way["highway"~"^(track|unclassified|service|residential|tertiary)$"]` +
    `["access"!~"^(private|no)$"]["motor_vehicle"!~"^(private|no)$"]${around};\n` +
    `out geom 300;`;

  for (const mirror of OVERPASS_MIRRORS) {
    // A mirror gets its own clock. The caller's signal still wins.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    const timer = setTimeout(abort, OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data?.elements)) continue;

      let best: NearbyFacility | null = null;

      for (const way of data.elements as OverpassWay[]) {
        const tags = way.tags ?? {};
        const highway = tags.highway ?? '';
        if (!DRIVEABLE_HIGHWAY.test(highway)) continue;

        // A gated or private road is not access. `motor_vehicle=no` catches
        // the hiking-only tracks that are still tagged as tracks.
        if (tags.access === 'private' || tags.access === 'no') continue;
        if (tags.motor_vehicle === 'private' || tags.motor_vehicle === 'no') continue;

        /*
         * Measured to the ROAD, not to the points somebody clicked when
         * drawing it. A long straight track has vertices kilometres apart, and
         * measuring to the nearest of those used to report a road as 2 km away
         * when it ran 350 m from the pin — which is how the app ended up
         * naming a further road as "the nearest" while a closer one sat
         * plainly on the map beside it.
         */
        const near = distanceToLineKm(latitude, longitude, way.geometry ?? []);
        if (near && near.km <= radiusKm && (!best || best.distanceKm > near.km)) {
          best = {
            id: `osm-way-${way.id}`,
            kind: 'road',
            name: tags.name?.trim() || tags.ref?.trim() || undefined,
            latitude: near.lat,
            longitude: near.lon,
            distanceKm: Math.round(near.km * 100) / 100,
            /**
             * The whole way, kept rather than thrown away.
             *
             * We already asked for `out geom`, so the line costs nothing extra
             * here and is the only way the map can SHOW the road when its chip
             * is tapped.
             *
             * Windowed around the point nearest the spot, not taken from the
             * start of the way: on a 40 km forest road the first 400 vertices
             * can be an hour's drive from the pin, which draws a yellow line
             * off the edge of the screen and calls it the nearest track.
             */
            line: (() => {
              const geometry = way.geometry ?? [];
              const start = Math.max(0, near.index - 200);
              return geometry
                .slice(start, start + 400)
                .map((p) => [p.lat, p.lon] as [number, number]);
            })()
          };
        }
      }

      // A mirror that answered is an answer, even when it found nothing.
      return { ok: true, road: best };
    } catch {
      // The caller changed their mind: stop, rather than working through the
      // other mirrors for an answer nobody is waiting for. This mirror simply
      // running out of its own clock is not that — try the next one.
      if (signal?.aborted) return { ok: false, road: null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  // Every door was shut. We know nothing about this ground.
  return { ok: false, road: null };
};

/**
 * The road alone, for callers that draw a chip or nothing.
 *
 * The chip row genuinely cannot tell the two outcomes apart — it draws no chip
 * either way — so it does not have to. Anything that puts a SENTENCE on the
 * screen must use `findNearestDriveableRoad` and say which it got.
 */
export const fetchNearestDriveableRoad = async (
  latitude: number,
  longitude: number,
  radiusKm = ROAD_RADIUS_KM,
  signal?: AbortSignal
): Promise<NearbyFacility | null> =>
  (await findNearestDriveableRoad(latitude, longitude, radiusKm, signal)).road;

/* ------------------------------------------------------------------ *
 * Every facility of a chosen kind, across the map in view
 * ------------------------------------------------------------------ */
/**
 * THE OTHER QUESTION.
 *
 * `fetchNearbyFacilities` above answers "what is near THIS spot", and it
 * deliberately collapses to the nearest one of each kind — a pin wearing
 * fourteen toilet chips tells a camper nothing. This answers "show me every
 * toilet on the screen", which is the opposite shape: one kind, or a few,
 * and all of them.
 *
 * A BOUNDING BOX RATHER THAN A RADIUS, because the thing being filled is a
 * rectangular screen. Asking for a radius that covers the corners of the
 * viewport fetches a third more ground than is being looked at, and Overpass
 * charges for it in seconds.
 *
 * THE CAP IS NOT COSMETIC. Overpass will refuse, or take thirty seconds over,
 * a continent-wide box. The caller gates on zoom before ever getting here;
 * this clamps the box as a second line of defence and tells the truth about
 * what came back.
 *
 * Never throws. Every mirror failing is `ok: false` with an empty list, which
 * the UI must render as "couldn't check" — never as "there are none here".
 */

/**
 * Below this the box is too big for Overpass to answer.
 *
 * WAS 10, WHICH IS ABOUT ONE CITY. A camper looking at "southern Alberta" —
 * the zoom you actually browse at when deciding where to go — tapped Toilets
 * and got nothing but a line of small text, which reads as a broken button.
 * Nine roughly doubles the ground covered and is still a box Overpass will
 * answer for a single amenity type.
 */
export const FACILITY_MIN_ZOOM = 9;

/**
 * Degrees of latitude/longitude the query box may span.
 *
 * This used to be 1.2° and the box was silently CLAMPED to it, which is the
 * dishonest failure: a camper at the edge of the gate got results for the
 * middle of their screen only, drawn as though that were the whole answer,
 * with no way to tell the difference from "there is nothing at the edges".
 * It is now wide enough to cover any viewport that clears the zoom gate, so
 * the clamp below is a backstop rather than something that fires in normal
 * use — and `fetchFacilitiesInView` reports when it does.
 */
const MAX_BOX_DEGREES = 3.0;

export interface FacilityViewBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface FacilityViewResult {
  /** False when every mirror failed. "Couldn't check", never "nothing here". */
  ok: boolean;
  facilities: MapFacility[];
  /**
   * True when what came back is a SAMPLE rather than the set — either the row
   * cap was hit, or the viewport was too wide and only its middle was asked
   * about. Both mean the same thing to a camper: there is more here than is
   * drawn, so an empty patch of screen proves nothing.
   */
  truncated: boolean;
}

const EMPTY_VIEW: FacilityViewResult = { ok: false, facilities: [], truncated: false };

/**
 * Viewport answers, so panning back across ground already covered does not
 * re-ask Overpass. `fetchFacilitiesInView` runs on every map move that
 * clears the zoom gate, which on a phone being dragged around is a lot of
 * identical questions. Only successful answers go in — see TtlCache.
 */
const facilityViewCache = new TtlCache<FacilityViewResult>(10 * 60 * 1000, 40);

export const fetchFacilitiesInView = async (
  bounds: FacilityViewBounds,
  kinds: readonly FacilityKind[],
  signal?: AbortSignal
): Promise<FacilityViewResult> => {
  const wanted = kinds.filter((kind) => FACILITY[kind].osm.length > 0);
  if (wanted.length === 0) return { ok: true, facilities: [], truncated: false };

  /* The box as asked plus what was asked about: two viewports that round to
     the same box want the same answer, and a different set of kinds does not.
     The clamp for an over-wide box now happens on the server, which is also
     what decides `truncated`. */
  const box = [
    bounds.south.toFixed(4), bounds.west.toFixed(4),
    bounds.north.toFixed(4), bounds.east.toFixed(4)
  ].join(',');
  const cacheKey = `${box}|${[...wanted].sort().join(',')}`;
  const cached = facilityViewCache.get(cacheKey);
  if (cached) return cached;

  const scan = await requestFacilities({
    minLat: bounds.south.toFixed(5),
    minLon: bounds.west.toFixed(5),
    maxLat: bounds.north.toFixed(5),
    maxLon: bounds.east.toFixed(5),
    kinds: wanted.join(',')
  }, signal);

  // "Couldn't check", never "nothing here".
  if (!scan?.ok || !scan.facilities) return EMPTY_VIEW;

  const wantedSet = new Set<string>(wanted);
  const facilities: MapFacility[] = [];

  for (const row of scan.facilities) {
    if (!wantedSet.has(row.kind)) continue;
    facilities.push({
      id: row.id,
      kind: row.kind as FacilityKind,
      name: row.name?.trim() || undefined,
      latitude: row.latitude,
      longitude: row.longitude,
      fromOsm: true,
      /* Nobody using this app has confirmed an OSM node. That is not a
         criticism of it — it is the difference the pin has to show. */
      confirmations: 0,
      fee: row.fee ?? undefined
    });
  }

  const result: FacilityViewResult = {
    ok: true,
    facilities,
    truncated: scan.truncated === true
  };
  facilityViewCache.set(cacheKey, result);
  return result;
};
