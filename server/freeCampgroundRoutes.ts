/**
 * Official campgrounds that cost nothing, across the rest of Canada and the
 * lower 48.
 *
 *   GET /api/free-campgrounds/ingest?from=0
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `recSiteRoutes.ts` AGAIN
 * ---------------------------------------------------------------------------
 *
 * British Columbia has a government layer that lists its recreation sites, so
 * `recSiteRoutes` reads that layer and uses OpenStreetMap only to CONFIRM that
 * a site is free. Nowhere else in the coverage area has one equivalent, public,
 * no-key layer of free campgrounds — the US alone would be the Forest Service,
 * the Bureau of Land Management, the Army Corps of Engineers, fifty state
 * parks systems and several thousand counties, each with its own portal, most
 * behind a key, several behind a login.
 *
 * So the source here is OpenStreetMap for BOTH halves, and the two claims it
 * has to support are kept separate and both required:
 *
 *   FREE      `fee=no`, tagged explicitly. An ABSENT fee tag is not a match —
 *             it means nobody said, which is the case this exists to exclude.
 *
 *   OFFICIAL  an operator that is a government body. That is what the pentagon
 *             pin claims and it must not be claimed loosely, so it is either
 *             `operator:type=government|public`, or an operator name matching
 *             one of the patterns below. Absent operator, or a private one, is
 *             not a match — a free campsite with no operator is somebody's
 *             pullout, which is what the camper-submitted pins are for.
 *
 * That is a weaker source than a government tenure layer and the description
 * written onto every row says so in words. It is the honest difference between
 * "British Columbia publishes this site" and "OpenStreetMap records this site
 * as run by the Forest Service".
 *
 * ---------------------------------------------------------------------------
 * ONE REGION AT A TIME, BECAUSE THE FUNCTION HAS THIRTY SECONDS
 * ---------------------------------------------------------------------------
 *
 * Overpass answers a state-sized box quickly ONLY because both tags are exact
 * matches served from its index; this is the same lesson `recSiteRoutes` had
 * to learn twice, and the reason there is not a regex anywhere near the query.
 * Even so, a continental box is not a thing to ask for inside a serverless
 * function, so the work is one state or province per step with a wall-clock
 * budget, and the response says where to resume.
 */
import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';
import { admin1At, admin1Regions, admin1Known, type Admin1Region } from './admin1Lookup.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let writeClient: SupabaseClient | null | undefined;
const getWriteClient = (): SupabaseClient | null => {
  if (writeClient !== undefined) return writeClient;
  writeClient = SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;
  if (!writeClient) console.info('[free-campgrounds] no service key — nothing can be stored.');
  return writeClient;
};

/** The app answers for the lower 48 and Canada. See `config/coverage.ts`. */
const COVERAGE = { minLat: 24.4, minLon: -139.1, maxLat: 60.1, maxLon: -52.0 };

const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/**
 * Operators that are a government of some kind.
 *
 * Deliberately a list of explicit patterns rather than "anything that is not
 * obviously a business". The pentagon pin says an agency runs this campground;
 * getting that wrong in the permissive direction puts a private lot on the map
 * wearing a government's badge, and the failure mode of getting it wrong in the
 * strict direction is only that a real campground stays off the map until
 * somebody tags its operator properly.
 */
const OFFICIAL_OPERATOR: RegExp[] = [
  // ---- United States, federal ----
  /\bforest service\b/i, /\busfs\b/i, /\bu\.?\s?s\.?\s?d\.?\s?a\.?\b/i,
  /bureau of land management/i, /\bblm\b/i,
  /national park service/i, /\bnps\b/i, /\bnational forest\b/i,
  /army corps of engineers/i, /\busace\b/i,
  /bureau of reclamation/i, /tennessee valley authority/i,
  /fish (and|&) wildlife/i,
  // ---- United States, state and local ----
  /\bstate park/i, /\bstate forest/i, /\bstate land/i,
  /department of natural resources/i, /\bdnr\b/i,
  /department of (conservation|environmental|parks|wildlife)/i,
  /\bwildlife (management|resources|department|division)/i,
  /\bcounty (park|of)\b/i, /\bcity of\b/i, /\btown of\b/i, /\bvillage of\b/i,
  /\btownship\b/i, /\bmunicipal/i, /\bparks (and|&) rec/i,
  // ---- Canada ----
  /parks canada/i, /parcs canada/i,
  /recreation sites and trails/i, /\bcrown land\b/i,
  /\bministry of\b/i, /minist[eè]re/i,
  /provincial (park|forest|recreation)/i,
  /(alberta|ontario|manitoba|saskatchewan|yukon) parks/i,
  /\bs[ée]paq\b/i, /soci[ée]t[ée] des [ée]tablissements/i,
  /regional (district|municipality)/i, /\bmunicipalit[eé]\b/i,
  /\brural municipality\b/i, /\bmrc\b/i,
  /department of (lands|tourism)/i
];

/** `operator:type` values that say "a government runs this" outright. */
const OFFICIAL_OPERATOR_TYPE = new Set(['government', 'public']);

const isOfficial = (tags: Record<string, string>): string | null => {
  const operator =
    tags.operator ?? tags['operator:en'] ?? tags.owner ?? tags['owner:en'] ?? '';
  const type = (tags['operator:type'] ?? '').trim().toLowerCase();

  if (operator.trim() && OFFICIAL_OPERATOR_TYPE.has(type)) return operator.trim();
  if (operator.trim() && OFFICIAL_OPERATOR.some((re) => re.test(operator))) {
    return operator.trim();
  }
  return null;
};

interface Candidate {
  osmId: string;
  lat: number;
  lon: number;
  name: string;
  operator: string;
}

/**
 * Free, officially-operated campsites inside one bounding box.
 *
 * Both tags exact, for the reason in the header. `out center tags` because a
 * way or relation needs a representative point AND its operator, and `out
 * center` alone would drop the tags this whole route turns on.
 */
const fetchRegion = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  timeoutMs: number
): Promise<{ ok: boolean; found: number; sites: Candidate[]; note?: string }> => {
  const box = `${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},` +
              `${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
  const query =
    `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000))}];` +
    `nwr["tourism"="camp_site"]["fee"="no"](${box});` +
    `out center tags;`;

  const startedAll = Date.now();
  const perMirrorMs = Math.max(6_000, Math.floor(timeoutMs / 2));
  const tried: string[] = [];

  for (const mirror of OVERPASS_MIRRORS) {
    const left = timeoutMs - (Date.now() - startedAll);
    if (left < 4_000) {
      tried.push(`${new URL(mirror).host}: not asked, ${left} ms left`);
      break;
    }
    const host = new URL(mirror).host;
    const at = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(perMirrorMs, left));
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

      const data = (await r.json()) as {
        elements?: {
          type?: string; id?: number;
          lat?: number; lon?: number;
          center?: { lat: number; lon: number };
          tags?: Record<string, string>;
        }[];
        remark?: string;
      };
      if (!Array.isArray(data.elements)) {
        tried.push(`${host}: answered without an element list`);
        continue;
      }
      /*
       * A 200 that is really a failure. An empty list carrying a runtime error
       * is NOT "no free campgrounds in this state", and storing it as one
       * would be this route quietly reporting a whole province as empty.
       */
      if (data.elements.length === 0 && /error|timed out|timeout/i.test(data.remark ?? '')) {
        tried.push(`${host}: 200 but failed — ${String(data.remark).slice(0, 120)}`);
        continue;
      }

      const sites: Candidate[] = [];
      for (const el of data.elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const tags = el.tags ?? {};
        const operator = isOfficial(tags);
        if (!operator) continue;
        sites.push({
          osmId: `${el.type ?? 'node'}/${el.id ?? 0}`,
          lat, lon,
          name: (tags.name ?? '').trim(),
          operator
        });
      }
      console.info(
        `[free-campgrounds] ${host}: ${data.elements.length} free, ` +
        `${sites.length} of them official, in ${Date.now() - at} ms`
      );
      return { ok: true, found: data.elements.length, sites };
    } catch (err: any) {
      tried.push(
        `${host}: ${controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 100)}` +
        ` after ${Date.now() - at} ms`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, found: 0, sites: [], note: `No mirror answered — ${tried.join('; ')}` };
};

const EARTH_M = 6_371_000;
const toRad = (d: number): number => (d * Math.PI) / 180;
const metresBetween = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * How close to an existing pin before this is the same campground.
 *
 * Every state box overlaps its neighbours, British Columbia is already covered
 * far better by `recSiteRoutes` reading the province's own layer, and this
 * route is meant to be re-runnable. All three produce the same failure without
 * this: two pins, a few metres apart, for one campground. 400 m is wide enough
 * to catch a way's centre against a node somebody placed at its entrance, and
 * tight enough not to swallow the next site along a lakeshore.
 */
const DUPLICATE_RADIUS_M = 400;

const describe = (operator: string): string =>
  `Recorded in OpenStreetMap as run by ${operator} and free to use. ` +
  'That is a community-maintained record, not the operator’s own listing — ' +
  'check the agency before relying on it, and expect the fee, the season and ' +
  'the road in to be the things most likely to have changed. Nobody from this ' +
  'app has been.';

export const registerFreeCampgroundRoutes = (app: Express): void => {
  /**
   * Walk the states and provinces, ingesting as it goes.
   *
   *   GET /api/free-campgrounds/ingest            first step
   *   GET /api/free-campgrounds/ingest?from=6     resume where the last ended
   *   GET /api/free-campgrounds/ingest?dry=1      look, store nothing
   *
   * `nextFrom` in the response is the only thing a caller has to carry.
   */
  app.get('/api/free-campgrounds/ingest', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    /*
     * Under Vercel's thirty second ceiling with room to write the last region
     * and answer. Overrunning does not fail politely — the function is killed
     * mid-write and the caller gets nothing back to resume from.
     */
    const budgetMs = Math.min(
      24_000,
      Math.max(6_000, parseInt(String(req.query.budgetMs ?? '22000'), 10) || 22_000)
    );
    const dry = String(req.query.dry ?? '') === '1';

    if (admin1Known() === 0) {
      return res.status(503).json({
        ok: false,
        note: 'State and province outlines did not load, so nothing can be placed or named.'
      });
    }

    /*
     * Regions clipped to the coverage area, and dropped entirely when they do
     * not meet it. Alaska, Hawaii and everything above 60°N are outside what
     * this app answers for, and a campground it will never draw is not one to
     * spend a step of the budget fetching.
     */
    const regions: Admin1Region[] = admin1Regions()
      .map((r) => ({
        ...r,
        bbox: {
          minLat: Math.max(r.bbox.minLat, COVERAGE.minLat),
          minLon: Math.max(r.bbox.minLon, COVERAGE.minLon),
          maxLat: Math.min(r.bbox.maxLat, COVERAGE.maxLat),
          maxLon: Math.min(r.bbox.maxLon, COVERAGE.maxLon)
        }
      }))
      .filter((r) => r.bbox.minLat < r.bbox.maxLat && r.bbox.minLon < r.bbox.maxLon);

    const from = Math.max(0, parseInt(String(req.query.from ?? '0'), 10) || 0);
    const writer = dry ? null : getWriteClient();
    if (!dry && !writer) {
      return res.status(503).json({ ok: false, note: 'No service key — cannot store.' });
    }

    const results: unknown[] = [];
    let index = from;
    let storedTotal = 0;

    while (index < regions.length) {
      const spent = Date.now() - startedAt;
      /*
       * Only start a region there is time to FINISH. Stopping half way through
       * one leaves it partly ingested with nothing recording how far it got,
       * and the next run would have no way to tell that from a region with
       * genuinely few campgrounds.
       */
      if (spent > budgetMs - 7_000) break;

      const region = regions[index];
      const perRegionMs = Math.min(12_000, budgetMs - spent - 2_000);
      const answer = await fetchRegion(region.bbox, perRegionMs);

      if (!answer.ok) {
        results.push({
          region: region.name, country: region.country,
          ok: false, note: answer.note
        });
        index += 1;
        continue;
      }

      /*
       * PLACED BY OUTLINE, NOT BY WHICH BOX FOUND IT. Bounding boxes overlap
       * and real borders do not, so a campground found in Montana's box may
       * well be in Idaho. `admin1At` is the same asset the map draws state
       * lines from; a point it cannot place keeps an empty province rather
       * than being handed the one that happened to fetch it.
       */
      const inRegion = answer.sites.filter((s) => {
        const where = admin1At(s.lat, s.lon);
        return where?.name === region.name;
      });

      /* ---- Anything already on the map here wins. ---- */
      let existing: { id: string; latitude: number; longitude: number }[] = [];
      if (inRegion.length > 0) {
        const client = writer ?? getWriteClient();
        if (client) {
          const { data } = await client
            .from('campsites')
            .select('id, latitude, longitude')
            .gte('latitude', region.bbox.minLat).lte('latitude', region.bbox.maxLat)
            .gte('longitude', region.bbox.minLon).lte('longitude', region.bbox.maxLon)
            .limit(5000);
          existing = (data ?? []) as typeof existing;
        }
      }

      const fresh = inRegion.filter((s) => {
        const id = `osm-free-${s.osmId.replace('/', '-')}`;
        return !existing.some(
          (e) =>
            e.id !== id &&
            metresBetween(e.latitude, e.longitude, s.lat, s.lon) <= DUPLICATE_RADIUS_M
        );
      });

      let stored = 0;
      if (!dry && writer && fresh.length > 0) {
        const rows = fresh.map((s) => ({
          id: `osm-free-${s.osmId.replace('/', '-')}`,
          name: s.name || 'Free campground',
          land_type: 'other' as const,
          land_manager: s.operator,
          latitude: Number(s.lat.toFixed(6)),
          longitude: Number(s.lon.toFixed(6)),
          state_province: region.name,
          country: region.country,
          description: describe(s.operator),
          is_free: true,
          source: 'agency_dataset' as const,
          updated_at: new Date().toISOString()
        }));
        const { error } = await writer.from('campsites').upsert(rows, { onConflict: 'id' });
        if (error) console.warn(`[free-campgrounds] ${region.name} store failed: ${error.message}`);
        else { stored = rows.length; storedTotal += stored; }
      }

      results.push({
        region: region.name,
        country: region.country,
        freeTagged: answer.found,
        official: answer.sites.length,
        insideTheBorder: inRegion.length,
        newHere: fresh.length,
        stored
      });
      index += 1;
    }

    const done = index >= regions.length;
    console.info(
      `[free-campgrounds] regions ${from}..${index - 1} of ${regions.length}, ` +
      `${storedTotal} stored (${Date.now() - startedAt} ms)`
    );

    return res.json({
      ok: true,
      dry,
      from,
      nextFrom: done ? null : index,
      done,
      regionsTotal: regions.length,
      storedThisCall: storedTotal,
      results
    });
  });
};
