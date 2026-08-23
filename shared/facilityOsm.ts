/**
 * WHAT A FACILITY LOOKS LIKE IN OPENSTREETMAP — shared by the server and the
 * client, because the question and the answer have to agree.
 *
 * The server asks Overpass using `OSM_SELECTORS` and reads the tags back with
 * `kindFromTags`. If those two ever drift, the layer asks for showers and
 * throws away showers, and the map says nobody has mapped one — the single
 * sentence this whole feature is not allowed to say by accident. One file, so
 * they cannot.
 *
 * The rest of what a facility IS — its name, its colour, its symbol, the
 * enum value a camper's submission is stored as — lives in
 * `src/config/facilities.ts`, which imports the selectors from here. That half
 * is all React and belongs nowhere near the server.
 */

/** Every kind OpenStreetMap can be asked about. */
export type OsmFacilityKind =
  | 'toilet' | 'water' | 'shower' | 'dump' | 'fuel' | 'propane'
  | 'laundry' | 'groceries' | 'waste' | 'air'
  | 'trail' | 'fishing' | 'boat';

/**
 * The Overpass selectors that mean each kind.
 *
 * `way` as well as `node` wherever the thing is commonly drawn as a building
 * rather than a point — a toilet block and a supermarket usually are.
 */
export const OSM_SELECTORS: Record<OsmFacilityKind, string[]> = {
  toilet: ['node["amenity"="toilets"]', 'way["amenity"="toilets"]'],
  water: [
    'node["amenity"="drinking_water"]',
    'node["man_made"="water_tap"]["drinking_water"="yes"]'
  ],
  shower: ['node["amenity"="shower"]', 'way["amenity"="shower"]'],
  dump: [
    'node["amenity"="sanitary_dump_station"]',
    'way["amenity"="sanitary_dump_station"]'
  ],
  fuel: ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'],
  /* `fuel:lpg` is on ordinary fuel stations that also sell it; the shop tag is
     the dedicated bottle exchange. Both are somewhere you refill. */
  propane: ['node["amenity"="fuel"]["fuel:lpg"="yes"]', 'node["shop"="gas"]'],
  laundry: ['node["shop"="laundry"]', 'node["amenity"="laundry"]'],
  groceries: [
    'node["shop"="supermarket"]', 'way["shop"="supermarket"]',
    'node["shop"="convenience"]', 'way["shop"="convenience"]'
  ],
  waste: [
    'node["amenity"="waste_disposal"]', 'way["amenity"="waste_disposal"]',
    'node["amenity"="recycling"]["recycling_type"="centre"]'
  ],
  air: ['node["amenity"="compressed_air"]'],
  /* Where a walk STARTS, rather than the path itself. A hiking route is a line
     hundreds of km long whose nearest point to a campsite is meaningless. */
  trail: [
    'node["highway"="trailhead"]',
    'node["information"="guidepost"]["hiking"="yes"]'
  ],
  fishing: ['node["leisure"="fishing"]', 'way["leisure"="fishing"]'],
  /* A slipway is the ramp itself. Marinas are excluded on purpose: a marina is
     a business with a gate, not somewhere to put a canoe in. */
  boat: ['node["leisure"="slipway"]', 'way["leisure"="slipway"]']
};

/** Which kind a returned element actually is, read back from its tags. */
export const kindFromTags = (
  tags: Record<string, string>
): OsmFacilityKind | null => {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.amenity === 'shower') return 'shower';
  if (tags.amenity === 'drinking_water' || tags.man_made === 'water_tap') return 'water';
  if (tags.amenity === 'sanitary_dump_station') return 'dump';
  if (tags['fuel:lpg'] === 'yes' || tags.shop === 'gas') return 'propane';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.shop === 'laundry' || tags.amenity === 'laundry') return 'laundry';
  if (tags.amenity === 'compressed_air') return 'air';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'groceries';
  if (tags.highway === 'trailhead' || tags.information === 'guidepost') return 'trail';
  if (tags.leisure === 'fishing') return 'fishing';
  if (tags.leisure === 'slipway') return 'boat';
  if (tags.amenity === 'waste_disposal' || tags.amenity === 'recycling') return 'waste';
  return null;
};

/**
 * A toilet behind a locked door is not a facility.
 *
 * `access=private` on a shower is somebody's bathroom, and drawing it would
 * send a camper to knock on a stranger's door at 6am.
 */
export const isReachable = (tags: Record<string, string>): boolean =>
  tags.access !== 'private' && tags.access !== 'no';

/** The selectors for a set of kinds, de-duplicated. */
export const selectorsFor = (kinds: readonly string[]): string[] => {
  const seen = new Set<string>();
  for (const kind of kinds) {
    const selectors = OSM_SELECTORS[kind as OsmFacilityKind];
    if (selectors) selectors.forEach((s) => seen.add(s));
  }
  return [...seen];
};
