/**
 * State and province boundaries (US + Canada).
 *
 * Serves two callers from one bundled file:
 *
 *   - The "State / province lines" map layer, which needs the outlines
 *     that overlap the current viewport.
 *   - The pin card's "Alberta, Canada" line, which needs the one
 *     region a single point falls inside.
 *
 * WHY THIS IS A BUNDLED FILE AND NOT AN API CALL
 *
 * It used to be an API call, and it did not work. The server fetched
 * Natural Earth's 1:10m admin-1 set on demand — 63 MB — and tried to
 * cache it on a serverless filesystem that is read-only, so every cold
 * start downloaded it again inside a 30-second budget it could not meet.
 * The layer drew nothing.
 *
 * `scripts/buildMapAssets.ts` now trims the 1:50m set to the 64 US and
 * Canadian regions and thins the coordinates, which comes to ~134 KB
 * over the wire. That is small enough to hold in the browser, which
 * removes the server from both jobs: the layer filters locally and the
 * pin lookup is a point-in-polygon test with no round trip.
 *
 * IMPORTANT: these are cartographic outlines, accurate to roughly a
 * kilometre. They are for orientation — "am I still in Montana?" — and
 * must never be used to decide which jurisdiction's camping rules apply
 * to a spot near a border.
 */
import type { BoundingBox } from '../config/coverage';

export interface Admin1 {
  country: 'United States' | 'Canada';
  countryCode: 'US' | 'CA';
  /** "State", "Province", "Territory". */
  type: string;
  /** "Montana", "Alberta". */
  name: string;
  /** "US-MT", "CA-AB". */
  isoCode: string;
  /** "Mont.", "Alta." */
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

const EMPTY: Admin1Collection = { type: 'FeatureCollection', features: [] };

/** Feature plus a precomputed bounds, so filtering never rewalks rings. */
interface IndexedFeature {
  feature: Admin1Feature;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

let indexed: IndexedFeature[] | null = null;
let loadPromise: Promise<IndexedFeature[]> | null = null;
let unavailable = false;

const ringsOf = (geometry: GeoJSON.Geometry): number[][][] => {
  if (geometry.type === 'Polygon') return geometry.coordinates as number[][][];
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).flat();
  }
  return [];
};

const indexFeature = (feature: Admin1Feature): IndexedFeature => {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of ringsOf(feature.geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { feature, minLon, minLat, maxLon, maxLat };
};

/**
 * Load the bundled outlines. Never throws; an empty list means the
 * layer draws nothing and the pin card shows no region line, which is
 * the correct way to fail — silence rather than a wrong answer.
 */
const load = async (): Promise<IndexedFeature[]> => {
  if (indexed) return indexed;
  if (unavailable) return [];
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetch('/map/admin1-us-ca.json');
      if (!res.ok) { unavailable = true; return []; }
      const data = await res.json() as Admin1Collection;
      if (!Array.isArray(data?.features)) { unavailable = true; return []; }
      indexed = data.features.map(indexFeature);
      return indexed;
    } catch {
      unavailable = true;
      return [];
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
};

/** Kick off the download ahead of first use. Safe to call repeatedly. */
export const primeAdmin1 = (): void => { void load(); };

/**
 * Every state or province whose outline overlaps the box.
 *
 * A plain bounds overlap, which is the whole test.
 *
 * The previous version tried to be clever here and asked whether any
 * edge of the polygon crossed the viewport. That is a different
 * question, and it has a spectacular failure mode: zoom far enough into
 * Alberta that no part of Alberta's border is on screen and Alberta
 * stops matching, so the layer goes blank at exactly the zoom levels
 * where someone is actually looking at it. Overlap includes the
 * enclosing region, which is what a viewport inside a state needs.
 */
export const fetchAdmin1 = async (box: BoundingBox): Promise<Admin1Collection> => {
  const all = await load();
  if (!all.length) return EMPTY;

  const features = all
    .filter((entry) =>
      entry.minLon <= box.maxLon && entry.maxLon >= box.minLon &&
      entry.minLat <= box.maxLat && entry.maxLat >= box.minLat)
    .map((entry) => entry.feature);

  return { type: 'FeatureCollection', features };
};

/** Ray casting against one ring. */
const pointInRing = (lon: number, lat: number, ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * Point-in-polygon across a feature's rings, counting crossings so an
 * inner ring subtracts. Straddling a shared border resolves to whichever
 * region is checked first; at the scale of these outlines the two
 * answers are both defensible within a kilometre of the line.
 */
const pointInFeature = (lon: number, lat: number, geometry: GeoJSON.Geometry): boolean => {
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as number[][][];
    if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
    for (let i = 1; i < rings.length; i += 1) {
      if (pointInRing(lon, lat, rings[i])) return false;
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates as number[][][][]) {
      if (!poly.length || !pointInRing(lon, lat, poly[0])) continue;
      let inHole = false;
      for (let i = 1; i < poly.length && !inHole; i += 1) {
        if (pointInRing(lon, lat, poly[i])) inHole = true;
      }
      if (!inHole) return true;
    }
  }
  return false;
};

/**
 * Which state or province contains this point?
 *
 * Null for anywhere outside the US and Canada — Mexico, open ocean — and
 * null while the outlines are still loading. Callers render nothing
 * rather than guessing.
 */
export const findAdmin1At = async (lat: number, lon: number): Promise<Admin1 | null> => {
  const all = await load();
  for (const entry of all) {
    if (lon < entry.minLon || lon > entry.maxLon) continue;
    if (lat < entry.minLat || lat > entry.maxLat) continue;
    if (pointInFeature(lon, lat, entry.feature.geometry)) return entry.feature.properties;
  }
  return null;
};
