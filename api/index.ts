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

/**
 * Rebuild the real request path from the rewrite's query parameter.
 *
 * MUST run before any route is registered, and before the JSON body parser,
 * so everything downstream sees the URL it expects.
 *
 *   /api/weather/alerts?minLat=50
 *     → Vercel invokes this function with ?path=weather&path=alerts&minLat=50
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
      push: !loadErrors.push
    },
    errors: Object.keys(loadErrors).length > 0 ? loadErrors : undefined,
    env: {
      supabaseUrl: Boolean(process.env.VITE_SUPABASE_URL),
      serviceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      vapidPublic: Boolean(process.env.VITE_VAPID_PUBLIC_KEY),
      vapidPrivate: Boolean(process.env.VAPID_PRIVATE_KEY)
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

// Weather: NWS + Environment Canada. No API keys needed.
await safeRegister(
  'weather',
  () => import('../server/weatherRoutes.js'),
  'registerWeatherRoutes'
);

// Push: needs VAPID keys and the Supabase service role key. Most likely to
// fail on a fresh deploy, least important to the map working.
await safeRegister(
  'push',
  () => import('../server/pushRoutes.js'),
  'registerPushRoutes'
);

// Unknown /api routes return JSON, not the SPA's HTML. A typo in a fetch URL
// should read as "Unknown endpoint", not "unexpected token <".
app.use((req, res) => {
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
