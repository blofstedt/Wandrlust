/**
 * Vercel serverless entry point for the Wandrlust API.
 *
 * THREE THINGS THIS FILE HAS TO GET RIGHT
 *
 * 1. PATH RECONSTRUCTION. On a non-Next.js project, `api/index.ts` maps to
 *    exactly `/api` — sub-paths like `/api/health` never reach it, and
 *    catch-all filenames ([...slug]) are a Next.js-only feature. So
 *    vercel.json rewrites `/api/:path*` here, and Vercel passes the captured
 *    segments as a QUERY PARAM rather than in the URL. The middleware below
 *    puts the path back before Express routes anything. Without it every
 *    request looks like a bare `/api` and nothing matches.
 *
 * 2. EXTENSIONS. The project is `"type": "module"`, so Node uses strict ESM
 *    resolution and every relative import needs a file extension. An
 *    extensionless '../server/boundaryRoutes' throws ERR_MODULE_NOT_FOUND and
 *    kills the function before it serves anything. We write `.js` even though
 *    the source is `.ts` — that's the ESM convention, referring to compiled
 *    output.
 *
 * 3. FAILURE ISOLATION. These modules run code at import time; `pushRoutes`
 *    builds a Supabase admin client the moment it loads. A static import that
 *    throws can't be caught, so one missing env var would take down
 *    boundaries and weather too. Dynamic import inside try/catch keeps a
 *    broken feature contained.
 *
 * `server.ts` at the repo root is untouched and still runs `npm run dev`.
 */
import express from 'express';

const app = express();

app.disable('x-powered-by');
// Vercel terminates TLS ahead of this function, so the scheme and the
// client IP only exist in X-Forwarded-*. Trust one hop — the platform's.
app.set('trust proxy', 1);

/**
 * Rebuild the real request path from the rewrite's query parameter.
 *
 * MUST run before any route is registered, and before the JSON body parser,
 * so everything downstream sees the URL it expects.
 *
 *   /api/weather/alerts?minLat=50
 *     → Vercel invokes this function with ?path=weather&path=alerts
&minLat=50
 *     → we restore  /api/weather/alerts?minLat=50
 */
app.use((req, _res, next) => {
  const raw = (req.query as Record<string, unknown>).path;

  if (raw !== undefined) {
    const segments = Array.isArray(raw) ? raw.map(String) : [String(raw)];

    // Keep every other query param; drop only the synthetic `path` key.
    const rest = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query as Record<string, unknown>)) {
      if (key === 'path') continue;
      if (Array.isArray(value)) value.forEach((v) => rest.append(key, String(v)));
      else rest.append(key, String(value));
    }

    const search = rest.toString();
    req.url = `/api/${segments.join('/')}${search ? `?${search}` : ''}`;
  }

  next();
});

app.use(express.json({ limit: '256kb' }));

/** Why a given feature is unavailable, surfaced by /api/health. */
const loadErrors: Record<string, string> = {};

/**
 * Health probe.
 *
 * Registered first and deliberately dependency-free, so it answers even when
 * every other route failed to load. Without it you're staring at an opaque
 * 500 with no way to tell what broke.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Wandrlust',
    runtime: 'vercel-serverless',
    time: new Date().toISOString(),
    features: {
      boundaries: !loadErrors.boundaries,
      weather: !loadErrors.weather,
      push: !loadErrors.push,
      cellCoverage: !loadErrors.cellCoverage,
      routing: !loadErrors.routing,
      facilities: !loadErrors.facilities
    },
    errors: Object.keys(loadErrors).length > 0 ? loadErrors : undefined,
    env: {
      supabaseUrl: Boolean(process.env.VITE_SUPABASE_URL),
      serviceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      vapidPublic: Boolean(process.env.VITE_VAPID_PUBLIC_KEY),
      vapidPrivate: Boolean(process.env.VAPID_PRIVATE_KEY),
      mapillaryToken: Boolean(process.env.MAPILLARY_TOKEN),
      /**
       * The agent string, printed ra
ther than reduced to a boolean.
       *
       * The National Weather Service and OpenStreetMap both refuse callers
       * they cannot identify, and this deployment spent its whole life sending
       * a placeholder that read "set NWS_USER_AGENT in .env" — a to-do note in
       * the field where a contact belongs. Nothing about it is secret and
       * seeing the exact string is the difference between knowing and guessing.
       */
      nwsUserAgent: process.env.NWS_USER_AGENT?.trim() || '(built-in default)'
    }
  });
});

/** Load one route module, recording any failure instead of propagating it. */
const safeRegister = async (
  name: string,
  load: () => Promise<Record<string, any>>,
  exportName: string
): Promise<void> => {
  try {
    const mod = await load();
    const register = mod[exportName];
    if (typeof register !== 'function') throw new Error(`${exportName} is not exported`);
    register(app);
  } catch (err: any) {
    loadErrors[name] = err?.message ?? 'failed to load';
    console.error(`[api] ${name} routes unavailable:`, err?.message);
  }
};

// Top-level await runs once per cold start, before any request is handled.
// The `.js` extensions are required — their absence caused the previous
// ERR_MODULE_NOT_FOUND crash.

// Boundaries: a pure HTTP proxy to government ArcGIS services. No credentials,
// no database. This one should always load.
await safeRegister(
  'boundaries',
  () => import('../server/boundaryRoutes.js'),
  'registerBoundaryRoutes'
);

/**
 * The full-detail offline land pack, served out of Supabase cell by cell.
 *
 * Registered right after boundaries because it is the same subject matter and
 * has the same failure mode: without it the app cannot download detailed maps,
 * and an app that offers a download button which 404s is worse than one that
 * says the pack is unavailable. The route answers `available: false` on its
 * own when Supabase is absent, so registering it is always safe.
 */
await safeRegister(
 
 'land-pack',
  () => import('../server/landPackRoutes.js'),
  'registerLandPackRoutes'
);

// Weather: NWS + Environment Canada. No API keys needed.
await safeRegister(
  'weather',
  () => import('../server/weatherRoutes.js'),
  'registerWeatherRoutes'
);

/**
 * Active fires: WFIGS perimeters (US) + FireRadar points (Canada).
 *
 * THIS WAS MISSING, AND THAT IS WHY NO FIRE EVER APPEARED IN PRODUCTION.
 * `server.ts` registers it for `npm run dev`, so the layer worked locally and
 * every deployed request to /api/fires fell through to the 404 below. The map
 * asked, got "Unknown endpoint", and — exactly as designed — degraded to
 * drawing no fires. A pure HTTP proxy to two public feeds; no keys.
 */
await safeRegister(
  'fires',
  () => import('../server/fireRoutes.js'),
  'registerFireRoutes'
);

/**
 * Alert feed status. Also missing, which is why the "who is behind these
 * warnings" panel could never tell the user whether the feed was live — the
 * 404 handler below already had a rule for /api/alerts, but nothing had ever
 * registered the routes it was describing.
 *
 * The routes only. The background ingest timer that `server.ts` starts has no
 * meaning in a serverless function that is torn down between requests.
 */
await safeRegister(
  'alerts',
  () => import('../server/alertIngest.js'),
  'registerAlertRoutes'
);

// Cell coverage: an OpenCellID proxy. Loads with or without a key — without
// one it answers "not configured", which is a valid answer the UI renders.
await safeRegister(
  'cellCoverage',
  () => import('../server/cellRoutes.js'),
  'registerCellRoutes'
);

// Routing: proxies OpenRouteService / Valhalla / OSRM. No key required — the
// Valhalla rung is what lets a route reach a forest road.
await safeRegister(
  'routing',
  () => import('../server/routeRoutes.js'),
  'registerRouteRoutes'
);

/**
 * Backroads: the unpaved and minor roads drawn as a map overlay.
 *
 * Registered here as well as in `server.ts` — see the note on fires ab
ove for
 * what happens when it is only in one of them. A pure Overpass proxy with an
 * in-memory cache and a CDN cache header; no keys, nothing to configure.
 */
await safeRegister(
  'backroads',
  () => import('../server/backroadRoutes.js'),
  'registerBackroadRoutes'
);

/**
 * Facilities: toilets, water, propane and the rest, from OpenStreetMap.
 *
 * AND HERE IS THE FOURTH TIME. Fires, alerts and spot context each shipped
 * registered in `server.ts` and not here, worked perfectly in `npm run dev`,
 * and answered 404 in production — where the client turned that into exactly
 * the degraded behaviour it was designed for, so nothing looked broken except
 * the feature quietly not existing. This route did it again: the map said
 * "couldn't check for toilets just now" for every camper, on every screen,
 * while the route it was calling had never been loaded.
 *
 * `scripts/checkServerImports.mjs` now fails the build when a route lives in
 * one entry point and not the other, so there cannot be a fifth.
 *
 * A pure Overpass proxy with an in-memory cache and a CDN cache header; no
 * keys, nothing to configure.
 */
await safeRegister(
  'facilities',
  () => import('../server/facilityRoutes.js'),
  'registerFacilityRoutes'
);

// Push: needs VAPID keys and the Supabase service role key. Most likely to
// fail on a fresh deploy, least important to the map working.
await safeRegister(
  'push',
  () => import('../server/pushRoutes.js'),
  'registerPushRoutes'
);

// Beacon: scans OpenStreetMap for places you might legally sleep. Needs
// Supabase to store and rank what it finds; MAPILLARY_TOKEN is optional and
// only adds the street-sign check.
await safeRegister(
  'beacon',
  () => import('../server/beaconRoutes.js'),
  'registerBeaconRoutes'
);

/**
 * Spot context: the name a coordinate gets, and the facilities within 5 km.
 *
 * MISSING FOR THE SAME REASON FIRES AND ALERTS WERE, which is the third time
 * this file has grown a route that `server.ts` had and 
it did not. Every
 * deployed request to /api/spot/context fell through to the 404 below, the
 * client turned that into `poiLookupFailed: true` exactly as designed, and the
 * report sheet therefore asked every camper about showers, restrooms and fuel
 * that OpenStreetMap could already have answered — while naming their spot
 * "Spot at 38.573, -109.549" instead of "Manti-La Sal National Forest Pullout".
 *
 * A pure Overpass proxy with an in-memory cache; no keys, nothing to configure.
 */
await safeRegister(
  'spot',
  () => import('../server/spotRoutes.js'),
  'registerSpotRoutes'
);

await safeRegister(
  'road-segments',
  () => import('../server/roadSegmentRoutes.js'),
  'registerRoadSegmentRoutes'
);

// BC Recreation Sites — read-only proxy of the DataBC layer.
await safeRegister(
  'rec-sites',
  () => import('../server/recSiteRoutes.js'),
  'registerRecSiteRoutes'
);

// OpenStreetMap campsites, swept once and cached for everybody.
await safeRegister(
  'osm-campsites',
  () => import('../server/osmCampsiteRoutes.js'),
  'registerOsmCampsiteRoutes'
);

// Free, officially-run campgrounds across the rest of Canada and the lower 48.
await safeRegister(
  'free-campgrounds',
  () => import('../server/freeCampgroundRoutes.js'),
  'registerFreeCampgroundRoutes'
);

  /**
   * Scout Paths: user-recorded road surface data from Scout Mode.
   * Closes the loop: recordings are now stored AND displayed on the map.
   */

/**
 * Which feature owns a path, so a route that failed to LOAD can say so.
 *
 * THIS EXISTS BECAUSE OF A BUG THAT HID FOR A WHOLE RELEASE. `weatherRoutes`
 * threw at import time (a relative import missing its `.js`), `safeRegister`
 * caught it exactly as designed, and every weather request then fell past the
 * registered routes into the 404 below. The client dutifully reported
 * "Weather unavailable (404)" — technically true, and useless: a 404 says the
 * endpoint does not exist, when in fact it exists and failed to start.
 *
 * A 503 naming the real error is the difference between a five-minute fix and
 * a week of guessing. `/api/health` already knew; nothing else asked it.
 */
const FEATURE_FOR_PATH: [RegExp, string][] = [
  [/^\/api\/weather/, 'weather'],
  [/^\/api\/boundaries/, 'boundaries'],
  [/^\/api\/cell-/, 'cellCoverage'],
  [/^\/api\/route/, 'routing'],
  [/^\/api\/push/, 'push'],
  [/^\/api\/alerts/, 'alerts'],
  [/^\/api\/fires/, 'fires'],
  [/^\/api\/backroads/, 'backroads'],
  [/^\/api\/facilities/, 'facilities'],
  [/^\/api\/beacon/, 'beacon'],
  [/^\/api\/spot/, 'spot'],
  [/^\/api\/road-segments/, 'road-segments'],
  [/^\/api\/rec-sites/, 'rec-sites'],
  [/^\/api\/osm-campsites/, 'osm-campsites'],
  [/^\/api\/free-campgrounds/, 'free-campgrounds'],
];

// Unknown /api routes return JSON, not the SPA's HTML. A typo in a fetch URL
// should read as "Unknown endpoint", not "unexpected token <".
app.use((req, res) => {
  const owner = FEATURE_FOR_PATH.find(([pattern]) => pattern.test(req.path))?.[1];

  if (owner && loadErrors[owner]) 
{
    return res.status(503).json({
      error: `The ${owner} service failed to start on this deployment.`,
      detail: loadErrors[owner],
      path: req.path,
      hint: 'See /api/health'
    });
  }

  res.status(404).json({
    error: 'Unknown endpoint',
    path: req.path,
    hint: 'Try /api/health'
  });
});

// Last-resort handler. Without it an async throw surfaces as Vercel's opaque
// FUNCTION_INVOCATION_FAILED page rather than something readable.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err?.message, err?.stack);
  res.status(500).json({ error: 'Something went wrong', detail: err?.message });
});

// No app.listen(). Vercel owns the server lifecycle.
export default app;
