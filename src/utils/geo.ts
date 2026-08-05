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
