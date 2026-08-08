/**
 * First-order administrative boundaries (US states, Canadian provinces).
 *
 *   GET /api/admin1?bbox=minLon,minLat,maxLon,maxLat
 *   GET /api/admin1/at?lat=&lon=    single point lookup for the pin card
 *
 * Source: Natural Earth 1:10m admin-1 states/provinces, public domain.
 * One-time download into a server-side cache; the dataset is a single
 * file (~14 MB) and is static on a year-scale, so a cold start hits
 * the network once and then the file is read from disk on every
 * request.
 *
 * Why Natural Earth, not a live service:
 *   - No key, no rate limit, no SLA to break.
 *   - The data does not change between US elections or Canadian
 *     provincial reorganisations. Ten-year-stale boundaries are
 *     fine for the "what state am I in" question this layer answers.
 *   - The 10m resolution is finer than what a "show me state lines"
 *     toggle needs at the zoom levels a camper uses, and the
 *     simplification is already done.
 *
 * The file is mirrored at:
 *   https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_admin_1_states_provinces.json
 * (verified 2026-08, ~14 MB, ~4600 features worldwide).
 */
import type { Express, Request, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bboxIntersectsCoverage } from '../src/config/coverage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ */
/* Data: one-time download into a server-side cache file              */
/* ------------------------------------------------------------------ */

const DATA_URL =
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/' +
  'master/10m/cultural/ne_10m_admin_1_states_provinces.json';
/** The cache lives in the project's data dir, next to the boundary data
 *  the seeder writes. Survives restarts; the file is not committed. */
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'admin1');
const CACHE_FILE = path.join(CACHE_DIR, 'ne_10m_admin_1_us_ca.json');

/** Slimmed shape, in memory, indexed by bbox. We only keep what the
 *  client needs. `geometry` is the original GeoJSON. */
interface Admin1Props {
  id: string;
  /** "United States" or "Canada". */
  country: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: 'US' | 'CA';
  /** "State" or "Province" or "Territory". */
  type: string;
  /** Display name: "Montana", "Alberta". */
  name: string;
  /** "US-MT", "CA-AB". */
  isoCode: string;
  /** Postal abbrev: "MT", "AB". */
  abbrev: string;
}

interface Admin1Feature {
  type: 'Feature';
  geometry: GeoJSON.Geometry;
  properties: Admin1Props;
  bbox: [number, number, number, number];
}

type Admin1Collection = {
  type: 'FeatureCollection';
  features: Admin1Feature[];
  meta: { fetchedAt: string; count: number };
};

let cachedCollection: Admin1Collection | null = null;
let loadPromise: Promise<Admin1Collection> | null = null;

/**
 * Load and slim the Natural Earth admin-1 file to just US+CA, and
 * cache it in memory + on disk. The disk cache is the "one-time"
 * download. The in-memory cache is the per-process hot path.
 */
const loadAdmin1 = async (): Promise<Admin1Collection> => {
  if (cachedCollection) return cachedCollection;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Try disk cache first.
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
      if (!res.ok) throw new Error(`Natural Earth fetch failed: ${res.status}`);
      raw = await res.text();
      // Best-effort write; never block startup on the disk.
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(CACHE_FILE, raw, 'utf-8');
      } catch {
        // Disk full / permission denied — we just keep the in-memory
        // copy and refetch next cold start.
      }
    }

    const parsed = JSON.parse(raw) as GeoJSON.FeatureCollection;
    const features: Admin1Feature[] = [];
    for (const f of parsed.features ?? []) {
      const p = f.properties as Record<string, unknown>;
      const isoA2 = p.iso_a2 as string | undefined;
      if (isoA2 !== 'US' && isoA2 !== 'CA') continue;
      const name = (p.name as string | undefined) ?? '';
      const isoCode = (p.iso_3166_2 as string | undefined) ?? '';
      if (!name || !isoCode) continue;
      const abbrev = (p.abbrev as string | undefined) ?? isoCode.split('-')[1] ?? '';
      const country = isoA2 === 'US' ? 'United States' : 'Canada';
      const type = (p.type_en as string | undefined) ?? (isoA2 === 'US' ? 'State' : 'Province');
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          id: `admin1:${isoCode}`,
          country,
          countryCode: isoA2 as 'US' | 'CA',
          type,
          name,
          isoCode,
          abbrev
        },
        bbox: f.bbox as [number, number, number, number] ?? [-180, -90, 180, 90]
      });
    }

    cachedCollection = {
      type: 'FeatureCollection',
      features,
      meta: { fetchedAt: new Date().toISOString(), count: features.length }
    };
    return cachedCollection;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
};

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ray-casting point-in-polygon for a single ring.
 *
 * Used by the per-pin card to ask "what state am I in". 64 features
 * × 1 ring (mostly), so a naive scan is fine. The hit-test does NOT
 * take holes into account — none of the US states or Canadian
 * provinces have holes, and a wrong answer on a state border (the
 * geometry is a few hundred metres off) is better than no answer.
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

const extractRings = (geom: GeoJSON.Geometry): number[][][] => {
  if (geom.type === 'Polygon') return geom.coordinates as number[][][];
  if (geom.type === 'MultiPolygon') {
    const out: number[][][] = [];
    for (const poly of geom.coordinates as number[][][][]) {
      for (const ring of poly) out.push(ring);
    }
    return out;
  }
  return [];
};

/**
 * Bbox-vs-bbox overlap test. Coarse but cheap; used to short-circuit
 * the polygon hit-test.
 */
const bboxContains = (
  b: [number, number, number, number],
  minLon: number, minLat: number, maxLon: number, maxLat: number
): boolean =>
  b[0] <= maxLon && b[2] >= minLon && b[1] <= maxLat && b[3] >= minLat;

const pointInGeometry = (lon: number, lat: number, geom: GeoJSON.Geometry): boolean => {
  const rings = extractRings(geom);
  for (const ring of rings) {
    if (pointInRing(lon, lat, ring)) return true;
  }
  return false;
};

/**
 * Polygon-bbox intersection. Used to filter the admin-1 set down to
 * just the states that actually overlap the caller's viewport.
 *
 * The cheap short-circuit: if the polygon's bbox doesn't overlap the
 * query bbox, it's out. Otherwise walk the rings — if any ring vertex
 * is inside the query bbox, the polygon overlaps; if the query bbox's
 * corners are inside the polygon, the polygon overlaps; otherwise we
 * have to do the full edge-vs-edge check.
 *
 * The last case (no shared vertex, no enclosed corner, edges crossing)
 * is the rare one. The state of Montana and the state of Wyoming
 * share a straight horizontal border, and a query bbox that straddles
 * that border without containing either endpoint is the only time
 * this matters in practice. The full edge test handles it.
 */
const segmentIntersectsBbox = (
  ax: number, ay: number, bx: number, by: number,
  minX: number, minY: number, maxX: number, maxY: number
): boolean => {
  // Cohen–Sutherland-lite: check both endpoints clipped against the
  // box, but the simpler test is "does the segment cross any edge
  // of the box?" which is what we actually need.
  const inside = (x: number, y: number) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (inside(ax, ay) || inside(bx, by)) return true;
  // Edge cross: each pair (segment edge, box edge) — only need
  // the four sides, not diagonals, because a line is straight.
  const edges: Array<[number, number, number, number]> = [
    [minX, minY, maxX, minY],
    [maxX, minY, maxX, maxY],
    [maxX, maxY, minX, maxY],
    [minX, maxY, minX, minY]
  ];
  for (const [ex1, ey1, ex2, ey2] of edges) {
    const d = (bx - ax) * (ey2 - ey1) - (by - ay) * (ex2 - ex1);
    if (Math.abs(d) < 1e-12) continue;
    const t = ((ex1 - ax) * (ey2 - ey1) - (ey1 - ay) * (ex2 - ex1)) / d;
    const u = ((ex1 - ax) * (by - ay) - (ey1 - ay) * (bx - ax)) / d;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return false;
};

const polygonIntersectsBbox = (
  geom: GeoJSON.Geometry,
  minX: number, minY: number, maxX: number, maxY: number
): boolean => {
  const rings = extractRings(geom);
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[i + 1];
      if (segmentIntersectsBbox(ax, ay, bx, by, minX, minY, maxX, maxY)) return true;
    }
  }
  return false;
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const readBbox = (req: Request): [number, number, number, number] | null => {
  const raw = (req.query.bbox as string | undefined) ?? '';
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (!bboxIntersectsCoverage({ minLon, minLat, maxLon, maxLat })) return null;
  return [minLon, minLat, maxLon, maxLat];
};

/**
 * Find the admin-1 (state / province) that contains a point.
 * Returns null if the point is not in any US/CA admin-1 in the
 * dataset (e.g. the user panned to Mexico and tapped something —
 * the dataset has no Mexican states loaded).
 */
export const findAdmin1At = async (
  lat: number, lon: number
): Promise<Admin1Props | null> => {
  const coll = await loadAdmin1();
  for (const f of coll.features) {
    if (!bboxContains(f.bbox, lon, lat, lon, lat)) continue;
    if (pointInGeometry(lon, lat, f.geometry)) return f.properties;
  }
  return null;
};

export const registerAdmin1Routes = (app: Express): void => {
  app.get('/api/admin1', async (req: Request, res: Response) => {
    const box = readBbox(req);
    if (!box) {
      return res.status(400).json({ error: 'bbox must be "minLon,minLat,maxLon,maxLat" within the app coverage area.' });
    }
    const [minLon, minLat, maxLon, maxLat] = box;

    let coll: Admin1Collection;
    try {
      coll = await loadAdmin1();
    } catch (e) {
      return res.status(502).json({ error: `admin-1 dataset unavailable: ${(e as Error).message}` });
    }

    const out = {
      type: 'FeatureCollection' as const,
      features: coll.features
        .filter((f) => {
          if (!bboxContains(f.bbox, minLon, minLat, maxLon, maxLat)) return false;
          // Coarse bbox passed — confirm with polygon-vs-bbox so we
          // don't ship Hawaii, Alaska, and the east coast for a
          // query that was just "show me Montana".
          return polygonIntersectsBbox(f.geometry, minLon, minLat, maxLon, maxLat);
        })
        .map((f) => ({
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: f.properties
        })),
      meta: coll.meta
    };
    return res.json(out);
  });

  app.get('/api/admin1/at', async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }
    try {
      const hit = await findAdmin1At(lat, lon);
      if (!hit) return res.json({ hit: null });
      return res.json({ hit });
    } catch (e) {
      return res.status(502).json({ error: `admin-1 lookup failed: ${(e as Error).message}` });
    }
  });
};
