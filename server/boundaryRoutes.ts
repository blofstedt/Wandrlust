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
 * can have.
 */
import type { Express, Request, Response } from 'express';

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

/** Per-source ceiling. Hitting it means the viewport is showing partial data. */
const RECORD_LIMIT = 250;

const overlaps = (
  a: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  b: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): boolean =>
  !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);

// Small in-memory cache. Viewports are rounded so panning reuses entries.
const boundaryCache = new Map<string, { at: number; body: unknown }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

interface SourceResult {
  features: any[];
  ok: boolean;
  /** True when the server had more polygons than it was willing to return. */
  truncated: boolean;
}

const queryBoundarySource = async (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number
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
    resultRecordCount: String(RECORD_LIMIT),
    f: 'geojson'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

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
      features.length >= RECORD_LIMIT;

    return { features, ok: true, truncated };
  } catch {
    return { features: [], ok: false, truncated: false };
  } finally {
    clearTimeout(timer);
  }
};

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
    const simplifyDegrees = Math.max(0.0001, Math.max(spanLat, spanLon) / 800);

    const cacheKey = [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(2)).join(',');
    const cached = boundaryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.body);

    const results = await Promise.all(
      BOUNDARY_SOURCES.map(async (source) => ({
        source,
        ...(await queryBoundarySource(source, bbox, simplifyDegrees))
      }))
    );

    const anyTruncated = results.some((r) => r.truncated);

    const body = {
      type: 'FeatureCollection',
      features: results.flatMap((r) => r.features),
      meta: {
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
        disclaimer:
          'Approximate land management boundaries. NOT survey-grade and NOT ' +
          'parcel-level ownership records — BLM states its Surface Management ' +
          'Agency data does not illustrate ownership boundaries. Private ' +
          'inholdings are not shown. These polygons do not constitute ' +
          'permission to camp. Confirm local regulations before travelling.'
      }
    };

    if (boundaryCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = boundaryCache.keys().next().value;
      if (oldest) boundaryCache.delete(oldest);
    }
    boundaryCache.set(cacheKey, { at: Date.now(), body });

    return res.json(body);
  });
};
