import type { SurfaceQuality } from './services/scoutMode';

/**
 * Scout Paths Configuration
 * 
 * Central configuration for the Scout Paths feature (road surface mapping).
 */

// Minimum zoom level to show Scout Paths
export const SCOUT_PATHS_MIN_ZOOM = 10;

// Should Scout Paths be shown at current zoom level
export const shouldShowScoutPaths = (zoom: number): boolean => zoom >= SCOUT_PATHS_MIN_ZOOM;

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
 * Surface type to description for tooltips.
 */
export const SCOUT_SURFACE_DESCRIPTION: Record<SurfaceQuality, string> = {
  smooth_paved: 'Smooth paved road - suitable for any vehicle',
  rough_paved: 'Rough paved road - may have potholes or cracks',
  good_gravel: 'Well-maintained gravel - suitable for most vehicles',
  washboard: 'Washboard gravel - bumpy, reduce speed',
  rutted_dirt: 'Rutted dirt road - high clearance recommended',
  rock_crawl: 'Rock crawling terrain - 4WD and high clearance required',
  impassable: 'Impassable - blocked or extremely rough',
};

/**
 * Line styling for different surface types.
 */
export const SCOUT_SURFACE_STROKE: Record<SurfaceQuality, string | null> = {
  smooth_paved: null,
  rough_paved: '5,3',
  good_gravel: '3,2',
  washboard: '8,4,2,4',
  rutted_dirt: '10,5',
  rock_crawl: '15,10',
  impassable: '2,2',
};

/**
 * Line width for different surface types.
 */
export const SCOUT_SURFACE_WEIGHT: Record<SurfaceQuality, number> = {
  smooth_paved: 3,
  rough_paved: 3,
  good_gravel: 3,
  washboard: 4,
  rutted_dirt: 2,
  rock_crawl: 5,
  impassable: 1,
};

/**
 * Opacity based on sample count (confidence level).
 */
export const getOpacityForSampleCount = (sampleCount: number): number => {
  if (sampleCount >= 20) return 1.0;
  if (sampleCount >= 10) return 0.9;
  if (sampleCount >= 5) return 0.7;
  if (sampleCount >= 3) return 0.5;
  return 0.3;
};

/**
 * Points awarded for different Scout actions.
 */
export const SCOUT_POINTS = {
  NEW_ROAD: 25,
  EXISTING_ROAD: 5,
  DAILY_CAP_NEW: 6,
  DAILY_CAP_EXISTING: 12,
  DAILY_TOTAL_CAP: 18,
};

/**
 * Thresholds for surface classification based on vertical variance.
 */
export const SURFACE_VARIANCE_THRESHOLDS = {
  SMOOTH_PAVED: 0.35,
  ROUGH_PAVED: 1.2,
  GOOD_GRAVEL: 3.0,
  WASHBOARD: 7.0,
  RUTTED_DIRT: 15.0,
  ROCK_CRAWL: 30.0,
};