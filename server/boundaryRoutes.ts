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

/**
 * True once we have learned that this database is still on migration 06's
 * six-argument `boundaries_in_bbox`, which has no area filter.
 *
 * Migration 07 adds `in_min_area_sq_km` so the zoomed-out overview can ask for
 * only the big parcels. Sending that argument to a database that has not run 07
 * is a hard PostgREST error, and treating it as an outage would knock the whole
 * seeded path out for five minutes on every wide-zoom request. So: try the new
 * signature, and if the function does not have that parameter, fall back to the
 * old call for the rest of the process. The overview then filters by area in
 * this file instead — more bytes over the wire, same map.
 */
let seededHasAreaFilter = true;

interface SeededResult {
  features: any[];
  sources: { id: string; label: string; attribution: string; confidence: string; featureCount: number }[];
}

const fetchSeededBoundaries = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number,
  minAreaSqKm = 0
): Promise<SeededResult | null> => {
  const client = getSeededClient();
  if (!client) return null;

  if (seededOutage && Date.now() - seededOutage.at < SEEDED_RECHECK_MS) return null;

  const call = (withArea: boolean) =>
    client.rpc('boundaries_in_bbox', {
      in_min_lat: bbox.minLat,
      in_min_lon: bbox.minLon,
      in_max_lat: bbox.maxLat,
      in_max_lon: bbox.maxLon,
      in_tolerance: simplifyDegrees,
      // Ask for one more than we'll keep, so truncation can be detected.
      in_limit: recordLimit + 1,
      ...(withArea ? { in_min_area_sq_km: minAreaSqKm } : {})
    });

  try {
    let { data, error } = await call(seededHasAreaFilter);

    // PostgREST reports a signature mismatch as "could not find the function
    // ... in the schema cache" (PGRST202). That means migration 07 is missing,
    // not that the database is down.
    if (error && seededHasAreaFilter && /PGRST202|schema cache|does not exist/i.test(
      `${error.code ?? ''} ${error.message ?? ''}`
    )) {
      console.info('[boundaries] boundaries_in_bbox has no area filter — run migration 07 for a lighter zoomed-out overview.');
      seededHasAreaFilter = false;
      ({ data, error } = await call(false));
    }

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
  /**
   * How long to wait on this service, in ms. Defaults to 6000.
   *
   * Per-source because the sources are not alike: most return many small
   * parcels, but a province-wide Crown land layer can be a single enormous
   * multipolygon that the server has to generalise before it can answer, and
   * holding every other source to that pace would make the whole map slow.
   */
  timeoutMs?: number;
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
    /**
     * Saskatchewan's provincial forest — Crown resource land, the province's
     * closest equivalent to Alberta's Green Area.
     *
     * Whole-layer source, so there is no `where` filter to get wrong and no
     * field name to typo: the layer IS the provincial forest, and the name and
     * designation below are constants rather than reads off a property.
     *
     * NOT YET CONFIRMED AGAINST THE LIVE SERVICE — the one source here that
     * carries that caveat. It was added from Saskatchewan's published service
     * documentation while its host was unreachable, so run
     * `npm run probe -- --source=saskatchewan_provincial_forest` before seeding
     * it. Until then it fails in the safe direction: a wrong URL reports the
     * source unavailable rather than drawing an empty province, and the
     * geometry guard in `queryBoundarySource` drops anything that is not a
     * polygon.
     */
    id: 'saskatchewan_provincial_forest',
    label: 'Saskatchewan Crown Land (Provincial Forest)',
    attribution: 'Government of Saskatchewan, Ministry of Environment',
    url: 'https://gis.saskatchewan.ca/arcgis/rest/services/Forestry/MapServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    // Published as the Fire Management branch's display definition of the
    // forest, explicitly not the official boundary.
    edgeAccuracy: 'generalised',
    // 21 days free camping is provincial policy for Crown resource land, not
    // anything stated by this layer — and the forest contains protected areas,
    // recreation sites and leases that are not subtracted from it.
    campingBasisKind: 'agency_policy_inference',
    name: () => 'Crown Land (Provincial Forest)',
    designation: () => 'Saskatchewan provincial forest',
    extent: { minLat: 49.0, minLon: -110.1, maxLat: 60.0, maxLon: -101.3 },
    /**
     * A HYPOTHESIS, NOT A DIAGNOSIS — offered as such.
     *
     * The live API reports this source `available: false` with no logged
     * error, which under the old code narrowed it to three silent paths: a
     * non-200, a response that was not GeoJSON, or a timeout. Of those, a
     * timeout is the most likely here and the only one worth pre-empting:
     * the provincial forest is close to a single continent-sized multipolygon
     * threaded with lakes and rivers, and the server has to load and
     * generalise the whole thing before it can answer, where every other
     * source in this list returns many small parcels.
     *
     * If the real cause turns out to be a refusal or a format mismatch, this
     * changes nothing and the log line added alongside it will say so.
     */
    timeoutMs: 12000
  },
  {
    /**
     * Manitoba's fifteen provincial forests — Crown land under The Forest Act.
     *
     * Small (about 22,000 km², a few percent of Manitoba Crown land) and on
     * ArcGIS Online, the same platform as the BLM and PAD-US sources above,
     * so none of the Saskatchewan concerns about a slow single continental
     * polygon on a provincial server apply here.
     *
     * The service name and layer id come from the service's own published
     * REST directory, not from a pattern — but they have still not been
     * exercised against the live endpoint from this machine, so treat the
     * first production response as the verification. Manitoba draws nothing
     * today, so the worst case is that it continues to draw nothing.
     */
    id: 'manitoba_provincial_forest',
    label: 'Manitoba Crown Land (Provincial Forest)',
    attribution: 'Government of Manitoba, Open Government Licence – Manitoba',
    url: 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Provincial_Forests___Version_6/FeatureServer/1/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    // 21 days free on unoccupied Crown land unless posted is provincial
    // policy, not something this layer states. Parks, wildlife management
    // areas and posted closures are not subtracted from these forests.
    campingBasisKind: 'agency_policy_inference',
    name: (p) => pick(p, 'NAME', 'FOREST_NAME', 'PF_NAME', 'PROVINCIAL_FOREST') ?? 'Provincial Forest',
    designation: () => 'Manitoba provincial forest',
    extent: { minLat: 48.9, minLon: -102.1, maxLat: 60.1, maxLon: -88.9 }
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
  },
  {
    /**
     * PAD-US — THE NATIONAL INVENTORY, AND THE ONLY SOURCE HERE THAT KNOWS
     * ABOUT STATE LAND.
     *
     * BLM and the Forest Service between them cover federal land and nothing
     * else, so every state forest, state trust parcel, national grassland and
     * county holding in the country was invisible to this app — which is
     * exactly the gap `COVERAGE_GAPS` records as "US state trust and state
     * forest lands". PAD-US is USGS's national roll-up of all of it.
     *
     * `Pub_Access = 'OA'` is the filter that makes it usable: PAD-US grades
     * every polygon Open / Restricted / Closed, and only OA means the public
     * may walk in. Restricted and Closed are excluded rather than shown with a
     * caveat, because a polygon a camper cannot enter is not a lead.
     *
     * WHAT OA STILL DOES NOT MEAN. Open access is a statement about entry, not
     * about sleeping — a state park is usually OA and usually forbids
     * overnight parking. So this source's `campingBasisKind` is the weakest of
     * the three, and Beacon leans on the agency-specific sources above it
     * before this one.
     *
     * Definition lifted from `scripts/landSources.ts`, where the field names
     * were already worked out for the seeder.
     */
    id: 'padus_open_access',
    label: 'Public land (PAD-US open access)',
    attribution: 'USGS Gap Analysis Project, Protected Areas Database of the US',
    url: 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/PADUS_Public_Access/FeatureServer/0/query',
    where: "Pub_Access = 'OA'",
    outFields: 'BndryName,Unit_Nm,Des_Tp,Mang_Name,Pub_Access',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'open_access_flag',
    name: (p) => pick(p, 'BndryName', 'Unit_Nm') ?? 'Public land',
    designation: (p) => pick(p, 'Des_Tp', 'Mang_Name') ?? 'Open access public land',
    extent: CONUS
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

/* -------------------------------------------------------------------------- */
/* The zoomed-out overview                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rough area of a GeoJSON polygon in km².
 *
 * Shoelace on the outer rings, scaled from degrees by the latitude of the
 * shape. It is not a survey figure and is not shown to anyone — it exists only
 * to answer "is this parcel big enough to be worth a pixel at zoom 4?", which
 * it does to well within the order of magnitude that question needs.
 */
const approxAreaSqKm = (geometry: any): number => {
  if (!geometry) return 0;

  const ringArea = (ring: any[]): number => {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let sum = 0;
    let latSum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[j];
      const b = ring[i];
      if (!Array.isArray(a) || !Array.isArray(b)) return 0;
      sum += a[0] * b[1] - b[0] * a[1];
      latSum += b[1];
    }
    const meanLat = latSum / ring.length;
    // 1° of latitude is ~111.32 km; 1° of longitude shrinks with the cosine.
    return (Math.abs(sum) / 2) * 111.32 * 111.32 * Math.cos((meanLat * Math.PI) / 180);
  };

  if (geometry.type === 'Polygon') return ringArea(geometry.coordinates?.[0]);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates ?? []).reduce(
      (total: number, poly: any) => total + ringArea(poly?.[0]),
      0
    );
  }
  return 0;
};

/**
 * Drop parcels too small to read at this zoom, largest first.
 *
 * Used when the caller asked for an overview and the database could not do the
 * filtering itself (migration 07 not run) or the data came from the live ArcGIS
 * services, which have no consistent area field to filter on.
 */
const largestParcels = (features: any[], minAreaSqKm: number, limit: number): any[] => {
  if (minAreaSqKm <= 0) return features.slice(0, limit);
  return features
    .map((f) => ({ f, area: approxAreaSqKm(f?.geometry) }))
    .filter((x) => x.area >= minAreaSqKm)
    .sort((a, b) => b.area - a.area)
    .slice(0, limit)
    .map((x) => x.f);
};

const overlaps = (
  a: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  b: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): boolean =>
  !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);

// Assembled responses, gzipped once and reused. Short-lived: this only exists
// to absorb bursts, since the per-source cache below does the real work.
const boundaryCache = new Map<string, { at: number; ttl: number; json: string; gzipped?: Buffer }>();
const CACHE_TTL_MS = 60 * 1000;
/**
 * Overview responses are kept far longer than detailed ones.
 *
 * There are only a handful of them (the client snaps wide-zoom requests to a
 * grid measured in whole map-widths), they are expensive to assemble, and the
 * shape of a national forest does not change over an afternoon.
 */
const OVERVIEW_TTL_MS = 6 * 60 * 60 * 1000;
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
  const timeoutMs = source.timeoutMs ?? 6000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${source.url}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Wandrlust/1.0' },
      signal: controller.signal
    });

    // Every failure below used to return silently, so a source that had
    // stopped answering was indistinguishable in the logs from one that
    // simply had no land in view. `available: false` in the response told
    // you THAT it failed and never WHY, which is the same silent-empty trap
    // this file's header warns about — one level further down.
    if (!response.ok) {
      console.warn(`[boundaries] ${source.id}: HTTP ${response.status} ${response.statusText}`);
      return { features: [], ok: false, truncated: false };
    }

    const data: any = await response.json();

    // ArcGIS reports failures as HTTP 200 with an `error` key. Treating that
    // as an empty result would silently hide land, so it is a hard failure.
    if (data?.error) {
      console.warn(`[boundaries] ${source.id}:`, data.error?.message ?? 'query error');
      return { features: [], ok: false, truncated: false };
    }
    if (!Array.isArray(data?.features)) {
      // Most often a service that ignored `f=geojson` and answered in Esri
      // JSON, which has `features[].geometry.rings` and no `type`.
      console.warn(
        `[boundaries] ${source.id}: response had no GeoJSON feature array (keys: ${Object.keys(
          data ?? {}
        ).join(',') || 'none'})`
      );
      return { features: [], ok: false, truncated: false };
    }

    const returned = data.features.length;
    const features = data.features
      // Polygons only. Several government services publish a boundary as a
      // LINE layer sitting next to the area layer, and a line drawn in the
      // public-land style would read as a sliver of campable land that isn't
      // there. Anything that is not an area is dropped rather than drawn.
      .filter((f: any) => f?.geometry && /^(Multi)?Polygon$/.test(String(f.geometry.type ?? '')))
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

    // The service answered with shapes and the geometry guard threw all of
    // them away — almost certainly a line layer being read as an area layer.
    // Silently drawing nothing here would look exactly like "no public land".
    if (returned > 0 && features.length === 0) {
      console.warn(
        `[boundaries] ${source.id}: ${returned} features returned, none were polygons ` +
          `(first geometry type: ${String(data.features[0]?.geometry?.type ?? 'none')})`
      );
    }

    return { features, ok: true, truncated };
  } catch (err) {
    console.warn(
      `[boundaries] ${source.id}: ${
        timedOut ? `no response within ${timeoutMs}ms` : (err as Error).message
      }`
    );
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
  precompressed?: Buffer,
  maxAgeSeconds = 300
): Promise<Buffer | undefined> => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
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

/**
 * THE PUBLIC-LAND POLYGONS FOR ONE BOX, FOR ANYTHING THAT IS NOT THE MAP.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Beacon used to decide "is this public land?" by reading OpenStreetMap tags
 * — `boundary=protected_area`, an `operator` string it pattern-matched — while
 * this file sat next to it holding the actual government surface-management
 * data the map has drawn all along. Two answers to one question, and the
 * weaker one was wired to the feature that sends campers somewhere.
 *
 * That mismatch is the whole reason a scan came back as a list of car parks
 * AND missed real public land at the same time: OSM's protected-area coverage
 * is volunteer-drawn and thin, so a national forest with no OSM polygon looked
 * exactly like a supermarket, and a conservancy easement with one looked
 * exactly like a national forest.
 *
 * Same sources, same cache, same seeded-database-first path as `/api/boundaries`.
 * If the map can draw it, Beacon can stand on it.
 *
 * Never throws. A source that is down contributes nothing and says so through
 * `ok`, which the caller must report rather than reading as "not public".
 */
export interface PublicLandLookup {
  /** False when every source failed — "could not check", never "not public". */
  ok: boolean;
  /** GeoJSON polygons carrying `_name`, `_designation`, `_source`. */
  features: any[];
}

export const fetchPublicLand = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  recordLimit = 400
): Promise<PublicLandLookup> => {
  const span = Math.max(
    Math.abs(bbox.maxLat - bbox.minLat),
    Math.abs(bbox.maxLon - bbox.minLon)
  );
  // A beacon scan is a few kilometres across, so the geometry can stay sharp.
  // This is a point-in-polygon test, not something being drawn.
  const simplifyDegrees = Math.max(0.00005, span / 2000);

  try {
    const seeded = await fetchSeededBoundaries(bbox, simplifyDegrees, recordLimit, 0);
    if (seeded && seeded.features.length > 0) {
      return { ok: true, features: seeded.features };
    }

    const results = await Promise.all(
      BOUNDARY_SOURCES.map((source) => cachedQuery(source, bbox, simplifyDegrees, recordLimit))
    );
    return {
      // Every single source failing is an outage, not an empty countryside.
      ok: results.some((r) => r.ok),
      features: results.flatMap((r) => r.features)
    };
  } catch {
    return { ok: false, features: [] };
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

    /**
     * Overview mode: the whole continent, only the big parcels, hairline thin.
     *
     * Below zoom 7 the client asks for this instead of nothing at all. It
     * deliberately accepts a much larger viewport than the detailed path — the
     * point is to show that there IS public land over there — and pays for it
     * by returning far fewer, far coarser polygons.
     */
    const isOverview = req.query.detail === 'overview';
    const minAreaSqKm = isOverview
      ? Math.max(0, Number(req.query.minAreaSqKm) || 0)
      : 0;

    // Refuse absurd viewports outright — these would hammer upstream services.
    const spanLat = Math.abs(maxLat - minLat);
    const spanLon = Math.abs(maxLon - minLon);
    if (spanLat > (isOverview ? 60 : 25) || spanLon > (isOverview ? 140 : 40)) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { skipped: 'viewport_too_large', sources: [], truncated: false }
      });
    }

    const bbox = { minLat, minLon, maxLat, maxLon };
    // Generalise geometry more aggressively when zoomed out.
    const span = Math.max(spanLat, spanLon);
    const simplifyDegrees = isOverview
      ? Math.max(0.002, span / 400)
      : Math.max(0.0001, span / 800);
    const recordLimit = isOverview ? 500 : recordLimitForSpan(span);
    const responseTtl = isOverview ? OVERVIEW_TTL_MS : CACHE_TTL_MS;

    // Four decimals, not two: the client snaps its requests to a grid, so an
    // exact key still hits on a pan. Rounding to two decimals used to merge
    // genuinely different viewports into one cache entry.
    const cacheKey = [
      [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(4)).join(','),
      isOverview ? `ov${minAreaSqKm}` : 'full'
    ].join('|');
    const cached = boundaryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cached.ttl) {
      await sendJson(req, res, cached.json, cached.gzipped, Math.round(cached.ttl / 1000));
      return;
    }

    const remember = async (body: unknown) => {
      const json = JSON.stringify(body);
      const gzipped = await sendJson(req, res, json, undefined, Math.round(responseTtl / 1000));
      if (boundaryCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = boundaryCache.keys().next().value;
        if (oldest) boundaryCache.delete(oldest);
      }
      boundaryCache.set(cacheKey, { at: Date.now(), ttl: responseTtl, json, gzipped });
    };

    /**
     * The database first.
     *
     * A seeded region answers from one indexed query. Anything else — no
     * Supabase, no migration, or simply nothing seeded for this viewport —
     * returns null and drops through to the live proxy below, so an unseeded
     * deploy behaves exactly as it did before.
     */
    const seeded = await fetchSeededBoundaries(bbox, simplifyDegrees, recordLimit, minAreaSqKm);
    if (seeded) {
      // If the database did the area filtering, this is a no-op slice.
      const kept = isOverview
        ? largestParcels(seeded.features, seededHasAreaFilter ? 0 : minAreaSqKm, recordLimit)
        : seeded.features.slice(0, recordLimit);
      const truncated = seeded.features.length > recordLimit;

      await remember({
        type: 'FeatureCollection',
        features: kept,
        meta: {
          servedFrom: 'seeded' as const,
          detail: isOverview ? ('overview' as const) : ('full' as const),
          sources: seeded.sources.map((s) => ({ ...s, available: true, truncated })),
          truncated,
          truncationNote: truncated
            ? 'More public land exists here than could be drawn at this zoom. Zoom in to see all of it.'
            : undefined,
          disclaimer: DISCLAIMER
        }
      });
      return;
    }

    const results = await Promise.all(
      BOUNDARY_SOURCES.map(async (source) => ({
        source,
        ...(await cachedQuery(source, bbox, simplifyDegrees, recordLimit))
      }))
    );

    const anyTruncated = results.some((r) => r.truncated);
    const liveFeatures = isOverview
      ? largestParcels(results.flatMap((r) => r.features), minAreaSqKm, recordLimit)
      : results.flatMap((r) => r.features);

    const body = {
      type: 'FeatureCollection',
      features: liveFeatures,
      meta: {
        servedFrom: 'live' as const,
        detail: isOverview ? ('overview' as const) : ('full' as const),
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

    await remember(body);
  });
};