/**
 * Urban, suburban or wilderness, from a committed list of towns.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE ON DISK AND NOT AN OVERPASS QUERY
 * ---------------------------------------------------------------------------
 *
 * The first version asked Overpass for every settlement near each batch of
 * campgrounds. It worked, when it worked. Over several attempts it returned
 * HTTP 500, HTTP 502, HTTP 400 for a malformed union, and timeouts at six
 * seconds and again at twelve, on all three mirrors — while the same service
 * answered a different query in 5.7 seconds. Classifying 832 campgrounds
 * became a manual loop of small bounding boxes with retries, which is not a
 * thing that should exist.
 *
 * Where a town IS does not change. It is reference data, not live data, and
 * this codebase already has a rule for that: big static datasets are prebuilt
 * into `public/map/` and committed, exactly as `lakes-us-ca.json` is bundled
 * into the server. So the towns are too. No network, no mirrors, no partial
 * coverage, no retry loop, and the answer is the same every time it runs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT KNOWS AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * About 20,000 populated places across the lower 48 and Canada, with a
 * population where one could be matched. A population of 0 means UNKNOWN, not
 * empty — it is treated as a small town, which is the safest reading: it draws
 * the tightest rings, so an unknown place makes the fewest claims about the
 * ground around it.
 *
 * This is still an estimate about a category, and every campsite it classifies
 * is stored with `setting_is_derived = true` so a camper who has stood there
 * can overwrite it and never be overwritten back.
 */
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import placeData from '../public/map/places-us-ca.json' with { type: 'json' };

export type Setting = 'urban' | 'suburban' | 'wilderness';

/** `[latitude, longitude, population]`; population 0 means unknown. */
type Place = [number, number, number];

const PLACES: Place[] = Array.isArray((placeData as any)?.places)
  ? ((placeData as any).places as Place[])
  : [];

/**
 * How far a settlement's influence reaches, in metres, by how big it is.
 *
 * Inside the first ring is urban, inside the second is suburban. A single
 * radius cannot work: two kilometres from Vancouver is a city and two
 * kilometres from a village of four hundred is trees.
 *
 * An unknown population takes the smallest pair deliberately. Guessing small
 * makes the app claim less — the failure is a genuinely suburban site reading
 * as back country, which understates how likely a knock is rather than
 * overstating how remote somewhere feels.
 */
const RINGS: { minPop: number; urban: number; suburban: number }[] = [
  { minPop: 500_000, urban: 10_000, suburban: 35_000 },
  { minPop: 100_000, urban: 6_000, suburban: 22_000 },
  { minPop: 25_000, urban: 4_000, suburban: 14_000 },
  { minPop: 5_000, urban: 2_500, suburban: 9_000 },
  { minPop: 0, urban: 1_200, suburban: 5_000 }
];

const ringsFor = (pop: number) =>
  RINGS.find((r) => pop >= r.minPop) ?? RINGS[RINGS.length - 1];

/**
 * A one-degree grid over the place list, built once.
 *
 * Twenty thousand places against several hundred campgrounds is only a few
 * million comparisons, which is survivable — but this runs inside a request
 * with a thirty second ceiling shared with everything else, and the index
 * turns it into a handful of lookups. The widest ring is 35 km, so a cell and
 * its neighbours always cover everything that could possibly reach a point.
 */
const grid = new Map<string, Place[]>();
for (const place of PLACES) {
  const key = `${Math.round(place[0])}:${Math.round(place[1])}`;
  const cell = grid.get(key);
  if (cell) cell.push(place);
  else grid.set(key, [place]);
}

const EARTH_M = 6_371_000;
const toRad = (d: number): number => (d * Math.PI) / 180;
const metresBetween = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/** True when the dataset loaded at all — a guard against a silent empty file. */
export const placesKnown = (): number => PLACES.length;

/**
 * Which kind of place this point sits in.
 *
 * The STRONGEST classification any nearby settlement produces wins: being far
 * from a village does not make somewhere rural if it is also inside a city.
 */
export const settingFor = (lat: number, lon: number): Setting => {
  let best: Setting = 'wilderness';
  const gy = Math.round(lat);
  const gx = Math.round(lon);

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const cell = grid.get(`${gy + dy}:${gx + dx}`);
      if (!cell) continue;
      for (const [plat, plon, pop] of cell) {
        const rings = ringsFor(pop);
        const metres = metresBetween(lat, lon, plat, plon);
        if (metres <= rings.urban) return 'urban';
        if (metres <= rings.suburban) best = 'suburban';
      }
    }
  }
  return best;
};
