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
import { settingFor, placesKnown } from './placeSetting.js';

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
  /national park service/i, /\bnps\b/i,
  /*
   * PLURAL. "Huron-Manistee National Forests" is one administrative unit
   * covering two forests and it is spelled that way on every sign; the
   * singular pattern missed it and five of its campgrounds with it.
   */
  /\bnational forests?\b/i,
  /army corps of engineers/i, /\busace\b/i,
  /bureau of reclamation/i, /tennessee valley authority/i,
  /fish (and|&) wildlife/i,
  // ---- United States, state and local ----
  /\bstate park/i, /\bstate forest/i, /\bstate land/i,
  /*
   * "Texas Parks and Wildlife" — the standard shape of a US state agency
   * name, and none of the patterns around it had a chance: the `parks,
   * recreation` one wants "recreation", the `department of wildlife` one
   * wants "department of", and this is neither. Found by the dry run.
   */
  /\bparks,?\s+(and|&)\s+wildlife\b/i,
  /department of natural resources/i, /\bdnr\b/i,
  /department of (conservation|environmental|parks|wildlife)/i,
  /\bwildlife (management|resources|department|division)/i,
  /\bcounty (park|of)\b/i, /\bcity of\b/i, /\btown of\b/i, /\bvillage of\b/i,
  /\btownship\b/i, /\bmunicipal/i,
  /*
   * The comma is not optional decoration. "Office of Parks, Recreation and
   * Historic Preservation" is New York's parks agency and the old
   * `parks (and|&) rec` never had a chance at it.
   */
  /\bparks,?\s+(and\s+|&\s+)?recreation\b/i, /\bparks (and|&) rec/i,
  /**
   * A state or province naming ITSELF as the operator.
   *
   * "State of Minnesota", "The Province of Alberta". Both are as plainly
   * government as an agency name and neither matched anything above, which
   * cost Alberta four campgrounds it publishes under its own name. Safe
   * against the obvious false friend: `\bstate of\b` does not fire inside
   * "estate of", because there is no word boundary in the middle of a word.
   */
  /\bstate of\b/i, /\bprovince of\b/i,
  /** New York's environmental agency, which signs itself by acronym. */
  /\bnys?dec\b/i,
  // ---- Canada ----
  /parks canada/i, /parcs canada/i,
  /*
   * AMPERSAND. The layer is "Recreation Sites and Trails BC" and half the
   * mappers write it "Recreation Sites & Trails" — six of BC's own free
   * campgrounds were being turned away over the word "and". Found by the dry
   * run, which is what it is for.
   */
  /recreation sites (and|&) trails/i, /\bcrown land\b/i,
  /\bministry of\b/i, /minist[eè]re/i,
  /provincial (park|forest|recreation)/i,
  /*
   * A province's parks agency, under its own name. BC and SaskParks were
   * both missing — "SaskParks" is one word, which is how Saskatchewan's
   * only free-tagged campsite in OpenStreetMap was turned away.
   */
  /(alberta|ontario|manitoba|saskatchewan|yukon|qu[ée]bec|new brunswick|nova scotia|newfoundland) parks/i,
  /\bbc parks\b/i, /british columbia parks/i, /\bsask\s?parks\b/i,
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

/**
 * ---------------------------------------------------------------------------
 * A PITCH INSIDE A PARK IS NOT A FREE CAMPGROUND
 * ---------------------------------------------------------------------------
 *
 * The first real ingest stored fifty Ontario rows and forty-seven of them were
 * called "Site 1" through "Site 47", all operated by Ontario Parks, strung a
 * few hundred metres apart along one canoe route. They are the individual
 * backcountry PITCHES inside a provincial park, and Ontario Parks backcountry
 * camping requires a paid permit — so every one of those pins was the app
 * telling a camper that a place costing money was free. That is the single
 * claim this app is least allowed to get wrong.
 *
 * `fee=no` on such a node is not even mistagged. It is answering "does this
 * particular pitch cost extra, on top of the permit you already bought" —
 * a different question from the one this route is asking.
 *
 * So being free and being official is not enough; it also has to be A PLACE
 * YOU DRIVE TO AND STAY AT, rather than one bookable unit inside somewhere
 * bigger. Every rejection is counted and returned by reason, because the
 * difference between "this state has no free campgrounds" and "this state's
 * free campgrounds were all filtered out" is invisible otherwise — and a
 * silent zero is how the last two rounds of this went wrong.
 */
const SUB_UNIT_NAME: RegExp[] = [
  // "Site 12", "Campsite 3", "Pitch 7b", "No. 4"
  /^\s*(site|campsite|camp|pitch|spot|no\.?)\s*#?\s*\d+[a-z]?\s*$/i,
  // "Saganaga Lake #12" — a named place plus a unit number
  /#\s*\d+\s*$/,
  // Bare numbers
  /^\s*\d+\s*$/
];

/**
 * Why this campsite is not a standalone free campground, or null if it is.
 *
 * An UNNAMED site is rejected too. Every BC recreation site — the standard
 * this was asked to match — has a name, and somewhere worth driving to
 * generally does; an unnamed node is far more often a pitch, a fragment or a
 * duplicate. It is the conservative reading, which is the one already chosen
 * for this feature: being short of a few good campgrounds costs a camper one
 * search, being wrong about a fee costs them a drive and a fine.
 */
const notAStandaloneCampground = (tags: Record<string, string>): string | null => {
  const name = (tags.name ?? '').trim();
  if (!name) return 'unnamed';
  if (SUB_UNIT_NAME.some((re) => re.test(name))) return 'numbered-sub-site';

  // Interior sites reached on foot or by paddle, under a permit system.
  if ((tags.backcountry ?? '').toLowerCase() === 'yes') return 'backcountry';
  // OSM's own word for one bookable unit inside a larger site.
  if ((tags.camp_site ?? '').toLowerCase() === 'pitch') return 'pitch';

  const permit = (tags.permit ?? '').toLowerCase();
  if (permit && permit !== 'no') return 'permit-required';
  if ((tags.access ?? '').toLowerCase() === 'permit') return 'permit-required';
  if ((tags.reservation ?? '').toLowerCase() === 'required') return 'reservation-required';
  // A stated charge contradicts `fee=no`; believe the more expensive one.
  if ((tags.charge ?? '').trim()) return 'charge-stated';

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
  timeoutMs: number,
  /**
   * Also report WHICH operators were turned away.
   *
   * `no-government-operator` is by far the biggest rejection reason and it
   * hides two completely different facts: a campsite whose operator tag is
   * EMPTY, which nobody can do anything about, and one that names an agency
   * this file's pattern list does not recognise, which is a five-minute fix.
   * Alberta reporting 382 free campsites and five official ones could be
   * either, and there was no way to tell from the outside — so a dry run now
   * says. Collected only on a dry run, because it is a diagnostic and the
   * strings are unbounded.
   */
  sample = false
): Promise<{
  ok: boolean; found: number; sites: Candidate[];
  rejected?: Record<string, number>;
  operators?: { blank: number; unrecognised: Record<string, number> };
  note?: string;
}> => {
  const box = `${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},` +
              `${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
  const query =
    `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000))}];` +
    `nwr["tourism"="camp_site"]["fee"="no"](${box});` +
    `out center tags;`;

  const startedAll = Date.now();
  /*
   * Nine seconds each, not half the budget. The first run of this gave each
   * mirror six and every one of them timed out on the big boxes — measured,
   * from production, not guessed. Overpass answers a state in a second or two
   * once the query is index-served; when it needs longer than that it is
   * because the box is genuinely large, and six seconds turns "slow" into
   * "nothing at all".
   */
  const perMirrorMs = Math.max(9_000, Math.floor(timeoutMs / 2));
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
      const rejected: Record<string, number> = {};
      const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

      let blankOperator = 0;
      const unrecognised: Record<string, number> = {};

      for (const el of data.elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (typeof lat !== 'number' || typeof lon !== 'number') { reject('no-position'); continue; }
        const tags = el.tags ?? {};

        const operator = isOfficial(tags);
        if (!operator) {
          reject('no-government-operator');
          if (sample) {
            const raw = (
              tags.operator ?? tags['operator:en'] ?? tags.owner ?? tags['owner:en'] ?? ''
            ).trim();
            if (raw) unrecognised[raw] = (unrecognised[raw] ?? 0) + 1;
            else blankOperator += 1;
          }
          continue;
        }

        const why = notAStandaloneCampground(tags);
        if (why) { reject(why); continue; }

        sites.push({
          osmId: `${el.type ?? 'node'}/${el.id ?? 0}`,
          lat, lon,
          name: (tags.name ?? '').trim(),
          operator
        });
      }
      console.info(
        `[free-campgrounds] ${host}: ${data.elements.length} free-tagged, ` +
        `${sites.length} standalone official campgrounds, in ${Date.now() - at} ms`
      );
      return {
        ok: true,
        found: data.elements.length,
        sites,
        rejected,
        ...(sample
          ? {
              operators: {
                blank: blankOperator,
                // The commonest twenty, by count. The tail is a long list of
                // one-offs and is not what a pattern list would be widened for.
                unrecognised: Object.fromEntries(
                  Object.entries(unrecognised)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 20)
                )
              }
            }
          : {})
      };
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

/**
 * Which of the land types this operator actually is.
 *
 * ONLY WHEN THE OPERATOR NAMES THE THING THE ENUM NAMES. Rounding to the
 * nearest value is the tempting version and it is wrong in the way this
 * codebase keeps refusing: filing a county park under `usfs` is the app
 * stating who owns a piece of ground, on the strength of nothing, to somebody
 * deciding whether they are allowed to sleep on it.
 *
 * A state WILDLIFE AREA is deliberately not `state_forest` — same government,
 * different land, different rules — and Parks Canada is not `crown_land`.
 * Everything without an exact home lands in `other_public`: public land, run
 * by an agency, and `land_manager` carries which one. See migration 29.
 */
const landTypeFor = (operator: string, country: string): string => {
  if (/forest service|\busfs\b|national forest|usda forest/i.test(operator)) return 'usfs';
  if (/bureau of land management|\bblm\b/i.test(operator)) return 'blm';
  if (/state forest|state land/i.test(operator)) return 'state_forest';
  if (country === 'Canada' && /crown land|\bministry of\b|minist[eè]re|provincial (park|forest|recreation)|recreation sites and trails/i.test(operator)) {
    return 'crown_land';
  }
  return 'other_public';
};

const describe = (operator: string): string =>
  `Recorded in OpenStreetMap as run by ${operator} and free to use. ` +
  'That is a community-maintained record, not the operator’s own listing — ' +
  'check the agency before relying on it, and expect the fee, the season and ' +
  'the road in to be the things most likely to have changed. Nobody from this ' +
  'app has been.';

/**
 * Urban, suburban or wilderness, for the rows just written.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND WRITE AND NOT A COLUMN ON THE UPSERT
 * ---------------------------------------------------------------------------
 *
 * `setting` decides the pin's glyph — trees for wilderness, houses for
 * suburban, towers for urban, and a neutral TENT when nobody has said. This
 * route left it null, so every campground it added drew as a tent until
 * somebody remembered to call `/api/rec-sites/settings` afterwards. Nobody
 * did, and the symptom was a forestry campground deep in the Alberta
 * foothills wearing the "we have no idea what this place is like" mark.
 *
 * The obvious fix is to put `setting` in the upsert, and it is wrong. The
 * upsert runs again every time this route re-walks a region, and it replaces
 * every column it names — so a camper who stood at that campground and
 * corrected its setting would have their answer overwritten by an estimate,
 * on a schedule, forever. `setting_is_derived` exists to stop exactly that,
 * and it can only stop it from a WHERE clause.
 *
 * So: upsert without it, then update only the rows this app still owns. Same
 * guard `/api/rec-sites/settings` uses, and that endpoint remains the way to
 * backfill anything stored before this existed.
 *
 * `settingFor` is a lookup against a committed list of towns — no network, no
 * mirrors, no failure mode — which is why this can run inline. An empty town
 * list would call the entire continent wilderness, so it classifies nothing
 * at all rather than guess.
 */
const classify = async (
  writer: SupabaseClient,
  rows: { id: string; latitude: number; longitude: number }[]
): Promise<void> => {
  if (placesKnown() === 0 || rows.length === 0) return;

  const byValue = new Map<string, string[]>();
  for (const row of rows) {
    const value = settingFor(row.latitude, row.longitude);
    const ids = byValue.get(value) ?? [];
    ids.push(row.id);
    byValue.set(value, ids);
  }

  for (const [value, ids] of byValue) {
    const { error } = await writer
      .from('campsites')
      .update({ setting: value, setting_is_derived: true })
      .in('id', ids)
      // The line that makes a camper's own answer permanent.
      .eq('setting_is_derived', true);
    if (error) console.warn(`[free-campgrounds] setting ${value} failed: ${error.message}`);
  }
};

export const registerFreeCampgroundRoutes = (app: Express): void => {
  /**
   * Walk the states and provinces, ingesting as it goes.
   *
   *   GET /api/free-campgrounds/ingest            first step
   *   GET /api/free-campgrounds/ingest?from=6     resume where the last ended
   *   GET /api/free-campgrounds/ingest?dry=1      look, store nothing
   *
   * `nextFrom` in the response is the only thing a caller has to carry. It
   * counts TILES, not regions — a province too big for Overpass to answer in
   * one go is asked in pieces, see the tiling note below — so a `from` saved
   * from an older run points somewhere else now. Start again from 0.
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
      /*
       * IN, BY ITS MIDDLE — not by whether a corner of it grazes the coverage
       * box. Clipping alone kept Nunavut and Alaska in: Nunavut survived as a
       * 60°-wide band along the top edge and Alaska as a strip down its
       * eastern side, and both are enormous, empty, and timed out every
       * mirror on the first production run. A territory whose centre is
       * outside what this app answers for has nothing here worth a step of
       * the budget.
       */
      .filter((r) => {
        const midLat = (r.bbox.minLat + r.bbox.maxLat) / 2;
        const midLon = (r.bbox.minLon + r.bbox.maxLon) / 2;
        return midLat >= COVERAGE.minLat && midLat <= COVERAGE.maxLat &&
               midLon >= COVERAGE.minLon && midLon <= COVERAGE.maxLon;
      })
      // Still clipped, so a state straddling the edge is only asked about the
      // part of itself this app draws.
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

    /*
     * ---------------------------------------------------------------------
     * A PROVINCE IS ASKED IN PIECES, BECAUSE ASKED WHOLE IT NEVER ANSWERED.
     * ---------------------------------------------------------------------
     *
     * This walk used to ask Overpass for one province at a time, and for the
     * four biggest that meant a box roughly twenty degrees on a side. Every
     * mirror timed out on every one of them, every time — measured in
     * production, from the dry run:
     *
     *   Québec                     no mirror answered
     *   Ontario                    no mirror answered
     *   Newfoundland and Labrador  no mirror answered
     *
     * Those three are not a rounding error. They are the province with the
     * most Crown land in the country and two of the next three, and the map
     * showed nothing across all of them — not "we looked and there is
     * nothing", which is what an empty map says, but "we never once got an
     * answer". That is the same failure this codebase has already written
     * down twice for boundaries: A SOURCE THAT ANSWERS A SMALL BOX PERFECTLY
     * CAN TIME OUT ON A BIG ONE, and the fix both times was to stop asking
     * the big one.
     *
     * So the unit of work is a TILE now, not a region. A region wider or
     * taller than `TILE_DEGREES` is cut into a grid of them and each piece is
     * asked on its own. Small states are one tile and behave exactly as
     * before; Québec becomes twelve boxes that Overpass answers in a second
     * or two each.
     *
     * This also fixes the resume problem the old loop had to guard against.
     * It would not START a region it could not FINISH, because a half-done
     * region left no record of how far it got — with tiles, a tile IS the
     * unit, `nextFrom` points at the next one, and stopping is always clean.
     *
     * SIX DEGREES is the size. Big enough that the fifty small states stay
     * one tile each and the walk does not get longer for them; small enough
     * that the worst box in the set — northern Québec, which is empty of
     * roads and full of lakes — comes back well inside a mirror's patience.
     */
    const TILE_DEGREES = 6;

    interface Tile { region: Admin1Region; part: number; parts: number; bbox: Admin1Region['bbox'] }

    const tiles: Tile[] = regions.flatMap((region) => {
      const { minLat, minLon, maxLat, maxLon } = region.bbox;
      const rows = Math.max(1, Math.ceil((maxLat - minLat) / TILE_DEGREES));
      const cols = Math.max(1, Math.ceil((maxLon - minLon) / TILE_DEGREES));
      const dLat = (maxLat - minLat) / rows;
      const dLon = (maxLon - minLon) / cols;
      const out: Tile[] = [];
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          out.push({
            region,
            part: out.length + 1,
            parts: rows * cols,
            bbox: {
              minLat: minLat + r * dLat,
              minLon: minLon + c * dLon,
              maxLat: minLat + (r + 1) * dLat,
              maxLon: minLon + (c + 1) * dLon
            }
          });
        }
      }
      return out;
    });

    const from = Math.max(0, parseInt(String(req.query.from ?? '0'), 10) || 0);
    const writer = dry ? null : getWriteClient();
    if (!dry && !writer) {
      return res.status(503).json({ ok: false, note: 'No service key — cannot store.' });
    }

    const results: unknown[] = [];
    let index = from;
    let storedTotal = 0;

    while (index < tiles.length) {
      const spent = Date.now() - startedAt;
      /*
       * Only start a tile there is time to FINISH — the same rule as before,
       * against a much smaller unit, so far less of the budget is ever left
       * unspent at the end of a call.
       */
      if (spent > budgetMs - 8_000) break;

      const tile = tiles[index];
      const region = tile.region;
      const label = tile.parts > 1
        ? `${region.name} (${tile.part}/${tile.parts})`
        : region.name;
      const perTileMs = Math.min(14_000, budgetMs - spent - 1_500);
      const answer = await fetchRegion(tile.bbox, perTileMs, dry);

      if (!answer.ok) {
        results.push({
          region: label, country: region.country,
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
            .gte('latitude', tile.bbox.minLat).lte('latitude', tile.bbox.maxLat)
            .gte('longitude', tile.bbox.minLon).lte('longitude', tile.bbox.maxLon)
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
      /*
       * A FAILED WRITE IS NOT "NOTHING NEW".
       *
       * The first production run reported `stored: 0` for fifty perfectly good
       * campgrounds, because the upsert was rejected (an invalid `land_type`)
       * and the only trace was a console warning. Zero-because-nothing-was-new
       * and zero-because-the-write-failed are opposite facts and they read
       * identically, which is the exact thing this project keeps writing down
       * and then doing anyway. The reason now comes back in the response.
       */
      let storeError: string | null = null;
      if (!dry && writer && fresh.length > 0) {
        const rows = fresh.map((s) => ({
          id: `osm-free-${s.osmId.replace('/', '-')}`,
          name: s.name || 'Free campground',
          land_type: landTypeFor(s.operator, region.country),
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
        if (error) {
          storeError = error.message;
          console.warn(`[free-campgrounds] ${region.name} store failed: ${error.message}`);
        } else {
          stored = rows.length;
          storedTotal += stored;
          await classify(writer, rows);
        }
      }

      results.push({
        region: label,
        country: region.country,
        freeTagged: answer.found,
        official: answer.sites.length,
        insideTheBorder: inRegion.length,
        newHere: fresh.length,
        stored,
        rejected: answer.rejected ?? {},
        ...(answer.operators ? { operators: answer.operators } : {}),
        ...(storeError ? { storeError } : {})
      });
      index += 1;
    }

    const done = index >= tiles.length;
    console.info(
      `[free-campgrounds] tiles ${from}..${index - 1} of ${tiles.length}, ` +
      `${storedTotal} stored (${Date.now() - startedAt} ms)`
    );

    return res.json({
      ok: true,
      dry,
      from,
      nextFrom: done ? null : index,
      done,
      // `from` counts TILES now, not regions — see the tiling note above.
      tilesTotal: tiles.length,
      regionsTotal: regions.length,
      storedThisCall: storedTotal,
      results
    });
  });
};
