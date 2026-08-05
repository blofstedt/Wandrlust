/**
 * Vercel serverless entry point for the Wandrlust API.
 *
 * TWO THINGS THIS FILE HAS TO GET RIGHT
 *
 * 1. EXTENSIONS. The project is `"type": "module"`, so Node uses strict ESM
 *    resolution — every relative import must carry a file extension. An
 *    extensionless `'../server/boundaryRoutes'` makes Node look for a file
 *    with no extension, fail, and kill the whole function before it serves a
 *    single request (ERR_MODULE_NOT_FOUND). We write `.js` even though the
 *    source is `.ts`: that's the ESM convention, and it refers to the compiled
 *    output.
 *
 * 2. FAILURE ISOLATION. These modules run code at import time — `pushRoutes`
 *    builds a Supabase admin client the moment it loads. A static import that
 *    throws cannot be caught, so one missing environment variable would take
 *    down boundaries and weather too. Dynamic `import()` inside try/catch
 *    means a broken feature stays broken on its own.
 *
 * `server.ts` at the repo root is untouched and still runs `npm run dev`.
 */
import express from 'express';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/** Why a given feature is unavailable, surfaced by /api/health. */
const loadErrors: Record<string, string> = {};

/**
 * Health probe.
 *
 * Registered FIRST and deliberately dependency-free, so it answers even when
 * every other route failed to load. That's the whole point of it — without
 * this you're staring at an opaque 500 with no way to tell what broke.
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

/** Load one route module, recording the failure instead of propagating it. */
const safeRegister = async (
  name: string,
  load: () => Promise<{ [key: string]: any }>,
  exportName: string
): Promise<void> => {
  try {
    const mod = await load();
    const register = mod[exportName];
    if (typeof register !== 'function') {
      throw new Error(`${exportName} is not exported`);
    }
    register(app);
  } catch (err: any) {
    loadErrors[name] = err?.message ?? 'failed to load';
    console.error(`[api] ${name} routes unavailable:`, err?.message);
  }
};

// Top-level await is available in ESM and runs once per cold start, before any
// request is handled — so routes are registered by the time traffic arrives.
//
// Note the `.js` extensions. They are required, and their absence is what
// produced ERR_MODULE_NOT_FOUND on the previous deploy.

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
// fail on a fresh deploy, and least important to the map working.
await safeRegister(
  'push',
  () => import('../server/pushRoutes.js'),
  'registerPushRoutes'
);

// Unknown /api routes return JSON, not the SPA's HTML. A typo in a fetch URL
// should read as "Unknown endpoint", not "unexpected token <".
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Unknown endpoint',
    path: req.path,
    hint: 'Try /api/health'
  });
});

// Last-resort handler. Without it, an async throw surfaces as Vercel's opaque
// FUNCTION_INVOCATION_FAILED page rather than something readable.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err?.message, err?.stack);
  res.status(500).json({ error: 'Something went wrong', detail: err?.message });
});

// No app.listen(). Vercel owns the server lifecycle.
export default app;
