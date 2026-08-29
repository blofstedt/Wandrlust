import { GeocodedLocation } from '../types';

/**
 * Place lookup for the search box, via OUR server rather than Nominatim.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS STOPPED CALLING NOMINATIM DIRECTLY
 * ---------------------------------------------------------------------------
 *
 * It failed on the first real thing anybody typed: "brag creek".
 *
 * Nominatim matches tokens and has no typo tolerance at all, so one missing
 * "g" is not a near miss — it is zero results. And zero results reached the
 * camper as "either there is no place by that name, or the lookup could not
 * be reached", which is a sentence about a network problem shown for a
 * perfectly healthy service answering a question anybody would call a typo.
 *
 * `/api/geocode` asks Photon first, which is built for search-as-you-type and
 * matches fuzzily, and falls back to Nominatim. It also carries the
 * identifying User-Agent Nominatim's usage policy asks for, which a browser
 * cannot set, and shares one cache across every camper instead of one per tab.
 *
 * ---------------------------------------------------------------------------
 * `ok` IS THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * This used to return `[]` for BOTH "nothing matched" and "could not ask",
 * and the UI could only hedge between them. They are different facts and the
 * camper deserves the right one, so they come back as different answers.
 */

export interface GeocodeAnswer {
  results: GeocodedLocation[];
  /** False only when nobody could be reached. An empty list with `ok` is a real "no". */
  ok: boolean;
}

/**
 * Search results, capped.
 *
 * This used to grow without limit: every distinct query anyone typed stayed
 * in memory for the life of the tab, and this app is a PWA that people leave
 * open for days. A Map iterates in insertion order, so deleting the first
 * key evicts the oldest entry.
 *
 * Only successful answers are remembered. Caching a failure would keep an
 * outage on screen long after it had passed.
 */
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, GeocodedLocation[]>();

const remember = (key: string, value: GeocodedLocation[]): void => {
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

interface GeocodeRow {
  displayName?: string;
  city?: string;
  stateProvince?: string;
  country?: string;
  lat?: number;
  lon?: number;
  boundingBox?: [number, number, number, number];
}

const toLocation = (row: GeocodeRow): GeocodedLocation[] => {
  if (typeof row?.lat !== 'number' || typeof row?.lon !== 'number') return [];
  const location: GeocodedLocation = {
    displayName: row.displayName ?? '',
    city: row.city ?? '',
    stateProvince: row.stateProvince ?? '',
    country: row.country ?? '',
    lat: row.lat,
    lon: row.lon
  };
  if (Array.isArray(row.boundingBox) && row.boundingBox.length === 4) {
    location.boundingBox = row.boundingBox;
  }
  return [location];
};

/**
 * NEVER THROWS. A failure comes back as `{ ok: false }`, not as an empty list
 * — the house rule for `src/services`, and the whole reason this signature
 * changed.
 */
export const geocodeSearch = async (
  query: string,
  limit = 6
): Promise<GeocodeAnswer> => {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { results: [], ok: true };

  const cacheKey = `${trimmed.toLowerCase()}::${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return { results: cached, ok: true };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `/api/geocode?q=${encodeURIComponent(trimmed)}&limit=${limit}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!response.ok) return { results: [], ok: false };

    const data = (await response.json().catch(() => null)) as
      { ok?: boolean; results?: GeocodeRow[] } | null;
    if (!data || data.ok === false || !Array.isArray(data.results)) {
      return { results: [], ok: false };
    }

    const results = data.results.flatMap(toLocation);
    remember(cacheKey, results);
    return { results, ok: true };
  } catch {
    // Network failure, abort, or offline. Not an answer about the world.
    return { results: [], ok: false };
  }
};
