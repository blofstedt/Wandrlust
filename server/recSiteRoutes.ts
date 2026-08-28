/**
 * BC Recreation Sites — Recreation Sites and Trails BC (RSTBC).
 *
 *   GET /api/rec-sites?offset=0&limit=200     a page of the provincial list
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND THE ONE QUESTION IT HAS TO ANSWER FIRST
 * ---------------------------------------------------------------------------
 *
 * RSTBC runs roughly 1,300 recreation sites across British Columbia. Most are
 * "user maintained", which means free, first-come-first-served, self-register
 * — exactly the kind of place this app exists to find. But NOT ALL OF THEM
 * ARE. A minority are operated under partnership agreements and charge a fee,
 * usually ten to fifteen dollars a night.
 *
 * That distinction is the whole job. A campground listed as free that turns
 * out to want fifteen dollars at a self-registration post is the app lying to
 * somebody who has already driven there, and "free camping" is the entire
 * promise on the front of this application.
 *
 * `FTEN_RECREATION_POLY_SVW` is a FOREST TENURE layer: it describes the land
 * reservation, not the visitor experience, so it may well carry no fee field
 * at all. Nothing here assumes either way. This route exists first as a way to
 * READ the layer from production — the only place in this project that can
 * reach a government host — and report exactly which attributes come back and
 * what is in them. Only once a fee flag is confirmed to exist, and confirmed
 * to be populated, does anything get written into `campsites`.
 *
 * So: read-only, on purpose. It writes nothing and takes no credentials. It is
 * a thin cached proxy of an open government dataset, in the same spirit as
 * `/api/boundaries`, and it must stay that way until the question above has a
 * real answer.
 */
import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * The writer. Same arrangement `public_lands` uses and for the same reason:
 * no browser may author one of these rows, because the whole value of the
 * record is that a government published it and a second source corroborated
 * the fee. Storing on read is the documented pattern in this codebase — see
 * the ingest note in boundaryRoutes.ts.
 */
let writeClient: SupabaseClient | null | undefined;
const getWriteClient = (): SupabaseClient | null => {
  if (writeClient !== undefined) return writeClient;
  writeClient = SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;
  if (!writeClient) console.info('[rec-sites] no service key — read-only, nothing will be stored.');
  return writeClient;
};

/**
 * `FRANCIS LAKE` reads as shouting next to `Eaton Creek`.
 *
 * Only touched when the whole string is upper case, so `McCall Flats`,
 * `Owen Flats "A" & "B"` and `Bob's Lake` are left exactly as published.
 */
const tidyName = (raw: string): string => {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s('"\-\/])([a-z])/g, (_m, lead, ch) => lead + ch.toUpperCase());
};

/**
 * What this app actually knows about a recreation site, said plainly.
 *
 * Three claims and three admissions, in that order. The admissions are not
 * boilerplate: the province publishes no amenity or fee data in this layer at
 * all, so anything the row's amenity columns say is a schema default rather
 * than a fact, and a camper reading the card deserves to know which is which.
 */
const describeSite = (campsites: number): string =>
  `Recreation site managed by Recreation Sites and Trails BC` +
  (campsites > 0 ? `, with ${campsites} defined campsite${campsites === 1 ? '' : 's'}` : '') +
  '. Free to camp according to OpenStreetMap contributors — the province does ' +
  'not publish fee status, so that is corroboration rather than proof. Check ' +
  'the board when you arrive. Facilities here are not recorded by anybody: ' +
  'most recreation sites have a pit toilet and a fire ring, none has drinking ' +
  'water or power, and nobody from this app has been to confirm it.';

/** DataBC's public OGC endpoint — the same host `bc_provincial_forest` uses. */
const DATABC_OWS = 'https://openmaps.gov.bc.ca/geo/pub/ows';

/** The full provincial list of forest recreation sites, reserves and trails. */
const TYPE_NAME = 'WHSE_FOREST_TENURE.FTEN_RECREATION_POLY_SVW';

const ATTRIBUTION = 'Recreation Sites and Trails BC, Government of British Columbia';
const LICENCE = 'Open Government Licence – British Columbia';

/**
 * Longitude-then-latitude by definition. Plain `EPSG:4326` is latitude-first
 * to the WFS 2.0 spec and longitude-first to much of the software implementing
 * it — the same trap `wfsQueryUrl` in boundaryRoutes.ts documents at length.
 */
const CRS84 = 'urn:ogc:def:crs:OGC:1.3:CRS84';

/** A WFS cannot generalise, so a runaway page is refused rather than parsed. */
const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 20_000;

/** Pages are small on purpose: a serverless function has thirty seconds. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

interface RecRecord {
  lat: number;
  lon: number;
  /** Every attribute as published, untouched. The mapping decision comes later. */
  props: Record<string, unknown>;
}

/** Cheap in-process cache. Pages are stable; the layer changes rarely. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

type Ring = [number, number][];

/**
 * A representative point for a recreation site polygon.
 *
 * The centre of the bounding box, not a true centroid. A recreation site is a
 * small, roughly convex clearing, so the two are within metres of each other
 * and the bbox centre cannot land outside the shape the way a centroid of a
 * crescent can. Good enough to drive to; the polygon itself is the record.
 */
const representativePoint = (geometry: unknown): { lat: number; lon: number } | null => {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let seen = 0;

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      seen += 1;
      return;
    }
    for (const child of node as Ring) walk(child);
  };

  walk((geometry as { coordinates?: unknown })?.coordinates);
  if (seen === 0) return null;
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
};

/**
 * ---------------------------------------------------------------------------
 * CONFIRMING THAT A SITE IS FREE, WHICH THIS DATASET CANNOT DO ALONE
 * ---------------------------------------------------------------------------
 *
 * Answered from production rather than guessed: `FTEN_RECREATION_POLY_SVW`
 * carries no fee, cost, charge, operator or maintenance attribute. Every field
 * name was read and none of them is about money. It is a tenure layer; it
 * describes the land reservation, not what happens when you arrive.
 *
 * The province says most recreation sites are free and a minority charge ten
 * to fifteen dollars. "Most" is not something this app will write onto a pin
 * that says free — so the rule is POSITIVE CONFIRMATION ONLY. A site is
 * ingested when OpenStreetMap independently tags a campsite at that spot as
 * `fee=no`, and otherwise it is left out entirely.
 *
 * That is deliberately lossy. It will drop genuinely free sites nobody has got
 * round to tagging, and this route reports how many it dropped so the size of
 * that silence is visible rather than assumed. Being short of a few good
 * campgrounds costs a camper one search; being wrong about a fee costs them a
 * drive down a forest road and fifteen dollars they did not plan for.
 */

/** Overpass mirrors, in the order beaconSources.ts settled on. */
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/**
 * How close an OpenStreetMap campsite has to be to count as the same place.
 *
 * A recreation site polygon is a few hundred metres across — Tamihi Creek is
 * 17 hectares, about 460 m corner to corner — so an OSM node placed anywhere
 * inside it can sit a couple of hundred metres from the bounding-box centre.
 * 600 m accepts that without reaching into the next drainage; RSTBC sites are
 * rarely closer together than a kilometre.
 */
const MATCH_RADIUS_M = 600;

const EARTH_M = 6_371_000;
const toRad = (d: number): number => (d * Math.PI) / 180;
const metresBetween = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

interface FreeCampsite {
  lat: number;
  lon: number;
  name?: string;
}

/** Campsites OpenStreetMap says cost nothing, inside one bounding box. */
const fetchFreeCampsites = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  timeoutMs: number
): Promise<{ ok: boolean; sites: FreeCampsite[]; note?: string }> => {
  const box = `${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},` +
              `${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
  /*
   * EXACT `fee=no`, NOT A REGEX — measured, not preferred.
   *
   * This started as a case-insensitive alternation over no|free|none|0, to be
   * generous about how people spell "nothing to pay". Over a province-sized
   * box that is the difference between an answer and a timeout: an exact tag
   * match is served from Overpass's index, a regex makes it scan. The first
   * run of this died at exactly that, twenty seconds in.
   *
   * The loss is small and the trade is good. `fee=no` is overwhelmingly the
   * documented spelling; the alternatives are rare enough that chasing them
   * costs more sites (through failing entirely) than it wins.
   *
   * An ABSENT `fee` tag is still not a match, which is the whole point: it
   * means nobody said, and that is the case this route exists to exclude.
   */
  const query =
    `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000))}];` +
    `nwr["tourism"="camp_site"]["fee"="no"](${box});` +
    `out center;`;

  /*
   * EACH MIRROR GETS ITS OWN CLOCK.
   *
   * One shared controller meant the first mirror to hang burnt the entire
   * budget and aborted the other two before they were asked — the same
   * "fallback you cannot afford to call" that beaconSources.ts already had to
   * unlearn once. The overall deadline still stands; it is just no longer
   * spendable by whoever goes first.
   */
  const startedAll = Date.now();
  const perMirrorMs = Math.max(6_000, Math.floor(timeoutMs / 2));
  /*
   * What each mirror said. The lesson is already written down at
   * `fetchOverpassScan` in beaconSources.ts: a refusal, a rate limit, a
   * timeout and a rejected query all read as "no mirror answered", and
   * without this line the only way to tell them apart is to guess. The first
   * run of this route did exactly that and cost a deploy.
   */
  const tried: string[] = [];

  try {
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
        if (!r.ok) {
          const why = await r.text().catch(() => '');
          tried.push(
            `${host}: HTTP ${r.status}${why ? ` ${why.slice(0, 120).replace(/\s+/g, ' ').trim()}` : ''}`
          );
          continue;
        }
        const data = (await r.json()) as {
          elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number };
                       tags?: Record<string, string> }[];
          remark?: string;
        };
        if (!Array.isArray(data.elements)) {
          tried.push(`${host}: answered without an element list`);
          continue;
        }
        // A 200 that is really a failure — see overpassFailureRemark in
        // beaconSources.ts. An empty list with a runtime error in it is NOT
        // "no free campsites here", and must never be read as one.
        if (data.elements.length === 0 && /error|timed out|timeout/i.test(data.remark ?? '')) {
          tried.push(`${host}: 200 but failed — ${String(data.remark).slice(0, 120)}`);
          continue;
        }
        const sites: FreeCampsite[] = [];
        for (const el of data.elements) {
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          if (typeof lat !== 'number' || typeof lon !== 'number') continue;
          sites.push({ lat, lon, name: el.tags?.name });
        }
        console.info(
          `[rec-sites] Overpass answered — ${host}: ${sites.length} free campsites ` +
          `in ${Date.now() - at} ms`
        );
        return { ok: true, sites };
      } catch (err: any) {
        tried.push(
          `${host}: ${controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 120)}` +
          ` after ${Date.now() - at} ms`
        );
        // Deliberately NOT a break. This mirror is out of time; the next one
        // still has its own, which is the entire point of the change above.
      } finally {
        clearTimeout(timer);
      }
    }
    console.warn(`[rec-sites] every Overpass mirror refused — ${tried.join(' | ')}`);
    return { ok: false, sites: [], note: `No Overpass mirror answered — ${tried.join('; ')}` };
  } finally {
    // Nothing shared left to clear.
  }
};

/**
 * Every free-tagged campsite in British Columbia, fetched once.
 *
 * The first version asked Overpass for the bounding box of each PAGE of
 * recreation sites. Pages are sorted by `FOREST_FILE_ID`, which is an
 * administrative number and not a place, so every page was scattered across
 * the province and every box was therefore province-sized anyway — the same
 * enormous query, run once per page, five times over.
 *
 * So it is asked once, for the province, and held. Campsites are sparse
 * enough that the whole answer is small, and every page after the first
 * matches against memory for nothing.
 */
const BC_BBOX = { minLat: 48.2, minLon: -139.1, maxLat: 60.1, maxLon: -114.0 };
const BC_FREE_TTL_MS = 30 * 60 * 1000;
let bcFreeCache: { at: number; result: { ok: boolean; sites: FreeCampsite[]; note?: string } } | null = null;

const freeCampsitesInBC = async (
  timeoutMs: number
): Promise<{ ok: boolean; sites: FreeCampsite[]; note?: string }> => {
  if (bcFreeCache && Date.now() - bcFreeCache.at < BC_FREE_TTL_MS && bcFreeCache.result.ok) {
    return bcFreeCache.result;
  }
  const result = await fetchFreeCampsites(BC_BBOX, timeoutMs);
  // Only a good answer is held. Caching a failure would turn one bad minute
  // into half an hour of "nothing here is free".
  if (result.ok) bcFreeCache = { at: Date.now(), result };
  return result;
};

/**
 * ---------------------------------------------------------------------------
 * URBAN, SUBURBAN OR WILDERNESS — DERIVED, AND HONEST ABOUT BEING DERIVED
 * ---------------------------------------------------------------------------
 *
 * Worked out from distance to the nearest mapped settlement, weighted by how
 * big that settlement is. Two kilometres from Vancouver is a city; two
 * kilometres from a hamlet of forty people is trees. A single radius cannot
 * express that, so each `place` kind carries its own pair of rings.
 *
 * This is the same signal Beacon already uses to judge the risk of a knock —
 * proximity to people, weighted by kind — and reusing the idea keeps the two
 * halves of the app saying the same thing about the same ground.
 *
 * IT IS A GUESS AND THE COLUMN SAYS SO. `setting_is_derived` is stored true
 * for everything here, so a camper who has actually stood there can overwrite
 * it and the deriver will never overwrite them back.
 */
type Setting = 'urban' | 'suburban' | 'wilderness';

interface Settlement { lat: number; lon: number; kind: string }

/** Metres: inside the first is urban, inside the second is suburban. */
const SETTLEMENT_RINGS: Record<string, [number, number]> = {
  city: [5000, 20000],
  town: [2500, 10000],
  village: [1200, 5000]
};

/**
 * A UNION OF EXACT MATCHES, NOT A REGEX — and this is the second time.
 *
 * The first version asked for `place~"^(city|town|village|hamlet|suburb|
 * neighbourhood)$"` over the whole province and never came back: thirty
 * seconds, no answer, the function killed. Exactly what the `fee=no` query did
 * a few hours earlier, for exactly the same reason — a regex makes Overpass
 * scan where an exact tag match is served from its index.
 *
 * Written out as four separate exact clauses instead. `suburb` and
 * `neighbourhood` are dropped: they only ever sit inside a city or town that
 * is already in the list, so they cost volume and change no answer.
 */
const settlementsQuery = (box: string, timeoutS: number): string =>
  `[out:json][timeout:${timeoutS}];` +
  '(' +
  `node["place"="city"](${box});` +
  `node["place"="town"](${box});` +
  `node["place"="village"](${box});` +
  // `);out;` — the semicolon after the group is required. Without it Overpass
  // answers HTTP 400, which is what the per-mirror log caught.
  ');out;';

/**
 * Settlements inside one bounding box, with a clock on each mirror.
 *
 * TWO THINGS WENT WRONG BEFORE THIS SHAPE.
 *
 * It asked for the whole province, which is a lot of nodes to move for a
 * question about four hundred campgrounds. And it gave each of three mirrors a
 * twenty second timeout, so a single slow mirror spent the entire thirty
 * second budget before the second was even asked — the same "fallback you
 * cannot afford to call" already fixed once in this file, rebuilt from
 * scratch a hundred lines below it.
 *
 * Now the caller passes the box its own batch occupies, and each mirror gets
 * a share of the budget rather than all of it. Every attempt is logged: a
 * refusal, a rate limit and a timeout are three different faults and reading
 * "no settlement data" tells you which one none of the time.
 */
const fetchSettlements = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  totalMs: number
): Promise<Settlement[] | null> => {
  const box = `${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)},` +
              `${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}`;
  const startedAll = Date.now();
  /*
   * TWELVE SECONDS EACH, NOT A THIRD OF THE BUDGET EACH.
   *
   * Splitting the budget evenly across three mirrors gave every one of them
   * 6.6 seconds, and all three timed out at exactly that — the query needs
   * longer than that to run, so dividing fairly meant starving all of them
   * equally. Two real attempts beat three impossible ones, and the loop's
   * "not enough left to be worth asking" guard turns the third into an
   * honest skip rather than a doomed request.
   */
  const perMirrorMs = 12_000;
  const tried: string[] = [];

  for (const mirror of OVERPASS_MIRRORS) {
    const left = totalMs - (Date.now() - startedAll);
    if (left < 4_000) {
      tried.push(`${new URL(mirror).host}: not asked, ${left} ms left`);
      break;
    }
    const host = new URL(mirror).host;
    const at = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(perMirrorMs, left));
    try {
      const query = settlementsQuery(box, Math.max(5, Math.round(Math.min(perMirrorMs, left) / 1000)));
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
        elements?: { lat?: number; lon?: number; tags?: Record<string, string> }[];
        remark?: string;
      };
      if (!Array.isArray(data.elements)) {
        tried.push(`${host}: no element list`);
        continue;
      }
      if (data.elements.length === 0 && /error|timed out|timeout/i.test(data.remark ?? '')) {
        tried.push(`${host}: 200 but failed — ${String(data.remark).slice(0, 100)}`);
        continue;
      }

      const list: Settlement[] = [];
      for (const el of data.elements) {
        if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
        const kind = el.tags?.place ?? '';
        if (!SETTLEMENT_RINGS[kind]) continue;
        list.push({ lat: el.lat, lon: el.lon, kind });
      }
      console.info(`[rec-sites] ${host}: ${list.length} settlements in ${Date.now() - at} ms`);
      return list;
    } catch (err: any) {
      tried.push(
        `${host}: ${controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 100)}` +
        ` after ${Date.now() - at} ms`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * NULL, NOT AN EMPTY LIST. Failing to reach Overpass tells us nothing about
   * where these campgrounds are, and an empty list would derive "wilderness"
   * for every one of them off the back of an outage.
   */
  console.warn(`[rec-sites] no settlement data — ${tried.join(' | ')}`);
  return null;
};

const deriveSetting = (lat: number, lon: number, settlements: Settlement[]): Setting => {
  let best: Setting = 'wilderness';
  for (const s of settlements) {
    const rings = SETTLEMENT_RINGS[s.kind];
    if (!rings) continue;
    const metres = metresBetween(lat, lon, s.lat, s.lon);
    // The strongest classification any settlement produces wins: being far
    // from a hamlet does not make you rural if you are also inside a city.
    if (metres <= rings[0]) return 'urban';
    if (metres <= rings[1]) best = 'suburban';
  }
  return best;
};

export const registerRecSiteRoutes = (app: Express): void => {
  app.get('/api/rec-sites', async (req: Request, res: Response) => {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(String(req.query.limit ?? String(DEFAULT_LIMIT)), 10) || DEFAULT_LIMIT)
    );

    const key = `${offset}:${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.body);

    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: TYPE_NAME,
      outputFormat: 'application/json',
      srsName: CRS84,
      count: String(limit),
      startIndex: String(offset),
      /*
       * A stable sort is what makes paging trustworthy. Without one a WFS may
       * return rows in whatever order the query planner produced, so page two
       * can repeat or skip rows from page one — see bcgov/bcdata issue 76.
       */
      sortBy: 'FOREST_FILE_ID'
    });

    const url = `${DATABC_OWS}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal
      });

      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        console.warn(
          `[rec-sites] DataBC HTTP ${upstream.status} — ${body.slice(0, 200).replace(/\s+/g, ' ')}`
        );
        return res.status(502).json({
          ok: false,
          records: [],
          note: `DataBC answered HTTP ${upstream.status}.`
        });
      }

      const text = await upstream.text();
      if (text.length > MAX_BYTES) {
        return res.status(502).json({
          ok: false,
          records: [],
          note: `That page was ${(text.length / 1e6).toFixed(1)}MB — ask for fewer.`
        });
      }

      const data = JSON.parse(text) as {
        features?: { geometry?: unknown; properties?: Record<string, unknown> }[];
        totalFeatures?: number;
        numberMatched?: number;
      };

      const features = Array.isArray(data.features) ? data.features : [];
      const records: RecRecord[] = [];
      for (const f of features) {
        const point = representativePoint(f.geometry);
        if (!point) continue;
        records.push({ ...point, props: f.properties ?? {} });
      }

      /*
       * The attribute names, once per page, because they are the entire reason
       * this route exists yet: whether RSTBC publishes anything that says a
       * site is free. Printed as well as returned so it survives in the logs.
       */
      const fields = Object.keys(features[0]?.properties ?? {}).sort();
      console.info(
        `[rec-sites] ${records.length} of ${data.numberMatched ?? '?'} from offset ${offset} ` +
        `in ${Date.now() - startedAt} ms — fields: ${fields.join(', ')}`
      );

      const body = {
        ok: true,
        offset,
        limit,
        returned: records.length,
        total: data.numberMatched ?? data.totalFeatures ?? null,
        fields,
        attribution: ATTRIBUTION,
        licence: LICENCE,
        /**
         * FREE IS NOT ASSUMED ANYWHERE, and this rides with every page so it
         * cannot be lost between here and whatever consumes it.
         */
        caution:
          'RSTBC sites are mostly user-maintained and free, but a minority are ' +
          'fee sites operated under agreement. Nothing in this response asserts ' +
          'that any site is free — check the attributes before treating one as such.',
        records
      };

      cache.set(key, { at: Date.now(), body });
      return res.json(body);
    } catch (err: any) {
      const why = controller.signal.aborted ? 'timed out' : String(err?.message ?? err);
      console.warn(`[rec-sites] failed after ${Date.now() - startedAt} ms — ${why}`);
      return res.status(502).json({ ok: false, records: [], note: `Could not reach DataBC (${why}).` });
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * The campgrounds an independent source confirms cost nothing.
   *
   *   GET /api/rec-sites/free?offset=0&limit=200
   *
   * Read-only, like its sibling. It fetches one page of ACTIVE recreation
   * sites that actually have campsites, asks OpenStreetMap which campsites in
   * that same box are tagged `fee=no`, and returns only the ones that match.
   * Everything else is reported as a count, never as a record, so the size of
   * what we are choosing not to claim stays visible.
   */
  app.get('/api/rec-sites/free', async (req: Request, res: Response) => {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200)
    );

    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: TYPE_NAME,
      outputFormat: 'application/json',
      srsName: CRS84,
      count: String(limit),
      startIndex: String(offset),
      sortBy: 'FOREST_FILE_ID',
      /*
       * Filtered at the server, not here. Roughly a quarter of this layer is
       * RETIRED and four fifths of it has no campsites at all — it is trails
       * and reserves — so asking for everything and discarding it would spend
       * the whole budget moving geometry we are going to throw away.
       */
      cql_filter: "LIFE_CYCLE_STATUS_CODE='ACTIVE' AND DEFINED_CAMPSITES>0"
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const upstream = await fetch(`${DATABC_OWS}?${params.toString()}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal
      });
      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        console.warn(`[rec-sites/free] DataBC HTTP ${upstream.status} — ${body.slice(0, 200)}`);
        return res.status(502).json({ ok: false, sites: [], note: `DataBC answered ${upstream.status}.` });
      }

      const data = JSON.parse(await upstream.text()) as {
        features?: { geometry?: unknown; properties?: Record<string, unknown> }[];
        numberMatched?: number;
      };
      const features = Array.isArray(data.features) ? data.features : [];

      const candidates = features
        .map((f) => ({ point: representativePoint(f.geometry), props: f.properties ?? {} }))
        .filter((c): c is { point: { lat: number; lon: number }; props: Record<string, unknown> } =>
          c.point !== null);

      if (candidates.length === 0) {
        return res.json({
          ok: true, offset, limit, considered: 0, confirmedFree: 0,
          unconfirmed: 0, total: data.numberMatched ?? null, sites: []
        });
      }

      // One province-wide lookup, held between pages. See `freeCampsitesInBC`
      // for why per-page boxes were the wrong shape.
      const free = await freeCampsitesInBC(20_000);
      if (!free.ok) {
        /*
         * Overpass being down is NOT "none of these are free". Refusing to
         * answer is the only honest response — a zero here, stored, would
         * quietly become "we checked and found nothing".
         */
        return res.status(502).json({
          ok: false, sites: [],
          note: free.note ?? 'Could not reach OpenStreetMap, so nothing could be confirmed free.'
        });
      }

      /**
       * MUTUAL NEAREST, NOT MERELY NEAR.
       *
       * Recreation sites cluster. Around Campbell River this layer holds Pye
       * Lake, Pye Bay and Pye Beach within a couple of kilometres of each
       * other, and Stella Lake North, Stella Beach and Stella Bay likewise.
       * A single OpenStreetMap campsite tagged `fee=no` sitting between them
       * would, on a plain radius test, "confirm" all three — one person's tag
       * silently vouching for two campgrounds nobody has said anything about.
       *
       * So a match counts only when each is the other's nearest: the OSM site
       * must be the closest one to this recreation site AND this recreation
       * site must be the closest one to it. A cluster then takes the pairing
       * it actually earned and the neighbours stay unconfirmed, which is the
       * honest outcome.
       */
      const nearestRecTo = (s: FreeCampsite) => {
        let best: { index: number; metres: number } | null = null;
        candidates.forEach((c, index) => {
          const metres = metresBetween(c.point.lat, c.point.lon, s.lat, s.lon);
          if (!best || metres < best.metres) best = { index, metres };
        });
        return best as { index: number; metres: number } | null;
      };

      const sites = [];
      for (const [index, c] of candidates.entries()) {
        let nearest: { site: FreeCampsite; metres: number } | null = null;
        for (const s of free.sites) {
          const metres = metresBetween(c.point.lat, c.point.lon, s.lat, s.lon);
          if (metres <= MATCH_RADIUS_M && (!nearest || metres < nearest.metres)) {
            nearest = { site: s, metres };
          }
        }
        if (!nearest) continue;
        // The other half of the pairing. A tie on distance keeps the match.
        const back = nearestRecTo(nearest.site);
        if (!back || back.index !== index) continue;

        sites.push({
          fileId: String(c.props.FOREST_FILE_ID ?? ''),
          name: String(c.props.PROJECT_NAME ?? '').trim(),
          lat: Number(c.point.lat.toFixed(6)),
          lon: Number(c.point.lon.toFixed(6)),
          campsites: Number(c.props.DEFINED_CAMPSITES ?? 0),
          district: String(c.props.GEOGRAPHIC_DISTRICT_NAME ?? ''),
          nearestTown: String(c.props.SITE_LOCATION ?? '').trim(),
          // Kept so the match can be audited rather than trusted.
          osmName: nearest.site.name ?? null,
          matchMetres: Math.round(nearest.metres)
        });
      }

      /*
       * ---- Stored on read, like every other government layer here. ----
       *
       * Idempotent on a namespaced id, so re-running a page corrects drift
       * rather than duplicating. Only the columns this source can actually
       * speak for are written: name, place, land type, fee and the
       * description. Ratings, reviews and anything a camper contributes are
       * NOT in the payload, so an upsert leaves them untouched — a re-run
       * must never reset what people have added.
       */
      let stored = 0;
      const writer = getWriteClient();
      if (writer && sites.length > 0) {
        const rows = sites.map((s) => ({
          id: `rstbc-${s.fileId}`,
          name: tidyName(s.name) || 'Recreation site',
          land_type: 'crown_land',
          land_manager: 'Recreation Sites and Trails BC',
          latitude: s.lat,
          longitude: s.lon,
          nearest_city: tidyName(s.nearestTown),
          state_province: 'British Columbia',
          country: 'Canada',
          description: describeSite(s.campsites),
          is_free: true,
          // BC's standard limit at a recreation site. Published policy, not
          // a per-site fact — a site with its own posted limit overrides it.
          stay_limit_days: 14,
          permit_required: false,
          source: 'agency_dataset',
          updated_at: new Date().toISOString()
        }));

        const { error } = await writer.from('campsites').upsert(rows, { onConflict: 'id' });
        if (error) {
          console.warn(`[rec-sites/free] store failed: ${error.message}`);
        } else {
          stored = rows.length;
        }

      }

      console.info(
        `[rec-sites/free] offset ${offset}: ${candidates.length} campgrounds considered, ` +
        `${sites.length} confirmed free by OSM, ${candidates.length - sites.length} unconfirmed, ` +
        `${stored} stored (${Date.now() - startedAt} ms)`
      );

      /*
       * `compact=1` drops to positional arrays. Same data, roughly half the
       * bytes, which is what makes paging the whole province practical.
       * Order: fileId, name, lat, lon, campsites, nearest town.
       */
      const compact = String(req.query.compact ?? '') === '1';
      /*
       * `brief=1` returns the counts and drops the list entirely. Running the
       * ingest across the province is five calls, and the operator doing it
       * wants to know how many landed, not to read a thousand campgrounds
       * back. The rows are in the database; that is where to look at them.
       */
      const brief = String(req.query.brief ?? '') === '1';

      return res.json({
        ok: true,
        offset,
        limit,
        total: data.numberMatched ?? null,
        considered: candidates.length,
        confirmedFree: sites.length,
        stored,
        /** Not "these charge" — "nobody has told us either way". */
        unconfirmed: candidates.length - sites.length,
        attribution: `${ATTRIBUTION}; fee status from OpenStreetMap contributors (ODbL)`,
        licence: LICENCE,
        sites: brief
          ? undefined
          : compact
          ? sites.map((s) => [s.fileId, s.name, s.lat, s.lon, s.campsites, s.nearestTown])
          : sites
      });
    } catch (err: any) {
      const why = controller.signal.aborted ? 'timed out' : String(err?.message ?? err);
      console.warn(`[rec-sites/free] failed after ${Date.now() - startedAt} ms — ${why}`);
      return res.status(502).json({ ok: false, sites: [], note: `Cross-check failed (${why}).` });
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * Classify stored campgrounds as urban, suburban or wilderness.
   *
   *   GET /api/rec-sites/settings?limit=400
   *
   * ITS OWN PASS, and that is not tidiness. Folding this into the free
   * cross-check meant two province-wide Overpass queries in one request — the
   * campsites tagged `fee=no` and every mapped settlement in British Columbia
   * — on top of a DataBC fetch and the writes. It timed out at the thirty
   * second ceiling, which is the same wall this file has hit twice before.
   * Separate jobs, separate requests, each comfortably inside the budget.
   *
   * Reads from the DATABASE rather than from DataBC: by the time this runs the
   * campgrounds are already stored, and re-fetching a government layer to
   * learn coordinates we already hold would be work for nothing.
   */
  app.get('/api/rec-sites/settings', async (req: Request, res: Response) => {
    // A thinner latitude band is a cheaper Overpass query. See `fetchSettlements`.
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '150'), 10) || 150));
    const writer = getWriteClient();
    if (!writer) {
      return res.status(503).json({ ok: false, note: 'No service key — cannot write settings.' });
    }

    const startedAt = Date.now();

    /**
     * AN EXPLICIT CELL BEATS A CLEVER BATCH.
     *
     * Sorting by latitude made each batch a band — but a band across British
     * Columbia is still nineteen degrees of longitude, and Overpass timed out
     * on it at six seconds and again at twelve. The area was always the
     * problem and no ordering of the rows fixes that.
     *
     * So the caller may name the box. Small cells are queries Overpass answers
     * in a second, and the work becomes a loop of reliable requests instead of
     * one unreliable request. Without a cell it still falls back to the band,
     * which is fine where the remaining rows are few.
     */
    const cell = ['minLat', 'minLon', 'maxLat', 'maxLon']
      .map((k) => parseFloat(String(req.query[k] ?? '')));
    const hasCell = cell.every((n) => Number.isFinite(n));

    /*
     * Ordered by latitude so a batch is a BAND rather than a scatter.
     *
     * The settlement lookup is bounded by whatever box the batch occupies, and
     * an arbitrary four hundred rows out of a province-wide table would put
     * that box back around the whole province. Sorting first makes each batch
     * a few degrees tall, which is a query Overpass answers quickly.
     */
    const { data, error } = await writer
      .from('campsites')
      .select('id, latitude, longitude')
      .eq('source', 'agency_dataset')
      .is('setting', null)
      .eq('setting_is_derived', true)
      .gte('latitude', hasCell ? cell[0] : -90)
      .gte('longitude', hasCell ? cell[1] : -180)
      .lte('latitude', hasCell ? cell[2] : 90)
      .lte('longitude', hasCell ? cell[3] : 180)
      .order('latitude', { ascending: true })
      .limit(limit);

    if (error) {
      return res.status(502).json({ ok: false, note: `Could not read campsites: ${error.message}` });
    }
    const rows = (data ?? []) as { id: string; latitude: number; longitude: number }[];
    if (rows.length === 0) {
      return res.json({ ok: true, remaining: 0, classified: 0, note: 'Nothing left to classify.' });
    }

    /*
     * Padded by the widest ring any settlement projects (20 km for a city), so
     * a campground near the edge of the band still sees the town just outside
     * it. Without the pad, a site at the boundary would be judged rural purely
     * because the batch stopped there.
     */
    const pad = 20_000 / 111_000;
    const lats = rows.map((r) => r.latitude);
    const lons = rows.map((r) => r.longitude);
    const settlements = await fetchSettlements({
      minLat: Math.min(...lats) - pad,
      maxLat: Math.max(...lats) + pad,
      minLon: Math.min(...lons) - pad,
      maxLon: Math.max(...lons) + pad
    }, 24_000);
    if (!settlements) {
      /*
       * Refusing beats guessing. An unreachable Overpass says nothing about
       * where these campgrounds are, and writing "wilderness" for all of them
       * off the back of an outage would be a confident answer nobody earned.
       */
      return res.status(502).json({
        ok: false,
        note: 'Could not reach OpenStreetMap for settlements, so nothing was classified.'
      });
    }

    const byValue = new Map<Setting, string[]>();
    for (const row of rows) {
      const value = deriveSetting(row.latitude, row.longitude, settlements);
      const ids = byValue.get(value) ?? [];
      ids.push(row.id);
      byValue.set(value, ids);
    }

    let classified = 0;
    for (const [value, ids] of byValue) {
      // `setting_is_derived` in the filter is what makes a camper's own answer
      // permanent: this pass can only ever touch rows it owns.
      const { error: updateError } = await writer
        .from('campsites')
        .update({ setting: value, setting_is_derived: true })
        .in('id', ids)
        .eq('setting_is_derived', true);
      if (updateError) {
        console.warn(`[rec-sites/settings] ${value} failed: ${updateError.message}`);
      } else {
        classified += ids.length;
      }
    }

    const summary = [...byValue].map(([v, ids]) => `${v}:${ids.length}`).join(' ');
    console.info(
      `[rec-sites/settings] ${classified} classified — ${summary} (${Date.now() - startedAt} ms)`
    );

    return res.json({
      ok: true,
      considered: rows.length,
      classified,
      breakdown: Object.fromEntries([...byValue].map(([v, ids]) => [v, ids.length])),
      settlementsKnown: settlements.length
    });
  });
};
