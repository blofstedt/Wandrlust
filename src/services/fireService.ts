/**
 * Active wildfire data for a viewport.
 *
 * The data comes from `/api/fires?bbox=...`, which merges the US WFIGS
 * perimeters feed and the Canadian FireRadar points feed into a single
 * GeoJSON response. This file is the client side of that: type
 * definitions, a thin fetcher with a small in-memory cache, and a
 * proximity helper used by the per-pin card.
 *
 * Two kinds of feature, one shape:
 *
 *   - `kind: 'perimeter'` — a polygon outline of the burn footprint.
 *     Renders as a red outline. Carries percent contained, discovery
 *     date, and the source agency. US only; the Canadian feed
 *     publishes points, not perimeters.
 *
 *   - `kind: 'point'` — a pin at the reported fire location.
 *     Renders as an orange dot. Carries the provincial status
 *     (e.g. "Being held") and reported size. Canada only.
 *
 * The card is colour-by-kind, not colour-by-country: a US perim is
 * the same red as a CA point would be, but they're never both rendered
 * for the same fire, so this matters only for picking the icon.
 */
import type { BoundingBox } from '../config/coverage';
import { distanceKm } from '../utils/geo';

/** A single wildfire feature, normalised across the two sources. */
export interface ActiveFire {
  /** Stable id — "wfigs:<OBJECTID>" for US, "fireradar:<incidentId>" for CA. */
  id: string;
  name: string;
  kind: 'perimeter' | 'point';
  country: 'US' | 'CA';
  /** Reported size in hectares; null if unknown. */
  sizeHa: number | null;
  /** Reported size in acres; null if unknown. */
  sizeAcres: number | null;
  /** 0-100, null if the source doesn't track it (Canadian feeds don't). */
  contained: number | null;
  /** Human-readable region: "US-CA / Lassen" or "BC". */
  region: string;
  /** ISO timestamp of discovery; null if unknown. */
  discovered: string | null;
  /** "Natural / lightning", "Human", etc. or null. */
  cause: string | null;
  /** "Being held", "Out of Control", "Under observation", etc. or null. */
  status: string | null;
  /** Centroid for proximity checks. */
  centroid: { lat: number; lon: number };
  /** The raw GeoJSON geometry. Polygon for perimeters, Point for points. */
  geometry: GeoJSON.Geometry;
}

interface FireResponseMeta {
  fetchedAt: string;
  errors: string[];
}

interface FireResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: GeoJSON.Geometry;
    properties: ActiveFire;
  }>;
  meta: FireResponseMeta;
}

/**
 * THE WIRE FORMAT IS NOT THE APP FORMAT. NORMALISE, DON'T ASSUME.
 *
 * `/api/fires` speaks GeoJSON, so its centroid is a `[lon, lat]` pair — the
 * order GeoJSON uses. `ActiveFire.centroid` is `{ lat, lon }`, because callers
 * read it by name and `centroid[0]` at a call site is how you end up plotting a
 * fire in the Pacific.
 *
 * Nothing translated between the two. Every consumer read `centroid.lat` off an
 * array and got `undefined`: the proximity check compared NaN and found no
 * fires ever, and the map handed Leaflet `[undefined, undefined]` for the first
 * Canadian fire in view, which threw and took the WHOLE fire layer down with
 * it — perimeters included. That is why no fires appeared.
 *
 * Fires without a usable position are dropped rather than placed at [0,0].
 */
const empty = (errors: string[]): FireResponse => ({
  type: 'FeatureCollection',
  features: [],
  meta: { fetchedAt: new Date().toISOString(), errors }
});

const readCentroid = (raw: unknown): { lat: number; lon: number } | null => {
  if (Array.isArray(raw) && raw.length >= 2) {
    const [lon, lat] = raw as [number, number];
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    return null;
  }
  if (raw && typeof raw === 'object') {
    const { lat, lon } = raw as { lat?: number; lon?: number };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat: lat as number, lon: lon as number };
    }
  }
  return null;
};

const normalise = (data: FireResponse): FireResponse => {
  const features: FireResponse['features'] = [];
  for (const feature of data.features) {
    const props = feature?.properties;
    const geometry = feature?.geometry ?? props?.geometry;
    if (!props || !geometry) continue;
    const centroid = readCentroid((props as unknown as { centroid: unknown }).centroid);
    if (!centroid) continue;
    features.push({
      type: 'Feature',
      geometry,
      properties: { ...props, centroid, geometry }
    });
  }
  return { ...data, features };
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const memCache = new Map<string, { at: number; data: FireResponse }>();
/** 30 min in-memory — the server already caches for 6h, so this is just
 *  to skip the round trip on a recent re-pan. */
const MEM_TTL_MS = 30 * 60 * 1000;
const MEM_MAX_ENTRIES = 60;

const memGet = (key: string): FireResponse | null => {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEM_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return hit.data;
};

const memPut = (key: string, data: FireResponse): void => {
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
 * Fetch active fires for a viewport.
 *
 *   - Returns an empty FeatureCollection on failure or no coverage.
 *     The map's fire layer degrades to "no markers" silently.
 *   - Never throws. Callers do not need a try/catch.
 *   - The bbox is rounded to 2 decimals before being sent, so adjacent
 *     viewports share the same cache entry.
 */
export const fetchActiveFires = async (
  box: BoundingBox,
  signal?: AbortSignal
): Promise<FireResponse> => {
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
    const res = await fetch(`/api/fires?${params.toString()}`, { signal });
    if (!res.ok) return empty([`HTTP ${res.status}`]);
    const data = await res.json() as FireResponse;
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      return empty(['malformed response']);
    }
    const normalised = normalise(data);
    memPut(key, normalised);
    return normalised;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return empty(['aborted']);
    return empty([(error as Error).message]);
  }
};

/**
 * Find fires within `radiusKm` of a point.
 *
 * Returns fires sorted by distance, each with its calculated distance
 * from the query point. Perimeters use their centroid for the
 * distance check, which is a slight under-estimate for a big fire
 * whose centroid is on the far side of the burn — good enough for
 * "is there a fire near me" warnings. If the user wants exact
 * polygon-vs-point distance, that's a future job.
 */
export const findFiresNear = (
  fires: ActiveFire[],
  lat: number, lon: number, radiusKm: number
): Array<{ fire: ActiveFire; distanceKm: number }> => {
  const out: Array<{ fire: ActiveFire; distanceKm: number }> = [];
  for (const fire of fires) {
    const d = distanceKm(lat, lon, fire.centroid.lat, fire.centroid.lon);
    if (d <= radiusKm) out.push({ fire, distanceKm: d });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
};
