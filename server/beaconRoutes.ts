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
import { fetchPublicLand } from './boundaryRoutes.js';

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
 * ---------------------------------------------------------------------------
 * THE TIME BUDGET, AND WHY THE OLD ONE DID NOT WORK
 * ---------------------------------------------------------------------------
 *
 * Vercel kills this function at thirty seconds and returns its own gateway
 * error page. That page is not JSON, so the browser's `res.json()` throws, and
 * the client reports the only thing it can tell from a thrown parse — "could
 * not reach the server". Beacon was not unreachable. It was still working.
 *
 * The old budget was one check at the TOP of each rung of the radius ladder,
 * which meant a rung was allowed to start at 19.9 s and then run for its full
 * length: Overpass at 11 s, Mapillary at 8 s and the government land layer all
 * in parallel, so ~12 s, landing at 32 s. Past the ceiling, every time, on
 * exactly the wide scans a camper in open country needs most.
 *
 * So there are two numbers now, and every upstream call is given a timeout cut
 * from what is actually left rather than its own comfortable default.
 *
 *   DEADLINE_MS   nothing upstream may still be running after this
 *   RESERVE_MS    kept back for the persist and the ranked read-back, which
 *                 are what turn a scan into an answer. Overrunning here would
 *                 throw away work already paid for with the camper's token.
 *
 * A rung that cannot finish inside what is left is not started. Answering with
 * two rungs' worth of leads beats being killed holding three.
 */
const DEADLINE_MS = 24_000;
const RESERVE_MS = 6_000;

/**
 * The least time a rung needs to be worth starting.
 *
 * Below this the Overpass query has no chance — its own server-side timeout is
 * 25 s and a cold mirror routinely takes five — so starting one would burn the
 * remaining budget and return nothing.
 */
const MIN_RUNG_MS = 7_000;

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

/**
 * WHY A REFUSAL SAYS WHAT IT SAW.
 *
 * A 401 from this route has exactly one cause — no usable Bearer arrived — and
 * for the whole life of the feature that was indistinguishable from four very
 * different faults: the camper genuinely signed out, a dead session the app
 * had not noticed, the header stripped in transit (a cross-origin redirect
 * drops it, and every browser does that silently), or the app never attaching
 * it. Diagnosing that by elimination cost a full session and could not be
 * settled at all without the camper's own device.
 *
 * So the refusal is logged with what actually arrived. No token value is ever
 * written — the scheme and the length are enough to tell "nothing came" from
 * "something came in the wrong shape", and the forwarded host is what betrays
 * a redirect having eaten it.
 */
const describeAuth = (req: Request): string => {
  const header = req.headers.authorization;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'unknown');
  if (!header) return `no Authorization header at all, host=${host}`;
  const [scheme] = header.split(' ');
  return `Authorization present: scheme=${scheme} length=${header.length}, host=${host}`;
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
 * THIS TEXT USED TO SEND PEOPLE SOMEWHERE BEACON NOW REFUSES TO LOOK.
 *
 * It said "try closer to the city edge or adjacent to municipal parks" —
 * written when any ground scored, and directly contradicted by the rule that
 * a candidate must sit on named public land. A municipal park is now rejected
 * outright, and so is a town.
 *
 * What replaces it says the two things that are actually true: nothing was
 * found ON PUBLIC LAND here, and an empty answer is about the MAP rather than
 * about the ground — public land whose boundary nobody has drawn in
 * OpenStreetMap is invisible to this scan and very common.
 */
const NOTHING_FOUND =
  'Nothing on public land here cleared the bar. Beacon only suggests places ' +
  'inside land the map names as public — national forest, BLM, Crown land — ' +
  'so a blank answer often means the boundary is not mapped rather than that ' +
  'there is nowhere to stay. Try a beacon further out, on land you know is public.';

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
      console.warn(`[beacon] refused, no usable sign-in — ${describeAuth(req)}`);
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
    /** How many rungs of the ladder actually ran. Zero means nothing was asked. */
    let rungsRun = 0;
    /**
     * Whether the agency boundary layer actually answered on the last rung.
     *
     * Public land is a REQUIREMENT in `buildCandidates`, not a bonus — a
     * candidate the government polygons cannot place on public land is dropped
     * outright. So when this is false, "nothing cleared the bar" is not a fact
     * about the ground; it is the test never having been run.
     */
    let landConfirmable = false;

    /** Milliseconds left before anything upstream has to be finished. */
    const remaining = () => DEADLINE_MS - RESERVE_MS - (Date.now() - startedAt);

    /**
     * Give up on a slow lookup rather than let it take the whole request down.
     *
     * `fetchPublicLand` has no timeout of its own — it fans out to several
     * government ArcGIS services — so it is capped from the outside here. A
     * lookup that loses the race resolves to "unavailable", which is a value
     * `buildCandidates` already knows how to be honest about: no candidate is
     * confirmed to be on public land, and the answer says so.
     */
    const within = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        work,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
        })
      // Clear the timer when the work wins, or a serverless invocation is
      // held open by a pending timeout that can no longer change anything.
      ]).finally(() => { if (timer) clearTimeout(timer); });
    };

    for (const radiusM of RADIUS_LADDER) {
      const left = remaining();

      /*
       * Not enough time left to run this rung properly. Stop here and answer
       * with what the earlier rungs found, rather than starting work the
       * platform is going to kill halfway through — which is what turned a
       * working scan into "could not reach the server".
       */
      if (left < MIN_RUNG_MS) {
        sources.budget = rungsRun === 0
          ? 'There was not enough time left to scan at all, so nothing here was ruled out.'
          : `Stopped after ${scannedRadius / 1000} km to answer inside the time limit.`;
        console.warn(
          `[beacon] stopping before the ${radiusM} m rung — ${left} ms left ` +
          `after ${Date.now() - startedAt} ms of work, ${rungsRun} rung(s) run`
        );
        break;
      }

      /**
       * How much budget each rung actually started with.
       *
       * One line, and it is the line that would have identified the last
       * outage in seconds instead of an afternoon. When Overpass reported
       * "no time left" for its second mirror, nothing anywhere recorded how
       * much time the scan had handed it — so whether the mirrors were slow
       * or the budget was already spent upstream could only be inferred from
       * arithmetic. Now it says so.
       */
      console.info(
        `[beacon] ${radiusM} m rung starting with ${left} ms ` +
        `(${Date.now() - startedAt} ms already spent)`
      );

      scannedRadius = radiusM;
      rungsRun += 1;

      /*
       * The government boundary layer is asked alongside the other two, and
       * it is the one that decides whether a candidate is on public land at
       * all. Same sources and same cache the map draws from — see
       * `fetchPublicLand`. A degree of padding either side of the scan radius
       * so a parcel edge just outside the circle still contains a spot on it.
       *
       * Every timeout is cut from what is left, never from a fixed default:
       * three calls each waiting their own comfortable maximum is precisely
       * how the request used to overrun.
       */
      const pad = (radiusM / 111_000) * 1.4;
      const [scan, signs, publicLand] = await Promise.all([
        // The long pole, and the one whose failure means nothing was scanned
        // at all — so it gets the largest share of whatever is left.
        fetchOverpassScan(lat, lon, radiusM, Math.min(14_000, left)),
        fetchSignsNear(lat, lon, radiusM, Math.min(8_000, left)),
        within(
          fetchPublicLand({
            minLat: lat - pad, minLon: lon - pad,
            maxLat: lat + pad, maxLon: lon + pad
          }),
          Math.min(10_000, left),
          { ok: false, features: [] }
        )
      ]);

      sources.openstreetmap = scan.ok ? 'ok' : (scan.note ?? 'unavailable');
      sources.mapillary = signs.ok ? `ok (${signs.coverage} coverage)` : (signs.note ?? 'unavailable');
      /*
       * Reported like any other source, because when this one is down every
       * candidate falls back to OpenStreetMap's thinner tagging — and a
       * camper reading a short list deserves to know that is why.
       */
      sources.publicLand = publicLand.ok
        ? `ok (${publicLand.features.length} parcels in range)`
        : 'unavailable — public land could not be confirmed from agency data';
      landConfirmable = publicLand.ok;

      found = buildCandidates(scan, signs, { lat, lon }, publicLand)
        .filter((c) => c.ruleScore >= REMEMBER_SCORE);

      if (found.filter((c) => c.ruleScore >= SURFACE_SCORE).length >= WANTED) break;
    }

    /**
     * A thin answer has to say WHY it is thin. "Nothing here", "we ran out of
     * time" and "we could not ask" are three different facts, and a camper
     * deciding where to sleep needs to know which one they are looking at.
     */
    const ranOutOfTime = rungsRun === 0;
    const couldNotAsk = !ranOutOfTime && sources.openstreetmap !== 'ok';

    /**
     * A FOURTH FACT, AND IT USED TO BE SPELLED AS THE FIRST ONE.
     *
     * OpenStreetMap answering is not the whole test. `buildCandidates` drops
     * every candidate the agency boundary layer cannot place on public land —
     * that is deliberate and it is the rule that stopped Beacon returning
     * supermarket car parks. But it means the government layer timing out and
     * the ground genuinely being empty produce the SAME empty list, and the
     * empty list was being reported with NOTHING_FOUND: "Nothing on public
     * land here cleared the bar."
     *
     * That sentence claims a test was run. When the boundary layer was down,
     * it was not — no candidate could have survived that filter no matter what
     * Overpass found. So the camper was told there is nowhere to sleep here on
     * the strength of a check that never happened, which is the one thing this
     * app does not do. Worse, it was told for free to everybody afterwards:
     * the scan row went in, and `beacon_scan_is_fresh` then served that
     * unchecked "nothing" to the next two days of campers looking at the same
     * ground.
     *
     * Only counted when the answer is EMPTY. If OpenStreetMap's own tagging
     * carried a lead through anyway, the scan did its job and keeps its token.
     */
    const landWentUnchecked =
      !ranOutOfTime && !couldNotAsk && !landConfirmable && found.length === 0;

    /** Ground was actually swept, whether or not anything was standing on it. */
    const sweptGround = !ranOutOfTime && !couldNotAsk && !landWentUnchecked;

    /* ---- Persist. Scores are recomputed with the learned model in SQL. ---- */
    /*
     * Recorded whenever a scan RAN, not only when it found something.
     *
     * "Nothing here" is an answer, and an expensive one — it is the whole
     * radius ladder against Overpass. Gated on `found.length > 0`, that answer
     * was thrown away the moment it was given: no `beacon_scans` row meant
     * `beacon_scan_is_fresh` could never say yes for empty ground, so the next
     * camper to beacon the same pullout paid another token to rediscover the
     * same nothing, and so did the one after that. Forever, for every patch of
     * empty country — which is most of them.
     *
     * The SQL was always ready for this: `beacon_persist_spots` loops over an
     * empty array zero times and still writes the scan row, and `beacon_scans`
     * declares `found_count integer not null default 0`. Only the caller
     * disagreed. This is the cache the migration means when it says the cache
     * "is the difference between Beacon being free to run and Beacon hammering
     * Overpass on every pin drop".
     *
     * Still skipped when nothing was swept — a scan that never ran has no
     * result to remember, and recording one would suppress the real scan for
     * the next two days.
     */
    /**
     * The write is what turns a scan into an answer — `readSpots` reads BACK
     * what was just stored. So a persist that fails produces an empty list
     * from ground that may have been full of leads, and that empty list must
     * never be spelled as "nothing here".
     */
    let persistFailed = false;
    if (service && sweptGround) {
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
      if (error) {
        console.warn('[beacon] persist failed:', error.message);
        persistFailed = true;
      }
    }

    const spots = await readSpots(scannedRadius);

    /**
     * NOTHING WAS SCANNED, SO THE BEACON GOES BACK.
     *
     * The token is claimed before the scan, which is right — a quota applied
     * after the expensive work is not a quota. But nothing ever gave it back,
     * and the sentence below promised in as many words that a failed scan
     * "did not use up a beacon". It did. Three failures in a row cost a camper
     * their whole twelve-hour allowance while telling them each time that they
     * still had it.
     *
     * Refunded only when NO GROUND WAS SWEPT — every mirror refused, or the
     * request ran out of time before a rung could start. A scan that ran and
     * found nothing keeps its token: that is a real answer about real ground,
     * and it is the answer Beacon exists to give.
     *
     * If the refund itself fails, the wording below changes rather than the
     * promise being made anyway. See `refunded`.
     */
    let refunded = false;
    let beaconsLeft = claim.remaining;
    let resetsAt = claim.resets_at;
    if (ranOutOfTime || couldNotAsk || landWentUnchecked || persistFailed) {
      const { data: back, error: refundError } = await caller.rpc('refund_beacon_token');
      if (refundError) {
        console.warn('[beacon] refund failed:', refundError.message);
      } else if (back?.ok === true) {
        refunded = true;
        beaconsLeft = back.remaining;
        resetsAt = back.resets_at ?? resetsAt;
      }
    }

    /** Only claimed when it is true. */
    const kept = refunded ? ' This did not use up a beacon — you still have it.' : '';

    return res.json({
      ok: spots.length > 0,
      spots,
      cached: false,
      remaining: beaconsLeft,
      resetsAt,
      radiusScannedM: scannedRadius,
      sources,
      disclaimer: DISCLAIMER,
      note: spots.length > 0
        ? undefined
        : ranOutOfTime
        ? 'The map services were too slow to answer, so no ground here was actually scanned. ' +
          `Nothing below has been ruled out — try again in a moment.${kept}`
        : couldNotAsk
        ? `Could not reach OpenStreetMap just now, so nothing was scanned.${kept}`
        : landWentUnchecked
        ? 'The government land boundaries could not be reached just now, and Beacon ' +
          'only suggests ground an agency names as public — so it had nothing to ' +
          `check against and ruled nothing out. Try again in a moment.${kept}`
        : persistFailed
        ? 'The scan ran, but its results could not be saved, so nothing can be ' +
          `shown for it. Nothing here has been ruled out — try again shortly.${kept}`
        : NOTHING_FOUND,
      signageNote: sources.mapillary?.startsWith('ok')
        ? undefined
        : 'Street-level signage was not checked here, so no spot below can be treated as sign-free.',
      /*
       * Said whenever the agency layer was down, INCLUDING when OpenStreetMap
       * tagging still carried a lead through. A spot resting on a volunteer's
       * `landuse=forest` is a weaker claim than one inside a named BLM parcel,
       * and the camper is the one who has to decide whether to drive there.
       */
      landNote: landConfirmable
        ? undefined
        : 'Agency land boundaries could not be reached, so nothing below is ' +
          'confirmed to sit on public land from the managing agency\'s own data.'
    });
  });
};
