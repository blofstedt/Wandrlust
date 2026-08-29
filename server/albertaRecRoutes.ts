/**
 * Alberta's own public-land layers.
 *
 *   GET /api/alberta-rec/probe    what the province actually publishes
 *
 * ---------------------------------------------------------------------------
 * WHY A PROBE ROUTE AND NOT JUST AN INGEST
 * ---------------------------------------------------------------------------
 *
 * The last two ingests in this repo were written against a guessed schema and
 * both had to be fixed in production — once for an invalid `land_type` that
 * silently rejected fifty good campgrounds, once for a field name nobody had
 * checked. The sandbox this is developed in cannot reach a government host, so
 * the only way to see a layer's real fields is to ask from somewhere that can.
 *
 * This route asks and reports. It stores nothing, writes nothing, and takes no
 * URL from the caller — the endpoints are fixed constants below, because a
 * route that fetches whatever it is handed is an open proxy sitting on our
 * domain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TWO LAYERS ARE, AND THE TRAP IN THE FIRST ONE
 * ---------------------------------------------------------------------------
 *
 * PUBLIC LAND RECREATION AREA is Alberta's nearest thing to the BC recreation
 * site layer that gives this app 832 of its pins. It is NOT a list of free
 * campgrounds and must never be ingested as one: Alberta operates plenty of
 * these with a nightly fee, and the province's own developed campgrounds are
 * exactly where the Public Lands Camping Pass does NOT apply. Whether a fee
 * field exists is the first thing this probe is for.
 *
 * PUBLIC LANDS CAMPING PASS BOUNDARY is the real extent of the pass area —
 * the thing `config/permits.ts` currently approximates with a rectangle and
 * says so. If it is small enough to simplify and commit, the hedge on every
 * Alberta permit match can become an answer.
 */
import type { Express, Request, Response } from 'express';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';

/** Fixed. The caller never supplies a URL — see the note above. */
const LAYERS = {
  recAreas:
    'https://geospatial.alberta.ca/mimas/rest/services/boundaries/' +
    'land_public_land_rec_area_public/FeatureServer/0',
  campingPass:
    'https://geospatial.alberta.ca/mimas/rest/services/boundaries/' +
    'land_public_land_camping_pass_public/FeatureServer/0'
} as const;

const ask = async (url: string, timeoutMs = 12_000): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const at = Date.now();
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!r.ok) return { ok: false, note: `HTTP ${r.status}`, ms: Date.now() - at };
    const body = await r.json();
    /*
     * ArcGIS answers a bad request with HTTP 200 and an `error` object. Read
     * as success that is an outage stored as an answer — the exact mistake
     * the OpenStreetMap sweep documents.
     */
    if (body?.error) {
      return { ok: false, note: `ArcGIS error ${body.error.code}: ${body.error.message}`, ms: Date.now() - at };
    }
    return { ok: true, body, ms: Date.now() - at };
  } catch (err: any) {
    return {
      ok: false,
      note: controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 160),
      ms: Date.now() - at
    };
  } finally {
    clearTimeout(timer);
  }
};

export const registerAlbertaRecRoutes = (app: Express): void => {
  app.get('/api/alberta-rec/probe', async (_req: Request, res: Response) => {
    const out: Record<string, unknown> = {};

    for (const [key, base] of Object.entries(LAYERS)) {
      const meta = await ask(`${base}?f=json`);
      if (!meta.ok) { out[key] = { reachable: false, ...meta }; continue; }

      const b = meta.body;
      const count = await ask(
        `${base}/query?where=1%3D1&returnCountOnly=true&f=json`
      );

      // One real feature, attributes only, so the field VALUES can be seen —
      // a field called `STATUS` says nothing until you know it holds "Open".
      const sample = await ask(
        `${base}/query?where=1%3D1&outFields=*&resultRecordCount=2` +
        `&returnGeometry=false&f=json`
      );

      out[key] = {
        reachable: true,
        ms: meta.ms,
        name: b?.name,
        geometryType: b?.geometryType,
        maxRecordCount: b?.maxRecordCount,
        supportsPagination: Boolean(b?.advancedQueryCapabilities?.supportsPagination),
        featureCount: count.ok ? count.body?.count : `unavailable (${count.note})`,
        fields: Array.isArray(b?.fields)
          ? b.fields.map((f: any) => `${f.name}:${f.type?.replace('esriFieldType', '')}`)
          : [],
        sample: sample.ok
          ? (sample.body?.features ?? []).map((f: any) => f.attributes)
          : `unavailable (${sample.note})`
      };
    }

    return res.json({ ok: true, layers: out });
  });
};
