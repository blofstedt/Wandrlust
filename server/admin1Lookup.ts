/**
 * Which state or province a coordinate is in, offline.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE ON DISK, AGAIN
 * ---------------------------------------------------------------------------
 *
 * Same reasoning as `placeSetting.ts`, and the same committed asset the map
 * already draws state lines from: `public/map/admin1-us-ca.json`, 64 outlines
 * across the lower 48 and Canada. Where a border IS does not change. It is
 * reference data, not live data, and this project's rule for reference data is
 * that it gets prebuilt into `public/map/` and bundled rather than fetched —
 * exactly as `lakes-us-ca.json` is bundled into the server.
 *
 * The alternative was reverse geocoding every campground through somebody
 * else's rate limit, or guessing the province from whichever bounding box the
 * query happened to use. The second is the one this replaces, and it is wrong
 * along every border in the coverage area — bounding boxes overlap, real
 * borders do not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT SAY
 * ---------------------------------------------------------------------------
 *
 * `admin1At` returns null rather than a nearest guess when a point falls
 * outside every outline — offshore, over a lake, in Mexico, or in the gaps a
 * simplified outline leaves along a coast. Null means "we do not know which
 * province this is", which is a true statement and a usable one. A wrong
 * province on a campsite card is neither.
 */
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import admin1Data from '../public/map/admin1-us-ca.json' with { type: 'json' };

export interface Admin1 {
  /** "British Columbia", "Montana". */
  name: string;
  /** "Canada" or "United States". */
  country: string;
  /** "CA-BC", "US-MT". */
  isoCode: string;
}

export interface Admin1Region extends Admin1 {
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

type Ring = [number, number][];

interface Entry {
  info: Admin1;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Every ring of every polygon. Holes are rare here and treated as solid. */
  rings: Ring[];
}

const ENTRIES: Entry[] = [];

const walkRings = (geometry: any, out: Ring[]): void => {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    (geometry.coordinates ?? []).forEach((r: Ring) => out.push(r));
  } else if (geometry.type === 'MultiPolygon') {
    (geometry.coordinates ?? []).forEach((poly: Ring[]) =>
      poly.forEach((r) => out.push(r))
    );
  }
};

for (const feature of ((admin1Data as any)?.features ?? []) as any[]) {
  const p = feature?.properties ?? {};
  if (!p.name || !p.country) continue;

  const rings: Ring[] = [];
  walkRings(feature.geometry, rings);
  if (!rings.length) continue;

  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }

  ENTRIES.push({
    info: {
      name: String(p.name),
      // Natural Earth spells it "United States of America"; the campsites
      // table already holds "United States", so normalise once, here.
      country: String(p.country) === 'Canada' ? 'Canada' : 'United States',
      isoCode: String(p.isoCode ?? '')
    },
    bbox: { minLat, minLon, maxLat, maxLon },
    rings
  });
}

/** A guard against a silently empty or reshaped asset. */
export const admin1Known = (): number => ENTRIES.length;

/** Standard ray casting. Rings are `[lon, lat]`, as GeoJSON requires. */
const inRing = (lat: number, lon: number, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * The state or province containing this point, or null when none does.
 *
 * The bounding-box test first is not an optimisation for its own sake: 64
 * outlines at Natural Earth's detail is a lot of segments to walk per
 * campground, and an ingest run does this thousands of times inside a
 * thirty-second function.
 */
export const admin1At = (lat: number, lon: number): Admin1 | null => {
  for (const entry of ENTRIES) {
    const b = entry.bbox;
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
    for (const ring of entry.rings) {
      if (inRing(lat, lon, ring)) return entry.info;
    }
  }
  return null;
};

/**
 * Every state and province, with its bounding box, ordered biggest first.
 *
 * The order is what makes a paged ingest predictable: the boxes that take the
 * longest to answer are met while the budget is whole, rather than being left
 * to the end where they are the ones that get cut off.
 */
export const admin1Regions = (): Admin1Region[] =>
  ENTRIES
    .map((e) => ({ ...e.info, bbox: e.bbox }))
    .sort((a, b) => {
      const area = (r: Admin1Region) =>
        (r.bbox.maxLat - r.bbox.minLat) * (r.bbox.maxLon - r.bbox.minLon);
      return area(b) - area(a);
    });
