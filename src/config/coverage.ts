/**
 * Supported coverage area.
 *
 * Wandrlust currently only ships verified public-land boundary data for the
 * continental United States (lower 48) and the Canadian provinces. Everything
 * outside that region is masked grey on the map and excluded from
 * boundary/campsite queries, so we never imply coverage we don't have.
 *
 * WHY THE COVERAGE STOPS AT 60°N
 *
 * Yukon, the Northwest Territories and Nunavut were inside this outline and
 * should not have been. No territorial land dataset is wired into the seeder,
 * so the whole area north of 60° drew as "in coverage" while returning nothing
 * — and an empty map inside the coverage line reads as "no public land here",
 * which is the single worst thing this app can say. It is better to be honestly
 * out of scope than dishonestly in it. The territories come back when there is
 * real data behind them, and not before.
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
  minLon: -139.5,
  maxLat: 60.1,
  maxLon: -52.6
};

/**
 * Simplified outline of CONUS + the Canadian provinces, as [lon, lat] pairs.
 *
 * Deliberately excludes Alaska, Hawaii, Mexico, and — as of now — Yukon, NWT
 * and Nunavut, which is why the northern edge runs flat along 60°N.
 */
export const COVERAGE_OUTLINE: [number, number][] = [
  [-124.8, 48.4], [-124.4, 40.4], [-120.6, 34.5], [-117.2, 32.5],
  [-114.8, 32.5], [-111.1, 31.3], [-108.2, 31.3], [-106.5, 31.8],
  [-103.1, 29.0], [-101.4, 29.8], [-99.1, 26.4], [-97.1, 25.9],
  [-94.0, 29.7], [-89.0, 29.0], [-85.0, 29.7], [-82.9, 24.5], [-80.0, 25.2],
  [-81.0, 31.0], [-75.5, 35.2], [-70.0, 41.5], [-66.9, 44.8],
  [-59.0, 46.5], [-52.6, 47.5],
  // The 60th parallel: the southern edge of the three territories.
  [-52.6, 60.0], [-139.0, 60.0],
  [-130.0, 54.0], [-125.0, 48.4]
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

export const COVERAGE_LABEL = 'the lower 48 & the Canadian provinces';

/** Minimum zoom at which full-detail boundary polygons are fetched. */
export const BOUNDARY_MIN_ZOOM = 7;

/**
 * Below BOUNDARY_MIN_ZOOM the map draws an OVERVIEW instead of nothing.
 *
 * Zooming out used to blank every boundary, so the answer to "where is there
 * public land near here?" was an empty continent until you had already guessed
 * where to look. The overview shows only the big parcels, as hairlines, and —
 * because it is fetched on a coarse grid and cached for the session — it is
 * drawn once and then simply panned around, rather than refetched on every
 * gesture.
 */
export const BOUNDARY_OVERVIEW_MIN_ZOOM = 3;

/**
 * Smallest parcel, in km², worth drawing in the overview at a given zoom.
 *
 * At zoom 3 a 200 km² parcel is under a pixel across: drawing it costs a
 * network round trip and a draw call to produce a dot nobody can see or tap.
 * The threshold relaxes as you zoom in and hands over to the full-detail layer
 * at BOUNDARY_MIN_ZOOM.
 */
export const overviewMinAreaSqKm = (zoom: number): number => {
  if (zoom <= 3) return 4000;
  if (zoom <= 4) return 1500;
  if (zoom <= 5) return 500;
  return 150;
};

/**
 * Minimum zoom at which the cell layer loads.
 *
 * Lower than this the reach rings around each mast overlap into one wash of
 * colour across a whole state, which reads as "there is coverage everywhere"
 * — the opposite of what the data says. The layer stays off and the status
 * chip says to zoom in, exactly as the boundary layer does.
 */
export const CELL_MIN_ZOOM = 9;