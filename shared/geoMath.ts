/**
 * Great-circle distance — shared by the client and every server module that
 * needs "how far is that", instead of each writing its own copy.
 *
 * This exact formula used to be retyped independently in `src/utils/geo.ts`,
 * `server/cellSources.ts`, `server/routeRoutes.ts`, `server/beaconSources.ts`
 * and `src/services/scoutMode.ts` — five copies with no shared source, the
 * same failure mode `shared/hazards.ts` was written to close for the alert
 * classifier. Distance math backs Beacon's proximity checks and cell-signal
 * ranking, so a formula that quietly drifted in one copy would be exactly as
 * dangerous and exactly as invisible.
 */

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in whatever unit `radius` is. */
export const haversine = (
  lat1: number, lon1: number, lat2: number, lon2: number, radius: number
): number => {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
};

export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS_M = 6_371_000;
export const EARTH_RADIUS_MILES = 3958.8;

export const haversineKm = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => haversine(lat1, lon1, lat2, lon2, EARTH_RADIUS_KM);

export const haversineM = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => haversine(lat1, lon1, lat2, lon2, EARTH_RADIUS_M);

export const haversineMiles = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => haversine(lat1, lon1, lat2, lon2, EARTH_RADIUS_MILES);
