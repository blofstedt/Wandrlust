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

/**
 * Fast rejection test before the more expensive polygon check.
 *
 * Also the Leaflet `maxBounds` rectangle — the box the user can pan
 * inside and cannot pan out of. Trimmed at -130° (was -139.5) so
 * Alaska's panhandle doesn't pull the bounding box across the
 * Pacific; everything else is the same as before. St John's at
 * ~-52.7 still sits inside this rectangle (the east edge is -52.0).
 */
export const COVERAGE_BBOX: BoundingBox = {
  minLat: 24.4,
  minLon: -130.0,
  maxLat: 60.1,
  // Pushed east to -52.0 so the box no longer clips the Avalon Peninsula —
  // St John's sits at ~-52.7 and was falling just outside the old -52.6 edge.
  maxLon: -52.0
};

/* ------------------------------------------------------------------ */
/* The map's viewing frame                                             */
/* ------------------------------------------------------------------ */

/**
 * Web Mercator latitude projection, in degree-equivalent units.
 *
 * The map is Mercator, so a degree of longitude is a fixed number of
 * screen pixels but a degree of latitude is not — one degree near the
 * Mexican border is a good deal shorter on screen than one degree in
 * northern Quebec. Padding the coverage box by a flat number of
 * degrees therefore produces a frame that LOOKS lopsided: a fat
 * margin along the bottom edge and a thin one along the top. Padding
 * in projected space and converting back is what makes the four
 * margins actually match on screen.
 */
const mercatorY = (lat: number): number =>
  (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

const inverseMercatorY = (y: number): number =>
  (360 / Math.PI) * Math.atan(Math.exp((y * Math.PI) / 180)) - 90;

/**
 * How much breathing room to leave around the coverage area, as a
 * fraction of the frame's longest side. Big enough that the coastlines
 * aren't jammed against the edge of the screen, small enough that the
 * continent still dominates the view.
 */
const VIEW_PAD_FRACTION = 0.06;

const viewPad = VIEW_PAD_FRACTION * Math.max(
  COVERAGE_BBOX.maxLon - COVERAGE_BBOX.minLon,
  mercatorY(COVERAGE_BBOX.maxLat) - mercatorY(COVERAGE_BBOX.minLat)
);

/**
 * The rectangle the map lives inside — Leaflet's `maxBounds`, and the
 * frame the user sees when fully zoomed out.
 *
 * This is DELIBERATELY NOT `COVERAGE_BBOX`. They answer different
 * questions and conflating them is what made the map feel wrong:
 *
 *   - `COVERAGE_BBOX` is a claim about DATA — "inside here we have
 *     something to say". It gates queries and the point-in-coverage
 *     test, and it must stay tight, because widening it would widen
 *     what the app implies it knows.
 *   - `MAP_VIEW_BBOX` is a claim about the VIEW — "this is the part
 *     of the world worth looking at". It wants margin, because a
 *     continent shoved against the edge of the viewport looks like a
 *     rendering bug rather than a decision.
 *
 * The margin is equal on all four sides in projected space, so the
 * gap above Canada, below Texas, west of the Pacific coast and east
 * of Newfoundland are the same width on screen.
 */
export const MAP_VIEW_BBOX: BoundingBox = {
  minLon: COVERAGE_BBOX.minLon - viewPad,
  maxLon: COVERAGE_BBOX.maxLon + viewPad,
  minLat: inverseMercatorY(mercatorY(COVERAGE_BBOX.minLat) - viewPad),
  maxLat: inverseMercatorY(mercatorY(COVERAGE_BBOX.maxLat) + viewPad)
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
  [-81.0, 31.0], [-75.5, 35.2], [-70.0, 41.5],
  // Down the Gulf of Maine and AROUND Nova Scotia, which the old straight
  // hop from New Brunswick to Newfoundland sliced clean through — the whole
  // southern half of the province was being greyed out.
  [-67.3, 44.8],   // New Brunswick / Maine coast
  [-66.4, 43.7],   // Bay of Fundy mouth
  [-65.8, 43.3],   // Cape Sable — the southern tip of Nova Scotia
  [-62.0, 44.3],   // Nova Scotia south shore
  [-59.7, 45.4],   // Canso, toward Cape Breton
  [-59.6, 47.1],   // Cape Breton north into the Cabot Strait
  // ...then Newfoundland, which was likewise cut off at its western edge.
  [-59.4, 47.6],   // south coast approach
  [-55.4, 46.7],   // Burin / south coast
  [-52.6, 46.6],   // Cape Race
  [-52.2, 47.6],   // Cape Spear / St John's, kept inside the mask
  [-52.2, 51.6],   // up the east coast
  [-55.6, 51.7],   // Strait of Belle Isle
  // The 60th parallel: the southern edge of the three territories.
  [-56.0, 60.0], [-139.0, 60.0],
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
export const BOUNDARY_OVERVIEW_MIN_ZOOM = 2;

/**
 * Smallest parcel, in km², worth drawing in the overview at a given zoom.
 *
 * At zoom 3 a 200 km² parcel is under a pixel across: drawing it costs a
 * network round trip and a draw call to produce a dot nobody can see or tap.
 * The threshold relaxes as you zoom in and hands over to the full-detail layer
 * at BOUNDARY_MIN_ZOOM.
 */
export const overviewMinAreaSqKm = (zoom: number): number => {
  // Zoomed fully out, only the continent-scale blocks are worth a draw call —
  // but there ARE some, so the map is never blank at minimum zoom.
  if (zoom <= 2) return 8000;
  if (zoom <= 3) return 4000;
  if (zoom <= 4) return 1500;
  if (zoom <= 5) return 500;
  return 150;
};

