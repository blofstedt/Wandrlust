import { distanceKm } from '../utils/geo';
import type { NearbyFacility, NearbyFacilityKind } from '../types';

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
 * The kinds worth a dot, and the OSM tags that mean each one.
 *
 * Deliberately short. Every kind added here is another dot over the pin and
 * another thing to read before deciding, so the bar is "would this change
 * where I sleep tonight" — which is true of a toilet and a water tap, and not
 * true of a picnic bench.
 */
const KIND_QUERY: Record<Exclude<NearbyFacilityKind, 'road'>, string[]> = {
  toilet: ['node["amenity"="toilets"]', 'way["amenity"="toilets"]'],
  shower: ['node["amenity"="shower"]', 'way["amenity"="shower"]'],
  water: [
    'node["amenity"="drinking_water"]',
    'node["man_made"="water_tap"]["drinking_water"="yes"]'
  ],
  dump: ['node["amenity"="sanitary_dump_station"]', 'way["amenity"="sanitary_dump_station"]'],
  fuel: ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'],
  groceries: [
    'node["shop"="supermarket"]', 'way["shop"="supermarket"]',
    'node["shop"="convenience"]', 'way["shop"="convenience"]'
  ],
  /* Where a walk STARTS — the trailhead — rather than the path itself. A
     hiking route is a line hundreds of km long whose nearest point to a
     campsite is meaningless; the head is a place you drive to and park. */
  trail: [
    'node["highway"="trailhead"]',
    'node["information"="guidepost"]["hiking"="yes"]'
  ],
  fishing: ['node["leisure"="fishing"]', 'way["leisure"="fishing"]'],
  /* A slipway is the ramp itself. Marinas are excluded on purpose: a marina
     is a business with a gate, not somewhere to put a canoe in. */
  boat: ['node["leisure"="slipway"]', 'way["leisure"="slipway"]'],
  waste: [
    'node["amenity"="waste_disposal"]', 'way["amenity"="waste_disposal"]',
    'node["amenity"="recycling"]["recycling_type"="centre"]'
  ]
};

export const FACILITY_LABEL: Record<NearbyFacilityKind, string> = {
  toilet: 'Toilet',
  shower: 'Shower',
  water: 'Drinking water',
  dump: 'Dump station',
  fuel: 'Fuel',
  groceries: 'Groceries',
  trail: 'Trailhead',
  fishing: 'Fishing spot',
  boat: 'Boat ramp',
  waste: 'Rubbish disposal',
  road: 'Driveable road'
};

export const FACILITY_GLYPH: Record<NearbyFacilityKind, string> = {
  toilet: '🚻',
  shower: '🚿',
  water: '🚰',
  dump: '🚽',
  fuel: '⛽',
  groceries: '🛒',
  trail: '🥾',
  fishing: '🎣',
  boat: '🛶',
  waste: '🗑️',
  road: '🛣️'
};

/** Which kind an element is, from the tags it came back with. */
const kindOf = (tags: Record<string, string>): NearbyFacilityKind | null => {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.amenity === 'shower') return 'shower';
  if (tags.amenity === 'drinking_water' || tags.man_made === 'water_tap') return 'water';
  if (tags.amenity === 'sanitary_dump_station') return 'dump';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'groceries';
  if (tags.highway === 'trailhead' || tags.information === 'guidepost') return 'trail';
  if (tags.leisure === 'fishing') return 'fishing';
  if (tags.leisure === 'slipway') return 'boat';
  if (tags.amenity === 'waste_disposal' || tags.amenity === 'recycling') return 'waste';
  return null;
};

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
  const clauses = Object.values(KIND_QUERY)
    .flat()
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

        // A toilet tagged access=private is somebody's bathroom, not a
        // facility; showing it would send a camper to knock on a door.
        if (tags.access === 'private' || tags.access === 'no') continue;

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

        for (const point of way.geometry ?? []) {
          const km = distanceKm(latitude, longitude, point.lat, point.lon);
          if (km > radiusKm) continue;
          if (best && best.distanceKm <= km) continue;

          best = {
            id: `osm-way-${way.id}`,
            kind: 'road',
            name: tags.name?.trim() || tags.ref?.trim() || undefined,
            latitude: point.lat,
            longitude: point.lon,
            distanceKm: Math.round(km * 100) / 100
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
