import type { SurfaceQuality } from './scoutMode';

/**
 * Viewport bounds for fetching road segments.
 */
export interface ViewportBounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * A road segment with crowdsourced surface quality data.
 * Used by the Scout Paths feature.
 */
export interface ScoutRoadSegment {
  id: string;
  line: [number, number][];
  surface: SurfaceQuality;
  roughness: number;
  sampleCount: number;
  updatedAt: string;
  osmWayId: number | null;
}

/**
 * Response from the road segments API.
 */
export interface ScoutRoadSegmentsResponse {
  segments: ScoutRoadSegment[];
}

/**
 * Minimum zoom level to show Scout Paths.
 */
export const SCOUT_PATHS_MIN_ZOOM = 10;

/**
 * Surface type to display color mapping.
 */
export const SCOUT_SURFACE_COLOR: Record<SurfaceQuality, string> = {
  smooth_paved: '#10B981',
  rough_paved: '#84CC16',
  good_gravel: '#EAB308',
  washboard: '#F59E0B',
  rutted_dirt: '#F97316',
  rock_crawl: '#EF4444',
  impassable: '#7F1D1D',
};

/**
 * Surface type to human-readable label mapping.
 */
export const SCOUT_SURFACE_LABEL: Record<SurfaceQuality, string> = {
  smooth_paved: 'Smooth Pavement',
  rough_paved: 'Rough Pavement',
  good_gravel: 'Good Gravel',
  washboard: 'Washboard',
  rutted_dirt: 'Rutted Dirt',
  rock_crawl: 'Rock Crawling',
  impassable: 'Impassable',
};

/**
 * Fetch road segments within the current viewport.
 */
export const fetchScoutRoadSegments = async (
  bounds: ViewportBounds,
  signal?: AbortSignal
): Promise<ScoutRoadSegmentsResponse> => {
  try {
    const response = await fetch(
      `/api/road-segments?minLat=${bounds.minLat}&minLon=${bounds.minLon}&maxLat=${bounds.maxLat}&maxLon=${bounds.maxLon}`,
      { signal }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch road segments: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    // Return empty segments on error to fail gracefully
    return { segments: [] };
  }
};