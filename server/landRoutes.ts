/**
 * Land-vs-water hit test.
 *
 *   GET /api/land/at?lat=&lon=
 *
 *   Returns `{ onLand: true }` if the point is on a continent or
 *   major island, `{ onLand: false }` otherwise. Used by the map to
 *   refuse a pin that lands in a lake, a bay, or the open ocean —
 *   a pin in the water is never a useful destination for a camper.
 *
 * Source: Natural Earth 1:110m land polygons. Public domain.
 * 127 polygons covering every continent and the major islands
 * (Hawaii, the Aleutians, the Caribbean chain, Madagascar, the
 * UK, Japan, Indonesia, New Zealand, etc.). Coarse but fine for
 * the question this answers.
 *
 *   https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json
 *   (verified 2026-08, ~150 KB, 127 features)
 *
 * CAVEAT: at 110m resolution, Natural Earth's land polygons treat
 * the Great Lakes and a few other big inland water bodies as part
 * of the continent — a point in the centre of Lake Superior reads
 * as 'on land' from this layer alone. For a pin-drop check, that
 * is the wrong answer. We override with a hand-curated list of
 * 'but actually water' polygons for the lakes the user is most
 * likely to drop a pin in: the five Great Lakes, Lake Winnipeg,
 * Great Bear Lake, and Great Slave Lake. Anything else is the
 * 110m land layer's problem to get right; these are the ones we
 * know are wrong.
 *
 * The 110m resolution is the right level here for everything
 * outside the override list. The 10m land layer would be more
 * accurate but is 18 MB; the override list is 8 polygons and a
 * few hundred bytes.
 */
import type { Express, Request, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_URL =
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/' +
  'master/110m/physical/ne_110m_land.json';
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'land');
const CACHE_FILE = path.join(CACHE_DIR, 'ne_110m_land.json');

/* ------------------------------------------------------------------ */
/* Override polygons: lakes the 110m layer treats as land but aren't  */
/* ------------------------------------------------------------------ */

/**
 * Hand-curated lake polygons. The five Great Lakes, Lake Winnipeg,
 * Great Bear Lake, and Great Slave Lake. Each is a single closed
 * ring, [lon, lat] pairs, traced at a level coarse enough to be
 * obviously 'this is the lake' without being a survey product. If
 * a user taps in the middle of one of these, the pin is refused.
 */
const LAKE_OVERRIDES: number[][][] = [
  // Lake Superior — the biggest by area.
  [[-92.0, 47.5], [-91.5, 46.5], [-90.5, 46.7], [-89.5, 47.0],
   [-88.0, 47.5], [-86.5, 47.0], [-85.5, 46.8], [-85.0, 47.5],
   [-86.0, 48.0], [-87.5, 48.3], [-89.0, 48.5], [-90.5, 48.4],
   [-91.5, 48.2], [-92.0, 47.8], [-92.0, 47.5]],
  // Lake Michigan — entirely inside the US.
  [[-88.0, 46.0], [-87.5, 45.5], [-86.8, 45.0], [-86.0, 44.5],
   [-86.2, 43.5], [-86.5, 42.5], [-87.0, 42.0], [-87.5, 41.8],
   [-87.7, 42.5], [-87.8, 43.0], [-88.0, 44.0], [-88.0, 46.0]],
  // Lake Huron (with Georgian Bay simplified out — that is fine,
  // the rest of the lake is the part the user might tap in).
  [[-84.5, 46.0], [-83.0, 45.5], [-82.0, 44.5], [-81.5, 43.5],
   [-82.0, 43.0], [-82.5, 43.0], [-83.0, 43.5], [-83.5, 44.5],
   [-84.0, 45.5], [-84.5, 46.0]],
  // Lake Erie.
  [[-83.5, 42.8], [-82.5, 42.0], [-81.0, 41.5], [-79.5, 41.8],
   [-78.9, 42.5], [-79.0, 43.0], [-80.0, 42.9], [-82.0, 42.8],
   [-83.0, 42.9], [-83.5, 42.8]],
  // Lake Ontario.
  [[-79.5, 43.5], [-78.0, 43.3], [-77.0, 43.4], [-76.0, 43.7],
   [-76.0, 44.0], [-77.0, 44.0], [-78.5, 43.9], [-79.5, 43.7],
   [-79.5, 43.5]],
  // Lake Winnipeg — big lake in Manitoba.
  [[-99.0, 52.5], [-97.0, 53.0], [-96.0, 52.5], [-96.0, 51.0],
   [-97.5, 50.0], [-99.0, 50.5], [-99.5, 51.5], [-99.0, 52.5]],
  // Great Bear Lake — NWT, north of the coverage box but on the
  // boundary. Cheap to add.
  [[-124.0, 66.0], [-122.0, 65.5], [-120.0, 65.0], [-119.0, 65.5],
   [-120.0, 66.0], [-122.0, 66.2], [-124.0, 66.0]],
  // Great Slave Lake — NWT, also near the boundary.
  [[-115.5, 62.0], [-113.0, 62.5], [-111.0, 62.3], [-111.5, 61.0],
   [-113.5, 60.5], [-115.5, 61.0], [-115.5, 62.0]]
];

/** Bbox of an override ring, for the same cheap pre-filter the
 *  land polygons use. */
const overrideBboxes: Array<[number, number, number, number]> = LAKE_OVERRIDES.map((ring) => {
  let minLon = Infinity, minLat = Infinity;
  let maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
});

/* ------------------------------------------------------------------ */
/* Land polygons: Natural Earth 110m                                   */
/* ------------------------------------------------------------------ */

interface CachedLand {
  /** Coarse bbox for fast pre-filter. [minLon, minLat, maxLon, maxLat] */
  polygons: Array<{ bbox: [number, number, number, number]; rings: number[][][] }>;
  fetchedAt: string;
}

let cached: CachedLand | null = null;
let loadPromise: Promise<CachedLand> | null = null;

const loadLand = async (): Promise<CachedLand> => {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(CACHE_FILE, 'utf-8');
    } catch {
      raw = null;
    }

    if (!raw) {
      const res = await fetch(DATA_URL, {
        signal: AbortSignal.timeout(60_000),
        headers: { 'User-Agent': 'Wandrlust/1.0 (camping map)' }
      });
      if (!res.ok) throw new Error(`Natural Earth land fetch failed: ${res.status}`);
      raw = await res.text();
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(CACHE_FILE, raw, 'utf-8');
      } catch {
        // Disk write is best-effort. The in-memory copy keeps
        // the app working.
      }
    }

    const parsed = JSON.parse(raw) as GeoJSON.FeatureCollection;
    const polygons: CachedLand['polygons'] = [];
    for (const f of parsed.features ?? []) {
      const geom = f.geometry as GeoJSON.Geometry | undefined;
      if (!geom) continue;
      const rings: number[][][] = [];
      if (geom.type === 'Polygon') {
        for (const ring of geom.coordinates as number[][][]) rings.push(ring);
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates as number[][][][]) {
          for (const ring of poly) rings.push(ring);
        }
      }
      if (!rings.length) continue;

      // Bbox of the outer ring of the first polygon in the feature.
      // Looser than a true polygon-vs-bbox but cheap, and the
      // 110m resolution is forgiving anyway.
      const outer = rings[0];
      let minLon = Infinity, minLat = Infinity;
      let maxLon = -Infinity, maxLat = -Infinity;
      for (const [lon, lat] of outer) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      polygons.push({
        bbox: [minLon, minLat, maxLon, maxLat],
        rings
      });
    }

    cached = { polygons, fetchedAt: new Date().toISOString() };
    return cached;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
};

/**
 * Ray-casting point-in-polygon for a single ring. Same test the
 * admin-1 route uses, copied so the two routes are independent.
 */
const pointInRing = (lon: number, lat: number, ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * Is the point inside one of the override lakes? (The lakes that
 * 110m land treats as land but actually are water.) Cheap test
 * — eight polygons, each with one ring of 8-15 vertices.
 */
const isInOverrideLake = (lon: number, lat: number): boolean => {
  for (let i = 0; i < LAKE_OVERRIDES.length; i++) {
    const [minLon, minLat, maxLon, maxLat] = overrideBboxes[i];
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (pointInRing(lon, lat, LAKE_OVERRIDES[i])) return true;
  }
  return false;
};

/**
 * Is the point on land?
 *
 * Returns false if the point is in the open ocean, in a bay, in
 * a small lake the 110m land layer did classify as water, or in
 * one of the big lakes (Great Lakes, Lake Winnipeg) that 110m
 * land mistakenly classified as land. Returns true if the point
 * is on any continent or major island.
 *
 * The override check runs first because it is the only place
 * the 110m layer is wrong inside the coverage area; everything
 * else is a single bbox + point-in-polygon pass.
 */
export const isOnLand = async (lat: number, lon: number): Promise<boolean> => {
  if (isInOverrideLake(lon, lat)) return false;
  const data = await loadLand();
  for (const poly of data.polygons) {
    const [minLon, minLat, maxLon, maxLat] = poly.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    for (const ring of poly.rings) {
      if (pointInRing(lon, lat, ring)) return true;
    }
  }
  return false;
};

export const registerLandRoutes = (app: Express): void => {
  app.get('/api/land/at', async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }
    try {
      const onLand = await isOnLand(lat, lon);
      return res.json({ onLand });
    } catch (e) {
      return res.status(502).json({ error: `land lookup failed: ${(e as Error).message}` });
    }
  });
};
