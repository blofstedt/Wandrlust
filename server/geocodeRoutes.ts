/**
 * Place lookup for the search box.
 *
 *   GET /api/geocode?q=bragg%20creek&limit=6
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT NOMINATIM CALLED FROM THE BROWSER ANY MORE
 * ---------------------------------------------------------------------------
 *
 * It was, and it failed on the first real thing anybody typed: "brag creek".
 *
 * Nominatim matches tokens. It has NO typo tolerance whatsoever, so one
 * missing "g" is not a near miss, it is zero results — and zero results is
 * exactly what "could not reach the search" looks like from the client. The
 * camper is told the lookup might be down while the service is up and
 * answering correctly, for a question nobody would call a typo out loud.
 *
 * PHOTON IS FIRST NOW, and it is the right tool for a search box: it is built
 * for search-as-you-type over the same OpenStreetMap data, and it matches
 * fuzzily, so "brag creek" finds Bragg Creek. Nominatim stays as the fallback,
 * because it is better at fully-qualified addresses and postcodes, which is
 * where Photon's fuzziness starts guessing.
 *
 * Going through our own server also fixes the thing that was quietly wrong
 * before. Nominatim's usage policy wants an identifying User-Agent and a
 * single point of contact, not one request per camper's browser straight off
 * the public endpoint — a browser cannot even set User-Agent. One server, one
 * agent string, one shared cache.
 *
 * ---------------------------------------------------------------------------
 * "NOTHING FOUND" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS
 * ---------------------------------------------------------------------------
 *
 * This route never returns an empty list to mean a failure. `ok` says whether
 * anybody was actually reached; the client draws two different sentences from
 * it, because telling a camper there is no such place when the truth is that
 * the search is down is the app inventing a fact out of a network error.
 */
import type { Express, Request, Response } from 'express';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';

/** What the client needs to move the map and label the place. */
export interface GeocodeHit {
  displayName: string;
  city: string;
  stateProvince: string;
  country: string;
  lat: number;
  lon: number;
  /** [south, north, west, east], where the source gave one. */
  boundingBox?: [number, number, number, number];
}

/**
 * The lower 48 and Canada, as a rectangle.
 *
 * Deliberately the same numbers as `COVERAGE_BBOX` in `config/coverage.ts`.
 * Searching somewhere the app greys out and refuses to query is a result that
 * can only disappoint, so it is dropped here rather than drawn.
 */
const COVERAGE = { minLat: 24.4, minLon: -139.1, maxLat: 60.1, maxLon: -52.0 };

const inCoverage = (lat: number, lon: number): boolean =>
  lat >= COVERAGE.minLat && lat <= COVERAGE.maxLat &&
  lon >= COVERAGE.minLon && lon <= COVERAGE.maxLon;

/**
 * Answers held for an hour, keyed on the query.
 *
 * Where a town is does not change in an hour, and a search box fires a
 * request every time somebody pauses typing — the same handful of queries
 * over and over across every camper using the app.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; hits: GeocodeHit[] }>();

const cached = (key: string): GeocodeHit[] | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.hits;
};

const remember = (key: string, hits: GeocodeHit[]): void => {
  cache.set(key, { at: Date.now(), hits });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

const fetchJson = async (url: string, timeoutMs: number): Promise<any | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!r.ok) {
      console.warn(`[geocode] ${new URL(url).host} answered HTTP ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (err: any) {
    console.warn(
      `[geocode] ${new URL(url).host} — ` +
      `${controller.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 120)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Photon — fuzzy, built for autocomplete.
 *
 * Returns GeoJSON. `properties.name` is the place itself and the rest of the
 * label is assembled from the administrative fields, because Photon has no
 * single display string of its own.
 */
const searchPhoton = async (
  q: string,
  limit: number,
  near: { lat: number; lon: number } | null
): Promise<GeocodeHit[] | null> => {
  /*
   * BIASED TOWARDS WHERE THE MAP IS LOOKING, when the client says.
   *
   * Fuzzy matching cuts both ways: "brag creek" finds Bragg Creek, Alberta,
   * and it also finds Big Black Creek, Alabama, and without a hint it has no
   * reason to prefer one. On a map, it does have a reason — the camper is
   * looking at somewhere — so the centre of the view goes with the query and
   * near things sort first. Missing is fine: the search still works, it just
   * ranks by relevance alone.
   */
  const bias = near ? `&lat=${near.lat.toFixed(4)}&lon=${near.lon.toFixed(4)}` : '';
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}` +
              `&limit=${limit * 3}&lang=en${bias}`;
  const data = await fetchJson(url, 6_000);
  if (!data || !Array.isArray(data.features)) return null;

  const hits: GeocodeHit[] = [];
  for (const f of data.features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const p = f.properties ?? {};
    const code = String(p.countrycode ?? '').toUpperCase();
    if (code && code !== 'CA' && code !== 'US') continue;
    if (!inCoverage(lat, lon)) continue;

    const name = String(p.name ?? '').trim();
    if (!name) continue;
    const city = String(p.city ?? p.district ?? p.county ?? '').trim();
    const state = String(p.state ?? '').trim();
    const country = String(p.country ?? '').trim();

    // "Bragg Creek, Alberta, Canada" — the same shape Nominatim's
    // `display_name` has, so the client can keep splitting on the first comma.
    const label = [name, city && city !== name ? city : '', state, country]
      .filter(Boolean).join(', ');

    const hit: GeocodeHit = {
      displayName: label,
      city: city || name,
      stateProvince: state,
      country,
      lat,
      lon
    };

    // Photon's `extent` is [west, north, east, south] — NOT the order
    // Nominatim uses, and getting it wrong frames the map on empty ocean.
    if (Array.isArray(p.extent) && p.extent.length === 4) {
      const [west, north, east, south] = p.extent.map(Number);
      if ([west, north, east, south].every(Number.isFinite)) {
        hit.boundingBox = [south, north, west, east];
      }
    }

    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
};

/** Nominatim — exact, and better at a full street address. */
const searchNominatim = async (q: string, limit: number): Promise<GeocodeHit[] | null> => {
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(limit),
    countrycodes: 'ca,us'
  });
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    6_000
  );
  if (!Array.isArray(data)) return null;

  const hits: GeocodeHit[] = [];
  for (const item of data) {
    const lat = parseFloat(item?.lat);
    const lon = parseFloat(item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inCoverage(lat, lon)) continue;

    const addr = item.address ?? {};
    const hit: GeocodeHit = {
      displayName: String(item.display_name ?? ''),
      city: addr.city || addr.town || addr.village || addr.hamlet || addr.county || '',
      stateProvince: addr.state || addr.province || '',
      country: addr.country || '',
      lat,
      lon
    };
    if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
      const [south, north, west, east] = item.boundingbox.map(Number);
      if ([south, north, west, east].every(Number.isFinite)) {
        hit.boundingBox = [south, north, west, east];
      }
    }
    hits.push(hit);
  }
  return hits;
};

export const registerGeocodeRoutes = (app: Express): void => {
  app.get('/api/geocode', async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(10, Math.max(1, parseInt(String(req.query.limit ?? '6'), 10) || 6));

    if (q.length < 2) return res.json({ ok: true, results: [], source: 'none' });

    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const near = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;

    /*
     * The bias is part of the question, so it is part of the cache key — the
     * same words asked from Alberta and from Arizona are two different
     * searches. Rounded to a degree, though: an answer is not worth
     * re-fetching because the map drifted a kilometre, and a key that fine
     * would mean a cache that never hits.
     */
    const key = `${q.toLowerCase()}::${limit}::` +
      (near ? `${Math.round(near.lat)},${Math.round(near.lon)}` : 'anywhere');
    const hit = cached(key);
    if (hit) return res.json({ ok: true, results: hit, source: 'cache' });

    /*
     * Photon first for the typo tolerance, Nominatim second for the precision.
     * Nominatim is also asked when Photon answers with NOTHING — an empty
     * answer from a fuzzy matcher is a strong hint the query is unusual rather
     * than misspelled, and that is the kind of thing Nominatim is better at.
     */
    const photon = await searchPhoton(q, limit, near);
    if (photon && photon.length > 0) {
      remember(key, photon);
      return res.json({ ok: true, results: photon, source: 'photon' });
    }

    const nominatim = await searchNominatim(q, limit);
    if (nominatim) {
      remember(key, nominatim);
      return res.json({ ok: true, results: nominatim, source: 'nominatim' });
    }

    /*
     * Photon returned an empty list and Nominatim could not be reached at all.
     * That is NOT "no such place" — it is one source saying nothing and the
     * other saying nothing at all — so it is reported as a failure and the
     * client says the search could not be reached.
     */
    if (photon) {
      return res.json({
        ok: true,
        results: [],
        source: 'photon',
        note: 'Nothing matched, and the second lookup could not be reached to check.'
      });
    }

    return res.status(502).json({
      ok: false,
      results: [],
      note: 'Neither place lookup could be reached.'
    });
  });
};
