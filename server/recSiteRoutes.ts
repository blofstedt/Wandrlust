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
};
