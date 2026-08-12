/**
 * Beacon.
 *
 *   GET /api/beacon/query?lat=&lon=     scan for places you might sleep near here
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * Where the evidence comes from, and what it is not, is documented once in
 * `server/beaconSources.ts`. This file is the orchestration around it, and
 * four decisions in here are load-bearing.
 *
 * ONE: EVERYTHING RUNS INSIDE THE REQUEST. The original design for this feature
 * called for a job queue and a background worker, because it assumed fetching
 * street-level imagery and running OCR over it. Mapillary publishes its sign
 * DETECTIONS as plain JSON, so the expensive half of that never happens — the
 * whole scan is two HTTP calls and some SQL, and it fits comfortably inside the
 * thirty-second serverless ceiling. A queue would have been infrastructure
 * built to serve an assumption that turned out to be false. There is a hard
 * time budget below instead.
 *
 * TWO: THE CACHE DECIDES WHETHER THE USER PAYS. Ground swept by anybody in the
 * last 48 hours is served from Postgres, and serving it does NOT spend one of
 * the camper's three tokens — they did not cost us an upstream call, so
 * charging for them would be charging rent on somebody else's work.
 *
 * THREE: THE QUOTA IS CHECKED WITH THE CALLER'S OWN CREDENTIALS. The browser
 * sends its Supabase access token, this route builds a client with it, and
 * `claim_beacon_token()` resolves `auth.uid()` from that. A client that simply
 * claims to have a token gets nothing — otherwise the rate limit would be a
 * suggestion.
 *
 * FOUR: THE DATABASE RANKS, NOT THIS FILE. Candidates are scored here from the
 * rules, persisted, and then read BACK through `beacon_spots_near`, which adds
 * the learned model score. That round trip is deliberate: it means the ranking
 * a camper sees is always the current model's, and there is exactly one place
 * where ranking happens.
 */
import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import {
  fetchOverpassScan, fetchSignsNear, buildCandidates, metresBetween,
  type Candidate
} from './beaconSources.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Outward sweep, in metres.
 *
 * Stops as soon as three candidates clear the bar, so a camper parked beside a
 * forest road never waits for a five-kilometre scan they did not need.
 */
const RADIUS_LADDER = [500, 1000, 5000];

/** How many we return. More than three is a list to trawl, not an answer. */
const WANTED = 3;

/**
 * Worth showing, and worth remembering.
 *
 * Two bars, not one. Anything above REMEMBER is stored so the model has
 * something to learn from and so the next camper's scan is free; only things
 * above SURFACE are put in front of a human. The gap is where "technically a
 * lead, practically a waste of a drive" lives.
 */
const SURFACE_SCORE = 2;
const REMEMBER_SCORE = 1;

/**
 * The whole request budget. Vercel's ceiling is 30 s; leaving a third of it
 * spare covers a slow Supabase round trip on a cold connection.
 */
const BUDGET_MS = 20_000;

/* ------------------------------------------------------------------ */
/* Supabase clients                                                    */
/* ------------------------------------------------------------------ */

let anonClient: SupabaseClient | null | undefined;
let serviceClient: SupabaseClient | null | undefined;

/** Reads that need no identity: the scan cache and the spot list. */
const getAnonClient = (): SupabaseClient | null => {
  if (anonClient !== undefined) return anonClient;
  anonClient =
    SUPABASE_URL && SUPABASE_ANON
      ? createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
      : null;
  if (!anonClient) console.info('[beacon] Supabase not configured — Beacon is off.');
  return anonClient;
};

/**
 * Writes. Persisting a spot has to bypass RLS because no browser is allowed to
 * author one — the score it carries is only meaningful if the server computed
 * it. The key never leaves this process and is never referenced from `src/`.
 */
const getServiceClient = (): SupabaseClient | null => {
  if (serviceClient !== undefined) return serviceClient;
  serviceClient =
    SUPABASE_URL && SERVICE_KEY
      ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
      : null;
  return serviceClient;
};

/** A client that acts as the signed-in caller, for the quota claim. */
const getCallerClient = (req: Request): SupabaseClient | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ') || !SUPABASE_URL || !SUPABASE_ANON) return null;

  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: header } }
  });
};

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

interface SpotRow {
  id: string;
  latitude: number;
  longitude: number;
  tier: string;
  generator: string;
  label: string | null;
  land_basis: string | null;
  sign_evidence: string;
  verify_count: number;
  rule_score: number;
  model_score: number;
  region: string;
}

const shape = (row: SpotRow, lat: number, lon: number) => ({
  id: row.id,
  latitude: row.latitude,
  longitude: row.longitude,
  tier: row.tier,
  generator: row.generator,
  label: row.label ?? 'Possible spot',
  landBasis: row.land_basis ?? undefined,
  signEvidence: row.sign_evidence,
  verifyCount: row.verify_count,
  score: Number((row.rule_score + row.model_score).toFixed(2)),
  region: row.region,
  metresAway: Math.round(metresBetween(lat, lon, row.latitude, row.longitude))
});

/**
 * The caveat that rides along with every answer.
 *
 * Not a disclaimer bolted on at the end — it is part of the payload, so there
 * is no way to render a Beacon result without it being available to render too.
 */
const DISCLAIMER =
  'These are leads worked out from public map data, not permission to stay. ' +
  'Boundaries are approximate, local rules change, and a sign on the ground ' +
  'beats anything in here. Check when you arrive.';

/**
 * The exact words for "we found nothing", from the original specification.
 * Kept verbatim because it tells the camper what to DO next, which is a great
 * deal more useful than an empty list.
 */
const NOTHING_FOUND =
  'No high-confidence spots found nearby. Try dropping a beacon closer to the ' +
  'city edge or adjacent to municipal parks.';

/* ------------------------------------------------------------------ */

const readCoords = (req: Request, keys: string[]): number[] | null => {
  const values = keys.map((k) => parseFloat(req.query[k] as string));
  return values.some((n) => Number.isNaN(n)) ? null : values;
};

/** Rough CONUS + Canada, matching the coverage the rest of the app claims. */
const inCoverage = (lat: number, lon: number): boolean =>
  lat >= 24 && lat <= 72 && lon >= -168 && lon <= -52;

export const registerBeaconRoutes = (app: Express): void => {
  app.get('/api/beacon/query', async (req: Request, res: Response) => {
    const coords = readCoords(req, ['lat', 'lon']);
    if (!coords) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }
    const [lat, lon] = coords;

    if (!inCoverage(lat, lon)) {
      return res.json({
        ok: false, spots: [], cached: false, disclaimer: DISCLAIMER,
        note: 'Beacon only covers the lower 48 and Canada.'
      });
    }

    const anon = getAnonClient();
    if (!anon) {
      return res.json({
        ok: false, spots: [], cached: false, disclaimer: DISCLAIMER,
        note: 'Beacon needs a database connection and this deployment has none configured.'
      });
    }

    const startedAt = Date.now();

    /** Read whatever is already known about this ground, ranked by the model. */
    const readSpots = async (radiusM: number) => {
      const { data, error } = await anon.rpc('beacon_spots_near', {
        in_lat: lat, in_lon: lon, in_radius_km: radiusM / 1000
      });
      if (error || !Array.isArray(data)) return [];
      return (data as SpotRow[])
        .map((row) => shape(row, lat, lon))
        .filter((spot) => spot.score >= SURFACE_SCORE)
        .slice(0, WANTED);
    };

    /* ---- Cache first. A hit costs the camper nothing. ---- */
    const { data: fresh } = await anon.rpc('beacon_scan_is_fresh', {
      in_lat: lat, in_lon: lon, in_radius_m: RADIUS_LADDER[0]
    });

    if (fresh === true) {
      const spots = await readSpots(RADIUS_LADDER[RADIUS_LADDER.length - 1]);
      return res.json({
        ok: spots.length > 0,
        spots,
        cached: true,
        disclaimer: DISCLAIMER,
        note: spots.length > 0
          ? 'Someone already swept this ground in the last two days, so this one was free.'
          : NOTHING_FOUND
      });
    }

    /* ---- A real scan. This is what costs a token. ---- */
    const caller = getCallerClient(req);
    if (!caller) {
      return res.status(401).json({
        ok: false, spots: [], cached: false, disclaimer: DISCLAIMER,
        note: 'Sign in to send out a beacon. Ground somebody has already scanned stays free.'
      });
    }

    const { data: claim, error: claimError } = await caller.rpc('claim_beacon_token');
    if (claimError || !claim || claim.ok !== true) {
      return res.status(429).json({
        ok: false, spots: [], cached: false, disclaimer: DISCLAIMER,
        remaining: claim?.remaining ?? 0,
        resetsAt: claim?.resets_at,
        note: claim?.message ?? 'Could not check your beacon allowance just now.'
      });
    }

    const service = getServiceClient();
    const sources: Record<string, string> = {};
    let found: Candidate[] = [];
    let scannedRadius = RADIUS_LADDER[0];

    for (const radiusM of RADIUS_LADDER) {
      scannedRadius = radiusM;

      // Out of budget. Stop where we are and answer with what we have rather
      // than letting the platform kill the request mid-flight.
      if (Date.now() - startedAt > BUDGET_MS) {
        sources.budget = 'Stopped early to stay inside the request time limit.';
        break;
      }

      const [scan, signs] = await Promise.all([
        fetchOverpassScan(lat, lon, radiusM),
        fetchSignsNear(lat, lon, radiusM)
      ]);

      sources.openstreetmap = scan.ok ? 'ok' : (scan.note ?? 'unavailable');
      sources.mapillary = signs.ok ? `ok (${signs.coverage} coverage)` : (signs.note ?? 'unavailable');

      found = buildCandidates(scan, signs, { lat, lon })
        .filter((c) => c.ruleScore >= REMEMBER_SCORE);

      if (found.filter((c) => c.ruleScore >= SURFACE_SCORE).length >= WANTED) break;
    }

    /* ---- Persist. Scores are recomputed with the learned model in SQL. ---- */
    if (service && found.length > 0) {
      const { error } = await service.rpc('beacon_persist_spots', {
        in_spots: found.map((c) => ({
          lat: c.lat, lon: c.lon, generator: c.generator,
          label: c.label, land_basis: c.landBasis,
          tokens: c.tokens, rule_score: c.ruleScore, sign_evidence: c.signEvidence
        })),
        in_scan_lat: lat,
        in_scan_lon: lon,
        in_radius_m: scannedRadius,
        in_sources: sources
      });
      if (error) console.warn('[beacon] persist failed:', error.message);
    }

    const spots = await readSpots(scannedRadius);

    /**
     * A thin answer has to say WHY it is thin. "Nothing here" and "we could not
     * ask" are different facts and a camper deciding where to sleep needs to
     * know which one they are looking at.
     */
    const couldNotAsk = sources.openstreetmap !== 'ok';

    return res.json({
      ok: spots.length > 0,
      spots,
      cached: false,
      remaining: claim.remaining,
      resetsAt: claim.resets_at,
      radiusScannedM: scannedRadius,
      sources,
      disclaimer: DISCLAIMER,
      note: spots.length > 0
        ? undefined
        : couldNotAsk
        ? 'Could not reach OpenStreetMap just now, so nothing was scanned. This did not use up a beacon you can spend later.'
        : NOTHING_FOUND,
      signageNote: sources.mapillary?.startsWith('ok')
        ? undefined
        : 'Street-level signage was not checked here, so no spot below can be treated as sign-free.'
    });
  });
};
