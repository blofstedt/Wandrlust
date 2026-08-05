/**
 * Vercel serverless entry point for the Wandrlust API.
 *
 * WHY THIS FILE EXISTS
 *
 * `server.ts` in the project root runs an Express server with `app.listen()`
 * and mounts Vite as middleware. That is exactly right for local development
 * and completely wrong for Vercel: Vercel does not run persistent Node
 * processes. It converts your code into serverless functions that spin up per
 * request and are destroyed afterwards, so nothing ever calls `listen()` and
 * the API simply doesn't exist. The symptom is a 404 on every `/api/*` route
 * while the frontend loads fine — which is exactly what happened here.
 *
 * This file exports the same Express app WITHOUT listening, which is the shape
 * Vercel expects. `server.ts` is untouched and still runs `npm run dev`.
 *
 * Everything is registered under /api because vercel.json routes /api/* here.
 */
import express from 'express';

import { registerBoundaryRoutes } from '../server/boundaryRoutes';
import { registerWeatherRoutes } from '../server/weatherRoutes';
import { registerPushRoutes } from '../server/pushRoutes';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/**
 * Cheap liveness probe.
 *
 * Hit https://your-domain/api/health after any deploy. If this returns JSON,
 * the backend is running. If it returns the app's HTML or a 404, it isn't —
 * and boundaries, weather and push are all silently dead.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Wandrlust',
    runtime: 'vercel-serverless',
    time: new Date().toISOString()
  });
});

// Public land boundaries — proxies three government ArcGIS services.
registerBoundaryRoutes(app);

// Weather + fire/flood/storm alerts (NWS + Environment Canada).
registerWeatherRoutes(app);

// Web Push delivery.
registerPushRoutes(app);

// Unknown /api routes must return JSON, not fall through to the SPA. A typo in
// a fetch URL should read as "Unknown endpoint", not "unexpected token <".
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown endpoint' });
});

// Last-resort handler: log the detail server-side, tell the client nothing.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled API error:', err.message);
  res.status(500).json({ error: 'Something went wrong' });
});

// No app.listen(). Vercel owns the server lifecycle.
export default app;
