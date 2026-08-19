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
/*
 * THE `.js` IS LOAD-BEARING. The project is `"type": "module"`, so the Vercel
 * function uses strict ESM resolution and a relative import without a file
 * extension throws ERR_MODULE_NOT_FOUND at import time. `safeRegister` in
 * api/index.ts catches it exactly as designed, and the whole boundaries
 * service then answers 503 — which is what took every public-land boundary
 * off the deployed map the day this import was added. We write `.js` even
 * though the source is `.ts`: that is the ESM convention, referring to the
 * compiled output. `npm run check:imports` now fails the build over it.
 */
import { subtractLakes, unionParcels, lakeCount, ringsIn } from './landGeometry.js';

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
/**
 * The tile cache is written as well as read, and RLS locks it to the server.
 * Same key the alert ingester, push dispatcher and Beacon routes already use.
 */
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  /**
   * How this service is asked.
   *
   * `arcgis` (the default) is what every source here was: an ArcGIS REST
   * `/query` endpoint that takes an envelope, a `where` clause and — the part
   * that matters most — `maxAllowableOffset`, so the SERVER generalises the
   * geometry before it sends it.
   *
   * `wfs` is an OGC Web Feature Service, which is how British Columbia
   * publishes. It has no equivalent of `maxAllowableOffset`: a WFS sends the
   * full-resolution shape or nothing. That difference is the reason for
   * `maxBytes` and for the local generalisation pass below — see the BC source
   * for what it costs.
   */
  protocol?: 'arcgis' | 'wfs';
  url: string;
  /** ArcGIS only. The layer filter. */
  where?: string;
  /** ArcGIS only. Which attributes to return. */
  outFields?: string;
  /** WFS only. The published feature type, e.g. `WHSE_ADMIN_BOUNDARIES.X`. */
  typeName?: string;
  /**
   * WFS only. Give up on a response bigger than this rather than parse it.
   *
   * A WFS cannot generalise, and a bbox filter SELECTS features without
   * CLIPPING them — so one query that happens to touch a province-sized
   * multipolygon can return tens of megabytes. This function has 30 seconds
   * and a shared lambda to live in, so past this budget the source reports
   * itself unavailable, which is honest, instead of stalling the whole
   * response for every other source too.
   */
  maxBytes?: number;
  /**
   * WFS only. Do not even ask when the viewport is wider than this, in degrees.
   *
   * An ArcGIS source answers a continent by generalising it. A WFS answers a
   * continent by sending it, so past a certain viewport there is no answer to
   * be had — only a long wait and a discarded download. Skipping is reported
   * as unavailable, which is what it is: this source could not answer THIS
   * question. The zoomed-out map is served by the committed overview instead,
   * and `landDataGap` still says what is and is not mapped.
   */
  maxSpanDegrees?: number;
  /**
   * Ask for the shape as it is and generalise it here.
   *
   * `maxAllowableOffset` is normally the best thing about an ArcGIS source —
   * the server thins the geometry before it sends it. Quebec's PATP service
   * answers that ask with forty-five features and NO GEOMETRY AT ALL: correct
   * attributes, nulls where the polygons should be, which this pipeline then
   * drops as "not an area". Asking for the plain shape and thinning it here
   * costs bytes and buys a province.
   */
  generaliseLocally?: boolean;
  /**
   * What to ask the service to answer in.
   *
   * `geojson` (the default) is what every ArcGIS source here uses. `esri` is
   * for a service that answers a GeoJSON request with attributes and a null
   * where the polygon should be — Quebec's does — and whose own format works
   * fine. Esri JSON carries geometry as `rings`, which `esriRingsToGeoJson`
   * turns back into polygons and holes.
   */
  format?: 'geojson' | 'esri';
  /**
   * The layer's own area column, if it has one.
   *
   * ArcGIS: used to ask for the BIGGEST parcels in view once the viewport is
   * wide, instead of whichever ones the database offers first. This is the
   * whole difference between an Ontario that looks like Ontario and an Ontario
   * that looks like a scatter of flecks — see `arcgisQueryUrl`. Prefer a plain
   * attribute column (`SYS_AREA`, `gis_acres`) over a computed geometry one
   * (`SHAPE.AREA`): the server can sort an indexed column, and these are the
   * services that were already timing out on the wide ask.
   *
   *
   * WFS: what it buys is the wide view. Past `maxSpanDegrees` the full ask is
   * hopeless, but "the biggest N shapes in view" is both affordable and the
   * right answer at that zoom — a forest too small to see is not what someone
   * looking at a whole province is asking about. Sorting is done by the
   * SERVER, so which shapes come back is principled rather than whichever
   * order the database felt like.
   */
  areaField?: string;
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

/**
 * The label for a source whose field names we do not control.
 *
 * `pick` needs the field name in advance, which is fine for a source whose
 * schema was read off its own REST page and wrong for one taken whole with
 * `outFields: '*'`. Manitoba's forests came back labelled "Provincial Forest"
 * — the fallback — fifteen times over, because the real field is not any of
 * NAME / FOREST_NAME / PF_NAME. Rather than keep guessing, ask the properties
 * what they have: the first string field whose NAME looks like a name.
 *
 * Ordered so an exact match wins before a fuzzy one, and length-capped so a
 * description field can never be mistaken for a label.
 */
const nameLike = (props: Record<string, any>, ...preferred: string[]): string | undefined => {
  const exact = pick(props, ...preferred);
  // Same rule as below: a field called NAME holding "92" is still an id.
  if (exact && /[a-z]/i.test(exact)) return exact;

  /*
   * A NUMBER IS AN ID, NOT A NAME. British Columbia's provincial forests came
   * back labelled "92" — a field whose key looked name-ish holding a bare
   * number — and a pin on the map reading "92" is worse than one reading
   * "Provincial Forest", because it looks like it knows something.
   */
  const usable = (v: unknown): v is string =>
    typeof v === 'string' &&
    v.trim() !== '' &&
    v.trim().length <= 80 &&
    /[a-z]/i.test(v);

  const keys = Object.keys(props ?? {});
  // A field actually called "name" of some sort, then anything name-ish.
  for (const pattern of [/(^|_)name($|_)/i, /name/i, /forest|unit|area|label|title/i]) {
    const hit = keys.find((k) => pattern.test(k) && usable(props[k]));
    if (hit) return String(props[hit]).trim();
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
    extent: CONUS,
    // Hosted feature service: `Shape__Area` is a real, indexed column.
    areaField: 'Shape__Area'
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
    extent: CONUS,
    // An attribute, not a computed geometry area — this layer was already
    // timing out on the wide ask and must not be made to work harder.
    areaField: 'gis_acres'
  },
  {
    /**
     * BRITISH COLUMBIA — the provincial forest, and the first source here that
     * is not an ArcGIS service.
     *
     * BC was the province this app was worst at. It is roughly 95% Crown land
     * and it drew as an empty map with a chip reading "No mapped public land in
     * view" — the app stating, confidently and wrongly, that there is nowhere
     * to camp in British Columbia. That is the exact failure `landDataGap` in
     * `src/config/coverage.ts` exists to prevent, and BC is the province it was
     * written about.
     *
     * WHY THIS LAYER AND NOT ANOTHER. The two BC layers people reach for first
     * are both traps, and both are recorded in CANDIDATE_SOURCES with the
     * reasons: ParcelMap BC is a cadastral fabric that covers TITLED parcels
     * and SURVEYED Crown parcels, so most of the province's Crown land is
     * simply absent from it, and it disclaims legal-boundary authority itself.
     * TANTALIS publishes Crown TENURES, which are encumbrances — land somebody
     * else already has rights to, the opposite of what a camper is looking for.
     *
     * FADM_PROV_FOREST is forest land designated Provincial Forest by Order in
     * Council under the Forest Act. Everything inside it is provincial Crown
     * land, which makes it a CONSERVATIVE answer rather than a complete one:
     * the polygons understate BC's Crown land badly — most of the province is
     * Crown land outside a provincial forest — but they do not overstate it,
     * and understating is the direction this app is allowed to be wrong in.
     * It is the same claim already made for Saskatchewan and Manitoba, whose
     * provincial forests are here for the same reason, and CA-BC stays in
     * COVERAGE_GAPS saying loudly that the rest is unmapped.
     *
     * WHAT THE DESIGNATION DOES NOT SAY. Nothing about camping. The 14-day
     * allowance is BC's general Land Act policy for Crown land, not a property
     * of this layer — hence `agency_policy_inference` — and a provincial
     * forest contains tenures, woodlots, recreation sites and areas closed by
     * order, none of which are subtracted here.
     *
     * NOT YET EXERCISED AGAINST THE LIVE SERVICE. The agent sandbox cannot
     * reach gov.bc.ca, so this endpoint was assembled from DataBC's published
     * WFS conventions and this dataset's own object name rather than confirmed
     * by a call. It fails in the safe direction — an unreachable or mis-named
     * feature type reports the source unavailable instead of drawing an empty
     * province, the axis-order guard rejects a response it cannot place in BC
     * rather than drawing it in the wrong hemisphere, and the geometry guard
     * drops anything that is not a polygon. Before trusting it, run
     * `npm run probe -- --source=bc_provincial_forest`, and check
     * `meta.sources[]` on a real BC viewport in production.
     */
    id: 'bc_provincial_forest',
    label: 'BC Crown Land (Provincial Forest)',
    attribution: 'Government of British Columbia, DataBC — Open Government Licence – British Columbia',
    protocol: 'wfs',
    url: 'https://openmaps.gov.bc.ca/geo/pub/ows',
    typeName: 'WHSE_ADMIN_BOUNDARIES.FADM_PROV_FOREST',
    confidence: 'managing_agency',
    edgeAccuracy: 'administrative',
    campingBasisKind: 'agency_policy_inference',
    /*
     * Production says this layer has no usable name field: every forest came
     * back as "92" — a number out of an id column that happened to look
     * name-shaped. `nameLike` now refuses a value with no letters in it, so
     * these read "Provincial Forest", exactly as Saskatchewan's and
     * Manitoba's constants do. If the field list in the logs ever shows a
     * real name column, name it here.
     */
    name: (p) => nameLike(p, 'PROV_FOREST_NAME', 'FOREST_NAME', 'NAME') ?? 'Provincial Forest',
    designation: () => 'British Columbia provincial forest',
    extent: { minLat: 48.2, minLon: -139.1, maxLat: 60.05, maxLon: -114.0 },
    /**
     * Longer than the 6s default, and deliberately not much longer.
     *
     * A WFS sends full-resolution geometry, so BC's first (uncached) answer is
     * genuinely more work than an ArcGIS query that generalises before it
     * replies. But the whole response waits for the slowest source, and
     * Saskatchewan already taught this file that a source which cannot answer
     * should fail fast rather than be waited on: at 12s it failed exactly as it
     * had at 6s, and all the extra time bought was a longer stall. 10s is the
     * compromise — enough for a cold GeoServer, short enough to leave room
     * inside the 30s function limit for everything else on screen.
     */
    timeoutMs: 12000,
    /*
     * MEASURED IN PRODUCTION, not guessed. A half-degree box around Prince
     * George answers with five forests; a one-degree box with nine; a
     * two-degree box blows a 12MB budget on its own. Full-resolution survey
     * geometry is simply what a WFS sends, and this layer's boundaries are
     * dense.
     *
     * So the budget goes up to what a serverless function can still parse in
     * one piece, and the span ceiling stops us spending twelve seconds and
     * twenty megabytes on a viewport we already know cannot be answered.
     */
    maxBytes: 20 * 1024 * 1024,
    maxSpanDegrees: 2.5,
    // Confirmed in production from the layer's own field list, which the
    // first response of every WFS source now prints.
    areaField: 'FEATURE_AREA_SQM'
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
     * DIAGNOSED, AND NOT YET FIXED. Production logs:
     *
     *     [boundaries] saskatchewan_provincial_forest: no response within 12000ms
     *
     * So it is a timeout, as suspected — but raising the limit is not the
     * answer. At 6s it failed, at 12s it still failed, and all 12s bought was
     * a longer stall before the same empty result, on every Saskatchewan
     * viewport, because the whole response waits for the slowest source. It
     * is back to the default: if this source cannot answer, it should fail
     * fast and let the rest of the map draw.
     *
     * THE ACTUAL FIX is to stop asking this server. Saskatchewan publishes
     * the same forest through its GeoHub as an ArcGIS Online hosted layer —
     * "Provincial Forest Boundary Polygon", item 3ee7b7d7d3244be789040017f0969e78
     * under org zcv98lgAl8xQ04cW on services3.arcgis.com — which is CDN-backed
     * and would answer in milliseconds, exactly as Manitoba's does. What is
     * missing is that service's exact name, and searching returns its LINE
     * sibling instead; the authoritative answer is one call to
     * arcgis.com/sharing/rest/content/items/<id>?f=json, which this machine
     * cannot reach. Guessing the name is what put a broken source here in the
     * first place, so it stays unguessed until someone can read that.
     */
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
    // Confirmed against production: none of the guessed field names matched
    // and all fifteen forests came back as the bare fallback, so this reads
    // whatever name-shaped field the layer actually carries.
    // Production printed this layer's fields: the name column is
    // PROV_FOREST_NAME, which none of the earlier guesses had.
    name: (p) => nameLike(p, 'PROV_FOREST_NAME', 'NAME', 'FOREST_NAME') ?? 'Provincial Forest',
    designation: () => 'Manitoba provincial forest',
    extent: { minLat: 48.9, minLon: -102.1, maxLat: 60.1, maxLon: -88.9 },
    areaField: 'AREA_HA'
  },
  /*
   * ---------------------------------------------------------------------------
   * QUEBEC, AND WHY IT IS NOT IN THIS LIST
   * ---------------------------------------------------------------------------
   *
   * The biggest gap in the country by area: roughly 92% of Quebec is terres du
   * domaine de l'État, and this file draws none of it.
   *
   * The right layer is not in doubt. It is the PATP — the public land use plan
   * — whose polygons exist only where the land is public, with a vocation on
   * each (`Utilisation multiple`, `Protection`, and so on). Its service is
   *
   *     servicescarto.mrnf.gouv.qc.ca/pes/rest/services/Territoire/PATP_prov_WMS
   *
   * layer 1, `Affectations surfaciques`, and it ANSWERS: the right features,
   * the right attributes, the right vocations. It just will not send the
   * shapes. Asked in GeoJSON it returns `"geometry": null`; asked in Esri JSON
   * it returns features with no geometry key at all; asked without
   * `maxAllowableOffset`, the same. The service name ends `_WMS` and that is
   * exactly what it is — a map service published to draw pictures, whose REST
   * query hands back the attribute table.
   *
   * Its whole `Territoire` folder was listed from production: thirty-odd
   * services, two of them published `_WFS` (FRONTIERES, Tirage_au_sort) and no
   * PATP among them. So this server has no vector PATP to give.
   *
   * AND THE SECOND DEAD END, so nobody repeats it. Quebec's word for whether
   * ground belongs to the public domain is `domanialité`, and there is a
   * service called exactly that:
   *
   *     peche.faune.gouv.qc.ca/arcgis_webadaptor_prodc_10_9_1/rest/services/
   *       PRODC-E/DOMANIALITE/MapServer
   *
   * It is the right layer — MRNF's own public-versus-private reference — and
   * its web adaptor answers `?f=json` with an HTML page rather than JSON, both
   * for the service and for its folder. It may want `f=pjson`, or a token, or
   * it may simply not be open. That is a five-second question for anyone with
   * a browser and unanswerable from here.
   *
   * WHAT TO TRY NEXT, in the order worth trying:
   *   1. Open DOMANIALITE in a browser. If the REST directory renders, the
   *      layer id and its fields are all that is missing.
   *   2. IGO / geoegl.msp.gouv.qc.ca — Quebec's other OGC infrastructure,
   *      which publishes real WFS; look for affectation or domanialité there.
   *   3. Données Québec's PATP dataset resources — if any of them is GeoJSON,
   *      the seeder can ingest it as a file source today, no new code.
   *   4. The regional PATP services (PATP_NdQ_EIBJ_WMS, PATP_NdQ_Kativik_WMS),
   *      in case a regional one was published differently from the provincial.
   *
   * The machinery a working service will need is already here and tested:
   * `format: 'esri'` reads Esri rings, `generaliseLocally` handles a service
   * that cannot thin its own geometry, and `maxBytes` keeps either from
   * flooding the function. Wiring one is a source entry, not a project.
   *
   * Until then Quebec is a recorded gap rather than a source that draws
   * nothing — because a source returning zero features says "no public land
   * here" to every camper in Quebec, and `landDataGap` says the true thing
   * instead.
   */
  {
    /**
     * NEW BRUNSWICK — Crown land, as an ownership layer.
     *
     * The cleanest source in this file after Alberta's Green Area: the
     * province publishes the EXTENT OF CROWN LAND itself, as open data, rather
     * than a designation that has to be read as a proxy for it. About half of
     * New Brunswick, concentrated in the northern interior.
     *
     * New Brunswick calls overnight camping "occasional use" and says plainly
     * that occasional use needs no authorisation. That is still policy rather
     * than anything this layer states, so the basis stays an inference — and
     * the layer includes Crown land that is leased, licensed or otherwise
     * spoken for, none of which is subtracted here.
     */
    id: 'new_brunswick_crown_land',
    label: 'New Brunswick Crown Land',
    attribution: 'Government of New Brunswick, Department of Natural Resources and Energy Development',
    url: 'https://gis-erd-der.gnb.ca/server/rest/services/OpenData/Crown_Lands/MapServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'cadastral_derived',
    campingBasisKind: 'agency_policy_inference',
    name: () => 'Crown Land',
    designation: () => 'New Brunswick Crown land',
    extent: { minLat: 44.5, minLon: -69.2, maxLat: 48.2, maxLon: -63.6 },
    // Printed by the layer itself: SHAPE.AREA, SHAPE.LEN, OBJECTID, HOLDER.
    areaField: 'SHAPE.AREA'
  },
  {
    /**
     * NOVA SCOTIA — Crown parcels, and the province where the caveat does the
     * most work.
     *
     * The layer is honest and specific: land under the administration of the
     * Minister of Natural Resources and Renewables under the Crown Lands Act,
     * including land the department holds only a partial interest in. It is
     * also fragmented — Nova Scotia's Crown land is roughly a third of the
     * province in thousands of pieces, not a solid block like Alberta's.
     *
     * TWO THINGS THIS PROVINCE DOES DIFFERENTLY, both in the rules card.
     * Wilderness areas and wildlife management areas sit inside these parcels
     * with their own rules, and Nova Scotia closes the woods outright in bad
     * fire seasons — a restriction no polygon here knows about.
     */
    id: 'nova_scotia_crown_land',
    label: 'Nova Scotia Crown Land',
    attribution: 'Government of Nova Scotia, Department of Natural Resources and Renewables',
    url: 'https://nsgiwa.novascotia.ca/arcgis/rest/services/PLAN/PLANCrownLandsWM84V1/MapServer/0/query',
    where: '1=1',
    outFields: '*',
    confidence: 'managing_agency',
    edgeAccuracy: 'cadastral_derived',
    campingBasisKind: 'agency_policy_inference',
    name: () => 'Crown Land',
    designation: () => 'Nova Scotia Crown land',
    extent: { minLat: 43.3, minLon: -66.5, maxLat: 47.2, maxLon: -59.6 }
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
    extent: { minLat: 41.6, minLon: -95.2, maxLat: 56.9, maxLon: -74.3 },
    /*
     * The reason this province stopped looking like confetti. `SYS_AREA` is
     * LIO's own area attribute, chosen over the computed `SHAPE.AREA` because
     * this service times out on the wide ask as it is.
     */
    areaField: 'SYS_AREA'
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
    extent: CONUS,
    areaField: 'GIS_Acres'
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

/**
 * How many parcels to ask each source for in the OVERVIEW, by how wide the
 * viewport is.
 *
 * ---------------------------------------------------------------------------
 * THIS IS WHY ONTARIO AND SASKATCHEWAN WENT BLANK WHEN YOU ZOOMED OUT
 * ---------------------------------------------------------------------------
 *
 * The overview used to ask every source for a flat 500 records however wide the
 * view was. Production logs, on a Great Lakes viewport:
 *
 *     [boundaries] ontario_clupa_general_use: no response within 6000ms
 *
 * — while the same source answers a one-degree box with 48 parcels instantly.
 * Nothing was wrong with the data. We were asking a provincial ArcGIS server to
 * fetch and generalise five hundred complex polygons spanning half a province,
 * which it cannot do inside the timeout, so the whole source dropped out and
 * Ontario drew as empty ground next to a well-covered Michigan.
 *
 * The ask was never worth its cost. At continental zoom the area filter throws
 * nearly all of those parcels away before anything is drawn — a hundred-square-
 * kilometre shape is a fraction of a pixel — so the server was being made to do
 * six times the work to produce a handful of visible shapes.
 *
 * Fewer records the wider you go. This is the opposite of the intuition that a
 * bigger area needs more data, and it is right for the same reason the area
 * filter exists: a wider view has room for fewer distinguishable shapes, not
 * more.
 *
 * ---------------------------------------------------------------------------
 * AND THEN IT WAS TOO FEW, AND ONTARIO LOOKED EMPTY INSTEAD OF BLANK
 * ---------------------------------------------------------------------------
 *
 * 80 per source was the number that stopped the timeouts, and it also meant a
 * camper looking at Ontario at zoom 5 saw about eleven parcels on a province
 * carpeted in General Use Areas — then crossed into the detailed tier and
 * watched it fill in. Sparse-and-wrong reads exactly like empty-and-wrong.
 *
 * What made 500 unaffordable was not the count. It was 500 polygons at
 * `geometryPrecision: 5` — one-metre coordinates — which the upstream server
 * had to fetch, generalise and serialise inside six seconds. The precision now
 * tracks the generalisation tolerance (about 100 m at these zooms) and
 * sub-pixel parts are dropped before the response is built, so the same count
 * is a fraction of the work it was.
 *
 * The ceiling is raised on the back of that, and `queryBoundarySource` carries
 * the insurance: a source that times out on the ambitious ask is retried once,
 * immediately, at the old conservative count. So the worst case is what this
 * function used to do on its own, and the normal case is a province that looks
 * like the province.
 */
const overviewRecordLimit = (span: number): number => {
  if (span > 60) return 200;
  if (span > 25) return 300;
  if (span > 12) return 400;
  return 500;
};

/**
 * What a source gets asked for after the ambitious ask timed out.
 *
 * Deliberately the number that was in force before the ceiling went up: it is
 * known to be answerable by every source in this file, including the slow
 * provincial ones, because it is what they were being asked for.
 */
const OVERVIEW_RETRY_RECORDS = 80;

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

/* -------------------------------------------------------------------------- */
/* Parts of a parcel that are too small to see                                 */
/* -------------------------------------------------------------------------- */

/**
 * THE THOUSANDS OF TINY SHAPES WERE NEVER THOUSANDS OF PARCELS.
 *
 * The area filter above works on FEATURES, and a feature is not a shape. One
 * Ontario General Use Area is a single MultiPolygon whose coordinates hold
 * every scrap of Crown land in that planning unit — the big blocks, and then
 * several hundred slivers between a lake and a road, each one a fraction of a
 * pixel wide at the zoom anyone looks at a province from.
 *
 * `approxAreaSqKm` sums all of them, so the feature sails through the filter
 * and brings its whole confetti of parts along. That is what a camper sees as
 * "thousands of individual parcels instead of grouping like Alberta does", and
 * it is the same confetti the browser is paying for: every part is vertices to
 * transfer, an outline to dissolve, and a path to draw. Alberta looks clean
 * because the Green Area genuinely IS one shape, not because it is treated
 * differently.
 *
 * So parts below what a screen can resolve are dropped from the geometry
 * itself, before the response is built. Nothing about which LAND is included
 * changes — only whether a shape too small to see is sent to be drawn.
 *
 * A FEATURE NEVER COMES BACK EMPTY. If every part is below the threshold the
 * biggest one is kept regardless. A parcel that draws as two pixels is honest;
 * a parcel that silently disappears is the empty-province failure this file
 * exists to prevent.
 */
const partAreaDeg2 = (ring: any[]): number => {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
};

/**
 * Drop sub-pixel parts of a MultiPolygon.
 *
 * `minPartDeg2` is in square degrees rather than km² on purpose: it is derived
 * from the same simplification tolerance the source was queried with, so it
 * scales with the zoom automatically and needs no latitude correction to
 * answer the only question being asked — "is this bigger than a few pixels?"
 *
 * `maxParts` is the backstop for a parcel that is genuinely made of hundreds
 * of visible pieces: keep the largest, drop the tail.
 */
export const pruneTinyParts = (geometry: any, minPartDeg2: number, maxParts: number): any => {
  if (geometry?.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) {
    return geometry;
  }
  const parts = geometry.coordinates as any[];
  if (parts.length <= 1) return geometry;

  const sized = parts
    .map((poly) => ({ poly, area: partAreaDeg2(poly?.[0]) }))
    .sort((a, b) => b.area - a.area);

  let kept = sized.filter((x) => x.area >= minPartDeg2).slice(0, maxParts);
  // Never nothing: the biggest piece survives whatever the threshold says.
  if (kept.length === 0) kept = sized.slice(0, 1);
  if (kept.length === parts.length) return geometry;

  return kept.length === 1
    ? { type: 'Polygon', coordinates: kept[0].poly }
    : { type: 'MultiPolygon', coordinates: kept.map((x) => x.poly) };
};

/** How many separate pieces one parcel may draw as. */
const MAX_PARTS_DETAIL = 160;
/**
 * A merged overview shape is not a parcel — it is every parcel one source has
 * in view, welded into one feature covering a province or a whole agency. So
 * its allowance is per SOURCE rather than per parcel, and it has to be
 * generous: an archipelago of Crown land around a hundred northern lakes is
 * genuinely a hundred pieces, and capping it at a couple of dozen is how a
 * province ends up looking emptier than it is.
 *
 * It is still far fewer shapes than the overview used to draw — two dozen
 * parts each across two hundred separate parcels.
 */
const MAX_PARTS_MERGED = 250;
/**
 * Parts kept per parcel on the way INTO the merge.
 *
 * Nothing here is about what is legible; it is about what the union can afford
 * to chew on. The threshold that decides what a camper actually sees is
 * applied afterwards, once neighbours have had their chance to join up.
 */
const MAX_PARTS_FOR_MERGE = 400;

/**
 * FOUR SIMPLIFICATION STEPS ON A SIDE.
 *
 * `simplifyDegrees` is already the tolerance the source is being asked to
 * generalise to — about one screen pixel on a phone at the view in question —
 * so four of them is a blob roughly four pixels across. Below that there is
 * nothing to look at and nothing to tap.
 */
/**
 * How small a piece of a welded shape has to be before it is not worth drawing.
 *
 * The tolerance is about a four-hundredth of the viewport, so a screen a
 * thousand pixels wide renders it as roughly two and a half pixels. The
 * multiplier is therefore in pixels, near enough, and it used to be FOUR —
 * which threw away every welded block under about ten pixels across.
 *
 * On Ontario and Alberta that changed nothing: their blocks are enormous. On
 * New Brunswick and Nova Scotia, whose Crown land is thousands of parcels a
 * few kilometres wide welded into modest blocks, it threw away the province.
 * Five hundred New Brunswick parcels came back as a single blob twenty-five
 * kilometres across, on a map of a province with thirty thousand square
 * kilometres of Crown land.
 *
 * A block four pixels across is small. It is not invisible, and on this map it
 * is somewhere a camper could actually go. The count is still bounded — the
 * biggest `MAX_PARTS_MERGED` survive and the rest are dropped — so the cost of
 * being less brutal here is bounded too.
 */
const visiblePartDeg2 = (simplifyDegrees: number): number => (1.5 * simplifyDegrees) ** 2;

const prunedFeatures = (features: any[], minPartDeg2: number, maxParts: number): any[] =>
  features.map((f) => {
    const geometry = pruneTinyParts(f?.geometry, minPartDeg2, maxParts);
    return geometry === f?.geometry ? f : { ...f, geometry };
  });

/**
 * TAKE THE WATER OUT, AT EVERY ZOOM.
 *
 * A Crown land or BLM polygon includes the lakes inside it, correctly — the
 * province owns the lakebed. Painted as this app's "you can sleep here" wash
 * it tells campers to pitch on open water, so it is cut out of the geometry
 * before the response is built. Server-side rather than in the browser
 * because a real geometric difference costs a couple of hundred milliseconds
 * and this answer is about to sit in a cache row for months.
 */
const withoutWater = (features: any[]): any[] =>
  features.map((f) => {
    const geometry = subtractLakes(f?.geometry);
    return geometry === f?.geometry ? f : { ...f, geometry };
  });

/**
 * ONE SHAPE PER SOURCE, FOR THE ZOOMED-OUT MAP.
 *
 * This is the difference between Ontario and Alberta, and it was never about
 * the provinces. Alberta's Green Area arrives as a single polygon; Ontario's
 * Crown land arrives as hundreds of General Use Areas, and hundreds of
 * separate shapes at province scale is both the flicker the camper sees and
 * most of the bytes on the wire.
 *
 * At overview zoom nobody is reading parcel edges — the question is "is there
 * public land over there" — so each source's parcels are merged into one
 * shape. It is a real boolean union, so it does not depend on neighbouring
 * parcels having matching vertices the way the browser's edge-cancelling
 * merge did, and the same input always produces the same output.
 *
 * THE MERGED SHAPE IS RENAMED, BECAUSE IT IS NO LONGER ONE PARCEL. Borrowing
 * the name of whichever General Use Area happened to be first would put a
 * specific, wrong name on a tap anywhere in the province. It takes the
 * SOURCE's name instead — "Ontario Crown Land — General Use Area" — which is
 * true of every square metre of the merged shape, and it keeps `_source`, so
 * the published stay rules still resolve exactly as before.
 */
/**
 * The grid parcels are snapped to before welding, as a multiple of the
 * generalisation tolerance. See `snapMultiPoly` in landGeometry.ts.
 *
 * ONE, and that is a measured number rather than a guessed one. Simulating what
 * the upstream servers actually do to a shared edge — thin each side's copy
 * independently, so the two wander either side of the truth — and unioning 36
 * parcels that all abut:
 *
 *     edge drift      no snap   0.25x   0.5x    1x     2x
 *     10% of tol.        1        1       1      1      2
 *     25% of tol.       11        7       1      1      1
 *     50% of tol.       31       —       18      1      3
 *
 * (parts after the union; 1 is a perfect weld, 36 is total failure)
 *
 * A bigger grid is not a better weld. Past about one tolerance, snapping starts
 * pushing neighbouring edges onto DIFFERENT grid lines as often as onto the
 * same one, and the weld gets worse again.
 *
 * One tolerance is also the honest ceiling. It is the distance the geometry was
 * already generalised by before it got here, so snapping to that grid cannot
 * move an edge further than the upstream server already moved it — and it is
 * never applied at the zooms where a camper reads an edge.
 */
const MERGE_SNAP_STEPS = 1;

/**
 * Rings one source may hand the clipper before its geometry gets trimmed.
 *
 * Measured rather than feared. Unioning synthetic parcels of the shape Ontario
 * sends — a main block plus a tail of slivers — on this machine:
 *
 *     200 parcels x 10 parts   (2,000 rings)    75 ms
 *     200 parcels x 40 parts   (8,000 rings)   113 ms
 *     500 parcels x 10 parts   (5,000 rings)   120 ms
 *
 * So the budget is set well above what any source returns, because every ring
 * trimmed to get under it is land that then cannot weld to its neighbours —
 * which is the entire failure this pipeline was reordered to fix. It is passed
 * to `unionParcels` explicitly, overriding the far more cautious default in
 * landGeometry.ts that was written before anyone had timed this.
 */
const MERGE_RING_BUDGET = 12000;

/**
 * Wall clock the whole merge may spend, across every source.
 *
 * The API is one Vercel function with a thirty-second ceiling and this runs
 * after eight government services have already been waited on. A merged shape
 * is a nicety; answering at all is not — so when the budget runs out the
 * remaining sources fall back to drawing their parcels, which is what the map
 * did before any of this existed.
 */
const MERGE_BUDGET_MS = 9000;

const ringsInGroup = (features: any[]): number =>
  features.reduce((n, f) => n + ringsIn(f?.geometry), 0);

const mergedBySource = (features: any[], simplifyDegrees: number): any[] => {
  const groups = new Map<string, any[]>();
  for (const f of features) {
    const id = String(f?.properties?._source ?? '');
    const g = groups.get(id);
    if (g) g.push(f);
    else groups.set(id, [f]);
  }

  const startedAt = Date.now();
  const out: any[] = [];

  groups.forEach((group) => {
    /*
     * Trim the input until the clipper can afford it.
     *
     * Starting threshold is half a pixel — small enough that anything two
     * neighbours could weld into something visible still goes in, large enough
     * to shed the confetti of sub-pixel slivers a fragmented Crown land parcel
     * carries. If that is still too much geometry the threshold quadruples and
     * we look again, up to four times.
     *
     * Deterministic, because the same input has to produce the same map: this
     * answer is about to sit in a cache for six hours.
     */
    let trimmed = group;
    /*
     * A QUARTER OF THE TOLERANCE, NOT A HALF.
     *
     * This is the gate parcels pass through to reach the union, and it was set
     * to shed the sub-pixel slivers a fragmented Crown land parcel carries.
     * Nova Scotia is made of nothing else: its Crown land is thousands of
     * pieces a kilometre or two across, so at province scale the gate was
     * closing on the whole province before the weld could turn it into
     * anything. Letting the smaller pieces in is what gives the union
     * something to join.
     *
     * The loop below still protects the clipper — if the geometry that gets
     * through is too much, the threshold quadruples and it looks again — so
     * this lowers the floor without raising the ceiling.
     */
    let minPart = (0.25 * simplifyDegrees) ** 2;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      trimmed = prunedFeatures(group, minPart, MAX_PARTS_FOR_MERGE);
      if (ringsInGroup(trimmed) <= MERGE_RING_BUDGET) break;
      minPart *= 4;
    }

    const merged =
      Date.now() - startedAt < MERGE_BUDGET_MS
        ? unionParcels(trimmed.map((f) => f.geometry), {
            snapDegrees: simplifyDegrees * MERGE_SNAP_STEPS,
            maxRings: MERGE_RING_BUDGET
          })
        : null;

    if (!merged) {
      // Nothing to join, a union we could not trust, or no time left. Either
      // way the parcels themselves are still the honest answer.
      out.push(...trimmed);
      return;
    }
    const first = group[0]?.properties ?? {};
    out.push({
      type: 'Feature',
      geometry: merged.geometry,
      properties: {
        ...first,
        _name: first._sourceName ?? first._name,
        _designation: first._designation,
        _mergedFrom: merged.merged
      }
    });
  });
  return out;
};

/**
 * ---------------------------------------------------------------------------
 * THE ZOOMED-OUT SHAPES, AND WHY THE ORDER OF THESE FOUR STEPS IS THE FEATURE
 * ---------------------------------------------------------------------------
 *
 * Ontario used to draw as a scatter of green flecks over a province that is
 * mostly Crown land, and the reason was the order this ran in, not the data.
 *
 * The overview USED TO throw parcels away first — everything under the area
 * threshold, everything past the record cap, every part of a multipolygon
 * under a few pixels — and merge whatever survived. So a hundred adjoining
 * General Use Areas of two or three pixels each, which together carpet a
 * region the size of a small country, were each individually judged too small
 * to draw and deleted BEFORE anything got the chance to notice they were
 * touching. What reached the merge was the handful of parcels that were
 * already big on their own, which is exactly what a camper saw: a province
 * reading as almost empty next to an Alberta that draws as one solid block,
 * for no reason except that Alberta's Crown land arrives as a single polygon
 * and Ontario's arrives in pieces.
 *
 * So the merge goes first now, and the size test happens afterwards, to the
 * merged shape. A hundred small neighbours become one large block and the
 * threshold has nothing to say about it. A small parcel genuinely out on its
 * own is still dropped, because at this zoom it really is a fraction of a
 * pixel — but it is dropped for being alone, not for being small in a crowd.
 *
 * NOTHING HERE PAINTS GROUND THAT NO SOURCE CLAIMED. The union only ever joins
 * pieces that touch (within the snap, which is about a pixel — see
 * `MERGE_SNAP_STEPS`), and it keeps holes: land inside a province that no
 * source called public stays a hole in the merged shape. This makes the map
 * show MORE of what the data already said, not more than the data says.
 */
const overviewShapes = (
  features: any[],
  simplifyDegrees: number,
  minAreaSqKm: number,
  recordLimit: number
): any[] => {
  // Water first, parcel by parcel. It has to happen before the merge — a
  // merged province overlaps every lake on the continent at once, which is
  // more than `subtractLakes` will take on, and it would give up and paint
  // the water green. Parcel-sized shapes each overlap a handful.
  const dry = withoutWater(features);

  // Then weld. The trimming the union needs to stay affordable happens inside,
  // per source, because the budget is per source.
  const merged = mergedBySource(dry, simplifyDegrees);

  // Now — and only now — drop what is still too small to see.
  const visible = prunedFeatures(merged, visiblePartDeg2(simplifyDegrees), MAX_PARTS_MERGED);

  // A safety net for sources whose union could not run: those still arrive as
  // loose parcels and the area filter is all that stands between a continental
  // view and a thousand specks. A merged shape is far larger than any
  // threshold, so this is a no-op for everything that welded.
  return largestParcels(visible, minAreaSqKm, recordLimit);
};

/**
 * Drop parcels too small to read at this zoom, largest first.
 *
 * Used when the caller asked for an overview and the database could not do the
 * filtering itself (migration 07 not run) or the data came from the live ArcGIS
 * services, which have no consistent area field to filter on.
 */
/**
 * How many parcels a source keeps in the overview even when all of them are
 * below the area threshold. Small enough not to clutter a continental view,
 * big enough that a province reads as "there is land here".
 */
const OVERVIEW_MIN_PER_SOURCE = 3;

const largestParcels = (features: any[], minAreaSqKm: number, limit: number): any[] => {
  if (minAreaSqKm <= 0) return features.slice(0, limit);

  const sized = features
    .map((f) => ({ f, area: approxAreaSqKm(f?.geometry), source: String(f?.properties?._source ?? '') }))
    .sort((a, b) => b.area - a.area);

  const kept = sized.filter((x) => x.area >= minAreaSqKm);

  /**
   * A SOURCE MUST NEVER VANISH FROM THE OVERVIEW JUST FOR BEING SMALL-GRAINED.
   *
   * The threshold is an absolute number of km², and it was tuned against land
   * that comes in continental slabs: Alberta's Green Area is 339,000 km² and
   * Ontario's General Use Areas are enormous, so both survive any zoom. Land
   * that comes in small pieces does not. Manitoba's fifteen provincial forests
   * average about 1,500 km² and the largest is a couple of thousand, so at the
   * zooms where someone is looking at the whole country every one of them was
   * filtered out — while both neighbours stayed painted.
   *
   * The result on screen was a Manitoba-shaped hole between two provinces full
   * of colour, which is this app's one forbidden sentence: it reads as "no
   * public land here" when the truth is "these parcels are smaller than the
   * ones next door". So every source that returned anything keeps its largest
   * few, threshold or not. They may be a pixel or two at the widest zoom —
   * that is a far better failure than a confident blank.
   */
  const keptIds = new Set(kept.map((x) => x.f));
  const sourcesWithKept = new Set(kept.map((x) => x.source));
  const perSource = new Map<string, number>();
  const guaranteed: typeof sized = [];
  for (const x of sized) {
    if (keptIds.has(x.f) || sourcesWithKept.has(x.source)) continue;
    const n = perSource.get(x.source) ?? 0;
    if (n >= OVERVIEW_MIN_PER_SOURCE) continue;
    perSource.set(x.source, n + 1);
    guaranteed.push(x);
  }

  /**
   * The guaranteed few go in FIRST, before the limit is applied.
   *
   * Appending them and then slicing by area — which is what this did at first —
   * quietly undoes the guarantee exactly when it matters. One wide viewport had
   * BLM alone return 500 parcels; sorted by area, every rescued Ontario or
   * Manitoba shape fell past the cut and the provinces went blank again, for a
   * different reason than before but with the identical result on screen.
   */
  return [...guaranteed, ...kept.sort((a, b) => b.area - a.area)]
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
  /**
   * Ran out of time, as opposed to refusing, erroring or answering oddly.
   *
   * The only failure worth retrying with a smaller ask: it says the service is
   * up and the question was too big, which is a question we can make smaller.
   */
  timedOut?: boolean;
  /**
   * The WFS answered, and the answer was bigger than we are willing to read.
   *
   * Also a question that can be made smaller — by asking for fewer of the
   * biggest shapes — but only where the layer has an area column to rank by.
   */
  overBudget?: boolean;
  /**
   * The service refused the biggest-first sort, which is worth one more try
   * without it — the sort is how the wide view chooses, not whether it draws.
   */
  orderByRejected?: boolean;
  /**
   * Where this answer came from.
   *
   * Reported in `meta` so the tile cache can be checked from outside without
   * reading logs — Vercel keeps those for an hour on this plan, which is not
   * long enough to notice a cache that quietly stopped working.
   */
  servedFrom?: 'memory' | 'db' | 'live';
}

/**
 * Decimal places worth asking for, given how hard the geometry is being
 * generalised anyway. Two vertices closer together than the tolerance are
 * about to be collapsed into one, so digits below it are bytes for nothing.
 * Floored at 3 (~100 m) and capped at 5 (~1 m).
 */
/**
 * THE COARSEST WE WILL EVER ASK A SERVER TO THIN A SHAPE — about 2 km.
 *
 * ---------------------------------------------------------------------------
 * WHY NEW BRUNSWICK DREW AS A TRIANGLE
 * ---------------------------------------------------------------------------
 *
 * The generalisation tolerance tracks the viewport, so a continental view asks
 * every service to thin its geometry to a quarter of a degree — twenty-four
 * kilometres. That is right for a shape the size of Alberta's Green Area and
 * catastrophic for a province whose Crown land is thousands of parcels a few
 * kilometres across: each one is thinned until it is a sliver, and welding
 * slivers gives you a sliver. New Brunswick came back as a thin triangle
 * covering about 2% of its Crown land. Nova Scotia came back as three specks.
 * The BLM, whose units are the whole point of the western map, came back as
 * three shards by the Colorado River.
 *
 * The pipeline was already careful to weld BEFORE deciding what is too small
 * to draw — that is the fix that stopped Ontario drawing as confetti. This is
 * the same lesson one step earlier: the shapes have to survive the journey
 * intact enough to weld at all.
 *
 * So the ask is capped. Two kilometres is still far coarser than anything a
 * zoomed-out map can show, the parcels arrive as recognisable shapes, and the
 * union makes blocks out of them — after which `visiblePartDeg2` drops
 * whatever is genuinely too small to see, which at continental zoom is most of
 * Nova Scotia and honestly so.
 *
 * It costs bytes on the wide view. The tile cache holds the answer for ninety
 * days, so it costs them once per region.
 */
const MAX_ASK_OFFSET_DEGREES = 0.02;

/** The tolerance actually asked for, never coarser than the cap. */
const askOffsetFor = (simplifyDegrees: number): number =>
  Math.min(simplifyDegrees, MAX_ASK_OFFSET_DEGREES);

const precisionFor = (simplifyDegrees: number): number =>
  Math.min(5, Math.max(3, Math.ceil(-Math.log10(Math.max(simplifyDegrees, 1e-6))) + 1));

/** The `/query` call for an ArcGIS source. */
const arcgisQueryUrl = (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number,
  biggestFirst = false
): string => {
  const params = new URLSearchParams({
    where: source.where ?? '1=1',
    geometry: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    /*
     * The area column rides along when there is one. It costs a number per
     * feature and it is the only way to see, from the logs, what units the
     * layer counts in — which is the difference between filtering for parcels
     * over a hundred square kilometres and filtering for none at all.
     */
    outFields:
      source.areaField && source.outFields && source.outFields !== '*'
        ? `${source.outFields},${source.areaField}`
        : source.outFields ?? '*',
    returnGeometry: 'true',
    outSR: '4326',
    /*
     * ASK FOR NO MORE PRECISION THAN THE VIEW CAN SHOW.
     *
     * This was a flat 5 decimal places — about a metre — on every request,
     * including the one that draws Ontario at the scale of the Great Lakes.
     * Every one of those digits is bytes off a provincial ArcGIS server, over
     * the wire, and through a JSON parse, to place a vertex a thousand times
     * finer than the pixel it lands in. The tolerance we are already asking
     * the server to generalise to says how fine is useful, so the precision
     * follows it: metres up close, hundreds of metres at province scale.
     */
    ...(source.generaliseLocally
      ? {}
      : {
          geometryPrecision: String(precisionFor(askOffsetFor(simplifyDegrees))),
          maxAllowableOffset: String(askOffsetFor(simplifyDegrees))
        }),
    resultRecordCount: String(recordLimit),
    f: source.format === 'esri' ? 'json' : 'geojson'
  });

  /*
   * BIGGEST FIRST, ONCE THE VIEW IS WIDE.
   *
   * ---------------------------------------------------------------------------
   * WHY ONTARIO DREW AS FLECKS OVER A PROVINCE THAT IS MOSTLY CROWN LAND
   * ---------------------------------------------------------------------------
   *
   * The wide ask has always been "give me the first N parcels that intersect
   * this box", and N is small on purpose because these servers cannot
   * generalise five hundred complex polygons inside a timeout. Then the area
   * filter throws away everything too small to draw at that zoom.
   *
   * Put those two together and the survivors are: whichever parcels the
   * database happened to hand over first, minus most of them. For a source
   * like Alberta's Green Area — one polygon — that is the whole truth. For
   * Ontario, which is thousands of General Use Areas covering most of the
   * north, it is a random handful of small ones, and the province drew as
   * confetti next to a solid Alberta. Nothing was wrong with the data.
   *
   * Every one of these services reports `supportsOrderBy: true` (checked in
   * production, per layer), so the wide ask now says WHICH N it wants. At a
   * zoom where a parcel under a few hundred km² is a pixel, the biggest ones
   * are the only ones that were ever going to be drawn.
   *
   * Only applied on the wide ask, so a close-in view still gets everything in
   * the box; and if a service ever refuses the parameter, the query is retried
   * once without it rather than dropping the source.
   */
  if (biggestFirst && source.areaField) params.set('orderByFields', `${source.areaField} DESC`);

  return `${source.url}?${params.toString()}`;
};

/* -------------------------------------------------------------------------- */
/* Asking a WFS instead of an ArcGIS service                                   */
/* -------------------------------------------------------------------------- */

/**
 * EVERY ARCGIS CONVENIENCE THIS FILE LEANS ON IS MISSING FROM A WFS.
 *
 * `maxAllowableOffset` generalises server-side; `geometryPrecision` trims the
 * digits; `resultRecordCount` caps the answer; and an Esri error arrives as a
 * tidy JSON `error` key. A WFS has one of those four — a feature count — and
 * for the other three the work moves here:
 *
 *   * the response is read against a byte budget, because a bbox filter on a
 *     WFS SELECTS features without CLIPPING them, so a single query can drag
 *     back a province-wide multipolygon at full survey resolution;
 *   * the geometry is generalised locally, to the same tolerance the ArcGIS
 *     sources are asked to generalise to, before anything downstream — the
 *     merge, the water cut, the response — has to carry it;
 *   * the coordinates are checked before they are trusted, because axis order
 *     is the one thing OGC services genuinely disagree about.
 *
 * None of it is BC-specific. It is what any OGC source added later will need.
 */

/**
 * Douglas–Peucker on one ring, iteratively.
 *
 * Iteratively, not recursively, because these rings arrive ungeneralised: a
 * provincial forest boundary can be tens of thousands of vertices, and the
 * recursive form of this algorithm is a stack overflow waiting for the one
 * input nobody tested with. A crash here would take the whole API down, not
 * just this source.
 */
const simplifyRing = (ring: number[][], tolerance: number): number[][] => {
  if (!Array.isArray(ring) || ring.length <= 4 || tolerance <= 0) return ring;

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;

  const stack: [number, number][] = [[0, ring.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const [ax, ay] = ring[first];
    const [bx, by] = ring[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let farthest = -1;
    let farthestSq = toleranceSq;

    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = ring[i];
      let distSq: number;
      if (lengthSq === 0) {
        distSq = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        // Perpendicular distance to the segment, squared — no square roots in
        // the inner loop of something that runs over a million vertices.
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
        distSq = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (distSq > farthestSq) {
        farthest = i;
        farthestSq = distSq;
      }
    }

    if (farthest > 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const kept: number[][] = [];
  for (let i = 0; i < ring.length; i += 1) if (keep[i]) kept.push(ring[i]);
  return kept;
};

/**
 * The ring as its own bounding box.
 *
 * The fallback for a shape that the tolerance dissolves entirely. Dropping it
 * instead would be a parcel silently disappearing, which this file has a rule
 * against; drawing a box is honest at a zoom where the real outline is smaller
 * than the generalisation itself.
 */
const ringBox = (ring: number[][]): number[][] => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    if (!Array.isArray(point)) continue;
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return ring;
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
};

/**
 * What the ArcGIS sources get for free: a shape generalised to the tolerance
 * this zoom can show, with the digits below it thrown away.
 */
const generaliseGeometry = (geometry: any, tolerance: number, precision: number): any => {
  const factor = 10 ** precision;
  const round = (v: number): number => Math.round(v * factor) / factor;

  const ring = (input: any): number[][] | null => {
    if (!Array.isArray(input) || input.length < 4) return null;
    let simplified = simplifyRing(input as number[][], tolerance);
    if (simplified.length < 4) simplified = ringBox(input as number[][]);

    const rounded: number[][] = [];
    for (const point of simplified) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const next = [round(point[0]), round(point[1])];
      const last = rounded[rounded.length - 1];
      // Rounding lands neighbouring vertices on the same spot. A duplicated
      // point is a zero-length segment, which some polygon maths treats as a
      // degenerate ring — cheaper to drop it here than to debug it there.
      if (!last || last[0] !== next[0] || last[1] !== next[1]) rounded.push(next);
    }
    if (rounded.length < 4) return ringBox(input as number[][]);

    // Rounding can also unclose the ring. Close it again.
    const first = rounded[0];
    const final = rounded[rounded.length - 1];
    if (first[0] !== final[0] || first[1] !== final[1]) rounded.push([first[0], first[1]]);
    return rounded;
  };

  const polygon = (rings: any): number[][][] | null => {
    if (!Array.isArray(rings) || rings.length === 0) return null;
    const outer = ring(rings[0]);
    if (!outer) return null;
    const holes = rings.slice(1).map(ring).filter(Boolean) as number[][][];
    return [outer, ...holes];
  };

  if (geometry?.type === 'Polygon') {
    const rings = polygon(geometry.coordinates);
    return rings ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geometry?.type === 'MultiPolygon') {
    const parts = (geometry.coordinates ?? []).map(polygon).filter(Boolean) as number[][][][];
    return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
  }
  return geometry;
};

/**
 * Prove the coordinates are longitude-then-latitude before drawing them.
 *
 * THE ONE THING OGC SERVICES DISAGREE ABOUT. WFS 2.0 with `EPSG:4326` means
 * latitude first to the specification and longitude first to a good deal of
 * software, and a server that quietly ignores `srsName` answers in its own
 * projection — for a BC service, metres in BC Albers. The request below asks
 * in CRS84, which is unambiguous, and this checks that the answer honoured it.
 *
 * A swap is corrected. Anything else is REJECTED, not drawn: a polygon in the
 * wrong hemisphere would paint public land across the Indian Ocean, and metres
 * read as degrees would paint it nowhere at all. Both are worse than a source
 * that says it is unavailable.
 */
const orientToLonLat = (
  features: any[],
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  sourceId: string
): any[] | null => {
  const sample = (() => {
    for (const feature of features) {
      let node: any = feature?.geometry?.coordinates;
      while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
      if (Array.isArray(node) && typeof node[0] === 'number' && typeof node[1] === 'number') {
        return node as number[];
      }
    }
    return null;
  })();
  if (!sample) return features;

  // Generous slack: a parcel may legitimately straddle the edge of the extent
  // we declared for it, and this test only has to tell a hemisphere from a
  // hemisphere.
  const inside = (lon: number, lat: number): boolean =>
    lon >= extent.minLon - 3 && lon <= extent.maxLon + 3 &&
    lat >= extent.minLat - 3 && lat <= extent.maxLat + 3;

  if (inside(sample[0], sample[1])) return features;

  if (inside(sample[1], sample[0])) {
    console.info(`[boundaries] ${sourceId}: response was latitude-first — swapping axes.`);
    const swap = (node: any): any =>
      Array.isArray(node[0])
        ? node.map(swap)
        : [node[1], node[0], ...node.slice(2)];
    return features.map((feature) => ({
      ...feature,
      geometry: feature?.geometry?.coordinates
        ? { ...feature.geometry, coordinates: swap(feature.geometry.coordinates) }
        : feature.geometry
    }));
  }

  console.warn(
    `[boundaries] ${sourceId}: coordinates are not degrees in this extent ` +
      `(first vertex ${sample[0]}, ${sample[1]}) — refusing to draw them.`
  );
  return null;
};

/**
 * Read a response body, giving up past a byte budget.
 *
 * The budget is on the wire, not on the parse: `JSON.parse` of forty megabytes
 * is a second of blocked event loop and a heap spike in a function shared with
 * every other request in flight. Stopping while it is still bytes is cheap.
 */
// `Response` in this file is Express's, imported at the top — this is the
// fetch one.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

const readBodyWithin = async (
  response: FetchResponse,
  maxBytes: number
): Promise<string | null> => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }

  const decoder = new TextDecoder();
  let out = '';
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
};

/**
 * How many of the biggest shapes to ask a WFS for first, by viewport width.
 *
 * SET LOW ON PURPOSE, because the cost of asking for too many is not a slower
 * map — it is a province that blinks. An over-budget answer is no answer, the
 * map draws nothing for that source, and panning back to a box that did fit
 * makes the green reappear. That flicker was the first thing anyone noticed
 * about British Columbia, and it is worth several small shapes to stop it.
 *
 * These are the numbers that came back inside the budget in production: three
 * biggest at continental width was 14MB, five at eight degrees was 13.9MB.
 */
const wideStartingRecords = (span: number): number => {
  if (span > 20) return 3;
  if (span > 10) return 4;
  if (span > 5) return 6;
  return 10;
};

/**
 * Esri JSON rings back into GeoJSON polygons.
 *
 * Esri puts every ring of a feature in one flat list and tells the outers from
 * the holes by winding: clockwise is an outer ring, counter-clockwise is a
 * hole in whichever outer ring contains it. GeoJSON wants that structure made
 * explicit, so this rebuilds it.
 *
 * IF THE WINDING IS NOT WHAT IT CLAIMS — some services publish everything one
 * way round — every ring is treated as its own outer ring rather than thrown
 * away. A hole drawn as solid land overstates by the area of a lake; a feature
 * dropped for a winding rule overstates nothing and shows nothing, which on a
 * map of where you may sleep is the worse of the two.
 */
const ringIsClockwise = (ring: number[][]): boolean => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[i][0] - ring[j][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum > 0;
};

const pointInRing = (point: number[], ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

export const esriRingsToGeoJson = (rings: any): any | null => {
  if (!Array.isArray(rings) || rings.length === 0) return null;

  const usable = rings.filter(
    (r: any) => Array.isArray(r) && r.length >= 4 && Array.isArray(r[0])
  ) as number[][][];
  if (usable.length === 0) return null;

  let outers = usable.filter(ringIsClockwise);
  const holes = usable.filter((r) => !ringIsClockwise(r));
  // Nothing wound the way Esri says: keep the land, lose the holes.
  if (outers.length === 0) outers = usable;

  const polygons: number[][][][] = outers.map((outer) => [outer]);
  if (outers.length === usable.length) {
    // No holes to place.
  } else {
    for (const hole of holes) {
      const owner = polygons.find((poly) => pointInRing(hole[0], poly[0]));
      // A "hole" inside nothing is not a hole — it is an outer ring wound the
      // other way. Keeping it as its own polygon loses no land; dropping it
      // would, quietly.
      if (owner) owner.push(hole);
      else polygons.push([hole]);
    }
  }

  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
};

/** The GetFeature call for a WFS source. */
const wfsQueryUrl = (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  recordLimit: number,
  biggestFirst = false
): string => {
  /*
   * CRS84 RATHER THAN EPSG:4326, IN BOTH DIRECTIONS.
   *
   * `urn:ogc:def:crs:OGC:1.3:CRS84` is longitude-then-latitude by definition,
   * where plain `EPSG:4326` is latitude-first to the WFS 2.0 specification and
   * longitude-first to a lot of the software implementing it. Naming CRS84
   * takes the argument off the table for the bbox we send AND the coordinates
   * we get back. `orientToLonLat` still checks, because "should" is not "did".
   */
  const CRS84 = 'urn:ogc:def:crs:OGC:1.3:CRS84';
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    // `typeNames` is the 2.0.0 spelling; GeoServer accepts the older
    // `typeName` too, and DataBC's own examples use it.
    typeNames: source.typeName ?? '',
    outputFormat: 'application/json',
    srsName: CRS84,
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat},${CRS84}`,
    count: String(recordLimit)
  });

  /*
   * `D` for descending is GeoServer's spelling and a space is the separator,
   * which URLSearchParams encodes as `+` — the form DataBC's own examples use.
   *
   * Only ever sent on the wide ask. If this service turned out to reject the
   * parameter the request would fail, and it must not be possible for that to
   * take out the close-in views that are working today.
   */
  if (biggestFirst && source.areaField) params.set('sortBy', `${source.areaField} D`);

  return `${source.url}?${params.toString()}`;
};

/**
 * Sources whose real attribute names have already been printed.
 *
 * Once per process, not once per request: the names are a fact about the
 * layer, and repeating them on every query would bury the failures that
 * matter.
 */
const loggedWfsFields = new Set<string>();

/** Sources whose area column has already had a value printed. */
const loggedAreaSample = new Set<string>();

/** Services that turned out not to honour `orderByFields` after all. */
const noOrderBy = new Set<string>();

/**
 * The ceiling and the clock for an ask that wants the biggest parcels first.
 *
 * 120 rather than the full overview cap: at the zoom this applies to, a
 * hundred and twenty merged blocks is already more shapes than the eye can
 * separate, and the smaller ask is what makes the sort affordable at all.
 */
const SORTED_ASK_RECORDS = 120;
const SORTED_ASK_TIMEOUT_MS = 12000;

/**
 * Whether this ask wants the biggest parcels rather than the first ones.
 *
 * Lives here rather than inside the query because the CACHE has to know too.
 * A sorted answer and an arbitrary one are different answers to the same
 * question, and they were sharing a slot — so an Ontario cached from the old
 * ask would have gone on being served for the ninety days that cache lives,
 * and the fix would have looked like it had not worked.
 */
const SORT_MIN_SPAN = 2.5;
/*
 * And an upper bound, measured: Ontario sorts twenty-two degrees inside twelve
 * seconds and cannot sort the whole continent at all. Past this the sort is
 * not a better answer, it is twelve seconds spent before the answer that was
 * always going to be used — and on the run that found this, those twelve
 * seconds are what left the unsorted retry too little time to land.
 */
const SORT_MAX_SPAN = 30;

const wantsBiggestFirst = (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): boolean => {
  const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon);
  return (
    source.protocol !== 'wfs' &&
    !!source.areaField &&
    !noOrderBy.has(source.id) &&
    span > SORT_MIN_SPAN &&
    span <= SORT_MAX_SPAN
  );
};

const queryBoundarySourceOnce = async (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number,
  timeoutOverrideMs?: number,
  /** How many of the biggest to ask a WFS for, when the first ask was too big. */
  wideRecordsOverride?: number,
  /** Ask the plain way — no biggest-first sort. The retry that always worked. */
  sortless = false
): Promise<SourceResult> => {
  if (!overlaps(bbox, source.extent)) return { features: [], ok: true, truncated: false };

  const isWfs = source.protocol === 'wfs';
  /*
   * Two things a WFS forced this file to learn, now shared with any source
   * that has to send its geometry ungeneralised: read the body against a byte
   * budget, and thin the shapes here instead.
   */
  const thinsItsOwnGeometry = isWfs || !!source.generaliseLocally;
  const readAgainstBudget = thinsItsOwnGeometry;

  /*
   * THE WIDE VIEW IS A DIFFERENT QUESTION, SO IT GETS A DIFFERENT ASK.
   *
   * Past `maxSpanDegrees` the full ask cannot be paid for: a WFS sends
   * survey-resolution geometry for every feature the box touches, and two
   * degrees of British Columbia is already sixteen megabytes. Asking anyway
   * spends the budget and draws nothing.
   *
   * So above that span we ask for the biggest shapes in view instead, sorted
   * by the layer's own area column, and say the answer is truncated — which
   * the map already knows how to show. A province drawn as its large forest
   * blocks is a true, partial answer at a zoom where the small ones would be
   * a pixel; a blank province is the one thing this file exists to prevent.
   *
   * Without an area column there is no principled subset to ask for — the
   * first N features in database order would be arbitrary — so those sources
   * still decline the viewport rather than draw an arbitrary sample of it.
   */
  const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon);
  const wideForWfs = isWfs && !!source.maxSpanDegrees && span > (source.maxSpanDegrees as number);

  if (wideForWfs && !source.areaField) {
    console.info(
      `[boundaries] ${source.id}: ${span.toFixed(1)}° viewport is past the ` +
        `${source.maxSpanDegrees}° a WFS can answer, and it has no area column to ` +
        'rank by — not asking.'
    );
    return { features: [], ok: false, truncated: false };
  }

  /*
   * How many of the biggest to ask for. Fewer the wider you go, for the same
   * reason `overviewRecordLimit` does it: a wider view has room for fewer
   * distinguishable shapes, and every extra one here is a megabyte.
   */
  /*
   * An override means the first ask came back too big, whatever the span was,
   * so this one is the biggest-N ask too — a two-degree viewport over dense
   * country can overflow exactly as a ten-degree one does.
   */
  const biggestFirst = wideForWfs || wideRecordsOverride != null;
  const wfsRecordLimit = wideRecordsOverride ?? (wideForWfs ? wideStartingRecords(span) : recordLimit);

  /*
   * Same threshold as the WFS: past two and a half degrees the record cap is
   * doing the choosing, so it had better choose well.
   */
  const sortWanted = !sortless && wantsBiggestFirst(source, bbox);

  const requestUrl = isWfs
    ? wfsQueryUrl(source, bbox, wfsRecordLimit, biggestFirst)
    : arcgisQueryUrl(
        source, bbox, simplifyDegrees,
        // A sorted ask is capped tighter than an unsorted one. The server has
        // to order the whole result set either way, but it does not have to
        // fetch and generalise five hundred polygons on top of that — and
        // these are the services that were already timing out.
        sortWanted ? Math.min(recordLimit, SORTED_ASK_RECORDS) : recordLimit,
        sortWanted
      );

  const controller = new AbortController();
  // One unresponsive service used to hold the whole response for nine seconds.
  // It is reported as unavailable rather than waited on.
  /*
   * A SORTED ASK IS SLOWER, AND WORTH WAITING FOR EXACTLY ONCE.
   *
   * Ontario and the Forest Service both time out at six seconds when asked to
   * order a continental result set — and both answer the unsorted question
   * fine, which is why the fallback below is the unsorted one. But a sorted
   * answer, once it arrives, is written to the tile cache and serves that
   * ground for ninety days, so it is worth a longer clock on the one request
   * that pays for it.
   */
  const timeoutMs =
    timeoutOverrideMs ?? (sortWanted ? SORTED_ASK_TIMEOUT_MS : source.timeoutMs ?? 6000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = Date.now();

  try {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: isWfs ? 'application/geo+json, application/json' : 'application/json',
        'User-Agent': 'Wandrlust/1.0'
      },
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

    /*
     * A WFS body is read against a budget and parsed here rather than by
     * `response.json()`, because a GetFeature answer has no ceiling on its
     * size — see `readBodyWithin`. A GeoServer failure also arrives as an XML
     * ExceptionReport rather than as JSON, so a parse error on a 200 is a
     * failed query, not a bug, and is reported as one.
     */
    let data: any;
    if (readAgainstBudget) {
      const budget = source.maxBytes ?? 8 * 1024 * 1024;
      const body = await readBodyWithin(response, budget);
      if (body === null) {
        console.warn(
          `[boundaries] ${source.id}: response exceeded ${Math.round(budget / 1024 / 1024)}MB — ` +
            'a WFS cannot generalise, so this viewport is too much to ask it for.'
        );
        return { features: [], ok: false, truncated: false, overBudget: true };
      }
      /*
       * SAY HOW BIG AND HOW SLOW, EVERY TIME.
       *
       * The field names and the payload size of a WFS layer cannot be read
       * from a development sandbox that has no route to the province, so
       * production is the only place these numbers exist. They are one info
       * line, and they are what the budget and the span ceiling above were
       * set from.
       */
      console.info(
        `[boundaries] ${source.id}: ${(body.length / 1024 / 1024).toFixed(1)}MB in ` +
          `${Date.now() - startedAt}ms`
      );

      try {
        data = JSON.parse(body);
      } catch {
        console.warn(
          `[boundaries] ${source.id}: answered 200 with something that is not JSON ` +
            `(starts: ${body.slice(0, 120).replace(/\s+/g, ' ')})`
        );
        return { features: [], ok: false, truncated: false };
      }
    } else {
      data = await response.json();
    }

    // ArcGIS reports failures as HTTP 200 with an `error` key. Treating that
    // as an empty result would silently hide land, so it is a hard failure.
    if (data?.error) {
      console.warn(`[boundaries] ${source.id}:`, data.error?.message ?? 'query error');
      /*
       * Unless the only new thing we asked for was the sort. Every one of
       * these layers advertises support for it, but an advertised capability
       * and a working one are not the same thing, and losing a source over a
       * nicety would be the empty-province failure all over again. Remember it
       * and let the caller ask again the old way.
       */
      if (sortWanted) {
        console.info(`[boundaries] ${source.id}: dropping the biggest-first sort and retrying`);
        noOrderBy.add(source.id);
        return { features: [], ok: false, truncated: false, orderByRejected: true };
      }
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

    /*
     * Esri JSON is a different shape all the way down — `attributes` where
     * GeoJSON has `properties`, `rings` where it has coordinates — so it is
     * turned into GeoJSON here, once, and nothing after this line knows the
     * difference.
     */
    const sentByServer = data.features.length;
    if (source.format === 'esri') {
      const firstRaw = JSON.stringify(data.features[0] ?? {}).slice(0, 300);
      data.features = data.features
        .map((f: any) => {
          const geometry = esriRingsToGeoJson(f?.geometry?.rings);
          return geometry
            ? { type: 'Feature', geometry, properties: f?.attributes ?? {} }
            : null;
        })
        .filter(Boolean);

      // Converted everything away: the service sent features and no geometry
      // in its own format either, which is worth saying out loud once.
      if (sentByServer > 0 && data.features.length === 0) {
        console.warn(
          `[boundaries] ${source.id}: ${sentByServer} Esri features, none carried rings — raw: ${firstRaw}`
        );
      }
    }

    const returned = data.features.length;

    // Once per source per process: what the layer's area column actually says.
    if (source.areaField && !loggedAreaSample.has(source.id) && data.features[0]) {
      loggedAreaSample.add(source.id);
      const sample = pick(data.features[0].properties ?? {}, source.areaField);
      console.info(`[boundaries] ${source.id}: ${source.areaField} of first feature = ${sample ?? 'absent'}`);
    }

    /*
     * Everything an ArcGIS source got from the server, done here instead: the
     * coordinates are checked before they are believed, then generalised to
     * the tolerance this zoom can show. Rejecting is a hard failure — a shape
     * we cannot place in the right hemisphere must never reach the map.
     */
    /*
     * What the layer really calls its attributes, once per source. Written for
     * the WFS, kept for everything: every source added since has been wired
     * from a distance, and a name field guessed wrong is the silent failure
     * that had fifteen Manitoba forests all reading "Provincial Forest".
     */
    if (!loggedWfsFields.has(source.id) && data.features[0]?.properties) {
      loggedWfsFields.add(source.id);
      // With values, not just names: "the column is called AFFECTATION" does
      // not say whether it holds "Utilisation multiple" or a numeric code,
      // and that is the difference between a usable filter and a wrong one.
      const props = data.features[0].properties as Record<string, unknown>;
      console.info(
        `[boundaries] ${source.id}: fields are ` +
          Object.entries(props)
            .map(([k, v]) => `${k}=${String(v ?? '').slice(0, 40)}`)
            .join(' | ')
            .slice(0, 900)
      );
    }

    let incoming: any[] = data.features;
    if (thinsItsOwnGeometry) {
      const oriented = orientToLonLat(incoming, source.extent, source.id);
      if (!oriented) return { features: [], ok: false, truncated: false };
      // Same ceiling as the ArcGIS ask: thin to the view, but never so far
      // that a parcel stops being a shape before it can be welded.
      const tolerance = askOffsetFor(simplifyDegrees);
      const precision = precisionFor(tolerance);
      incoming = oriented
        .map((f: any) => {
          const geometry = generaliseGeometry(f?.geometry, tolerance, precision);
          return geometry ? { ...f, geometry } : null;
        })
        .filter(Boolean) as any[];
    }

    const features = incoming
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
      // A WFS says so arithmetically: it reports how many features matched
      // the filter alongside how many it actually sent.
      (typeof data?.numberMatched === 'number' &&
        typeof data?.numberReturned === 'number' &&
        data.numberMatched > data.numberReturned) ||
      features.length >= wfsRecordLimit ||
      // The biggest-N ask is a deliberate subset. It must never present
      // itself as the whole picture.
      biggestFirst;

    // The service answered with shapes and the geometry guard threw all of
    // them away — almost certainly a line layer being read as an area layer.
    // Silently drawing nothing here would look exactly like "no public land".
    if (returned > 0 && features.length === 0) {
      console.warn(
        `[boundaries] ${source.id}: ${returned} features returned, none were polygons ` +
          `(first geometry type: ${String(data.features[0]?.geometry?.type ?? 'none')})` +
          // Verbatim, because "none" has meant three different things so far:
          // a null geometry, an Esri ring list, and a line layer.
          ` raw: ${JSON.stringify(data.features[0] ?? {}).slice(0, 300)}`
      );
    }

    return { features, ok: true, truncated };
  } catch (err) {
    console.warn(
      `[boundaries] ${source.id}: ${
        timedOut ? `no response within ${timeoutMs}ms` : (err as Error).message
      }`
    );
    return { features: [], ok: false, truncated: false, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * ASK AMBITIOUSLY, THEN ASK THE WAY THAT ALWAYS WORKED.
 *
 * The overview record ceiling was raised so a province stops drawing as a
 * handful of scattered parcels. The reason it was ever low is a real one — a
 * provincial ArcGIS server given too much to generalise stops answering at
 * all, and a source that drops out draws as empty ground, which is the worst
 * thing this map can do.
 *
 * So the two are separated. The ambitious ask goes first; if and only if it
 * TIMES OUT — the service is up, the question was too big — the same question
 * is asked again immediately at the count that was in force before, which
 * every source here is known to answer. An HTTP error, an ArcGIS error or a
 * malformed body are not retried: those are not about size, and asking again
 * would just spend the budget twice on the same failure.
 *
 * The retry is given a shorter clock than the first attempt so a genuinely
 * dead service cannot hold the whole response for two full timeouts.
 */
const queryBoundarySource = async (
  source: BoundarySource,
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number
): Promise<SourceResult> => {
  const first = await queryBoundarySourceOnce(source, bbox, simplifyDegrees, recordLimit);

  /*
   * A WIDE WFS ASK THAT CAME BACK TOO BIG IS ASKED AGAIN, SMALLER.
   *
   * How many of the biggest forests fit inside the byte budget is not a number
   * anyone can know in advance: it depends on how complicated the shapes under
   * this particular viewport are, and the biggest shapes are the most
   * complicated ones. Forty was measured to be too many for eight degrees of
   * British Columbia; three might be too many somewhere else.
   *
   * So it converges instead of guessing — each attempt asks for a quarter of
   * the last, twice — rather than give up and draw a blank province. The
   * service is fast (sixteen megabytes in 1.2 seconds) and an over-budget read
   * is abandoned the moment it crosses the line, so the ladder costs a second
   * or two, not a timeout.
   */
  if (!first.ok && first.overBudget && source.protocol === 'wfs' && source.areaField) {
    const span = Math.max(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon);
    // A narrow viewport that overflowed was asking for everything in it, so
    // the ladder starts from the biggest-N ask rather than from that.
    let asked = wideStartingRecords(span);
    let attempt = first;
    /*
     * Halving, and all the way down to one. Giving up at three left the map
     * blank wherever the three biggest forests in view were themselves too
     * much geometry — and one big green block is a truthful answer where
     * nothing at all is not.
     */
    for (let step = 0; step < 4 && attempt.overBudget; step += 1) {
      asked = Math.max(1, Math.floor(asked / 2));
      console.info(`[boundaries] ${source.id}: retrying with the ${asked} biggest in view`);
      attempt = await queryBoundarySourceOnce(
        source, bbox, simplifyDegrees, recordLimit, 8000, asked
      );
    }
    return attempt;
  }

  if (first.orderByRejected) {
    return queryBoundarySourceOnce(source, bbox, simplifyDegrees, recordLimit, undefined, undefined, true);
  }

  if (first.ok || !first.timedOut || recordLimit <= OVERVIEW_RETRY_RECORDS) return first;

  /*
   * PLAIN, AND SMALLER. Dropping the sort here is the whole safety net: a
   * sorted ask that times out must land on the exact question these services
   * have always answered, or asking for a better-chosen Ontario would end in
   * no Ontario at all — which is what happened the first time this shipped.
   */
  console.info(
    `[boundaries] ${source.id}: retrying unsorted at ${OVERVIEW_RETRY_RECORDS} records after timeout`
  );
  return queryBoundarySourceOnce(
    source, bbox, simplifyDegrees, OVERVIEW_RETRY_RECORDS, 6000, undefined, true
  );
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

/* -------------------------------------------------------------------------- */
/* The tile cache in Supabase                                                  */
/* -------------------------------------------------------------------------- */

/**
 * WHY A CACHE THAT OUTLIVES THE PROCESS.
 *
 * BLM units, national forests and Crown land change on the order of an act of
 * legislature, and this API was asking eight government servers about them
 * again and again. The only cache was `sourceCache`, a Map in one Node process
 * — and the API runs as a Vercel serverless function, so that Map is empty
 * every time a lambda is recycled. In practice a large share of requests were
 * cold, and a cold request for Ontario waits on a provincial ArcGIS server
 * that may take six seconds or simply not answer.
 *
 * So the answer is written to Supabase, keyed on the exact question. The
 * second time anyone looks at that ground — any device, any lambda, weeks
 * later — it is one indexed read.
 *
 * THIS IS NOT A SOURCE OF TRUTH AND MUST NEVER BECOME ONE. A miss falls
 * straight through to the live services. A failed query is never written: a
 * cached failure would hide real public land for as long as the row lived, and
 * an empty map that looks confident is the worst thing this app can do.
 *
 * The proper answer is still `public_lands` and `npm run seed`, which the
 * route already prefers and which has never been run against this database —
 * `select count(*) from public_lands` returns zero, so that path has never
 * fired once. See migration 19.
 */
let cacheClient: SupabaseClient | null | undefined;

const getCacheClient = (): SupabaseClient | null => {
  if (cacheClient !== undefined) return cacheClient;
  cacheClient =
    SUPABASE_URL && SERVICE_KEY
      ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
      : null;
  if (!cacheClient) {
    console.info('[boundaries] no service key — tile cache disabled, live services only.');
  }
  return cacheClient;
};

/**
 * Switched off after the table itself proves unusable — migration 19 not run,
 * key wrong, host unreachable. Deliberately NOT triggered by a miss: a miss is
 * the correct answer for ground nobody has looked at yet, and treating it as a
 * fault would disable the cache permanently on the very first request.
 */
let tileCacheOutage: { at: number } | null = null;
const TILE_CACHE_RECHECK_MS = 5 * 60 * 1000;

/** Boundaries do not move. Three months is conservative for a road atlas. */
const TILE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const tileCacheGet = async (key: string): Promise<SourceResult | null> => {
  const client = getCacheClient();
  if (!client) return null;
  if (tileCacheOutage && Date.now() - tileCacheOutage.at < TILE_CACHE_RECHECK_MS) return null;

  try {
    const { data, error } = await client
      .from('boundary_tile_cache')
      .select('features, truncated, fetched_at')
      .eq('cache_key', key)
      .maybeSingle();

    if (error) {
      console.warn(`[boundaries] tile cache unavailable: ${error.message}`);
      tileCacheOutage = { at: Date.now() };
      return null;
    }
    if (!data || !Array.isArray(data.features)) return null;
    if (Date.now() - new Date(data.fetched_at as string).getTime() > TILE_CACHE_TTL_MS) return null;

    return {
      features: data.features as any[],
      ok: true,
      truncated: Boolean(data.truncated)
    };
  } catch (err) {
    console.warn(`[boundaries] tile cache read failed: ${(err as Error).message}`);
    tileCacheOutage = { at: Date.now() };
    return null;
  }
};

/** One write in fifty also trims the table. Cheap, and it never runs away. */
const PRUNE_ODDS = 50;

const tileCachePut = async (
  key: string,
  source: BoundarySource,
  result: SourceResult
): Promise<void> => {
  const client = getCacheClient();
  // Only real answers are stored, and an empty one is not worth a row: the
  // upstream service may simply have had nothing in that box today.
  if (!client || !result.ok || result.features.length === 0) return;
  if (tileCacheOutage && Date.now() - tileCacheOutage.at < TILE_CACHE_RECHECK_MS) return;

  try {
    const { error } = await client.from('boundary_tile_cache').upsert(
      {
        cache_key: key,
        source_id: source.id,
        features: result.features,
        feature_count: result.features.length,
        truncated: result.truncated,
        fetched_at: new Date().toISOString()
      },
      { onConflict: 'cache_key' }
    );
    if (error) {
      console.warn(`[boundaries] tile cache write failed: ${error.message}`);
      tileCacheOutage = { at: Date.now() };
      return;
    }
    if (Math.floor(Math.random() * PRUNE_ODDS) === 0) {
      await client.rpc('prune_boundary_tile_cache', {
        in_max_age_days: 180,
        in_max_rows: 20000
      });
    }
  } catch (err) {
    console.warn(`[boundaries] tile cache write failed: ${(err as Error).message}`);
  }
};

/**
 * ASK EACH SOURCE ABOUT ITS OWN GROUND, NOT ABOUT THE CONTINENT.
 *
 * A continental viewport was being sent to every service as a continental
 * envelope, including to the ones that only hold one province. Ontario cannot
 * have a General Use Area in Nevada, so the extra ninety degrees bought
 * nothing — and it cost the thing that matters: the box the server has to
 * think about, which is what decides whether it can sort at all. Clipped to
 * Ontario's own extent the continental ask is twenty-one degrees, which that
 * service sorts inside a couple of seconds, so the zoomed-out map gets the
 * biggest areas in the province rather than the first eighty it was handed.
 *
 * It also tightens the cache: every viewport wider than a source now asks the
 * same question about it, and hits the same row.
 */
const clipToExtent = (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number }
) => ({
  minLat: Math.max(bbox.minLat, extent.minLat),
  minLon: Math.max(bbox.minLon, extent.minLon),
  maxLat: Math.min(bbox.maxLat, extent.maxLat),
  maxLon: Math.min(bbox.maxLon, extent.maxLon)
});

const cachedQuery = async (
  source: BoundarySource,
  requestedBox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  simplifyDegrees: number,
  recordLimit: number
): Promise<SourceResult> => {
  if (!overlaps(requestedBox, source.extent)) {
    return { features: [], ok: true, truncated: false };
  }
  const bbox = clipToExtent(requestedBox, source.extent);

  const box = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon]
    .map((n) => n.toFixed(4))
    .join(',');
  /*
   * THE GENERALISATION IS PART OF THE QUESTION.
   *
   * It was missing from this key, so an overview request and a detailed one
   * for the same box shared a row — and whichever asked first decided what
   * fidelity the other got. Bucketed rather than raw so that near-identical
   * tolerances still share, which is the whole point of a key.
   */
  const tolerance = simplifyDegrees.toPrecision(2);
  const key =
    `${source.id}|${box}|${tolerance}|${recordLimit}` +
    (wantsBiggestFirst(source, bbox) ? '|big' : '');

  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) {
    return { ...hit.result, servedFrom: 'memory' };
  }

  /*
   * Supabase before the network, but only on a cold key. A warm lambda never
   * pays for this; a cold one pays a single indexed read instead of a round
   * trip to a government ArcGIS server.
   */
  if (!hit) {
    const stored = await tileCacheGet(key);
    if (stored) {
      if (sourceCache.size >= SOURCE_CACHE_MAX) {
        const oldest = sourceCache.keys().next().value;
        if (oldest) sourceCache.delete(oldest);
      }
      sourceCache.set(key, { at: Date.now(), result: stored });
      return { ...stored, servedFrom: 'db' };
    }
  }

  const refresh = runQuery(key, source, bbox, simplifyDegrees, recordLimit, hit?.result)
    .then((result) => {
      // Written behind the response, never in front of it: a camper waiting on
      // a map should not also be waiting on our bookkeeping.
      void tileCachePut(key, source, result);
      return { ...result, servedFrom: 'live' as const };
    });

  // Something cached but past its TTL: answer now, refresh behind the scenes.
  if (hit) {
    void refresh.catch(() => { /* runQuery already swallows failures */ });
    return { ...hit.result, servedFrom: 'memory' };
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
 * The zoomed-out map says one more thing, because it is doing one more thing.
 *
 * Its shapes are not parcels. Neighbouring parcels administered under the same
 * rules are welded into blocks so a province reads at its true extent instead
 * of as a scatter of the few parcels big enough to survive on their own — and
 * a camper needs to know that the block is a region, not a boundary, before
 * they read anything off its edge.
 */
const OVERVIEW_DISCLAIMER =
  DISCLAIMER +
  ' Zoomed out, neighbouring areas under the same rules are drawn merged ' +
  'into one block, so an edge here is the rough extent of a region and not ' +
  'the boundary of any one parcel. Zoom in for the real parcels.';

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
    const recordLimit = isOverview ? overviewRecordLimit(span) : recordLimitForSpan(span);
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
      /*
       * NOTE FOR WHOEVER FINALLY RUNS THE SEED. Migration 07's area filter runs
       * in the database, so the small parcels are dropped before they get here
       * and cannot be welded to their neighbours the way the live path welds
       * them. That makes a seeded overview slightly sparser than a live one
       * until `boundaries_in_bbox` learns to merge, or is asked for everything.
       * It is not visible today: `public_lands` is empty and this branch has
       * never fired in production.
       */
      const kept = isOverview
        ? overviewShapes(
            largestParcels(seeded.features, seededHasAreaFilter ? 0 : minAreaSqKm, recordLimit),
            simplifyDegrees,
            minAreaSqKm,
            recordLimit
          )
        : withoutWater(
            prunedFeatures(
              seeded.features.slice(0, recordLimit),
              visiblePartDeg2(simplifyDegrees),
              MAX_PARTS_DETAIL
            )
          );
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
          // The map merges abutting parcels by cancelling shared edges, and it
          // cannot do that without knowing how far this generalisation may
          // have pushed the two sides of one apart.
          simplifyDegrees,
          disclaimer: isOverview ? OVERVIEW_DISCLAIMER : DISCLAIMER
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
    const allLive = results.flatMap((r) => r.features);
    /*
     * The overview merges before it filters — see `overviewShapes`, which is
     * where the whole "why does Ontario draw as flecks and Alberta as a block"
     * answer lives. The detailed tier deliberately does not merge at all: past
     * BOUNDARY_MIN_ZOOM a camper is reading edges, and every parcel is its own
     * shape with its own name, stay limit and permit.
     */
    const liveFeatures = isOverview
      ? overviewShapes(allLive, simplifyDegrees, minAreaSqKm, recordLimit)
      : withoutWater(
          prunedFeatures(allLive, visiblePartDeg2(simplifyDegrees), MAX_PARTS_DETAIL)
        );

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
          truncated: r.truncated,
          // memory / db / live — see `SourceResult.servedFrom`. This is how
          // you check the Supabase tile cache is working without logs: ask
          // for the same box twice and watch these turn from live to db.
          servedFrom: r.servedFrom ?? 'live'
        })),
        truncated: anyTruncated,
        truncationNote: anyTruncated
          ? 'More public land exists here than could be drawn at this zoom. Zoom in to see all of it.'
          : undefined,
        /**
         * WHAT THE MERGE ACTUALLY DID, SO IT CAN BE CHECKED FROM OUTSIDE.
         *
         * One line per source that welded, saying how many parcels went in and
         * how many pieces came out. Ontario reading `parcels: 200, pieces: 4`
         * is the whole feature working; `parcels: 200, pieces: 190` says the
         * union ran and found almost nothing touching, which would mean the
         * snap is wrong; the source missing from this list entirely means the
         * union did not run at all — out of time, or refused for size.
         *
         * Vercel keeps runtime logs for an hour on this plan, which is not long
         * enough to notice a merge that quietly stopped working. This is in the
         * response instead, where it can be read any time.
         */
        merged: isOverview
          ? liveFeatures
              .filter((f) => Number(f?.properties?._mergedFrom) > 0)
              .map((f) => ({
                source: String(f?.properties?._source ?? ''),
                parcels: Number(f?.properties?._mergedFrom ?? 0),
                pieces:
                  f?.geometry?.type === 'MultiPolygon'
                    ? (f.geometry.coordinates?.length ?? 0)
                    : 1
              }))
          : undefined,
        simplifyDegrees,
        // Lakes the server was able to cut out of these shapes. Zero means
        // the asset is missing from the bundle and water is being painted.
        lakesKnown: lakeCount(),
        disclaimer: isOverview ? OVERVIEW_DISCLAIMER : DISCLAIMER
      }
    };

    await remember(body);
  });
};
