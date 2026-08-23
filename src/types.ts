/**
 * Surface quality types for Scout Paths road surface classification.
 * Based on vertical acceleration variance from phone motion sensors.
 * Matches the surface_quality enum in the database.
 */
export type SurfaceQuality = 
  | 'smooth_paved' | 'rough_paved' | 'good_gravel'
  | 'washboard' | 'rutted_dirt' | 'rock_crawl' | 'impassable';

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

export type LandType = 'blm' | 'usfs' | 'state_forest' | 'dispersed' | 'crown_land';
