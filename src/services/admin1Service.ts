/**
 * First-order administrative boundaries (US states, Canadian provinces).
 *
 * Two clients of the same /api/admin1 endpoints, used in two places:
 *
 *   - Map layer (`showAdmin1` toggle): fetch all admin-1 polygons
 *     in the viewport, draw as outline-only. Light line, no fill —
 *     the boundaries are a context, not a highlight.
 *
 *   - Pin card ("United States — Montana"): ask the server which
 *     admin-1 a single point is in. The polygon hit-test is
 *     server-side because the dataset is 14 MB and the per-pin
 *     check is one HTTP call instead of 14 MB to the client.
 */
import type { BoundingBox } from '../config/coverage';

/** Slim shape from server/admin1Routes.ts Admin1Props. */
export interface Admin1 {
  id: string;
  country: 'United States' | 'Canada';
  countryCode: 'US' | 'CA';
  type: string;
  name: string;
  isoCode: string;
  abbrev: string;
}

export interface Admin1Feature {
  type: 'Feature';
  geometry: GeoJSON.Geometry;
  properties: Admin1;
}

export interface Admin1Collection {
  type: 'FeatureCollection';
  features: Admin1Feature[];
}

/* ------------------------------------------------------------------ */
/* Map layer: bbox fetch                                                */
/* ------------------------------------------------------------------ */

const memCache = new Map<string, { at: number; data: Admin1Collection }>();
/** 24h in-memory. The underlying data is from Natural Earth, which
 *  is a 5-year-stale snapshot of admin boundaries — 24h of
 *  staleness on top of that is rounding error. */
const MEM_TTL_MS = 24 * 60 * 60 * 1000;
const MEM_MAX_ENTRIES = 30;

const memGet = (key: string): Admin1Collection | null => {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEM_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return hit.data;
};

const memPut = (key: string, data: Admin1Collection): void => {
  if (memCache.size >= MEM_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, { at: Date.now(), data });
};

const bboxKey = (box: BoundingBox): string => [
  box.minLon.toFixed(2), box.minLat.toFixed(2),
  box.maxLon.toFixed(2), box.maxLat.toFixed(2)
].join(',');

/**
 * Fetch the admin-1 polygons in a viewport.
 *
 *   - Empty FeatureCollection on failure or out-of-coverage.
 *     The map layer degrades to "no lines drawn" silently.
 *   - Never throws.
 *   - The bbox is rounded to 2 decimals before being sent, so adjacent
 *     viewports share the same cache entry.
 */
export const fetchAdmin1 = async (
  box: BoundingBox,
  signal?: AbortSignal
): Promise<Admin1Collection> => {
  const key = bboxKey(box);
  const fromMem = memGet(key);
  if (fromMem) return fromMem;

  const params = new URLSearchParams({
    bbox: [
      box.minLon.toFixed(5), box.minLat.toFixed(5),
      box.maxLon.toFixed(5), box.maxLat.toFixed(5)
    ].join(',')
  });

  try {
    const res = await fetch(`/api/admin1?${params.toString()}`, { signal });
    if (!res.ok) return { type: 'FeatureCollection', features: [] };
    const data = await res.json() as Admin1Collection;
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      return { type: 'FeatureCollection', features: [] };
    }
    memPut(key, data);
    return data;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return { type: 'FeatureCollection', features: [] };
    }
    return { type: 'FeatureCollection', features: [] };
  }
};

/* ------------------------------------------------------------------ */
/* Pin card: single-point lookup                                        */
/* ------------------------------------------------------------------ */

const pointCache = new Map<string, { at: number; data: Admin1 | null }>();
/** 7 days. The server has the data, the result is a stable
 *  identifier, and a user opening the same pin twice in a week
 *  deserves the same answer. */
const POINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POINT_MAX_ENTRIES = 200;

const pointKey = (lat: number, lon: number): string =>
  `${lat.toFixed(3)},${lon.toFixed(3)}`;

/**
 * Find the admin-1 (state/province) that contains a single point.
 * Returns null if the point is in Mexico, mid-ocean, or anywhere
 * outside the US+CA dataset. Used by the per-pin card.
 *
 *   - 3-decimal precision in the cache key (~110 m). A user
 *     tapping 5 m away is asking the same question; a user
 *     tapping 200 m away might cross a state line and deserves
 *     a re-lookup.
 *   - Never throws.
 */
export const findAdmin1At = async (
  lat: number, lon: number,
  signal?: AbortSignal
): Promise<Admin1 | null> => {
  const key = pointKey(lat, lon);
  const hit = pointCache.get(key);
  if (hit && Date.now() - hit.at < POINT_TTL_MS) return hit.data;

  const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5) });
  try {
    const res = await fetch(`/api/admin1/at?${params.toString()}`, { signal });
    if (!res.ok) {
      pointCache.set(key, { at: Date.now(), data: null });
      return null;
    }
    const data = await res.json() as { hit: Admin1 | null };
    const value = data?.hit ?? null;
    if (pointCache.size >= POINT_MAX_ENTRIES) {
      const oldest = pointCache.keys().next().value;
      if (oldest) pointCache.delete(oldest);
    }
    pointCache.set(key, { at: Date.now(), data: value });
    return value;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return null;
    pointCache.set(key, { at: Date.now(), data: null });
    return null;
  }
};
