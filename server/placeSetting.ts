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
 * ---------------------------------------------------------------------------
 * THIS WAS FIXED RINGS AND EVERY ONE OF THEM WAS FAR TOO WIDE
 * ---------------------------------------------------------------------------
 *
 * The first version used five population buckets with hand-picked radii —
 * 5 km of "suburban" around a place of unknown size, 14 km around a town of
 * 25,000. Reported as wilderness sites showing suburban, and measured
 * afterwards, which is the order it should have been done in:
 *
 *   Blue Cloud, a BLM site in the Mojave, 4.2 km from a dot with no
 *   population recorded                                        -> suburban
 *   Goat Rock, BLM back country, 11.1 km from a town of 27,828  -> suburban
 *   A Forest Service dispersed site 10.2 km from Prescott       -> suburban
 *   Clear Creek, in the North Cascades, 4.5 km from another
 *   unnamed-population dot                                      -> suburban
 *
 * Eleven kilometres from a town of twenty-eight thousand is open country, and
 * two thirds of the place list (13,378 of 19,919) has NO population recorded
 * at all — so the unknown bucket's 5 km ring was doing most of the
 * classifying, on the least evidence.
 *
 * ---------------------------------------------------------------------------
 * SO THE RADIUS IS DERIVED FROM THE POPULATION RATHER THAN GUESSED
 * ---------------------------------------------------------------------------
 *
 * A settlement's built-up area is roughly its population divided by how
 * densely people live in it, and the radius is the radius of that circle.
 * That is one line of arithmetic and it scales continuously, where five
 * buckets have four cliffs in them and no reasoning behind any number.
 *
 *   25,000 people ->  2.3 km built up,  5.1 km to the edge of the fringe
 *   100,000       ->  4.6 km        , 10.1 km
 *   500,000       -> 10.3 km        , 22.7 km
 *
 * All four sites above come out `wilderness` now, and a campsite 3 km from a
 * town of 30,000 still comes out `suburban`, which is the case this is for.
 */

/**
 * People per square kilometre in the built-up part of a settlement.
 *
 * North American towns and suburbs sit around 1,000–2,000; the middle of that
 * is the honest choice given the answer is a category, not a distance.
 */
const BUILT_UP_DENSITY = 1_500;

/** How far past the built-up edge the fringe reaches, as a multiple of it. */
const SUBURBAN_REACH = 2.2;

/**
 * Below this, a settlement cannot make anywhere URBAN — only suburban.
 *
 * Camping beside a town of eight thousand is "there are houses here", which
 * is what suburban means on this map. It is not a city. Two of exactly that
 * were what the report called urban-when-really-suburban: a Corps of
 * Engineers site on the edge of Fort Worth, and a city RV park in Ashland,
 * Wisconsin, population eight thousand.
 */
const URBAN_MIN_POP = 50_000;

/**
 * What to assume for a place with no population recorded.
 *
 * Two thirds of the list. They are overwhelmingly hamlets, localities and
 * named crossroads, so they are treated as a small settlement — which puts
 * the fringe at about 700 m, i.e. you are basically standing in the place.
 * They can never produce `urban`: knowing a settlement is HERE is not knowing
 * it is a CITY, and the old code claimed exactly that within 1.2 km.
 */
const ASSUMED_UNKNOWN_POP = 500;

/**
 * Nothing reaches further than this, whatever the arithmetic says.
 *
 * Fifty kilometres from a city centre is not its suburbs by any definition a
 * camper cares about. It also keeps every ring inside the one-degree grid
 * search below: a degree of longitude is 55.8 km at 60°N, the top of the
 * coverage area, so a cell and its neighbours always contain the whole reach.
 */
const MAX_FRINGE_M = 50_000;

/** Radius of the built-up area itself, in metres. */
const builtUpRadiusM = (pop: number): number =>
  Math.sqrt(pop / (Math.PI * BUILT_UP_DENSITY)) * 1000;

interface Reach {
  /** Inside this and it is urban — only for places big enough to be a city. */
  urban: number;
  /** Inside this and it is suburban. */
  suburban: number;
}

const reachFor = (pop: number): Reach => {
  const known = pop > 0;
  const people = known ? pop : ASSUMED_UNKNOWN_POP;
  const core = builtUpRadiusM(people);
  return {
    // An unknown or small place cannot claim a city, so its urban reach is nil.
    urban: known && people >= URBAN_MIN_POP ? Math.min(core, MAX_FRINGE_M) : 0,
    suburban: Math.min(core * SUBURBAN_REACH, MAX_FRINGE_M)
  };
};

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
        const reach = reachFor(pop);
        const metres = metresBetween(lat, lon, plat, plon);
        if (reach.urban > 0 && metres <= reach.urban) return 'urban';
        if (metres <= reach.suburban) best = 'suburban';
      }
    }
  }
  return best;
};
