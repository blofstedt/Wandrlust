/**
 * Public land boundaries.
 *
 *   GET /api/boundaries?minLat=&minLon=&maxLat=&maxLon=
 *
 * Proxies authoritative government ArcGIS REST services. Proxying (rather than
 * calling from the browser) gives us one place to cache, normalise provenance,
 * and avoid per-origin CORS differences.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN — the map was hiding almost everything
 * ---------------------------------------------------------------------------
 *
 * 1. THE "NATIONAL" BLM SOURCE HELD 7 FEATURES.
 *    The previous endpoint was `.../SurfaceManagementAgency/FeatureServer/0`,
 *    whose layer is literally named `SurfaceManagementAgency_Clip`. It is a
 *    small clipped SAMPLE of the national dataset — a query for Moab, Utah,
 *    which is ringed by BLM land, returned zero features. Every US boundary
 *    was missing and the API reported `available: true` throughout, because
 *    an empty result is not an error.
 *
 * 2. THE FOREST SERVICE FILTER COULD NEVER MATCH.
 *    The filter was `ADMIN_AGENCY_CODE IN ('BLM','FS')`, but that field's
 *    actual values are BIA, BLM, DOD, NPS, PVT, ST, USFS. `'FS'` matches
 *    nothing, so national forests were excluded by a typo.
 *
 * 3. ALBERTA WAS SHOWING MANAGEMENT ZONES, NOT CROWN LAND.
 *    PLUZ (Public Land Use Zones) are a handful of specially managed areas —
 *    Kananaskis, Ghost, McLean Creek. Alberta's actual Crown land is the
 *    GREEN AREA: roughly 339,000 km², about 60% of the province, and where
 *    most random camping in the province happens. It was absent entirely.
 *
 * Every endpoint and field name below was verified against the live services
 * before being committed. If you change one, re-verify — a wrong field name
 * fails silently as an empty result, which is the worst failure mode this app
 * can have. `npm run probe` checks all of them in one go.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DATA COMES FROM NOW
 * ---------------------------------------------------------------------------
 *
 * Seeded data first, live services second.
 *
 * `npm run seed` has always written every polygon into Supabase, and until now
 * nothing read it — this endpoint proxied the live ArcGIS services on every
 * single request, so seeding changed nothing the user could see, and the map
 * was only ever as available as five government servers.
 *
 * A request now asks the database first. If it has boundaries for that
 * viewport they are served from there: one query, no upstream dependency, and
 * a response in milliseconds instead of seconds.
 *
 * If the database is not configured, not migrated, or simply has nothing for
 * that area, the live proxy below answers exactly as it always did. That
 * fallback is deliberate and load-bearing — it means this is safe to deploy
 * before anyone has run a seed, and it means an unseeded region degrades to
 * the old behaviour rather than to an empty map that would read as "no public
 * land here".
 */
import type { Express, Request, Response } from 'express';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const gzipAsync = promisify(gzip);

/* -------------------------------------------------------------------------- */
/* Seeded boundaries                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read-only client on the public key.
 *
 * Boundaries are world-readable by RLS policy, so there is no reason to reach
 * for the service role here — and a service-role client in a request path is
 * how key leaks happen.
 */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY;

let seededClient: SupabaseClient | null | undefined;

const getSeededClient = (): SupabaseClient | null => {
  if (seededClient !== undefined) return seededClient;
  seededClient =
    SUPABASE_URL && SUPABASE_ANON
      ? createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
      : null;
  if (!seededClient) {
    console.info('[boundaries] Supabase not configured — using live services only.');
  }
  return seededClient;
};

/**
 * Suppresses the seeded lookup after the database itself proves unusable —
 * migration not run, credentials wrong, host unreachable.
 *
 * Deliberately NOT triggered by an empty result. An empty result is a correct
 * answer meaning "nothing is seeded for this bounding box", which is expected
 * constantly while only some regions are loaded. Treating that as a failure
 * would let one pan into unseeded Montana switch the whole seeded path off for
 * five minutes, so a user panning back to a seeded region would silently get
 * the slow live path instead.
 */
let seededOutage: { at: number } | null = null;
const SEEDED_RECHECK_MS = 5 * 60 * 1000;

interface SeededResult {
  features: any[];
  sources: { id: string; label: string; attribution: string; confidence: string; featureCount: number }[];
}

const fetchSeededBoundaries = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number
): Promise<SeededResult | null> => {
  const client = getSeededClient();
  if (!client) return null;

  if (seededOutage && Date.now() - seededOutage.at < SEEDED_RECHECK_MS) return null;

  try {
    const { data, error } = await client.rpc('boundaries_in_bbox', {
      in_min_lat: bbox.minLat,
      in_min_lon: bbox.minLon,
      in_max_lat: bbox.maxLat,
      in_max_lon: bbox.maxLon,
      in_tolerance: simplifyDegrees,
      // Ask for one more than we'll keep, so truncation can be detected.
      in_limit: recordLimit + 1
    });

    if (error) {
      // Most likely the migration has not been run. Say so once, clearly,
      // rather than failing every request in silence.
      console.warn(`[boundaries] seeded lookup unavailable: ${error.message}`);
      seededOutage = { at: Date.now() };
      return null;
    }

    // The database answered, so it is healthy — whatever it answered.
    seededOutage = null;

    const features = Array.isArray(data?.features) ? data.features : [];
    // Nothing seeded for this box. Fall through to the live services for this
    // request only; the seeded path stays enabled for everywhere else.
    if (features.length === 0) return null;

    // Count per source from the features themselves — no second round trip.
    const counts = new Map<string, { label: string; attribution: string; confidence: string; n: number }>();
    for (const f of features) {
      const p = f?.properties ?? {};
      const id = String(p._source ?? 'unknown');
      const existing = counts.get(id);
      if (existing) existing.n += 1;
      else {
        counts.set(id, {
          label: String(p._sourceName ?? id),
          attribution: String(p._attribution ?? ''),
          confidence: String(p._confidence ?? 'managing_agency'),
          n: 1
        });
      }
    }

    return {
      features,
      sources: [...counts.entries()].map(([id, v]) => ({
        id,
        label: v.label,
        attribution: v.attribution,
        confidence: v.confidence,
        featureCount: v.n
      }))
    };
  } catch (err) {
    console.warn(`[boundaries] seeded lookup failed: ${(err as Error).message}`);
    seededOutage = { at: Date.now() };
    return null;
  }
};

interface BoundarySource {
  id: string;
  label: string;
  attribution: string;
  url: string;
  where: string;
  outFields: string;
  confidence: 'designated_general_use' | 'managing_agency' | 'managed_zone';
  /** How much to trust the polygon's edges. Never survey-grade. */
  edgeAccuracy: 'generalised' | 'administrative' | 'cadastral_derived';
  /** On what basis camping is claimed to be permitted. */
  campingBasisKind: 'explicit_designation' | 'open_access_flag' | 'agency_policy_inference';
  name: (p: Record<string, any>) => string;
  designation: (p: Record<string, any>) => string;
  /** Limits the source to its real geographic extent. */
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

/**
 * Field names arrive lower-cased from some services and upper-cased from
 * others, depending on the underlying database. Rather than guess per source,
 * look the key up case-insensitively.
 */
const pick = (props: Record<string, any>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    if (props[key] != null && props[key] !== '') return String(props[key]);
    const found = Object.keys(props).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found && props[found] != null && props[found] !== '') return String(props[found]);
  }
  return undefined;
};

const CONUS = { minLat: 24.0, minLon: -125.5, maxLat: 49.5, maxLon: -66.5 };

const BOUNDARY_SOURCES: BoundarySource[] = [
  {
    // Verified: 71,046 features nationally; returns results for Moab.
    // Replaces the 7-feature clipped sample this app shipped with.
    id: 'blm_lands',
    label: 'BLM public land',
    attribution: 'Bureau of Land Management, Geospatial Business Platform',
    url: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/BLM_Lands/FeatureServer/0/query',
    where: '1=1',
    outFields: 'unit_name',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    name: (p) => pick(p, 'unit_name') ?? 'BLM land',
    designation: () => 'Bureau of Land Management',
    extent: CONUS
  },
  {
    // Verified: 112 national forests; returns Custer Gallatin for Bozeman.
    // The previous config tried to get these from the BLM layer using an
    // agency code that does not exist in that field.
    id: 'usfs_national_forest',
    label: 'National Forest',
    attribution: 'USDA Forest Service, Enterprise Data Warehouse',
    url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/1/query',
    where: '1=1',
    outFields: 'FORESTNAME,REGION',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    name: (p) => pick(p, 'forestname', 'FORESTNAME') ?? 'National Forest',
    designation: () => 'US Forest Service',
    extent: CONUS
  },
  {
    // Verified: GWA_CODE 'GLC_G' is the Green Area — Alberta's Crown land.
    // Deliberately excludes the White Area, which is the settled southern
    // portion of the province and largely private freehold.
    id: 'alberta_green_area',
    label: 'Alberta Crown Land (Green Area)',
    attribution: 'Government of Alberta, Open Government Licence – Alberta',
    url: 'https://geospatial.alberta.ca/titan/rest/services/boundary/asrd_administrative_area/MapServer/1/query',
    where: "GWA_CODE='GLC_G'",
    outFields: 'GWA_NAME,GWA_CODE',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    // Random camping is generally permitted on Green Area Crown land, but a
    // Public Lands Camping Pass is required in the Eastern Slopes and some
    // areas are closed. That is inference from policy, not a designation.
    campingBasisKind: 'agency_policy_inference',
    name: () => 'Crown Land (Green Area)',
    designation: () => 'Alberta public land',
    extent: { minLat: 48.9, minLon: -120.1, maxLat: 60.1, maxLon: -109.9 }
  },
  {
    // Kept: PLUZ are specific managed zones layered ON TOP of Crown land,
    // each with its own rules, so they are genuinely separate information.
    id: 'alberta_pluz',
    label: 'Alberta Public Land Use Zones',
    attribution: 'Government of Alberta, Open Government Licence – Alberta',
    url: 'https://geospatial.alberta.ca/titan/rest/services/base/land_use_management_10tm_nad83_aep/MapServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managed_zone',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    name: (p) => pick(p, 'PLUZ_NAME', 'pluz_name') ?? 'Public Land Use Zone',
    designation: () => 'Public Land Use Zone (PLUZ)',
    extent: { minLat: 48.9, minLon: -120.1, maxLat: 60.1, maxLon: -109.9 }
  },
  {
    // Verified: returns General Use Areas for northern Ontario.
    id: 'ontario_clupa_general_use',
    label: 'Ontario Crown Land — General Use Area',
    attribution: "Land Information Ontario, King's Printer for Ontario",
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open06/MapServer/5/query',
    where: "DESIGNATION_ENG='General Use Area'",
    outFields: 'NAME_ENG,DESIGNATION_ENG',
    confidence: 'designated_general_use',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    name: (p) => pick(p, 'NAME_ENG') ?? 'General Use Area',
    designation: (p) => pick(p, 'DESIGNATION_ENG') ?? 'General Use Area',
    extent: { minLat: 41.6, minLon: -95.2, maxLat: 56.9, maxLon: -74.3 }
  }
];

/**
 * Per-source ceiling. Hitting it means the viewport is showing partial data.
 *
 * Scaled down for wide viewports: five sources each returning 250 polygons is
 * over a thousand shapes for the browser to draw, and at that zoom most of them
 * are a few pixels across. The response says when it truncated, and the map
 * tells the user to zoom in, so nothing is being claimed that isn't true.
 */
const recordLimitForSpan = (span: number): number => {
  if (span > 6) return 120;
  if (span > 2) return 200;
  return 250;
};

const overlaps = (
  a: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  b: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): boolean =>
  !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);

// Assembled responses, gzipped once and reused. Short-lived: this only exists
// to absorb bursts, since the per-source cache below does the real work.
const boundaryCache = new Map<string, { at: number; json: string; gzipped?: Buffer }>();
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 60;

/**
 * Per-source cache, and the reason panning stopped being painful.
 *
 * The client snaps its requests to a grid, so a short pan asks for the exact
 * same box and lands here instead of on five government ArcGIS services that
 * take seconds each. Entries are served immediately and refreshed in the
 * background — land management boundaries do not change minute to minute, so
 * showing a slightly old polygon while a fresh one loads costs nothing, and
 * waiting for the network costs the user the whole interaction.
 */
const sourceCache = new Map<string, { at: number; result: SourceResult }>();
const inFlight = new Map<string, Promise<SourceResult>>();
const SOURCE_TTL_MS = 30 * 60 * 1000;
const SOURCE_CACHE_MAX = 600;

interface SourceResult {
  features: any[];
  ok: boolean;
  /** True when the server had more polygons than it was willing to return. */
  truncated: boolean;
}

const queryBoundarySource = async (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number
): Promise<SourceResult> => {
  if (!overlaps(bbox, source.extent)) return { features: [], ok: true, truncated: false };

  const params = new URLSearchParams({
    where: source.where,
    geometry: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: source.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: String(simplifyDegrees),
    resultRecordCount: String(recordLimit),
    f: 'geojson'
  });

  const controller = new AbortController();
  // One unresponsive service used to hold the whole response for nine seconds.
  // It is reported as unavailable rather than waited on.
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${source.url}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Wandrlust/1.0' },
      signal: controller.signal
    });

    if (!response.ok) return { features: [], ok: false, truncated: false };

    const data: any = await response.json();

    // ArcGIS reports failures as HTTP 200 with an `error` key. Treating that
    // as an empty result would silently hide land, so it is a hard failure.
    if (data?.error) {
      console.warn(`[boundaries] ${source.id}:`, data.error?.message ?? 'query error');
      return { features: [], ok: false, truncated: false };
    }
    if (!Array.isArray(data?.features)) return { features: [], ok: false, truncated: false };

    const features = data.features
      .filter((f: any) => f?.geometry)
      .map((f: any) => {
        const props = f.properties ?? {};
        return {
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            _source: source.id,
            _sourceName: source.label,
            _attribution: source.attribution,
            _confidence: source.confidence,
            _edgeAccuracy: source.edgeAccuracy,
            _campingBasisKind: source.campingBasisKind,
            _name: source.name(props),
            _designation: source.designation(props)
          }
        };
      });

    // Two signals that the server withheld polygons: its own flag, and hitting
    // our requested cap exactly.
    const truncated =
      data?.exceededTransferLimit === true ||
      data?.properties?.exceededTransferLimit === true ||
      features.length >= recordLimit;

    return { features, ok: true, truncated };
  } catch {
    return { features: [], ok: false, truncated: false };
  } finally {
    clearTimeout(timer);
  }
};

/** Runs the query once per key, sharing one in-flight promise among callers. */
const runQuery = (
  key: string,
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number,
  stale?: SourceResult
): Promise<SourceResult> => {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = queryBoundarySource(source, bbox, simplifyDegrees, recordLimit)
    .then((result) => {
      if (!result.ok) {
        // A failure is never cached. Caching one would hide real public land
        // for the whole TTL because a government service blipped, and an
        // empty map that looks confident is the worst thing this app can do.
        return stale ?? result;
      }

      if (sourceCache.size >= SOURCE_CACHE_MAX) {
        const oldest = sourceCache.keys().next().value;
        if (oldest) sourceCache.delete(oldest);
      }
      sourceCache.set(key, { at: Date.now(), result });
      return result;
    })
    .catch(() => stale ?? { features: [], ok: false, truncated: false })
    .finally(() => { inFlight.delete(key); });

  inFlight.set(key, promise);
  return promise;
};

const cachedQuery = (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number
): Promise<SourceResult> => {
  const box = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon]
    .map((n) => n.toFixed(4))
    .join(',');
  const key = `${source.id}|${box}|${recordLimit}`;

  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return Promise.resolve(hit.result);

  const refresh = runQuery(key, source, bbox, simplifyDegrees, recordLimit, hit?.result);

  // Something cached but past its TTL: answer now, refresh behind the scenes.
  if (hit) {
    void refresh.catch(() => { /* runQuery already swallows failures */ });
    return Promise.resolve(hit.result);
  }
  return refresh;
};

/**
 * Send JSON gzipped when the client will take it.
 *
 * Boundary payloads are long runs of coordinate digits and repeated property
 * names — they compress by roughly ten to one, which on a phone tethered to a
 * weak signal is the difference between a second and ten.
 */
const sendJson = async (
  req: Request,
  res: Response,
  json: string,
  precompressed?: Buffer
): Promise<Buffer | undefined> => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Vary', 'Accept-Encoding');

  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (!acceptsGzip || json.length < 2048) {
    res.send(json);
    return undefined;
  }

  try {
    const buffer = precompressed ?? (await gzipAsync(json));
    res.setHeader('Content-Encoding', 'gzip');
    res.end(buffer);
    return buffer;
  } catch {
    res.send(json);
    return undefined;
  }
};

/**
 * Said the same way whichever path answered. The seeded database and the live
 * services carry exactly the same caveats, because it is the same data.
 */
const DISCLAIMER =
  'Approximate land management boundaries. NOT survey-grade and NOT ' +
  'parcel-level ownership records — BLM states its Surface Management ' +
  'Agency data does not illustrate ownership boundaries. Private ' +
  'inholdings are not shown. These polygons do not constitute ' +
  'permission to camp. Confirm local regulations before travelling.';

export const registerBoundaryRoutes = (app: Express): void => {
  app.get('/api/boundaries', async (req: Request, res: Response) => {
    const minLat = parseFloat(req.query.minLat as string);
    const minLon = parseFloat(req.query.minLon as string);
    const maxLat = parseFloat(req.query.maxLat as string);
    const maxLon = parseFloat(req.query.maxLon as string);

    if ([minLat, minLon, maxLat, maxLon].some((n) => Number.isNaN(n))) {
      return res.status(400).json({
        error: 'minLat, minLon, maxLat and maxLon are required numeric query params.'
      });
    }

    // Refuse absurd viewports outright — these would hammer upstream services.
    const spanLat = Math.abs(maxLat - minLat);
    const spanLon = Math.abs(maxLon - minLon);
    if (spanLat > 25 || spanLon > 40) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { skipped: 'viewport_too_large', sources: [], truncated: false }
      });
    }

    const bbox = { minLat, minLon, maxLat, maxLon };
    // Generalise geometry more aggressively when zoomed out.
    const span = Math.max(spanLat, spanLon);
    const simplifyDegrees = Math.max(0.0001, span / 800);
    const recordLimit = recordLimitForSpan(span);

    // Four decimals, not two: the client snaps its requests to a grid, so an
    // exact key still hits on a pan. Rounding to two decimals used to merge
    // genuinely different viewports into one cache entry.
    const cacheKey = [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(4)).join(',');
    const cached = boundaryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      await sendJson(req, res, cached.json, cached.gzipped);
      return;
    }

    /**
     * The database first.
     *
     * A seeded region answers from one indexed query. Anything else — no
     * Supabase, no migration, or simply nothing seeded for this viewport —
     * returns null and drops through to the live proxy below, so an unseeded
     * deploy behaves exactly as it did before.
     */
    const seeded = await fetchSeededBoundaries(bbox, simplifyDegrees, recordLimit);
    if (seeded) {
      const truncated = seeded.features.length > recordLimit;
      const body = {
        type: 'FeatureCollection',
        features: seeded.features.slice(0, recordLimit),
        meta: {
          servedFrom: 'seeded' as const,
          sources: seeded.sources.map((s) => ({ ...s, available: true, truncated })),
          truncated,
          truncationNote: truncated
            ? 'More public land exists here than could be drawn at this zoom. Zoom in to see all of it.'
            : undefined,
          disclaimer: DISCLAIMER
        }
      };

      const json = JSON.stringify(body);
      const gzipped = await sendJson(req, res, json);

      if (boundaryCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = boundaryCache.keys().next().value;
        if (oldest) boundaryCache.delete(oldest);
      }
      boundaryCache.set(cacheKey, { at: Date.now(), json, gzipped });
      return;
    }

    const results = await Promise.all(
      BOUNDARY_SOURCES.map(async (source) => ({
        source,
        ...(await cachedQuery(source, bbox, simplifyDegrees, recordLimit))
      }))
    );

    const anyTruncated = results.some((r) => r.truncated);

    const body = {
      type: 'FeatureCollection',
      features: results.flatMap((r) => r.features),
      meta: {
        servedFrom: 'live' as const,
        sources: results.map((r) => ({
          id: r.source.id,
          label: r.source.label,
          attribution: r.source.attribution,
          confidence: r.source.confidence,
          available: r.ok,
          featureCount: r.features.length,
          truncated: r.truncated
        })),
        truncated: anyTruncated,
        truncationNote: anyTruncated
          ? 'More public land exists here than could be drawn at this zoom. Zoom in to see all of it.'
          : undefined,
        disclaimer: DISCLAIMER
      }
    };

    const json = JSON.stringify(body);
    const gzipped = await sendJson(req, res, json);

    if (boundaryCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = boundaryCache.keys().next().value;
      if (oldest) boundaryCache.delete(oldest);
    }
    boundaryCache.set(cacheKey, { at: Date.now(), json, gzipped });
  });
};
