import type { FilterState, LandType, RoadAccess } from '../types';

/**
 * Filter defaults, in one place.
 *
 * These were duplicated across App.tsx (initial state), the reset handler, the
 * "active filter count" badge, and the empty-state button — with the distance
 * default set to 500 while the slider only went to 150, so the badge claimed a
 * filter was active that the user could not clear. One source of truth fixes
 * that class of bug permanently.
 */

export const ALL_LAND_TYPES: LandType[] = [
  'blm', 'usfs', 'state_forest', 'dispersed', 'crown_land'
];

export const DISTANCE_MIN_MILES = 5;
export const DISTANCE_MAX_MILES = 500;

export const DEFAULT_FILTERS: Omit<FilterState, 'searchQuery'> = {
  landTypes: ALL_LAND_TYPES,
  waterOnly: false,
  toiletOnly: false,
  cellSignalOnly: false,
  petFriendlyOnly: false,
  rigLengthMinFt: 0,
  roadAccessMax: 'all',
  maxDistanceMiles: 100,
  sortBy: 'distance'
};

export const createDefaultFilters = (searchQuery = ''): FilterState => ({
  searchQuery,
  ...DEFAULT_FILTERS,
  landTypes: [...ALL_LAND_TYPES]
});

/** Ordered loosest -> strictest, so a rig can be compared against a ceiling. */
export const ROAD_ACCESS_RANK: Record<RoadAccess, number> = {
  paved: 0, gravel: 1, high_clearance: 2, '4x4_only': 3
};

export const ROAD_ACCESS_LABEL: Record<RoadAccess | 'all', string> = {
  all: 'Any road',
  paved: 'Paved only',
  gravel: 'Gravel or better',
  high_clearance: 'High clearance OK',
  '4x4_only': 'Anything, including 4x4'
};

/** How many filters differ from the defaults — drives the badge on the nav. */
export const countActiveFilters = (state: FilterState): number => {
  let count = 0;
  if (state.landTypes.length !== ALL_LAND_TYPES.length) count += 1;
  if (state.waterOnly) count += 1;
  if (state.toiletOnly) count += 1;
  if (state.cellSignalOnly) count += 1;
  if (state.petFriendlyOnly) count += 1;
  if (state.rigLengthMinFt !== DEFAULT_FILTERS.rigLengthMinFt) count += 1;
  if (state.roadAccessMax !== DEFAULT_FILTERS.roadAccessMax) count += 1;
  if (state.maxDistanceMiles !== DEFAULT_FILTERS.maxDistanceMiles) count += 1;
  return count;
};
