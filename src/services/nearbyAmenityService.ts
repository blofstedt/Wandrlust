import { distanceKm, distanceToLineKm } from '../utils/geo';
import type { FacilityKind, MapFacility, NearbyFacility, NearbyFacilityKind } from '../types';
import { FACILITY, FACILITY_KINDS } from '../config/facilities';

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

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
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

/**
 * The Overpass selectors for a set of kinds, read off the shared table.
 *
 * The tags used to be duplicated here, in `config/spotReport.ts` and in
 * `server/spotContext.ts`, and they disagreed — which is how a toilet ended
 * up being called a `restroom` in one place and being unstorable in another.
 * `config/facilities.ts` is now the only copy.
 */
const selectorsFor = (kinds: readonly FacilityKind[]): string[] =>
  kinds.flatMap((kind) => FACILITY[kind].osm);

/** Every kind that OpenStreetMap can actually answer for. */
const OSM_KINDS = FACILITY_KINDS.filter((kind) => FACILITY[kind].osm.length > 0);

/**
 * Which kind an element is, from the tags it came back with.
 *
 * Order matters where tags overlap: a fuel station that also sells propane
 * carries `amenity=fuel` AND `fuel:lpg=yes`, and a camper hunting propane
 * wants it to come back as propane rather than disappearing into the fuel
 * pile. So the narrower reading is tested first.
 */
const kindOf = (tags: Record<string, string>): FacilityKind | null => {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.amenity === 'shower') return 'shower';
  if (tags.amenity === 'drinking_water' || tags.man_made === 'water_tap') return 'water';
  if (tags.amenity === 'sanitary_dump_station') return 'dump';
  if (tags['fuel:lpg'] === 'yes' || tags.shop === 'gas') return 'propane';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'laundry' || tags.amenity === 'laundry') return 'laundry';
  if (tags.amenity === 'compressed_air') return 'air';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'groceries';
  if (tags.highway === 'trailhead' || tags.information === 'guidepost') return 'trail';
  if (tags.leisure === 'fishing') return 'fishing';
  if (tags.leisure === 'slipway') return 'boat';
  if (tags.amenity === 'waste_disposal' || tags.amenity === 'recycling') return 'waste';
  return null;
};

/**
 * A toilet behind a locked door is not a facility.
 *
 * `access=private` on a shower is somebody's bathroom, and drawing it would
 * send a camper to knock on a stranger's door at 6am.
 */
const isReachable = (tags: Record<string, string>): boolean =>
  tags.access !== 'private' && tags.access !== 'no';

export interface NearbyFacilityResult {
  /** False when every mirror failed — "couldn't check", never "nothing here". */
  ok: boolean;
  /** The nearest of each kind found, closest kind first. At most one per kind. */
  facilities: NearbyFacility[];
}

const EMPTY: NearbyFacilityResult = { ok: false, facilities: [] };

export const fetchNearbyFacilities = async (
  latitude: number,
  longitude: number,
  radiusKm = FACILITY_RADIUS_KM,
  signal?: AbortSignal
): Promise<NearbyFacilityResult> => {
  const metres = Math.round(radiusKm * 1000);
  const around = `(around:${metres},${latitude.toFixed(5)},${longitude.toFixed(5)})`;
  const clauses = selectorsFor(OSM_KINDS)
    .map((selector) => `  ${selector}${around};`)
    .join('\n');

  const query = `[out:json][timeout:15];\n(\n${clauses}\n);\nout center 240;`;

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data?.elements)) continue;

      /** Nearest wins, per kind: one dot each, whatever the mirror sends. */
      const nearest = new Map<NearbyFacilityKind, NearbyFacility>();

      for (const element of data.elements as OverpassElement[]) {
        const lat = element.lat ?? element.center?.lat;
        const lon = element.lon ?? element.center?.lon;
        const tags = element.tags ?? {};
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;

        const kind = kindOf(tags);
        if (!kind) continue;
        if (!isReachable(tags)) continue;

        const km = distanceKm(latitude, longitude, lat, lon);
        if (km > radiusKm) continue;

        const existing = nearest.get(kind);
        if (existing && existing.distanceKm <= km) continue;

        nearest.set(kind, {
          id: `osm-${element.type}-${element.id}`,
          kind,
          name: tags.name?.trim() || undefined,
          latitude: lat,
          longitude: lon,
          distanceKm: Math.round(km * 10) / 10,
          /** Free unless OSM says otherwise; undefined when nobody said. */
          fee: tags.fee === undefined ? undefined : tags.fee !== 'no'
        });
      }

      return {
        ok: true,
        facilities: [...nearest.values()].sort((a, b) => a.distanceKm - b.distanceKm)
      };
    } catch {
      // An abort is the caller changing their mind, not a mirror failing.
      if (signal?.aborted) return EMPTY;
    }
  }

  return EMPTY;
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

export const fetchNearestDriveableRoad = async (
  latitude: number,
  longitude: number,
  radiusKm = ROAD_RADIUS_KM,
  signal?: AbortSignal
): Promise<NearbyFacility | null> => {
  const metres = Math.round(radiusKm * 1000);
  const around = `(around:${metres},${latitude.toFixed(5)},${longitude.toFixed(5)})`;
  // `out geom` rather than `out center`: a road is a line, and the centre of a
  // 20 km forest road can be nowhere near the point that matters.
  const query =
    `[out:json][timeout:15];\n` +
    `way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|footway|path|cycleway|steps|bridleway)$"]${around};\n` +
    `out geom 120;`;

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal
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

      return best;
    } catch {
      if (signal?.aborted) return null;
    }
  }

  return null;
};

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

/** Below this the box is too big for Overpass and too coarse to be useful. */
export const FACILITY_MIN_ZOOM = 10;

/** Degrees of latitude/longitude. ~110 km — a generous phone screen at z10. */
const MAX_BOX_DEGREES = 1.2;

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
  /** True when the answer hit the row cap, so it is a sample, not the set. */
  truncated: boolean;
}

const EMPTY_VIEW: FacilityViewResult = { ok: false, facilities: [], truncated: false };

/** How many we will draw before the map becomes a wall of glyphs. */
const MAX_IN_VIEW = 250;

export const fetchFacilitiesInView = async (
  bounds: FacilityViewBounds,
  kinds: readonly FacilityKind[],
  signal?: AbortSignal
): Promise<FacilityViewResult> => {
  const wanted = kinds.filter((kind) => FACILITY[kind].osm.length > 0);
  if (wanted.length === 0) return { ok: true, facilities: [], truncated: false };

  // Clamp around the centre rather than refusing outright: a slightly-too-big
  // box still answers for the middle of the screen, which is where the camper
  // is looking. The zoom gate upstream is what stops this happening normally.
  const midLat = (bounds.south + bounds.north) / 2;
  const midLon = (bounds.west + bounds.east) / 2;
  const halfLat = Math.min((bounds.north - bounds.south) / 2, MAX_BOX_DEGREES / 2);
  const halfLon = Math.min((bounds.east - bounds.west) / 2, MAX_BOX_DEGREES / 2);

  const box = [
    (midLat - halfLat).toFixed(5), (midLon - halfLon).toFixed(5),
    (midLat + halfLat).toFixed(5), (midLon + halfLon).toFixed(5)
  ].join(',');

  const clauses = selectorsFor(wanted)
    .map((selector) => `  ${selector}(${box});`)
    .join('\n');

  const query = `[out:json][timeout:20];\n(\n${clauses}\n);\nout center ${MAX_IN_VIEW + 1};`;

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data?.elements)) continue;

      const wantedSet = new Set(wanted);
      /* Keyed by id so a node and the way describing the same building do not
         both draw. OSM ids are unique per type, so the type is in the key. */
      const found = new Map<string, MapFacility>();

      for (const element of data.elements as OverpassElement[]) {
        const lat = element.lat ?? element.center?.lat;
        const lon = element.lon ?? element.center?.lon;
        const tags = element.tags ?? {};
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;

        const kind = kindOf(tags);
        // A selector can drag in a neighbouring tag — `amenity=fuel` matches
        // the propane query too. Only keep what was actually asked for.
        if (!kind || !wantedSet.has(kind)) continue;
        if (!isReachable(tags)) continue;

        const id = `osm-${element.type}-${element.id}`;
        if (found.has(id)) continue;

        found.set(id, {
          id,
          kind,
          name: tags.name?.trim() || undefined,
          latitude: lat,
          longitude: lon,
          fromOsm: true,
          /* Nobody using this app has confirmed an OSM node. That is not a
             criticism of it — it is the difference the pin has to show. */
          confirmations: 0,
          fee: tags.fee === undefined ? undefined : tags.fee !== 'no'
        });
      }

      const facilities = [...found.values()];
      return {
        ok: true,
        facilities: facilities.slice(0, MAX_IN_VIEW),
        truncated: facilities.length > MAX_IN_VIEW
      };
    } catch {
      // An abort is the caller changing their mind, not a mirror failing.
      if (signal?.aborted) return EMPTY_VIEW;
    }
  }

  return EMPTY_VIEW;
};
