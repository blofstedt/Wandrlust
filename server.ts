import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

import { registerBoundaryRoutes } from './server/boundaryRoutes';
import { registerWeatherRoutes } from './server/weatherRoutes';
import { registerPushRoutes } from './server/pushRoutes';

/**
 * One process serves both the API and the client.
 *
 * In development Vite runs as middleware; in production we serve the built
 * bundle from dist/ with an SPA fallback.
 *
 * REMOVED: /api/camping-ai
 * That endpoint asked a language model to invent dispersed campsites, complete
 * with coordinates. Hallucinated coordinates send somebody down a forest road
 * to a site that does not exist, which is the exact failure this app exists to
 * prevent. Campsites now come only from the curated dataset, OpenStreetMap,
 * and other campers.
 */
const startServer = async (): Promise<void> => {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'Wandrlust' });
  });

  // Public land boundaries — three authoritative government ArcGIS services.
  registerBoundaryRoutes(app);

  // Weather plus fire / flood / storm alerts (NWS + Environment Canada).
  registerWeatherRoutes(app);

  // Web Push delivery.
  registerPushRoutes(app);

  // Unknown API routes must return JSON, not the SPA's index.html — otherwise
  // a typo in a fetch URL shows up in the client as "unexpected token <".
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown endpoint' });
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, { maxAge: '1h', index: false }));

    // SPA fallback. Must also serve /auth/callback so the OAuth redirect
    // reaches the client and the PKCE exchange can complete.
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Last-resort handler: log the detail, tell the client nothing useful.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled server error:', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Wandrlust running on http://0.0.0.0:${PORT}`);
  });
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
