import { distanceKm } from '../utils/geo';
import type { NearbyFacility, NearbyFacilityKind } from '../types';

/**
 * The nearest toilet, shower, tap, dump station or fuel pump to a spot.
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
const KIND_QUERY: Record<NearbyFacilityKind, string[]> = {
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
  ]
};

export const FACILITY_LABEL: Record<NearbyFacilityKind, string> = {
  toilet: 'Toilet',
  shower: 'Shower',
  water: 'Drinking water',
  dump: 'Dump station',
  fuel: 'Fuel',
  groceries: 'Groceries'
};

export const FACILITY_GLYPH: Record<NearbyFacilityKind, string> = {
  toilet: '🚻',
  shower: '🚿',
  water: '🚰',
  dump: '🚽',
  fuel: '⛽',
  groceries: '🛒'
};

/** Which kind an element is, from the tags it came back with. */
const kindOf = (tags: Record<string, string>): NearbyFacilityKind | null => {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.amenity === 'shower') return 'shower';
  if (tags.amenity === 'drinking_water' || tags.man_made === 'water_tap') return 'water';
  if (tags.amenity === 'sanitary_dump_station') return 'dump';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'groceries';
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

  const query = `[out:json][timeout:15];\n(\n${clauses}\n);\nout center 120;`;

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

      /** Nearest wins, per kind: six dots at most, whatever the mirror sends. */
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
