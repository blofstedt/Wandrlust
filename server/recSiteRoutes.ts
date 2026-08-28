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
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';

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
   * `fee` is free text in practice, so the common spellings of "nothing to pay"
   * are all accepted — but ONLY those. An absent `fee` tag is not a match: it
   * means nobody said, which is the case this whole route exists to exclude.
   */
  const query =
    `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000))}];` +
    `(node["tourism"="camp_site"]["fee"~"^(no|free|none|0)$",i](${box});` +
    `way["tourism"="camp_site"]["fee"~"^(no|free|none|0)$",i](${box}););` +
    `out center;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const host = new URL(mirror).host;
      const at = Date.now();
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
        if (controller.signal.aborted) break;
      }
    }
    console.warn(`[rec-sites] every Overpass mirror refused — ${tried.join(' | ')}`);
    return { ok: false, sites: [], note: `No Overpass mirror answered — ${tried.join('; ')}` };
  } finally {
    clearTimeout(timer);
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

      const sites = [];
      for (const c of candidates) {
        let nearest: { site: FreeCampsite; metres: number } | null = null;
        for (const s of free.sites) {
          const metres = metresBetween(c.point.lat, c.point.lon, s.lat, s.lon);
          if (metres <= MATCH_RADIUS_M && (!nearest || metres < nearest.metres)) {
            nearest = { site: s, metres };
          }
        }
        if (!nearest) continue;

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

      console.info(
        `[rec-sites/free] offset ${offset}: ${candidates.length} campgrounds considered, ` +
        `${sites.length} confirmed free by OSM, ${candidates.length - sites.length} unconfirmed ` +
        `(${Date.now() - startedAt} ms)`
      );

      return res.json({
        ok: true,
        offset,
        limit,
        total: data.numberMatched ?? null,
        considered: candidates.length,
        confirmedFree: sites.length,
        /** Not "these charge" — "nobody has told us either way". */
        unconfirmed: candidates.length - sites.length,
        attribution: `${ATTRIBUTION}; fee status from OpenStreetMap contributors (ODbL)`,
        licence: LICENCE,
        sites
      });
    } catch (err: any) {
      const why = controller.signal.aborted ? 'timed out' : String(err?.message ?? err);
      console.warn(`[rec-sites/free] failed after ${Date.now() - startedAt} ms — ${why}`);
      return res.status(502).json({ ok: false, sites: [], note: `Cross-check failed (${why}).` });
    } finally {
      clearTimeout(timer);
    }
  });
};
