/**
 * Spot context.
 *
 *   GET /api/spot/context?lat=&lon=
 *
 * The lookup that makes the submission form short: it names the place from
 * OpenStreetMap and reports which facilities are already within 5 km, so the
 * form can skip both the name field and any facility question it can answer
 * on its own. See `server/spotContext.ts` for why no language model is
 * involved in the naming.
 *
 * This route never fails the request. An Overpass outage comes back as
 * `ok: false` with `poiLookupFailed: true`, and the form's job is then to ASK
 * rather than to state — "we could not check" and "there is nothing here" are
 * different facts and this app does not let them blur.
 */
import type { Express, Request, Response } from 'express';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { fetchSpotContext, type SpotContextResult } from './spotContext.js';
import { TtlCache } from '../shared/ttlCache.js';

/**
 * A small warm-instance cache.
 *
 * Explicitly NOT load-bearing: the API runs as a serverless function, so this
 * map vanishes whenever the platform feels like it, and everything still works
 * when it does — the next request just pays for another Overpass call. It
 * exists because dropping a pin, nudging it twenty metres and dropping it
 * again is a completely normal thing to do, and that should not be three
 * round trips to a rate-limited public service.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new TtlCache<SpotContextResult>(CACHE_TTL_MS, CACHE_MAX);

/** ~110 m of latitude. Finer than this and the cache never hits. */
const cacheKey = (lat: number, lon: number) =>
  `${lat.toFixed(3)},${lon.toFixed(3)}`;

const readCache = (key: string): SpotContextResult | null => cache.get(key) ?? null;

const writeCache = (key: string, value: SpotContextResult): void => {
  // A failed lookup is not worth remembering — the next request should get a
  // real attempt rather than ten minutes of cached pessimism.
  if (!value.ok) return;
  cache.set(key, value);
};

/** Rough CONUS + Canada, matching the coverage the rest of the app claims. */
const inCoverage = (lat: number, lon: number): boolean =>
  lat >= 24 && lat <= 72 && lon >= -168 && lon <= -52;

export const registerSpotRoutes = (app: Express): void => {
  app.get('/api/spot/context', async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }

    if (!inCoverage(lat, lon)) {
      return res.json({
        ok: false,
        name: '',
        pois: [],
        poiLookupFailed: true,
        note: 'Outside the area Wandrlust covers, so nothing could be looked up.'
      });
    }

    const key = cacheKey(lat, lon);
    const cached = readCache(key);
    if (cached) return res.json(cached);

    const context = await fetchSpotContext(lat, lon);
    writeCache(key, context);

    return res.json(context);
  });
};
