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
 * THIS RECTANGLE MUST CONTAIN `COVERAGE_OUTLINE`. It is a cheap
 * pre-filter, nothing more — the outline is the authority on what is
 * covered. When the box is tighter than the outline it silently
 * rejects places the outline says are in scope, and it drags the
 * viewing frame in with it so the corner of the coverage area is
 * clipped off the edge of the screen.
 *
 * That is exactly what the old -130° west edge did. It was trimmed
 * there to keep Alaska's panhandle from pulling the box across the
 * Pacific, but the outline still ran out to -139° along the 60th
 * parallel, so the whole northwest corner of British Columbia — Atlin,
 * the Stikine, Haida Gwaii — tested as "outside coverage" and the map
 * could never be panned or zoomed far enough west to show it.
 *
 * The west edge now matches the outline's own westernmost point: the
 * BC / Yukon / Alaska corner at roughly -139°. Nothing about what the
 * app claims to know has changed; the polygon test below still decides
 * that, and it still excludes Alaska.
 */
export const COVERAGE_BBOX: BoundingBox = {
  minLat: 24.4,
  minLon: -139.1,
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
  [-56.0, 60.0], [-139.1, 60.0],
  /*
   * DOWN THE BC COAST, not straight across it.
   *
   * The old outline hopped from (-139, 60) to (-130, 54) in one
   * segment. That line is a diagonal drawn through British Columbia:
   * it cut the corner off the northwest of the province, sliced
   * Haida Gwaii off entirely and left Prince Rupert sitting in the
   * grey. The coast is followed properly now — south along the
   * Alaska panhandle border, out around Haida Gwaii, then down the
   * outer edge of Vancouver Island.
   */
  [-136.4, 59.4],   // panhandle border, Yakutat side
  [-134.6, 58.5],
  [-133.0, 57.4],
  [-131.6, 56.4],
  [-130.1, 55.3],   // head of the Portland Canal
  [-130.2, 54.7],   // Dixon Entrance, north of Prince Rupert
  [-133.4, 54.2],   // Haida Gwaii, north tip
  [-133.1, 52.9],   // Haida Gwaii, west shore
  [-131.0, 51.9],   // Cape St James, south tip
  [-128.4, 51.0],   // central mainland coast
  [-128.6, 50.7],   // Cape Scott, north end of Vancouver Island
  [-126.3, 49.2],   // Vancouver Island, west shore
  [-125.1, 48.5]    // Barkley Sound, closing to Cape Flattery
];

/** World ring used as the outer boundary of the grey mask. */
export const WORLD_RING: [number, number][] = [
  [-180, -85], [180, -85], [180, 85], [-180, 85]
];

/**
 * `MAP_VIEW_BBOX` as a ring, for the solid backdrop outside the frame.
 *
 * Map tiles are only fetched inside the frame, so on a screen whose
 * shape doesn't match the frame's there is a band along two edges with
 * no imagery in it at all. Filling that band with the same flat colour
 * the map container uses turns "tiles that failed to load" into a clean
 * matte around the map, which is what it actually is.
 */
export const VIEW_RING: [number, number][] = [
  [MAP_VIEW_BBOX.minLon, MAP_VIEW_BBOX.minLat],
  [MAP_VIEW_BBOX.maxLon, MAP_VIEW_BBOX.minLat],
  [MAP_VIEW_BBOX.maxLon, MAP_VIEW_BBOX.maxLat],
  [MAP_VIEW_BBOX.minLon, MAP_VIEW_BBOX.maxLat]
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
 * where to look.
 */
export const BOUNDARY_OVERVIEW_MIN_ZOOM = 2;

/**
 * -----------------------------------------------------------------------------
 * THE ZOOMED-OUT MAP ASKS FOR THE WHOLE COVERAGE AREA, ONCE, AND THEN NEVER
 * ASKS AGAIN.
 * -----------------------------------------------------------------------------
 *
 * WHY PUBLIC LAND USED TO POP IN AND OUT WHILE YOU MOVED THE MAP.
 *
 * The overview used to follow the viewport: a padded box, snapped to a grid
 * derived from the screen, refetched whenever a pan left it. That sounds
 * reasonable and it is the whole bug, because of what sits on the other end.
 * Each source has a hard record cap — a couple of hundred parcels per request —
 * and the government services return whatever comes first, not the biggest. So
 * two overlapping boxes come back holding DIFFERENT arbitrary subsets of the
 * same ground.
 *
 * Pan far enough to cross the box, and the map replaced everything it was
 * drawing with that different subset. Areas that were on screen a moment ago
 * were simply not in the new answer, so they vanished; others appeared for the
 * first time. Nothing was wrong with the data and nothing had failed. The map
 * was being handed a fresh sample of the same continent every few gestures and
 * faithfully drawing each one.
 *
 * No box that moves can fix that. So the box stops moving: at every zoom below
 * BOUNDARY_MIN_ZOOM the map asks for exactly this rectangle — the entire
 * coverage area — and the answer serves every wide view there is. Panning costs
 * nothing. Zooming from 6 out to 2 costs nothing. There is no second sample to
 * disagree with the first, so there is nothing to pop.
 *
 * It is one request per week per device (the response caches for seven days on
 * disk), where it used to be one per pan.
 *
 * The trade is honest and it is the right way round: this single answer is
 * generalised harder than a tight box would have been, so the shapes are
 * blockier than they were at zoom 6. That is what BOUNDARY_MIN_ZOOM is for —
 * cross it and real geometry for the viewport loads on top. Coarse and stable
 * beats sharp and flickering for a view whose only question is "is there public
 * land over there".
 */
export const OVERVIEW_BOX: BoundingBox = { ...COVERAGE_BBOX };

/**
 * Smallest parcel, in km², the overview bothers to keep.
 *
 * ONE NUMBER, NOT A CURVE, and that is deliberate: it is part of the request
 * URL, so a value that changed with zoom would mint a different request at
 * every zoom level and undo everything above. The same answer has to serve
 * zoom 2 and zoom 6 alike.
 *
 * It is set low because at continental span it barely binds — the server keeps
 * parcels largest-first up to its own record cap, which runs out long before
 * this does. Where it matters is a source that returned only a handful, and
 * there we would rather draw them.
 */
export const OVERVIEW_MIN_AREA_SQ_KM = 120;

/**
 * -----------------------------------------------------------------------------
 * THE SAME DATA, DRAWN COARSER THE FURTHER OUT YOU ARE.
 * -----------------------------------------------------------------------------
 *
 * This applies ONLY to the overview that ships with the app, and the difference
 * matters. Everything above is about a REMOTE answer, which arrives as a capped
 * sample — the government services return a couple of hundred areas per request
 * and pick them arbitrarily, so asking twice gives two different answers and
 * anything that varies the request makes land flicker. That is why the remote
 * overview is one fixed question asked once.
 *
 * The bundled file has no cap and no sampling. It is the whole coverage area,
 * complete, on the device. Choosing what to draw from it is therefore a pure
 * function of zoom and viewport: pan away and back at the same zoom and you get
 * exactly the same shapes, every time. Nothing can flicker, so it is free to
 * show less when zoomed out and more as you come in — which is the right thing
 * to do anyway, because 10,000 parcels on one continental screen is a lot of
 * geometry to dissolve and draw for shapes a pixel wide.
 *
 * The number is the smallest bounding-box side, in degrees, worth drawing. It
 * is measured against a box the parcel already carries, so the test costs
 * nothing, and each band lands at roughly five pixels on screen.
 */
export const overviewMinSpanDegrees = (zoom: number): number => {
  if (zoom <= 3) return 0.6;   // ~65 km — the continental blocks
  if (zoom <= 4) return 0.3;   // ~33 km
  if (zoom <= 5) return 0.12;  // ~13 km
  return 0;                    // zoom 6: everything the file holds
};


/* -------------------------------------------------------------------------- */
/* Which jurisdictions actually have parcel data behind them                   */
/* -------------------------------------------------------------------------- */

/**
 * The provinces whose Crown land this app can actually draw, and how much of
 * each one it draws.
 *
 * Four, at the time of writing: Alberta (the Green Area, plus Public Land Use
 * Zones), Ontario (CLUPA General Use Areas), Saskatchewan (the provincial
 * forest) and Manitoba (the fifteen provincial forests). Those are the only
 * Canadian jurisdictions publishing a queryable open layer that delineates
 * land a camper may actually use — see COVERAGE_GAPS in
 * `scripts/landSources.ts` for what each of the others publishes instead and
 * why it doesn't qualify.
 *
 * WHY THE VALUE IS NOT JUST `true`. Saskatchewan is mapped for the forested
 * centre and north and nothing else, because the only Crown land the province
 * publishes further south is leases and cottage lots. Manitoba is thinner
 * still. Filing either alongside Alberta as simply "covered" would make a
 * blank map read as "we looked and there is nothing", which is the exact
 * confusion this whole function exists to prevent — so they carry their own
 * caveats instead of a null.
 *
 * The United States is not listed because its coverage is federal and
 * national: BLM and the US Forest Service publish one layer each covering
 * every state, so there is no state-by-state gap to declare. State trust and
 * state forest land is a separate gap, recorded in COVERAGE_GAPS.
 */
const MAPPED_CA_PROVINCES = new Map<string, string | null>([
  ['CA-AB', null],
  // Ontario is the best-covered province here and still not a clean null.
  // CLUPA stops before the Far North, which is planned under the Far North
  // Act and is not in the layer we query — so the northern two fifths of the
  // province draws blank while being overwhelmingly Crown land.
  ['CA-ON', 'the Far North is not mapped'],
  ['CA-SK', 'only the provincial forest is mapped'],
  // Manitoba's caveat is the strongest of the three and has to be, because
  // its coverage is the weakest: fifteen provincial forests, about 22,000 km²
  // of a province that is roughly three quarters Crown land. Being listed
  // here at all would otherwise imply the province is done.
  ['CA-MB', 'only the 15 provincial forests are mapped — most Manitoba Crown land is not']
]);

/**
 * Why a province is blank, in a camper's words — or null when the blankness
 * genuinely means "we looked and there is nothing here".
 *
 * THIS IS THE HOUSE RULE IN ONE FUNCTION. An empty map inside the coverage
 * outline is the single most dangerous thing this app can show, because "no
 * public land in view" and "no data for this province" look identical and mean
 * opposite things. Someone in British Columbia — a province that is largely
 * Crown land — was being shown an empty map and a chip reading "No mapped
 * public land in view". That is the app stating, wrongly and confidently, that
 * there is nowhere to camp.
 *
 * Pass the ISO code of the state or province under the middle of the screen.
 * Null means the usual message is safe to show.
 */
export const landDataGap = (isoCode: string | null | undefined): string | null => {
  if (!isoCode) return null;
  if (!isoCode.startsWith('CA-')) return null;
  // A mapped province may still carry a caveat — partial coverage is its own
  // answer, and it is not the same as full coverage OR as no data at all.
  if (MAPPED_CA_PROVINCES.has(isoCode)) return MAPPED_CA_PROVINCES.get(isoCode) ?? null;
  return 'no Crown land data yet';
};
