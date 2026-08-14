/**
 * Where Beacon's evidence comes from.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * Beacon answers "could I sleep near here?" from two free, keyless-or-nearly
 * sources. Neither of them knows whether you may legally park somewhere. What
 * they know is narrower and worth stating exactly:
 *
 *   OPENSTREETMAP, through Overpass. Who a piece of land appears to belong to
 *   (`boundary=protected_area`, `landuse=military`, `access=private`), what the
 *   roads around it are, and where the compact, point-like features are that a
 *   coordinate can honestly describe — a parking area, a passing place, a rest
 *   area. No key, no registration. This is the source that works on a
 *   deployment with no configuration at all.
 *
 *   MAPILLARY, when MAPILLARY_TOKEN is set. Not imagery — DETECTIONS. Mapillary
 *   runs its own computer vision over every image it holds and publishes the
 *   traffic signs it found as plain point features. So the "check the signage"
 *   step is one JSON request for a bounding box, not a gigabyte of model
 *   weights and a GPU. The token is free and takes no payment details.
 *
 * WHAT NEITHER OF THEM IS: a statement of the law. Camping and overnight
 * parking rules are municipal, seasonal, and frequently posted on a sign that
 * exists in no database at all. Everything this module produces is a lead for a
 * human to check, and the word "lead" is doing real work.
 *
 * THREE RULES THIS FILE FOLLOWS
 *
 *   1. A CANDIDATE'S COORDINATE MUST MEAN SOMETHING. Only compact, point-like
 *      features become candidates. A 4 km winding forest road has a centroid,
 *      and that centroid is very often in a river — so roads inform a candidate
 *      and never become one. Sending somebody to a made-up coordinate is the
 *      exact failure the removed AI-campsite endpoint was removed for.
 *
 *   2. ABSENCE OF A SIGN IS NOT ABSENCE OF A RULE. "Mapillary found no
 *      no-parking sign" only means something where Mapillary has looked. So
 *      imagery density is measured and carried, and a clear reading is only
 *      awarded where there was enough coverage for clear to be informative.
 *
 *   3. NOTHING HERE THROWS. Every fetch resolves to a result object with an
 *      `ok` flag and a plain-English `note`. A source that is down produces a
 *      thinner answer that says it is thinner — never an empty map that looks
 *      confident.
 */

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type BeaconGenerator = 'public_land' | 'urban';
export type SignEvidence = 'unknown' | 'clear' | 'restricted';

/**
 * A feature token.
 *
 * These strings are the model's feature names, stored on every spot and
 * tallied in `beacon_signals`. RENAMING ONE THROWS AWAY EVERYTHING THE APP
 * HAS LEARNED ABOUT IT — the old token keeps its counts and the new one starts
 * at zero. Add freely; rename never.
 */
export type Token = string;

export interface Candidate {
  lat: number;
  lon: number;
  generator: BeaconGenerator;
  /** What the place is, in the words a camper would use. */
  label: string;
  /** Why we think you might be allowed to stay. Shown verbatim. */
  landBasis: string;
  tokens: Token[];
  ruleScore: number;
  signEvidence: SignEvidence;
}

export interface SourceNote {
  ok: boolean;
  note?: string;
}

const UA = process.env.NWS_USER_AGENT ?? 'wandrlust-app (contact: set NWS_USER_AGENT in .env)';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const metresBetween = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

type Ring = { lat: number; lon: number }[];

/**
 * Ray casting, written out here rather than imported from `src/utils/geo.ts`.
 *
 * The server bundle and the client bundle are built separately and this module
 * is meant to be liftable on its own; a twenty-line function is a cheaper price
 * than a cross-bundle import.
 */
const pointInRing = (lat: number, lon: number, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    const straddles = (yi > lat) !== (yj > lat);
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/* ------------------------------------------------------------------ */
/* Overpass                                                            */
/* ------------------------------------------------------------------ */

/**
 * Mirrors tried in order — the same list `cellSources.ts` uses, for the same
 * reason: Overpass instances rate-limit and go down routinely, and that has to
 * be survivable.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OverpassScan extends SourceNote {
  /** Land polygons, with geometry, for ownership and exclusion tests. */
  areas: OverpassElement[];
  /** Roads, with geometry, used as context for a candidate — never as one. */
  roads: OverpassElement[];
  /** Compact features whose centre is a coordinate worth sending someone to. */
  features: OverpassElement[];
  /**
   * Viewpoints, peaks, water and settlements.
   *
   * Never candidates — you do not sleep on a summit marker. These are what a
   * candidate is scored AGAINST: the first three are why a spot is worth
   * having, the last is why it is risky.
   */
  context: OverpassElement[];
}

const EMPTY_SCAN: OverpassScan = { ok: false, areas: [], roads: [], features: [], context: [] };

/**
 * One request, three result sets.
 *
 * Overpass allows several `out` statements with different modes in a single
 * query, so the polygons come back with full geometry (needed for
 * point-in-polygon), the roads come back with geometry (needed for "is there
 * road access within 120 m"), and the compact candidate features come back as
 * centres. Three round trips collapsed into one matters when the whole request
 * has a twelve-second budget.
 */
const buildQuery = (lat: number, lon: number, radiusM: number): string => {
  const around = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})`;

  const areas = [
    `way["boundary"="protected_area"]${around};`,
    `relation["boundary"="protected_area"]${around};`,
    `way["landuse"~"^(forest|military|residential|industrial)$"]${around};`,
    `way["leisure"~"^(park|nature_reserve)$"]${around};`,
    `way["access"~"^(private|no)$"]${around};`
  ].join('');

  const roads = [
    `way["highway"~"^(track|unclassified|service|residential|tertiary|secondary)$"]${around};`
  ].join('');

  // Compact features only. See rule 1 in the file header.
  const features = [
    `node["amenity"="parking"]${around};`,
    `way["amenity"="parking"]${around};`,
    `node["amenity"="parking_space"]${around};`,
    `node["highway"="rest_area"]${around};`,
    `way["highway"="rest_area"]${around};`,
    `way["highway"="services"]${around};`,
    `node["highway"="passing_place"]${around};`,
    `node["highway"="turning_circle"]${around};`,
    `node["tourism"="camp_site"]${around};`,
    `way["tourism"="camp_site"]${around};`
  ].join('');

  /**
   * What makes a spot WORTH having, and what makes it RISKY.
   *
   * Neither of these was ever asked for, which is why the scan could only
   * rank places by their paperwork. A free parking area on unmapped ground
   * beside a track scored exactly as well as a pullout on a ridge over a
   * lake, because nothing in the query knew the ridge or the lake were
   * there. So the map filled up with car parks.
   *
   * Viewpoints, peaks and water are the view. Settlements are the risk: the
   * single best predictor of being moved on at 2am is how close you are to
   * people who did not expect you.
   */
  const context = [
    `node["tourism"="viewpoint"]${around};`,
    `node["natural"="peak"]${around};`,
    `way["natural"="water"]${around};`,
    `way["waterway"="riverbank"]${around};`,
    `node["place"~"^(city|town|village|hamlet|suburb)$"]${around};`
  ].join('');

  return (
    `[out:json][timeout:25];` +
    `(${areas});out geom 150;` +
    `(${roads});out geom 250;` +
    `(${features});out center 150;` +
    `(${context});out center 120;`
  );
};

/**
 * Sort the flat element list back into the three groups.
 *
 * Overpass concatenates the result sets, so they are told apart by their tags
 * rather than by position — which is also what makes the function robust to a
 * mirror reordering them.
 */
const sortElements = (elements: OverpassElement[]): Omit<OverpassScan, keyof SourceNote> => {
  const areas: OverpassElement[] = [];
  const roads: OverpassElement[] = [];
  const features: OverpassElement[] = [];
  const context: OverpassElement[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    // Context first: a viewpoint carries no `highway` or `amenity`, so it
    // would otherwise fall through to `areas` and be tested as a boundary.
    if (
      tags.tourism === 'viewpoint' || tags.natural === 'peak' ||
      tags.natural === 'water' || tags.waterway === 'riverbank' || tags.place
    ) {
      context.push(el);
    } else if (tags.highway && !['rest_area', 'services', 'passing_place', 'turning_circle'].includes(tags.highway)) {
      roads.push(el);
    } else if (tags.amenity === 'parking' || tags.amenity === 'parking_space' ||
               tags.tourism === 'camp_site' || tags.highway) {
      features.push(el);
    } else {
      areas.push(el);
    }
  }
  return { areas, roads, features, context };
};

export const fetchOverpassScan = async (
  lat: number,
  lon: number,
  radiusM: number,
  timeoutMs = 11_000
): Promise<OverpassScan> => {
  const query = buildQuery(lat, lon, radiusM);

  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { elements?: unknown };
      if (!Array.isArray(data?.elements)) continue;

      return { ok: true, ...sortElements(data.elements as OverpassElement[]) };
    } catch {
      // Next mirror. Only every mirror failing is an outage.
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ...EMPTY_SCAN,
    note: 'Could not reach OpenStreetMap just now, so nothing was scanned here.'
  };
};

/* ------------------------------------------------------------------ */
/* Mapillary traffic sign detections                                   */
/* ------------------------------------------------------------------ */

/**
 * Signs that mean "not here".
 *
 * Prefixes, not exact values: Mapillary's taxonomy carries regional variants
 * as suffixes (`regulatory--no-parking--g1`, `--g2`, and so on), and matching
 * the exact string would silently miss most of the world.
 */
const RESTRICTIVE_SIGN_PREFIXES = [
  'regulatory--no-parking',
  'regulatory--no-stopping',
  'regulatory--no-waiting',
  'regulatory--parking-restrictions',
  'regulatory--no-overnight',
  'regulatory--no-motor-vehicles',
  'regulatory--no-entry'
];

/** Signs that mean "yes, here" — weak positive evidence, never a guarantee. */
const PERMISSIVE_SIGN_PREFIXES = [
  'information--parking',
  'information--camping',
  'information--rest-area'
];

export interface SignDetection {
  lat: number;
  lon: number;
  value: string;
  restrictive: boolean;
  permissive: boolean;
}

export interface SignScan extends SourceNote {
  detections: SignDetection[];
  /**
   * How much Mapillary has actually seen around here. This is what licenses
   * reading "no restrictive sign found" as evidence rather than as silence.
   */
  coverage: 'none' | 'sparse' | 'dense';
}

const classify = (value: string) => ({
  restrictive: RESTRICTIVE_SIGN_PREFIXES.some((p) => value.startsWith(p)),
  permissive: PERMISSIVE_SIGN_PREFIXES.some((p) => value.startsWith(p))
});

/**
 * Traffic signs Mapillary's vision pipeline already found near a point.
 *
 * This is the whole of the "OCR the signage" requirement, and it costs one
 * JSON request. Mapillary detects and classifies signs across its entire image
 * corpus and serves the results as point features, so the work of reading a
 * sign has already been done by somebody with a GPU cluster.
 *
 * Without MAPILLARY_TOKEN this returns coverage 'none' and no detections, and
 * every candidate downstream is marked `sign_evidence: 'unknown'`. That is the
 * honest reading — we did not look, so we did not see — and it is deliberately
 * NOT the same as looking and finding nothing.
 */
export const fetchSignsNear = async (
  lat: number,
  lon: number,
  radiusM: number,
  timeoutMs = 8_000
): Promise<SignScan> => {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token) {
    return {
      ok: false, detections: [], coverage: 'none',
      note: 'No Mapillary token is set, so no street-level signage was checked.'
    };
  }

  // Degrees per metre varies with latitude for longitude but not for latitude.
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.15, Math.cos(toRad(lat))));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
    .map((n) => n.toFixed(6)).join(',');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url =
      `https://graph.mapillary.com/map_features?access_token=${encodeURIComponent(token)}` +
      `&fields=object_value,geometry&bbox=${bbox}&layer=trafficsigns&limit=500`;

    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false, detections: [], coverage: 'none',
        note: 'Mapillary did not answer, so no street-level signage was checked.'
      };
    }

    const data = (await res.json()) as {
      data?: { object_value?: string; geometry?: { coordinates?: [number, number] } }[];
    };
    if (!Array.isArray(data?.data)) {
      return {
        ok: false, detections: [], coverage: 'none',
        note: 'Mapillary returned nothing usable, so no signage was checked.'
      };
    }

    const detections: SignDetection[] = [];
    for (const row of data.data) {
      const coords = row.geometry?.coordinates;
      const value = row.object_value;
      if (!value || !Array.isArray(coords) || coords.length < 2) continue;
      const [signLon, signLat] = coords;
      if (typeof signLat !== 'number' || typeof signLon !== 'number') continue;
      detections.push({ lat: signLat, lon: signLon, value, ...classify(value) });
    }

    /**
     * The density judgement. Any signs at all means somebody has driven here
     * with a camera; a good number means the absence of a no-parking sign is
     * worth something. The thresholds are deliberately conservative — being
     * wrong in the "we don't know" direction costs a camper one candidate,
     * being wrong the other way costs them a ticket.
     */
    const coverage: SignScan['coverage'] =
      detections.length === 0 ? 'none' : detections.length < 8 ? 'sparse' : 'dense';

    return {
      ok: true,
      detections,
      coverage,
      note: coverage === 'none'
        ? 'Mapillary has no sign detections around here, so signage is unknown.'
        : undefined
    };
  } catch {
    return {
      ok: false, detections: [], coverage: 'none',
      note: 'Could not reach Mapillary, so no street-level signage was checked.'
    };
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------------------------------------------ */
/* Reading the tags                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tags that take a place off the list outright, whatever else is true of it.
 *
 * These are not scored, they are vetoes. A model that has learned that
 * `access=private` usually works out fine has learned something about the
 * campers who report back, not about the law, and it must not be able to
 * outvote an explicit prohibition.
 */
const isForbidden = (tags: Record<string, string>): string | null => {
  const no = (v?: string) => v === 'no' || v === 'private';

  if (no(tags.access)) return 'Access is tagged private.';
  if (tags.landuse === 'military') return 'Inside a military area.';
  if (no(tags.motor_vehicle) || no(tags.vehicle)) return 'Vehicles are not allowed.';
  if (tags.overnight === 'no') return 'Overnight stays are tagged as not allowed.';
  if (tags.camping === 'no' || tags.tents === 'no') return 'Camping is tagged as not allowed.';
  if (tags.motorhome === 'no' || tags.caravan === 'no') return 'Motorhomes are not allowed.';
  if (tags.maxstay && tags.maxstay !== 'unlimited') return `Posted maximum stay: ${tags.maxstay}.`;

  // `parking:condition:*` and the older `parking:lane:*:condition` both encode
  // kerbside rules. Any restrictive value anywhere in that namespace is fatal.
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith('parking:')) continue;
    if (/no_parking|no_stopping|no_standing|disabled|customers|residents|ticket/.test(value)) {
      return 'Kerbside parking here is restricted.';
    }
  }
  return null;
};

/** Land-ownership token and the plain-English basis that goes with it. */
interface LandReading {
  token: Token;
  basis: string;
  /**
   * Is this ground PUBLIC, by name, from the map's own tags?
   *
   * Not "probably public", not "nobody said it was private". A named agency
   * that manages land the public may use. Everything else is false, and false
   * now means the candidate is dropped rather than merely marked down.
   */
  isPublic: boolean;
}

const landFromArea = (tags: Record<string, string>): LandReading | null => {
  const operator = (tags.operator ?? '').toLowerCase();
  const protectTitle = (tags.protect_title ?? '').toLowerCase();
  const name = (tags.name ?? '').toLowerCase();
  const haystack = `${operator} ${protectTitle} ${name}`;

  if (haystack.includes('bureau of land management') || haystack.includes('national monument')) {
    return { token: 'land=blm', isPublic: true, basis: 'Inside land mapped as Bureau of Land Management, where dispersed camping is often the general rule.' };
  }
  if (haystack.includes('forest service') || haystack.includes('national forest') || haystack.includes('usfs')) {
    return { token: 'land=usfs', isPublic: true, basis: 'Inside land mapped as National Forest, where dispersed camping is often allowed away from developed sites.' };
  }
  if (haystack.includes('crown')) {
    return { token: 'land=crown', isPublic: true, basis: 'Inside land mapped as Crown land, where camping rules vary by province.' };
  }
  if (haystack.includes('national grassland')) {
    return { token: 'land=grassland', isPublic: true, basis: 'Inside a mapped National Grassland, where dispersed camping is often allowed.' };
  }
  if (haystack.includes('state forest') || haystack.includes('state trust') ||
      haystack.includes('department of natural resources')) {
    return { token: 'land=state_forest', isPublic: true, basis: 'Inside land mapped as a state forest or state trust land. Rules vary by state and some require a permit.' };
  }
  if (haystack.includes('wildlife management') || haystack.includes('national wildlife refuge')) {
    // Public, but overnight use is very often prohibited outright.
    return { token: 'land=wildlife', isPublic: false, basis: 'Inside a mapped wildlife area. These are public but overnight stays are usually forbidden.' };
  }
  /*
   * `boundary=protected_area` with no agency named. Public-ish and no more
   * than that — a conservancy easement and a national forest carry the same
   * tag. It no longer counts as public on its own, which is the change that
   * stops "protected" being read as "yours to sleep on".
   */
  if (tags.boundary === 'protected_area') {
    return { token: 'land=protected', isPublic: false, basis: 'Inside a mapped protected area with no managing agency recorded. Protected does not mean open.' };
  }
  if (tags.landuse === 'forest') {
    return { token: 'land=forest', isPublic: false, basis: 'Inside mapped forest with no owner recorded. Timber company land looks exactly like this.' };
  }
  if (tags.leisure === 'park' || tags.leisure === 'nature_reserve') {
    return { token: 'land=park_edge', isPublic: false, basis: 'Beside a mapped park. Municipal parks very often forbid overnight parking.' };
  }
  if (tags.landuse === 'residential') {
    return { token: 'land=residential', isPublic: false, basis: 'On a residential street.' };
  }
  return null;
};

/** What a candidate feature actually is, and its own tags' contribution. */
const describeFeature = (
  tags: Record<string, string>
): { label: string; tokens: Token[]; score: number } | null => {
  if (tags.amenity === 'parking' || tags.amenity === 'parking_space') {
    const free = tags.fee === 'no' || tags.fee === undefined;
    /*
     * A CAR PARK IS THE WEAKEST THING ON THIS LIST, not the strongest.
     *
     * It used to open at 1.5, half a point under the surfacing bar, so a free
     * parking area beside a track cleared it on road context alone. That is
     * how a scan came back as a list of car parks. On a forest road a
     * `amenity=parking` really is the pullout you want — which is why this is
     * still a candidate at all — but it earns its place from the public land
     * it sits on and the view it has, not from being a car park.
     */
    return {
      label: tags.name ?? 'Parking area',
      tokens: ['feature=parking', free ? 'parking=free' : 'parking=fee'],
      score: free ? 0.25 : -1
    };
  }
  if (tags.highway === 'rest_area' || tags.highway === 'services') {
    return { label: tags.name ?? 'Rest area', tokens: ['feature=rest_area'], score: 2 };
  }
  if (tags.highway === 'passing_place') {
    return { label: 'Passing place', tokens: ['feature=passing_place'], score: 1 };
  }
  if (tags.highway === 'turning_circle') {
    return { label: 'Turning circle at a road end', tokens: ['feature=turning_circle'], score: 0.5 };
  }
  if (tags.tourism === 'camp_site') {
    const free = tags.fee === 'no';
    return {
      label: tags.name ?? 'Campsite',
      tokens: ['feature=camp_site', free ? 'camp=free' : 'camp=fee'],
      score: free ? 3 : 0
    };
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Candidate assembly                                                  */
/* ------------------------------------------------------------------ */

const centreOf = (el: OverpassElement): { lat: number; lon: number } | null => {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return el.center;
  return null;
};

/**
 * What a spot LOOKS OUT ON, scored from what the map knows is near it.
 *
 * A viewpoint is somebody having said "the view from here is the point". A
 * peak is terrain. Water is the other thing campers drive for. None of these
 * proves you can see anything — trees, a rise, or the wrong orientation all
 * beat this — so the wording that reaches the camper says "near a mapped
 * viewpoint", never "great view".
 *
 * Distances are deliberately short. A lake four kilometres away is not your
 * view, it is just in the same valley.
 */
const viewScore = (
  lat: number, lon: number, context: OverpassElement[]
): { score: number; tokens: Token[]; note: string | null } => {
  const tokens: Token[] = [];
  let score = 0;
  let note: string | null = null;

  let nearestView = Infinity;
  let nearestWater = Infinity;

  for (const el of context) {
    const tags = el.tags ?? {};
    const centre = el.lat !== undefined && el.lon !== undefined
      ? { lat: el.lat, lon: el.lon }
      : el.center;
    if (!centre) continue;
    const metres = metresBetween(lat, lon, centre.lat, centre.lon);

    if (tags.tourism === 'viewpoint' || tags.natural === 'peak') {
      if (metres < nearestView) nearestView = metres;
    } else if (tags.natural === 'water' || tags.waterway === 'riverbank') {
      if (metres < nearestWater) nearestWater = metres;
    }
  }

  if (nearestView <= 400) {
    score += 2; tokens.push('view=viewpoint_near');
    note = 'Within a few hundred metres of a mapped viewpoint or summit.';
  } else if (nearestView <= 1200) {
    score += 1; tokens.push('view=viewpoint_walk');
    note = 'A mapped viewpoint or summit is within about a kilometre.';
  }

  if (nearestWater <= 300) {
    score += 1.5; tokens.push('view=water_near');
    note = note
      ? `${note} There is mapped water beside it too.`
      : 'Beside mapped water.';
  } else if (nearestWater <= 1000) {
    score += 0.5; tokens.push('view=water_walk');
  }

  if (tokens.length === 0) tokens.push('view=none_mapped');
  return { score, tokens, note };
};

/**
 * How likely somebody is to knock on the window, from how close the people are.
 *
 * This is the only honest proxy available without a law database: the risk of
 * being moved on rises steeply with proximity to a settlement, because that is
 * where bylaws, enforcement and irritated residents all live. It is a
 * PENALTY-ONLY signal — being far from town does not make a place legal, it
 * makes being noticed less likely, and those are different claims.
 */
const riskScore = (
  lat: number, lon: number, context: OverpassElement[]
): { score: number; tokens: Token[]; note: string | null } => {
  let nearestPlace = Infinity;
  let placeKind = '';

  for (const el of context) {
    const tags = el.tags ?? {};
    if (!tags.place) continue;
    const centre = el.lat !== undefined && el.lon !== undefined
      ? { lat: el.lat, lon: el.lon }
      : el.center;
    if (!centre) continue;
    const metres = metresBetween(lat, lon, centre.lat, centre.lon);
    if (metres < nearestPlace) { nearestPlace = metres; placeKind = tags.place; }
  }

  // A city centre and a hamlet are not the same amount of attention.
  const weight = placeKind === 'city' ? 1.5
    : placeKind === 'town' || placeKind === 'suburb' ? 1
    : 0.6;

  if (nearestPlace <= 800) {
    return {
      score: -3 * weight,
      tokens: ['risk=in_settlement'],
      note: 'Inside a settlement, where overnight parking is most likely to be noticed and posted against.'
    };
  }
  if (nearestPlace <= 2500) {
    return {
      score: -1.5 * weight,
      tokens: ['risk=near_settlement'],
      note: 'On the edge of a settlement.'
    };
  }
  if (nearestPlace <= 8000) {
    return { score: -0.25 * weight, tokens: ['risk=settlement_nearby'], note: null };
  }
  return {
    score: 1,
    tokens: ['risk=remote'],
    note: 'Well away from any mapped settlement.'
  };
};

/** Nearest point on any mapped road, and that road's tags. */
const nearestRoad = (
  lat: number, lon: number, roads: OverpassElement[]
): { metres: number; tags: Record<string, string> } | null => {
  let best: { metres: number; tags: Record<string, string> } | null = null;

  for (const road of roads) {
    for (const node of road.geometry ?? []) {
      const metres = metresBetween(lat, lon, node.lat, node.lon);
      if (!best || metres < best.metres) best = { metres, tags: road.tags ?? {} };
    }
  }
  return best;
};

/**
 * Turn a raw scan into scored candidates.
 *
 * The order here is the order the checks have to happen in: vetoes first, so
 * nothing forbidden can be rescued by a good score; then ownership; then the
 * road context; then signage; and the learned model is applied later, in the
 * database, on top of the rule score computed here.
 */
export const buildCandidates = (
  scan: OverpassScan,
  signs: SignScan,
  origin: { lat: number; lon: number }
): Candidate[] => {
  const candidates: Candidate[] = [];

  for (const el of scan.features) {
    const centre = centreOf(el);
    if (!centre) continue;

    const tags = el.tags ?? {};

    // ---- Veto: the feature's own tags.
    if (isForbidden(tags)) continue;

    const described = describeFeature(tags);
    if (!described) continue;

    const tokens: Token[] = [...described.tokens];
    let score = described.score;
    let basis = '';
    let generator: BeaconGenerator = 'urban';

    // ---- Ownership. Smallest containing area wins, the same way the map's
    // existing pin-drop picks the tightest boundary parcel.
    let containing: { tags: Record<string, string>; size: number } | null = null;
    for (const area of scan.areas) {
      const ring = area.geometry;
      if (!ring || ring.length < 3) continue;
      if (!pointInRing(centre.lat, centre.lon, ring)) continue;

      const lats = ring.map((p) => p.lat);
      const lons = ring.map((p) => p.lon);
      const size = (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lons) - Math.min(...lons));
      if (!containing || size < containing.size) containing = { tags: area.tags ?? {}, size };
    }

    /**
     * ---- PUBLIC LAND IS A REQUIREMENT, NOT A BONUS.
     *
     * This is the single biggest change to what Beacon returns, and it is the
     * reason scans used to come back as a list of car parks. Public land was
     * worth +3 and everything else was worth nothing — so a free parking area
     * on unmapped ground beside a track cleared the surfacing bar on road
     * context alone, and a supermarket lot scored the same as a forest pullout.
     *
     * Now: if the map does not name an agency that manages this ground for
     * public use, the candidate is dropped. Not marked down — dropped.
     *
     * WHAT THIS COSTS, SAID PLAINLY. Public-land polygons are patchy, and
     * Crown land especially so outside Ontario and Alberta. A scan over ground
     * that IS public but unmapped will now find nothing, and the panel says it
     * found nothing. That is the correct trade: an empty answer is a camper
     * driving on, and a wrong answer is a camper parked in a supermarket lot
     * being told it was a lead.
     */
    if (!containing) {
      // No polygon at all: ownership unknown, which is not public.
      continue;
    }

    // ---- Veto: the land it sits on.
    if (isForbidden(containing.tags)) continue;

    const land = landFromArea(containing.tags);
    if (!land || !land.isPublic) continue;

    tokens.push(land.token);
    basis = land.basis;
    generator = 'public_land';
    score += 3;

    // ---- Road context. Somewhere you cannot drive to is not a place to sleep.
    const road = nearestRoad(centre.lat, centre.lon, scan.roads);
    if (!road || road.metres > 150) {
      tokens.push('road=none');
      score -= 1;
    } else {
      // ---- Veto: restrictions on the road it sits beside.
      if (isForbidden(road.tags)) continue;

      const highway = road.tags.highway ?? 'unknown';
      tokens.push(`road=${highway}`);
      tokens.push(`surface=${road.tags.surface ?? 'unknown'}`);

      // An unpaved track is the classic dispersed-camping approach; a
      // residential street is where tickets happen.
      if (highway === 'track' || highway === 'unclassified') score += 1;
      if (highway === 'residential') score -= 0.5;
      if (highway === 'secondary' || highway === 'tertiary') score -= 0.5;
    }

    // ---- Signage.
    let signEvidence: SignEvidence = 'unknown';
    const nearbySigns = signs.detections.filter(
      (s) => metresBetween(centre.lat, centre.lon, s.lat, s.lon) <= 60
    );

    // ---- Veto: a restrictive sign close enough to be about this spot.
    const restrictive = nearbySigns.filter(
      (s) => s.restrictive && metresBetween(centre.lat, centre.lon, s.lat, s.lon) <= 40
    );
    if (restrictive.length > 0) continue;

    if (signs.coverage === 'dense' && nearbySigns.length > 0) {
      // Mapillary has looked hard here and found no prohibition. That is the
      // only case where a clear reading is honest.
      signEvidence = 'clear';
      tokens.push('sign:no_parking=absent', 'imagery=dense');
      score += 1;
    } else if (signs.coverage === 'sparse') {
      tokens.push('sign:no_parking=unknown', 'imagery=sparse');
    } else {
      tokens.push('sign:no_parking=unknown', 'imagery=none');
    }

    if (nearbySigns.some((s) => s.permissive)) {
      tokens.push('sign:parking_allowed=present');
      score += 0.5;
    }

    // ---- Is it worth being there? Views and water, from the map.
    const view = viewScore(centre.lat, centre.lon, scan.context);
    score += view.score;
    tokens.push(...view.tokens);

    // ---- How likely is a knock? Distance from people, and nothing else.
    const risk = riskScore(centre.lat, centre.lon, scan.context);
    score += risk.score;
    tokens.push(...risk.tokens);

    // ---- Distance from where the beacon was dropped. Closer is more useful,
    // and this is the only part of the score that is about convenience rather
    // than legality.
    const away = metresBetween(origin.lat, origin.lon, centre.lat, centre.lon);
    if (away <= 1000) score += 0.5;

    /*
     * The basis the camper reads is the land first, then why this one was
     * ranked where it was. Ordered that way because "may I be here" is the
     * question that matters and "is it nice" is the tie-breaker.
     */
    const reasons = [basis, view.note, risk.note].filter(Boolean) as string[];

    candidates.push({
      lat: centre.lat,
      lon: centre.lon,
      generator,
      label: described.label,
      landBasis: reasons.join(' '),
      tokens,
      ruleScore: Number(score.toFixed(3)),
      signEvidence
    });
  }

  return candidates;
};
