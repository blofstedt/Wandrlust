/**
 * The full-detail offline land pack.
 *
 *   GET /api/land-pack/manifest        what is available, and how big it is
 *   GET /api/land-pack/cell?minLat=…   one grid cell of real boundary geometry
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE BUNDLED OVERVIEW
 * ---------------------------------------------------------------------------
 *
 * `public/map/public-land-overview.json` ships inside the app: instant, tiny,
 * works with no signal, and generalised to the point where an edge can be a
 * kilometre out. That is the right default and the wrong thing to plan a night
 * around.
 *
 * This is the other half of the choice — the real polygons, at the resolution
 * the map draws when it is online, pulled down once and kept. It is large and
 * it is slow, and the app says so before it starts rather than after.
 *
 * ---------------------------------------------------------------------------
 * IT READS `public_lands`, WHICH IS EMPTY UNTIL SOMEBODY SEEDS IT
 * ---------------------------------------------------------------------------
 *
 * There is no fallback to the live government services here, and that is
 * deliberate. `/api/boundaries` may fall through to them because it is
 * answering one viewport and a slow answer beats none. A pack download is
 * hundreds of sequential cells; pointing that at eight public ArcGIS services
 * would take an hour, hammer infrastructure this project does not own, and
 * still produce a patchy result nobody could tell was patchy.
 *
 * So when nothing is seeded the manifest says `available: false` and the app
 * declines to offer the download at all. A button that cannot work must not be
 * drawn — see the offline settings panel, which explains the situation instead.
 */
import type { Express, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY;

let client: SupabaseClient | null | undefined;

/** Read-only, on the public key. Boundaries are world-readable by RLS policy. */
const getClient = (): SupabaseClient | null => {
  if (client !== undefined) return client;
  client =
    SUPABASE_URL && SUPABASE_ANON
      ? createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
      : null;
  return client;
};

/* -------------------------------------------------------------------------- */
/* The grid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Coverage, matching `src/config/coverage.ts`. Kept as plain numbers rather
 * than imported because this file runs on the server bundle and the config is
 * a client module — but if one moves, move the other.
 */
const PACK_BBOX = { minLat: 24.4, minLon: -139.1, maxLat: 60.1, maxLon: -52.0 };

/**
 * Cell size in degrees.
 *
 * Small enough that one cell answers inside the 30-second serverless ceiling
 * even where the land is dense (northern Ontario), large enough that the whole
 * of North America is a few hundred requests rather than a few thousand.
 */
const CELL_DEGREES = 4;

/** Full-detail tolerance — the same order the map uses when zoomed in. */
const PACK_TOLERANCE = 0.0005;
/** Per-cell ceiling. Reported honestly when hit; see `truncated` below. */
const PACK_CELL_LIMIT = 4000;

export interface PackCell {
  id: string;
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

const buildGrid = (): PackCell[] => {
  const cells: PackCell[] = [];

  for (let lat = PACK_BBOX.minLat; lat < PACK_BBOX.maxLat; lat += CELL_DEGREES) {
    for (let lon = PACK_BBOX.minLon; lon < PACK_BBOX.maxLon; lon += CELL_DEGREES) {
      const maxLat = Math.min(lat + CELL_DEGREES, PACK_BBOX.maxLat);
      const maxLon = Math.min(lon + CELL_DEGREES, PACK_BBOX.maxLon);
      cells.push({
        id: `${lat.toFixed(1)}_${lon.toFixed(1)}`,
        minLat: lat,
        minLon: lon,
        maxLat,
        maxLon
      });
    }
  }
  return cells;
};

const GRID = buildGrid();

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

export const registerLandPackRoutes = (app: Express): void => {
  /**
   * What the pack would contain, before committing to downloading it.
   *
   * The parcel count is a real `count(*)`, not an estimate, because it is the
   * number the download screen shows a camper who is about to spend their data
   * allowance. An estimate presented as a size is a small lie with a real cost.
   */
  app.get('/api/land-pack/manifest', async (_req: Request, res: Response) => {
    const supabase = getClient();

    if (!supabase) {
      res.json({
        available: false,
        reason: 'not_configured',
        message: 'Full-detail maps are not available on this deployment.',
        cells: [],
        parcelCount: 0
      });
      return;
    }

    try {
      const { count, error } = await supabase
        .from('public_lands')
        .select('id', { count: 'exact', head: true });

      if (error) {
        res.json({
          available: false,
          reason: 'unavailable',
          message: 'Full-detail maps could not be reached right now. Try again later.',
          cells: [],
          parcelCount: 0
        });
        return;
      }

      const parcelCount = count ?? 0;

      /*
       * Zero rows is the normal state of this table today, and it is a
       * perfectly good answer — it means nobody has run the seed. It is NOT an
       * error, and it must not be dressed up as one, but it also must not be
       * dressed up as an empty continent.
       */
      if (parcelCount === 0) {
        res.json({
          available: false,
          reason: 'not_seeded',
          message:
            'Full-detail maps have not been prepared yet. The quick map still works everywhere; ' +
            'detailed boundaries load from the government services while you have signal.',
          cells: [],
          parcelCount: 0
        });
        return;
      }

      res.json({
        available: true,
        parcelCount,
        cellDegrees: CELL_DEGREES,
        cells: GRID,
        /*
         * Bytes are deliberately absent rather than guessed. Cell sizes vary by
         * two orders of magnitude between Nevada and northern Ontario, so any
         * single multiplier would be wrong everywhere; the client reports real
         * bytes as they land instead.
         */
        note:
          'Sizes are reported as the download runs. Expect a large download and use wifi.'
      });
    } catch {
      res.json({
        available: false,
        reason: 'unavailable',
        message: 'Full-detail maps could not be reached right now. Try again later.',
        cells: [],
        parcelCount: 0
      });
    }
  });

  /**
   * One cell of the pack, at full detail.
   *
   * Returns an empty FeatureCollection for a cell with no public land in it,
   * which is most of them — the grid is a rectangle and the continent is not.
   */
  app.get('/api/land-pack/cell', async (req: Request, res: Response) => {
    const supabase = getClient();
    if (!supabase) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }

    const num = (key: string): number | null => {
      const value = Number(req.query[key]);
      return Number.isFinite(value) ? value : null;
    };

    const minLat = num('minLat');
    const minLon = num('minLon');
    const maxLat = num('maxLat');
    const maxLon = num('maxLon');

    if (minLat === null || minLon === null || maxLat === null || maxLon === null) {
      res.status(400).json({ error: 'bad_bbox' });
      return;
    }

    // A cell larger than the grid's own would time out and, worse, would let a
    // caller use this as an uncapped export endpoint.
    if (maxLat - minLat > CELL_DEGREES + 0.01 || maxLon - minLon > CELL_DEGREES + 0.01) {
      res.status(400).json({ error: 'cell_too_large' });
      return;
    }

    try {
      const { data, error } = await supabase.rpc('boundaries_in_bbox', {
        in_min_lat: minLat,
        in_min_lon: minLon,
        in_max_lat: maxLat,
        in_max_lon: maxLon,
        in_tolerance: PACK_TOLERANCE,
        in_limit: PACK_CELL_LIMIT + 1
        // No in_min_area_sq_km. A pack wants every parcel in the cell, so
        // the filter would be 0 — a no-op — and passing an argument the
        // function does not have is a hard PostgREST error on any database
        // that has not run migration 07. Omitting it works on both.
      });

      if (error) {
        res.status(502).json({ error: 'query_failed', message: error.message });
        return;
      }

      const features = Array.isArray(data?.features) ? data.features : [];
      const truncated = features.length > PACK_CELL_LIMIT;

      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json({
        type: 'FeatureCollection',
        features: truncated ? features.slice(0, PACK_CELL_LIMIT) : features,
        // Carried through to the client so a truncated pack can say it is one,
        // rather than presenting a partial cell as the whole truth.
        truncated
      });
    } catch (err) {
      res.status(502).json({ error: 'query_failed', message: (err as Error).message });
    }
  });
};
