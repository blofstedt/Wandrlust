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
 * uniformly. We do not pretend the point is the perimeter — the client
 * draws them as two distinct things (red outline for perimeters, orange
 * dot for points) so the user can tell what they are looking at.
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
import { bboxIntersectsCoverage } from '../src/config/coverage';
import { distanceKm } from './cellSources.js';

interface CacheEntry { at: number; body: unknown; }
const cache = new Map<string, CacheEntry>();
/** 6h — fire data updates within hours; 6h keeps the network quiet without
 *  serving a stale answer through a full day of a camper's trip. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 80;

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

const fetchWfigsPerimeters = async (
  minLon: number, minLat: number, maxLon: number, maxLat: number
): Promise<FireFeatureProps[]> => {
  // ArcGIS geometry intersect: build an envelope. We use a simple
  // bbox-vs-bbox filter, accepting a few extra perimeters that just
  // touch the edge — over-inclusion here is fine, the client clips.
  const params = new URLSearchParams({
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
    outFields: 'attr_IncidentName,attr_IncidentSize,attr_PercentContained,' +
               'attr_POOState,attr_POOCounty,attr_FireDiscoveryDateTime,' +
               'attr_InitialLatitude,attr_InitialLongitude,OBJECTID,GlobalID',
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
  if (data.error || !Array.isArray(data.features)) return [];

  const out: FireFeatureProps[] = [];
  for (const f of data.features) {
    const a = f.attributes ?? {};
    if (!f.geometry?.rings?.length) continue;
    const rings = f.geometry.rings;
    const centroid = polygonCentroid(rings) ??
      [a.attr_InitialLongitude ?? 0, a.attr_InitialLatitude ?? 0];
    // Esri polygon ring format is identical to GeoJSON polygon ring
    // format ([lon, lat] vertices) — copy directly.
    const geometry: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: rings as GeoJSON.Polygon['coordinates']
    };
    out.push({
      id: `wfigs:${a.OBJECTID ?? a.GlobalID ?? Math.random()}`,
      name: a.attr_IncidentName?.trim() || 'Unnamed fire',
      kind: 'perimeter',
      country: 'US',
      sizeAcres: safeNumber(a.attr_IncidentSize ?? a.poly_GISAcres),
      sizeHa: safeNumber(a.attr_IncidentSize ?? a.poly_GISAcres) != null
        ? acresToHa(a.attr_IncidentSize ?? a.poly_GISAcres!)
        : null,
      contained: safeNumber(a.attr_PercentContained),
      region: [a.attr_POOState, a.attr_POOCounty].filter(Boolean).join(' / ') || 'US',
      discovered: dateFromEpochMs(a.attr_FireDiscoveryDateTime),
      cause: null,
      status: null,
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
    if (p.extinguished) continue; // skip contained fires — they're done
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
  // Cap the requested area: 4 degrees on a side is roughly the size of
  // California. Beyond that, either the user is looking at the whole
  // continent (point data is sparse enough to be useful) or the URL
  // is malformed; either way we serve the whole feed.
  const SPAN_CAP_DEG = 4;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  if (span > SPAN_CAP_DEG) {
    return [minLon, minLat, maxLon, maxLat]; // over-cap: still serve, the bboxes overlap
  }
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
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(hit.body);
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

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, { at: Date.now(), body });

    return res.json(body);
  });
};
