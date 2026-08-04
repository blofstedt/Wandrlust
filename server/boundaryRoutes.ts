/**
 * Public land boundaries.
 *
 *   GET /api/boundaries?minLat=&minLon=&maxLat=&maxLon=
 *
 * Proxies authoritative government ArcGIS REST services. Proxying (rather than
 * calling from the browser) gives us one place to cache, normalise provenance,
 * and avoid per-origin CORS differences.
 *
 * Every polygon returned carries `_source`, `_confidence`, `_edgeAccuracy` and
 * `_campingBasisKind` so the client never has to guess what it's drawing.
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
  /** Limit the source to its real geographic extent. */
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

const BOUNDARY_SOURCES: BoundarySource[] = [
  {
    id: 'blm_sma_national',
    label: 'BLM Surface Management Agency (BLM / USFS)',
    attribution: 'Bureau of Land Management, Geospatial Business Platform',
    url: 'https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/SurfaceManagementAgency/FeatureServer/0/query',
    where: "ADMIN_AGENCY_CODE IN ('BLM','FS')",
    outFields: 'ADMIN_UNIT_NAME,ADMIN_AGENCY_CODE',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    name: (p) => p.ADMIN_UNIT_NAME || 'Federal land',
    designation: (p) =>
      p.ADMIN_AGENCY_CODE === 'BLM' ? 'Bureau of Land Management'
      : p.ADMIN_AGENCY_CODE === 'FS' ? 'US Forest Service'
      : String(p.ADMIN_AGENCY_CODE ?? 'Federal'),
    extent: { minLat: 24.0, minLon: -125.5, maxLat: 49.5, maxLon: -66.5 }
  },
  {
    id: 'ontario_clupa_general_use',
    label: 'Ontario Crown Land — General Use Area',
    attribution: "Land Information Ontario, King's Printer for Ontario",
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open06/MapServer/5/query',
    where: "DESIGNATION_ENG='General Use Area'",
    outFields: 'NAME_ENG,DESIGNATION_ENG,POLICY_IDENT',
    confidence: 'designated_general_use',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    name: (p) => p.NAME_ENG || 'General Use Area',
    designation: (p) => p.DESIGNATION_ENG || 'General Use Area',
    extent: { minLat: 41.6, minLon: -95.2, maxLat: 56.9, maxLon: -74.3 }
  },
  {
    id: 'alberta_pluz',
    label: 'Alberta Public Land Use Zones',
    attribution: 'Government of Alberta, Open Government Licence – Alberta',
    url: 'https://geospatial.alberta.ca/titan/rest/services/base/land_use_management_10tm_nad83_aep/MapServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managed_zone',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'explicit_designation',
    name: (p) => p.PLUZ_NAME || 'Public Land Use Zone',
    designation: () => 'Public Land Use Zone (PLUZ)',
    extent: { minLat: 48.9, minLon: -120.1, maxLat: 60.1, maxLon: -109.9 }
  }
];

const overlaps = (
  a: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  b: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): boolean =>
  !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);

// Small in-memory cache. Viewports are rounded so panning reuses entries.
const boundaryCache = new Map<string, { at: number; body: unknown }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const queryBoundarySource = async (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number
): Promise<{ features: any[]; ok: boolean }> => {
  if (!overlaps(bbox, source.extent)) return { features: [], ok: true };

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
    resultRecordCount: '250',
    f: 'geojson'
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const response = await fetch(`${source.url}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Wandrlust/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return { features: [], ok: false };

    const data: any = await response.json();
    if (!Array.isArray(data?.features)) return { features: [], ok: false };

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

    return { features, ok: true };
  } catch {
    return { features: [], ok: false };
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
        meta: { skipped: 'viewport_too_large', sources: [] }
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
          featureCount: r.features.length
        })),
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
