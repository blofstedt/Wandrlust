import { TtlCache } from '../utils/ttlCache';
import type { SurfaceQuality } from './scoutMode';

export interface ScoutRoadSegment {
  id: string;
  line: [number, number][];
  surface: SurfaceQuality;
  roughness: number;
  sampleCount: number;
  updatedAt: string;
  osmWayId: number | null;
}

export interface ScoutRoadSegmentScan {
  ok: boolean;
  segments: ScoutRoadSegment[];
  truncated: boolean;
}

const EMPTY: ScoutRoadSegmentScan = { ok: false, segments: [], truncated: false };

export const SCOUT_SURFACE_COLOR: Record<SurfaceQuality, string> = {
  smooth_paved: '#10B981',
  rough_paved: '#84CC16',
  good_gravel: '#EAB308',
  washboard: '#F59E0B',
  rutted_dirt: '#F97316',
  rock_crawl: '#EF4444',
  impassable: '#7F1D1D'
};

export const SCOUT_SURFACE_LABEL: Record<SurfaceQuality, string> = {
  smooth_paved: 'Smooth pavement',
  rough_paved: 'Rough pavement',
  good_gravel: 'Good gravel',
  washboard: 'Washboard',
  rutted_dirt: 'Rutted dirt',
  rock_crawl: 'Rock crawling',
  impassable: 'Impassable'
};

const segmentCache = new TtlCache<ScoutRoadSegmentScan>(10 * 60 * 1000, 40);

export interface ViewportBounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export const fetchScoutRoadSegments = async (
  bounds: ViewportBounds,
  signal?: AbortSignal
): Promise<ScoutRoadSegmentScan> => {
  const cacheKey = bounds.minLat.toFixed(2) + ',' + bounds.minLon.toFixed(2) + ',' + bounds.maxLat.toFixed(2) + ',' + bounds.maxLon.toFixed(2);
  const cached = segmentCache.get(cacheKey);
  if (cached) return cached;
  try {
    const params = new URLSearchParams({
      minLat: bounds.minLat.toFixed(5),
      minLon: bounds.minLon.toFixed(5),
      maxLat: bounds.maxLat.toFixed(5),
      maxLon: bounds.maxLon.toFixed(5)
    });
    const res = await fetch('/api/road-segments?' + params, { signal });
    if (!res.ok) {
      if (res.status === 404) console.warn('[scout-paths] /api/road-segments endpoint not found.');
      return EMPTY;
    }
    const data = await res.json();
    if (data?.ok === true && Array.isArray(data.segments)) {
      const scan: ScoutRoadSegmentScan = {
        ok: true,
        segments: data.segments.map((s: any) => ({
          id: s.id,
          line: s.line,
          surface: s.surface,
          roughness: s.roughness,
          sampleCount: s.sampleCount,
          updatedAt: s.updatedAt,
          osmWayId: s.osmWayId
        })),
        truncated: data.truncated ?? false
      };
      segmentCache.set(cacheKey, scan);
      return scan;
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
};

export const SCOUT_PATHS_MIN_ZOOM = 10;
export const shouldShowScoutPaths = (zoom: number): boolean => zoom >= SCOUT_PATHS_MIN_ZOOM;