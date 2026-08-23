import type { Express, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('roadSegmentRoutes requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export type SurfaceQuality = 'smooth_paved' | 'rough_paved' | 'good_gravel' | 'washboard' | 'rutted_dirt' | 'rock_crawl' | 'impassable';

export interface RoadSegment {
  id: string;
  line: [number, number][];
  surface: SurfaceQuality;
  roughness: number;
  sampleCount: number;
  updatedAt: string;
  osmWayId: number | null;
}

export interface RoadSegmentScan {
  ok: boolean;
  segments: RoadSegment[];
  truncated: boolean;
}

const EMPTY: RoadSegmentScan = { ok: false, segments: [], truncated: false };

interface CacheEntry { at: number; scan: RoadSegmentScan; }
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 60;
const cache = new Map<string, CacheEntry>();

const cacheGet = (key: string): RoadSegmentScan | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.scan;
};

const cacheSet = (key: string, scan: RoadSegmentScan): void => {
  if (!scan.ok) return;
  if (cache.size >= CACHE_MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
  cache.set(key, { at: Date.now(), scan });
};

const varianceToSurface = (variance: number): SurfaceQuality => {
  if (variance < 0.35) return 'smooth_paved';
  if (variance < 1.2) return 'rough_paved';
  if (variance < 3.0) return 'good_gravel';
  if (variance < 7.0) return 'washboard';
  if (variance < 15.0) return 'rutted_dirt';
  if (variance < 30.0) return 'rock_crawl';
  return 'impassable';
};

const surfaceToRoughness = (surface: SurfaceQuality): number => ({
  smooth_paved: 10, rough_paved: 30, good_gravel: 50,
  washboard: 70, rutted_dirt: 85, rock_crawl: 95, impassable: 100
}[surface] ?? 50);

const simplify = (points: [number, number][], tolerance = 0.0001): [number, number][] => {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const ax = points[first][1], ay = points[first][0];
    const bx = points[last][1], by = points[last][0];
    const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
    let worstDistSq = -1, worstIndex = first;
    for (let i = first + 1; i < last; i++) {
      const px = points[i][1], py = points[i][0];
      let distSq: number;
      if (lenSq === 0) distSq = (px - ax) ** 2 + (py - ay) ** 2;
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)); const cx = ax + t * dx, cy = ay + t * dy; distSq = (px - cx) ** 2 + (py - cy) ** 2; }
      if (distSq > worstDistSq) { worstDistSq = distSq; worstIndex = i; }
    }
    if (worstDistSq > tolerance * tolerance) { keep[worstIndex] = 1; stack.push([first, worstIndex], [worstIndex, last]); }
  }
  return points.filter((_, i) => keep[i]);
};

const geomToLine = (geom: any): [number, number][] | null => {
  if (!geom?.coordinates) return null;
  return geom.coordinates.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
};

const fetchSegmentsInBox = async (minLat: number, minLon: number, maxLat: number, maxLon: number): Promise<RoadSegment[]> => {
  // PostGIS bbox overlap on the geometry column. `.withinBounds` is not a
  // supabase-js method; `st_intersects` with the envelope WKT is the standard
  // PostgREST way to ask "which linestrings touch this box".
  const bboxWkt = `SRID=4326;POLYGON((${minLon} ${minLat},${maxLon} ${minLat},${maxLon} ${maxLat},${minLon} ${maxLat},${minLon} ${minLat}))`;
  const { data, error } = await supabaseAdmin
    .from('road_segments')
    .select('id, geom, surface, roughness_index, sample_count, osm_way_id, updated_at')
    .filter('geom', 'st_intersects', bboxWkt)
    .lte('sample_count', 1000)
    .order('updated_at', { ascending: false });
  if (error) { console.error('[road-segments] DB error:', error.message); return []; }
  if (!Array.isArray(data)) return [];
  return data.map(row => {
    const line = geomToLine(row.geom);
    if (!line || line.length < 2) return null;
    const simplified = simplify(line, 0.0002);
    if (simplified.length < 2) return null;
    const dbSurface = row.surface as string | null;
    const validSurfaces: SurfaceQuality[] = ['smooth_paved','rough_paved','good_gravel','washboard','rutted_dirt','rock_crawl','impassable'];
    const surface: SurfaceQuality = dbSurface && validSurfaces.includes(dbSurface as SurfaceQuality) ? dbSurface as SurfaceQuality : varianceToSurface(row.roughness_index ?? 0);
    return { id: String(row.id), line: simplified, surface, roughness: surfaceToRoughness(surface), sampleCount: Number(row.sample_count ?? 0), updatedAt: row.updated_at ?? new Date().toISOString(), osmWayId: row.osm_way_id ? Number(row.osm_way_id) : null };
  }).filter(Boolean) as RoadSegment[];
};

const MAX_BOX_DEGREES = 5.0;
const MAX_SEGMENTS = 500;

export const registerRoadSegmentRoutes = (app: Express): void => {
  app.get('/api/road-segments', async (req: Request, res: Response) => {
    const nums = ['minLat', 'minLon', 'maxLat', 'maxLon'].map(k => parseFloat(req.query[k] as string));
    if (nums.some(n => !Number.isFinite(n))) return res.status(400).json({ ...EMPTY, message: 'minLat, minLon, maxLat and maxLon are required numeric query params.' });
    const [minLat, minLon, maxLat, maxLon] = nums;
    if (maxLat <= minLat || maxLon <= minLon) return res.status(400).json({ ...EMPTY, message: 'Box is inside out.' });
    const latSpan = maxLat - minLat, lonSpan = maxLon - minLon;
    if (latSpan * lonSpan > MAX_BOX_DEGREES * MAX_BOX_DEGREES) return res.status(400).json({ ...EMPTY, message: 'Box too large. Max 5 degrees per side.' });
    const key = [minLat, minLon, maxLat, maxLon].map(v => Math.round(v * 100) / 100).join(',');
    const cached = cacheGet(key);
    if (cached) { res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400'); return res.json(cached); }
    try {
      const segments = await fetchSegmentsInBox(minLat, minLon, maxLat, maxLon);
      const truncated = segments.length > MAX_SEGMENTS;
      const scan: RoadSegmentScan = { ok: true, segments: truncated ? segments.slice(0, MAX_SEGMENTS) : segments, truncated };
      cacheSet(key, scan);
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
      return res.json(scan);
    } catch (err: any) {
      console.error('[road-segments] Error:', err.message);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).json({ ...EMPTY, message: err.message || 'Failed to fetch road segments' });
    }
  });
};