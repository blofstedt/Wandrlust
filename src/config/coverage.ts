/**
 * Supported coverage area.
 *
 * Wandrlust currently only ships verified public-land boundary data for the
 * continental United States (lower 48) and Canada. Everything outside that
 * region is masked grey on the map and excluded from boundary/campsite
 * queries, so we never imply coverage we don't have.
 *
 * IMPORTANT: the outline below is a hand-simplified cartographic approximation
 * used purely to draw a UI mask. It is NOT a legal, political, or surveyed
 * border and must never be used to determine jurisdiction.
 */

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Fast rejection test before the more expensive polygon check. */
export const COVERAGE_BBOX: BoundingBox = {
  minLat: 24.4,
  minLon: -141.0,
  maxLat: 83.2,
  maxLon: -52.6
};

/**
 * Simplified outline of CONUS + Canada as [longitude, latitude] pairs.
 * Deliberately excludes Alaska, Hawaii, and Mexico.
 */
export const COVERAGE_OUTLINE: [number, number][] = [
  [-124.8, 48.4], [-124.4, 40.4], [-120.6, 34.5], [-117.2, 32.5],
  [-114.8, 32.5], [-111.1, 31.3], [-108.2, 31.3], [-106.5, 31.8],
  [-103.1, 29.0], [-101.4, 29.8], [-99.1, 26.4], [-97.1, 25.9],
  [-94.0, 29.7], [-89.0, 29.0], [-85.0, 29.7], [-82.9, 24.5], [-80.0, 25.2],
  [-81.0, 31.0], [-75.5, 35.2], [-70.0, 41.5], [-66.9, 44.8],
  [-59.0, 46.5], [-52.6, 47.5], [-52.6, 60.0],
  [-60.0, 83.2], [-141.0, 83.2],
  [-141.0, 60.0], [-139.0, 60.0], [-130.0, 54.0], [-125.0, 48.4]
];

/** World ring used as the outer boundary of the grey mask. */
export const WORLD_RING: [number, number][] = [
  [-180, -85], [180, -85], [180, 85], [-180, 85]
];

/** Ray-casting point-in-polygon test. */
const pointInRing = (lat: number, lon: number, ring: [number, number][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [lonI, latI] = ring[i];
    const [lonJ, latJ] = ring[j];
    const intersects =
      latI > lat !== latJ > lat &&
      lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI;
    if (intersects) inside = !inside;
  }
  return inside;
};

export const isWithinCoverage = (lat: number, lon: number): boolean => {
  if (
    lat < COVERAGE_BBOX.minLat || lat > COVERAGE_BBOX.maxLat ||
    lon < COVERAGE_BBOX.minLon || lon > COVERAGE_BBOX.maxLon
  ) return false;
  return pointInRing(lat, lon, COVERAGE_OUTLINE);
};

export const bboxIntersectsCoverage = (box: BoundingBox): boolean =>
  !(
    box.maxLat < COVERAGE_BBOX.minLat || box.minLat > COVERAGE_BBOX.maxLat ||
    box.maxLon < COVERAGE_BBOX.minLon || box.minLon > COVERAGE_BBOX.maxLon
  );

export const clampToCoverage = (box: BoundingBox): BoundingBox => ({
  minLat: Math.max(box.minLat, COVERAGE_BBOX.minLat),
  minLon: Math.max(box.minLon, COVERAGE_BBOX.minLon),
  maxLat: Math.min(box.maxLat, COVERAGE_BBOX.maxLat),
  maxLon: Math.min(box.maxLon, COVERAGE_BBOX.maxLon)
});

export const COVERAGE_LABEL = 'Continental USA & Canada';

/** Minimum zoom at which boundary polygons are fetched. */
export const BOUNDARY_MIN_ZOOM = 7;
