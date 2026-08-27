/**
 * Active wildfire perimeters and points.
 *
 *   GET /api/fires?bbox=minLon,minLat,maxLon,maxLat
 *
 *   Returns a GeoJSON FeatureCollection of currently active wildfires that
 *   intersect the requested bounding box, with the two source feeds the
 *   app speaks to merged into a single response.
 *
 * ---------------------------------------------------------------------------
 * Sources
 * ---------------------------------------------------------------------------
 *
 *  - US perimeters: WFIGS Interagency Fire Perimeters, current. Published by
 *    the National Interagency Fire Center (NIFC) as an ArcGIS FeatureServer
 *    layer. Each feature carries a polygon for the burn area, the incident
 *    name, current size in acres, and percent contained. No key. We
 *    filter server-side with a geometry query so the response only contains
 *    perimeters that actually intersect the caller's bbox, not the full
 *    continent.
 *
 *  - Canadian points: FireRadar's public aggregation of provincial fire
 *    management agency feeds. Real GeoJSON, refreshed within the hour from
 *    the source agencies (BC Wildfire Service, Alberta Wildfire, Ontario
 *    Aviation Service, SOPFEU, etc.). The data points are reported fire
 *    locations, not perimeters. No key. CWFIS hosts a similar feed through
 *    a WMS that is harder to consume; FireRadar is the more direct path.
 *
 * Perimeters are richer (you can see the burn footprint). Points are
 * coarser (a pin at the reported location) but cover the country
 * uniformly. We do not pretend the point is the perimeter — a perimeter
 * additionally gets its burn footprint outlined, and a point never does.
 * Both wear the same flame icon, coloured by `underControl`, so a fire
 * reads the same on either side of the border.
 *
 * ---------------------------------------------------------------------------
 * "Active" means active
 * ---------------------------------------------------------------------------
 *
 * Both feeds carry finished fires — a US perimeter keeps its record after
 * the incident is declared out, and the Canadian feed keeps extinguished
 * incidents for a while. Those are filtered out here rather than in the
 * client, so every consumer (map layer, per-pin card, push alerts) agrees
 * on what counts as burning. A fire that is contained or being held is
 * still active and is still returned — being under control is a colour,
 * not a reason to hide it.
 *
 * ---------------------------------------------------------------------------
 * Caching
 * ---------------------------------------------------------------------------
 *
 * The WFIGS feed refreshes "every 5 minutes" per NIFC; the FireRadar feed
 * carries per-source `lastUpdatedAt` that ranges from minutes to a couple
 * of hours. Caching for 6 hours means a returning camper reads the same
 * fire map they got earlier today, and a fresh fetch still happens on a
 * trip-planning session. The cache key is the rounded bbox so adjacent
 * viewports share the same answer.
 */
import type { Express, Request, Response } from 'express';
// The `.js` here is load-bearing, same as in weatherRoutes.ts: under strict
// ESM on Vercel an extensionless relative import throws ERR_MODULE_NOT_FOUND
// at load time, which takes the whole fire endpoint down with it.
import { bboxIntersectsCoverage } from '../src/config/coverage.js';
import { distanceKm } from './cellSources.js';
import { TtlCache } from '../shared/ttlCache.js';

/** 6h — fire data updates within hours; 6h keeps the network quiet without
 *  serving a stale answer through a full day of a camper's trip. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 80;
const cache = new TtlCache<unknown>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);

const WFIGS_PERIMETERS =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';
const FIRERADAR_CURRENT =
  'https://fireradar.ca/api/public/wildfires-current?format=geojson';

interface WfigsAttrs {
  OBJECTID?: number;
  attr_IncidentName?: string;
  attr_IncidentSize?: number;
  attr_PercentContained?: number;
  attr_POOState?: string;
  attr_POOCounty?: string;
  attr_FireDiscoveryDateTime?: number;
  attr_InitialLatitude?: number;
  attr_InitialLongitude?: number;
  attr_StageOfControlStatus?: string;
  /** Set once the incident is declared out. Its presence means "finished". */
  attr_FireOutDateTime?: number;
  /** Set when the perimeter was fully contained / brought under control. */
  attr_ContainmentDateTime?: number;
  attr_ControlDateTime?: number;
  /** 'WF' wildfire, 'RX' prescribed burn. We only map wildfires. */
  attr_IncidentTypeCategory?: string;
  attr_ModifiedOnDateTime_dt?: number;
  poly_DateCurrent?: number;
  poly_PolygonDateTime?: number;
  poly_GISAcres?: number;
  GlobalID?: string;
}

interface EsriFeature {
  attributes: WfigsAttrs;
  geometry?: { rings?: number[][][]; };
}

interface EsriQueryResponse {
  features?: EsriFeature[];
  exceededTransferLimit?: boolean;
  error?: { message: string };
}

interface FireFeatureProps {
  id: string;
  name: string;
  /** 'perimeter' (US, polygon) or 'point' (Canadian, point). */
  kind: 'perimeter' | 'point';
  country: 'US' | 'CA';
  sizeHa: number | null;
  sizeAcres: number | null;
  contained: number | null;
  /** Where the fire is, in human terms — "AK / Yukon-Koyukuk" or "BC". */
  region: string;
  discovered: string | null;
  cause: string | null;
  status: string | null;
  /**
   * True when the agency reports the fire as held / contained / under
   * control, false when it is still running. Drives the colour of the
   * flame on the map: orange for under control, red for not.
   *
   * This is the AGENCY'S word, not ours. When a feed says nothing about
   * control state we report `false` — "not reported under control" — and
   * the map draws red. Red on a fire we know little about is the honest
   * side to err on.
   */
  underControl: boolean;
  /** Centroid for points and perimeters alike. */
  centroid: [number, number];
  /** The raw GeoJSON geometry. */
  geometry: GeoJSON.Geometry;
}

type FireFC = GeoJSON.FeatureCollection<GeoJSON.Geometry, FireFeatureProps>;

/** US acres → hectares. 1 acre = 0.404686 ha. */
const acresToHa = (ac: number): number => ac * 0.404686;

const safeNumber = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
};

const dateFromEpochMs = (ms: unknown): string | null => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  // WFIGS stores epoch milliseconds. FireRadar stores ISO strings.
  try { return new Date(ms).toISOString(); } catch { return null; }
};

const dateFromIso = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
};

/**
 * Polygon centroid (approximate, ring by ring then average). Good enough
 * for "is this fire near the pin" proximity checks; the polygon itself
 * is what we render.
 */
const polygonCentroid = (rings: number[][][]): [number, number] | null => {
  if (!rings.length) return null;
  const outer = rings[0];
  if (!outer.length) return null;
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  for (const [lon, lat] of outer) {
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      sumLon += lon;
      sumLat += lat;
      n++;
    }
  }
  if (!n) return null;
  return [sumLon / n, sumLat / n];
};

/* ------------------------------------------------------------------ */
/* Active vs. finished, running vs. under control                      */
/* ------------------------------------------------------------------ */
/**
 * The two feeds describe the same two facts in different words, so the
 * word matching lives here once and both fetchers use it.
 *
 *   "is it finished?"        → isFinishedStatus
 *   "is it under control?"   → isCalmStatus
 *
 * These read the agency's own status string. Neither one invents a
 * state the feed didn't report: an unrecognised status is neither
 * finished nor calm, which keeps the fire on the map, drawn in red.
 */
/**
 * Lowercase, and flatten every separator to a single space.
 *
 * The agencies write the same status four ways — "Out of Control",
 * "out-of-control", "OUT_OF_CONTROL". Without this, the hyphenated form
 * dodges the "out of control" guard below and then matches the bare word
 * "out", and a fire that is running loose gets deleted from the map as
 * finished. Normalise first, match second.
 */
const normaliseStatus = (raw: string | null | undefined): string =>
  (raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const isFinishedStatus = (raw: string | null | undefined): boolean => {
  const s = normaliseStatus(raw);
  if (!s) return false;
  // "Out", "Fire out", "Extinguished", "Declared out". Guard against
  // "out of control", which contains "out" and is the exact opposite.
  if (/out of control/.test(s)) return false;
  return /\b(out|extinguish\w*|complete|closed|inactive)\b/.test(s);
};

const isCalmStatus = (raw: string | null | undefined): boolean => {
  const s = normaliseStatus(raw);
  if (!s) return false;
  if (/out of control|not under control/.test(s)) return false;
  // BC / Alberta / Ontario wording, plus the US "contained" family.
  return /under control|being held|\bheld\b|contain\w*|patrol\w*|observ\w*|monitor\w*/.test(s);
};

/**
 * How long a perimeter can sit untouched before we stop calling it active.
 *
 * WFIGS "current" carries the whole season, and a good number of records
 * are fires that finished weeks ago whose crew never filed an out date.
 * Drawing those is the map claiming a fire is burning where nothing is.
 * A month with no update to an incident record is the agency's way of
 * saying it's over.
 *
 * Every filter in this file only ever removes a fire on POSITIVE
 * evidence it is finished — a stated out date, a stated status, a stated
 * update time that has gone stale. A record missing the field is kept.
 * Getting this backwards would hide a burning fire from someone driving
 * toward it, which is the one failure this app cannot have.
 */
const STALE_AFTER_DAYS = 30;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

/**
 * Newest epoch-ms timestamp across the fields NIFC uses for "last touched".
 *
 * DISCOVERY DATE IS DELIBERATELY NOT IN THIS LIST. A big western fire
 * burns for two months; ageing a record out by when it STARTED would
 * erase exactly the fires that matter most. Only fields that mean "this
 * record was updated" count, and when none of them are present we return
 * null and keep the fire. Silence is not evidence a fire went out.
 */
const lastTouchedMs = (a: WfigsAttrs): number | null => {
  const candidates = [
    a.attr_ModifiedOnDateTime_dt,
    a.poly_DateCurrent,
    a.poly_PolygonDateTime
  ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!candidates.length) return null;
  return Math.max(...candidates);
};

/**
 * Is this WFIGS record a fire that is still going?
 *
 * Out means out: an out date, a prescribed burn, or a record nobody has
 * touched in a month. Everything else stays on the map, contained or
 * not — a 100%-contained fire is still a fire you can smell from your
 * campsite, and it is drawn in orange rather than hidden.
 */
const isActiveWfigs = (a: WfigsAttrs): boolean => {
  if (typeof a.attr_FireOutDateTime === 'number' && Number.isFinite(a.attr_FireOutDateTime)) {
    return false;
  }
  if (isFinishedStatus(a.attr_StageOfControlStatus)) return false;
  // Category is 'WF' for wildfires. Prescribed burns ('RX') are planned
  // work, not a hazard to route around, and showing them as wildfire
  // alarms a camper about a fire crew doing their job.
  const category = (a.attr_IncidentTypeCategory ?? '').trim().toUpperCase();
  if (category && category !== 'WF') return false;

  const touched = lastTouchedMs(a);
  if (touched != null && Date.now() - touched > STALE_AFTER_MS) return false;

  return true;
};

/** US: contained or formally controlled counts as under control. */
const wfigsUnderControl = (a: WfigsAttrs): boolean => {
  const dated = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  if (dated(a.attr_ControlDateTime) || dated(a.attr_ContainmentDateTime)) return true;
  if (isCalmStatus(a.attr_StageOfControlStatus)) return true;
  const pct = safeNumber(a.attr_PercentContained);
  if (pct != null && pct >= 100) return true;
  // Partly contained is not contained. A fire at 60% is still running on
  // 40% of its edge, and the camper downwind of that edge needs red.
  return false;
};

const fetchWfigsPerimeters = async (
  minLon: number, minLat: number, maxLon: number, maxLat: number
): Promise<FireFeatureProps[]> => {
  // ArcGIS geometry intersect: build an envelope. We use a simple
  // bbox-vs-bbox filter, accepting a few extra perimeters that just
  // touch the edge — over-inclusion here is fine, the client clips.
  const params = new URLSearchParams({
    /**
     * `where` IS NOT OPTIONAL, EVEN WITH A GEOMETRY FILTER.
     *
     * An ArcGIS FeatureServer query with a geometry but no where clause is
     * rejected outright — "Unable to perform query" — and the reply is a 200
     * with an `error` object inside it, which this code reads as "no fires".
     * Every US perimeter request came back empty for that reason. The other
     * ArcGIS callers in this repo (server/boundaryRoutes.ts) all send `1=1`.
     */
    where: '1=1',
    geometry: JSON.stringify({
      xmin: minLon, ymin: minLat, xmax: maxLon, ymax: maxLat,
      spatialReference: { wkid: 4326 }
    }),
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'json',
    returnGeometry: 'true',
    /**
     * All fields, not a named list. NIFC renames and re-prefixes columns
     * between service versions, and one stale name in an explicit `outFields`
     * makes the whole query fail — which looks exactly like "there are no
     * fires". The extra attributes cost a fraction of what the geometry does.
     */
    outFields: '*',
    resultRecordCount: '500'
  });
  const url = `${WFIGS_PERIMETERS}?${params.toString()}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Wandrlust/1.0 (camping map)' }
  });
  if (!res.ok) {
    throw new Error(`WFIGS responded ${res.status}`);
  }
  const data = await res.json() as EsriQueryResponse;
  // ArcGIS reports query errors inside a 200. Swallowing that reads as "no
  // fires burning", which is the one answer this app must never give by
  // accident — surface it so it lands in the response's `meta.errors`.
  if (data.error) throw new Error(`WFIGS query rejected: ${data.error.message}`);
  if (!Array.isArray(data.features)) return [];

  const out: FireFeatureProps[] = [];
  for (const f of data.features) {
    const a = f.attributes ?? {};
    if (!f.geometry?.rings?.length) continue;
    if (!isActiveWfigs(a)) continue;
    const rings = f.geometry.rings;
    const centroid = polygonCentroid(rings) ??
      [a.attr_InitialLongitude ?? 0, a.attr_InitialLatitude ?? 0];
    // Esri polygon ring format is identical to GeoJSON polygon ring
    // format ([lon, lat] vertices) — copy directly.
    const geometry: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: rings as GeoJSON.Polygon['coordinates']
    };
    // Reported size, whichever of the two fields carries it. Read once into
    // a variable so the value that is size-checked is the same one that gets
    // converted — the `!` this replaces was only safe by coincidence.
    const acres = safeNumber(a.attr_IncidentSize ?? a.poly_GISAcres);

    out.push({
      id: `wfigs:${a.OBJECTID ?? a.GlobalID ?? Math.random()}`,
      name: a.attr_IncidentName?.trim() || 'Unnamed fire',
      kind: 'perimeter',
      country: 'US',
      sizeAcres: acres,
      sizeHa: acres != null ? acresToHa(acres) : null,
      contained: safeNumber(a.attr_PercentContained),
      region: [a.attr_POOState, a.attr_POOCounty].filter(Boolean).join(' / ') || 'US',
      discovered: dateFromEpochMs(a.attr_FireDiscoveryDateTime),
      cause: null,
      status: a.attr_StageOfControlStatus?.trim() || null,
      underControl: wfigsUnderControl(a),
      centroid: centroid as [number, number],
      geometry
    });
  }
  return out;
};

interface FireRadarProps {
  incidentId?: string;
  name?: string;
  province?: string;
  status?: string;
  extinguished?: boolean;
  reportedSizeHa?: number;
  suspectedCause?: string | null;
  firstReportedAt?: string;
  lastUpdatedAt?: string;
}

interface FireRadarFC {
  features?: Array<{ type: 'Feature'; geometry: GeoJSON.Point; properties: FireRadarProps }>;
}

const fetchFireRadarPoints = async (
  minLon: number, minLat: number, maxLon: number, maxLat: number
): Promise<FireFeatureProps[]> => {
  // The whole feed is ~700 points across all of Canada; it's cheap to
  // pull the entire feed and bbox-filter on the server. If the size ever
  // grows past a megabyte we'd want a real bbox param, but right now
  // this is the simpler and more reliable path.
  const res = await fetch(FIRERADAR_CURRENT, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': 'Wandrlust/1.0 (camping map)' }
  });
  if (!res.ok) throw new Error(`FireRadar responded ${res.status}`);
  const data = await res.json() as FireRadarFC;
  if (!Array.isArray(data.features)) return [];

  const out: FireFeatureProps[] = [];
  for (const f of data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    const p = f.properties ?? {};
    // Finished fires are not "active fires". The feed flags most of them
    // with `extinguished`, but some provinces only say so in the status
    // string ("Out", "Extinguished"), so check both.
    if (p.extinguished) continue;
    if (isFinishedStatus(p.status)) continue;
    out.push({
      id: `fireradar:${p.incidentId ?? Math.random()}`,
      name: p.name?.trim() || 'Unnamed fire',
      kind: 'point',
      country: 'CA',
      sizeAcres: safeNumber(p.reportedSizeHa) != null
        ? (p.reportedSizeHa! / 0.404686) : null,
      sizeHa: safeNumber(p.reportedSizeHa),
      contained: null, // FireRadar doesn't surface percent contained
      region: p.province || 'CA',
      discovered: dateFromIso(p.firstReportedAt),
      cause: p.suspectedCause ?? null,
      status: p.status ?? null,
      // "Being held", "Under control", "Being patrolled" → orange.
      // "Out of control" and anything the provinces word differently → red.
      underControl: isCalmStatus(p.status),
      centroid: [lon, lat],
      geometry: f.geometry
    });
  }
  return out;
};

const readBbox = (req: Request): [number, number, number, number] | null => {
  const raw = (req.query.bbox as string | undefined) ?? '';
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  // Sanity: in-bounds for the app's coverage area or we'd be making
  // two big transcontinental fetches for a user who panned off-map.
  if (!bboxIntersectsCoverage({ minLon, minLat, maxLon, maxLat })) return null;
  // Reject inverted / zero-area boxes early.
  if (minLon >= maxLon || minLat >= maxLat) return null;
  // A box bigger than about California is served in full rather than
  // clamped: at that zoom the user is looking at the continent, fire point
  // data is sparse enough to stay cheap, and trimming the box would drop
  // fires that are on screen. There used to be an `if` here that returned
  // the same value in both branches, which read as a cap and was not one.
  return [minLon, minLat, maxLon, maxLat];
};

/**
 * Find fires within `radiusKm` of a given point.
 *
 * Used by the per-pin card. Not paginated: the caller's radius is small
 * (~25 km) and perimeters that intersect a 25 km circle are short.
 */
export const findFiresNear = (
  features: FireFeatureProps[],
  lat: number, lon: number, radiusKm: number
): Array<{ fire: FireFeatureProps; distanceKm: number }> => {
  const out: Array<{ fire: FireFeatureProps; distanceKm: number }> = [];
  for (const fire of features) {
    const [fLon, fLat] = fire.centroid;
    const d = distanceKm(lat, lon, fLat, fLon);
    if (d <= radiusKm) out.push({ fire, distanceKm: d });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
};

export const registerFireRoutes = (app: Express): void => {
  app.get('/api/fires', async (req: Request, res: Response) => {
    const box = readBbox(req);
    if (!box) {
      return res.status(400).json({ error: 'bbox must be "minLon,minLat,maxLon,maxLat" within the app coverage area.' });
    }
    const [minLon, minLat, maxLon, maxLat] = box;

    // 2-decimal cache key (~1.1 km) so two slightly different viewports
    // share the same answer; coarser than the cell-coverage cache
    // because fire perimeters can be huge.
    const cacheKey = `fires:${minLon.toFixed(2)},${minLat.toFixed(2)},${maxLon.toFixed(2)},${maxLat.toFixed(2)}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      return res.json(hit);
    }

    // Fire the two feeds in parallel. If either fails, the other still
    // serves — losing one country for a single hiccup is a worse
    // experience than logging the failure and continuing.
    const errors: string[] = [];
    const [us, ca] = await Promise.all([
      fetchWfigsPerimeters(minLon, minLat, maxLon, maxLat).catch((e) => {
        errors.push(`WFIGS: ${(e as Error).message}`);
        return [] as FireFeatureProps[];
      }),
      fetchFireRadarPoints(minLon, minLat, maxLon, maxLat).catch((e) => {
        errors.push(`FireRadar: ${(e as Error).message}`);
        return [] as FireFeatureProps[];
      })
    ]);
    const features = [...us, ...ca];

    const body: FireFC & { meta: { fetchedAt: string; errors: string[] } } = {
      type: 'FeatureCollection',
      features: features.map((p) => ({
        type: 'Feature',
        geometry: p.geometry,
        properties: p
      })) as FireFC['features'],
      meta: {
        fetchedAt: new Date().toISOString(),
        errors
      }
    };

    cache.set(cacheKey, body);

    return res.json(body);
  });
};
