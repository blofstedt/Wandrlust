/**
 * OpenStreetMap campsites, swept once and remembered for everybody.
 *
 *   GET /api/osm-campsites?lat=&lon=&radiusMiles=
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 *
 * Every camper's BROWSER used to query Overpass directly, on every meaningful
 * pan of the map. A thousand campers looking at the same valley meant a
 * thousand identical queries against a volunteer-funded service, and every one
 * of them waited several seconds for an answer somebody else had already been
 * given. The only cache was a ten-minute one inside the tab, which died with
 * the tab and helped nobody else.
 *
 * Now the ground is swept once and the result is kept for ninety days, so the
 * second person to look at a place pays nothing and waits for nothing. Same
 * shape as `land_ingest_coverage` for boundaries and `beacon_scans` for
 * Beacon; see migration 28 for why the sites live in the sweep row rather than
 * in `campsites`.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT KEEP IT HONEST
 * ---------------------------------------------------------------------------
 *
 * ONLY A REAL ANSWER IS STORED. An Overpass outage must never be written down
 * as "no campsites here" — that would be an empty map, cached, for three
 * months, for everybody. A failed sweep stores nothing and says so.
 *
 * A STALE ANSWER BEATS NO ANSWER. If the sweep has expired and Overpass cannot
 * be reached to refresh it, the old sites are served with their age attached
 * rather than an empty list. Campgrounds do not vanish because a mirror is
 * down.
 */
import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';
import { toCampsite, type OverpassElement } from '../shared/osmCampsite.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * The cache is written with the service key because `osm_campsite_sweeps` has
 * RLS on and no policies — a browser that could write there could claim a
 * valley was swept and empty, and hide its campsites for three months.
 */
let cacheClient: SupabaseClient | null | undefined;
const getCacheClient = (): SupabaseClient | null => {
  if (cacheClient !== undefined) return cacheClient;
  cacheClient = SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;
  if (!cacheClient) console.info('[osm-campsites] no service key — every request will hit Overpass.');
  return cacheClient;
};

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const MILES_TO_METRES = 1609.34;
/** Overpass struggles past this, and the browser clamped here too. */
const MAX_RADIUS_M = 80_000;
const MAX_RESULTS = 60;

/** Ninety days, as asked for. See migration 28 for why that is the number. */
const FRESH_FOR_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How much the map has to move before it counts as new ground.
 *
 * A quarter degree is roughly 28 km north-south — a fraction of the 80 km
 * sweep, so a camper panning around a valley keeps landing in the same cell
 * and keeps getting the same free answer. Finer than this and the cache would
 * fragment into thousands of overlapping sweeps of the same ground; coarser
 * and the edge of a cell would sit too far from what was actually swept.
 */
const CELL_DEGREES = 0.25;

const sweepKey = (lat: number, lon: number, radiusM: number): string => {
  const snap = (n: number) => (Math.round(n / CELL_DEGREES) * CELL_DEGREES).toFixed(2);
  return `${snap(lat)}:${snap(lon)}:${radiusM}`;
};

const overpassQuery = (lat: number, lon: number, radiusM: number): string =>
  `[out:json][timeout:20];` +
  `(node["tourism"="camp_site"](around:${radiusM},${lat},${lon});` +
  `way["tourism"="camp_site"](around:${radiusM},${lat},${lon});` +
  `node["tourism"="caravan_site"](around:${radiusM},${lat},${lon}););` +
  `out center ${MAX_RESULTS};`;

interface SweepResult {
  sites: unknown[];
  ok: boolean;
  tried: string[];
}

const sweep = async (lat: number, lon: number, radiusM: number): Promise<SweepResult> => {
  const query = overpassQuery(lat, lon, radiusM);
  const tried: string[] = [];
  const startedAll = Date.now();
  const TOTAL_MS = 22_000;
  const PER_MIRROR_MS = 11_000;

  for (const mirror of OVERPASS_MIRRORS) {
    const left = TOTAL_MS - (Date.now() - startedAll);
    if (left < 4_000) {
      tried.push(`${new URL(mirror).host}: not asked, ${left} ms left`);
      break;
    }
    const host = new URL(mirror).host;
    const at = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PER_MIRROR_MS, left));
    try {
      const r = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!r.ok) { tried.push(`${host}: HTTP ${r.status}`); continue; }

      const data = (await r.json()) as { elements?: OverpassElement[]; remark?: string };
      if (!Array.isArray(data.elements)) { tried.push(`${host}: no element list`); continue; }
      /*
       * A 200 that is really a failure — see `overpassFailureRemark` in
       * beaconSources.ts. An empty list carrying a runtime error is NOT "no
       * campsites here", and storing it as one would cache an outage.
       */
      if (data.elements.length === 0 && /error|timed out|timeout/i.test(data.remark ?? '')) {
        tried.push(`${host}: 200 but failed — ${String(data.remark).slice(0, 100)}`);
        continue;
      }

      const shaped = data.elements
        .map(toCampsite)
        .filter((s): s is NonNullable<typeof s> => s !== null);

      // OSM often holds a node and a way for one physical site.
      const seen = new Set<string>();
      const unique = shaped.filter((s) => {
        const key = `${s.latitude.toFixed(4)},${s.longitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      console.info(`[osm-campsites] ${host}: ${unique.length} sites in ${Date.now() - at} ms`);
      return { sites: unique, ok: true, tried };
    } catch (err: any) {
      tried.push(
        `${host}: ${controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 100)}` +
        ` after ${Date.now() - at} ms`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { sites: [], ok: false, tried };
};

export const registerOsmCampsiteRoutes = (app: Express): void => {
  app.get('/api/osm-campsites', async (req: Request, res: Response) => {
    const lat = parseFloat(String(req.query.lat));
    const lon = parseFloat(String(req.query.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, sites: [], note: 'lat and lon are required.' });
    }
    const radiusMiles = parseFloat(String(req.query.radiusMiles ?? '50'));
    const radiusM = Math.min(
      MAX_RADIUS_M,
      Math.round((Number.isFinite(radiusMiles) ? radiusMiles : 50) * MILES_TO_METRES)
    );

    const key = sweepKey(lat, lon, radiusM);
    const client = getCacheClient();

    /* ---- Has anybody swept this ground lately? ---- */
    let cached: { sites: unknown[]; fetched_at: string } | null = null;
    if (client) {
      const { data } = await client
        .from('osm_campsite_sweeps')
        .select('sites, fetched_at')
        .eq('cell_key', key)
        .maybeSingle();
      if (data) cached = data as { sites: unknown[]; fetched_at: string };
    }

    const ageMs = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
    if (cached && ageMs < FRESH_FOR_MS) {
      return res.json({
        ok: true,
        sites: cached.sites,
        servedFrom: 'cache',
        ageDays: Math.floor(ageMs / 86_400_000)
      });
    }

    /* ---- Nobody has, or it has expired. Ask Overpass. ---- */
    const result = await sweep(lat, lon, radiusM);

    if (!result.ok) {
      console.warn(`[osm-campsites] sweep failed — ${result.tried.join(' | ')}`);
      /*
       * A STALE ANSWER BEATS NO ANSWER. Campgrounds do not vanish because a
       * mirror is down, so an expired sweep is served with its age attached
       * rather than replaced by an empty list.
       */
      if (cached) {
        return res.json({
          ok: true,
          sites: cached.sites,
          servedFrom: 'stale-cache',
          ageDays: Math.floor(ageMs / 86_400_000),
          note: 'OpenStreetMap could not be reached, so this is the last sweep of this ground.'
        });
      }
      return res.json({
        ok: false,
        sites: [],
        servedFrom: 'none',
        note: 'Could not reach OpenStreetMap, so campsites here have not been checked.'
      });
    }

    /* ---- Only a real answer is written down. ---- */
    if (client) {
      const { error } = await client.from('osm_campsite_sweeps').upsert({
        cell_key: key,
        geom: `SRID=4326;POINT(${lon} ${lat})`,
        radius_m: radiusM,
        sites: result.sites,
        found_count: result.sites.length,
        fetched_at: new Date().toISOString()
      }, { onConflict: 'cell_key' });
      if (error) console.warn(`[osm-campsites] could not store sweep: ${error.message}`);
    }

    return res.json({
      ok: true,
      sites: result.sites,
      servedFrom: 'live',
      ageDays: 0
    });
  });
};
