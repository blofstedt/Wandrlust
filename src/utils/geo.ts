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
 * Bearings, for the navigation camera
 * ------------------------------------------------------------------ */

const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Initial great-circle bearing from one point to another, in degrees from
 * north. Always 0–360, never negative, because it feeds a CSS rotation and a
 * `-15deg` there is a different-looking bug from a `345deg`.
 */
export const bearingDegrees = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

/**
 * Where you end up going `distanceKm` from a point on a given bearing.
 *
 * Used to place the navigation camera ahead of the vehicle, so the vehicle
 * sits low in the frame with the road it's about to drive filling the screen —
 * which is the whole point of a chase view.
 */
export const destinationPoint = (
  lat: number, lon: number, bearingDeg: number, distanceKm: number
): [number, number] => {
  const δ = distanceKm / EARTH_RADIUS_KM;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
};

/**
 * Smallest signed turn from one bearing to another, in degrees (-180..180].
 *
 * Rotating the map from 350° to 10° must be a 20° turn to the right, not a
 * 340° spin to the left. Without this the camera lurches all the way round
 * every time the heading crosses north.
 */
export const bearingDelta = (from: number, to: number): number =>
  ((((to - from) % 360) + 540) % 360) - 180;

/**
 * An unwrapped running bearing.
 *
 * CSS rotates through whatever number you give it, so the value handed to a
 * transform has to keep accumulating past 360 rather than wrapping. Feed it
 * the previous unwrapped angle and the new compass bearing.
 */
export const unwrapBearing = (previousUnwrapped: number, nextBearing: number): number =>
  previousUnwrapped + bearingDelta(((previousUnwrapped % 360) + 360) % 360, nextBearing);

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
