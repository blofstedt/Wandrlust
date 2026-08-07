/**
 * Small geodesic helpers.
 *
 * Previously the Haversine formula was redefined inside App.tsx on every
 * render and then called twice per campsite (once to filter, once to sort).
 * It lives here now, and callers compute distance once.
 */

const EARTH_RADIUS_MILES = 3958.8;
const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

const haversine = (
  lat1: number, lon1: number, lat2: number, lon2: number, radius: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
};

export const distanceMiles = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => haversine(lat1, lon1, lat2, lon2, EARTH_RADIUS_MILES);

export const distanceKm = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => haversine(lat1, lon1, lat2, lon2, EARTH_RADIUS_KM);

/** Rounded to ~1 km, for anything that leaves the device. */
export const coarsen = (value: number): number => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ *
 * Point in polygon
 *
 * Used to answer "what land did the user just tap?" from the boundary
 * polygons already sitting in memory, rather than firing another request at
 * a government server for a point we have already downloaded the shape of.
 *
 * Plain ray casting on the raw lon/lat pairs. At the scale of a single parcel
 * the difference between planar and spherical geometry is far below the
 * positional uncertainty of the boundaries themselves — these edges are
 * accurate to hundreds of metres, so a metre of projection error changes
 * nothing. Anything more sophisticated would be false precision.
 * ------------------------------------------------------------------ */

/** GeoJSON linear ring: an array of [lon, lat] pairs. */
type Ring = [number, number][];

const pointInRing = (lon: number, lat: number, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** One polygon: an outer ring followed by any number of holes. */
const pointInPolygon = (lon: number, lat: number, rings: Ring[]): boolean => {
  if (rings.length === 0 || !pointInRing(lon, lat, rings[0])) return false;
  // A hit inside a hole is a miss.
  return !rings.slice(1).some((hole) => pointInRing(lon, lat, hole));
};

/**
 * Does `geometry` — a GeoJSON Polygon or MultiPolygon — contain the point?
 *
 * Anything else (a line, a point, a malformed shape) returns false rather
 * than throwing, because this runs inside a click handler on data fetched
 * from three different government services.
 */
export const pointInGeometry = (
  lat: number,
  lon: number,
  geometry: unknown
): boolean => {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (!g || typeof g.type !== 'string' || !Array.isArray(g.coordinates)) return false;

  if (g.type === 'Polygon') {
    return pointInPolygon(lon, lat, g.coordinates as Ring[]);
  }
  if (g.type === 'MultiPolygon') {
    return (g.coordinates as Ring[][]).some((poly) => pointInPolygon(lon, lat, poly));
  }
  return false;
};