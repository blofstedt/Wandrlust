/**
 * Which US states a viewport touches.
 *
 * WHY THIS EXISTS
 *
 * The NWS alerts API has no bounding-box query. It will answer for a single
 * POINT, or for a list of STATES, and nothing in between. `/api/weather/alerts`
 * used to ask for the single point at the centre of the viewport, which meant a
 * heat advisory two valleys over — plainly inside the visible map — was never
 * fetched at all, and so was never drawn.
 *
 * Asking by state fixes that: one request covering everything on screen.
 *
 * WHAT THIS TABLE IS, AND IS NOT
 *
 * These are loose bounding boxes, rounded outward. They are used for ONE
 * decision — which state feeds to ask — and nothing else. Over-inclusion is
 * free: an extra state's alerts come back, get their real geometry attached,
 * and are then filtered against the actual viewport. Under-inclusion is what we
 * cannot afford, so every box is padded rather than tight.
 *
 * Nothing here is ever shown to a user, and nothing is ever placed on the map
 * using these numbers. A state box is not a claim about where a warning is.
 *
 * Alaska and Hawaii are absent on purpose: coverage is CONUS + Canada
 * (see src/config/coverage.ts).
 */

/** [west, south, east, north], padded outward. */
export const US_STATE_BBOX: Record<string, [number, number, number, number]> = {
  AL: [-88.6, 30.1, -84.8, 35.1],
  AR: [-94.7, 32.9, -89.6, 36.6],
  AZ: [-115.0, 31.2, -108.9, 37.1],
  CA: [-124.5, 32.4, -114.0, 42.1],
  CO: [-109.2, 36.9, -101.9, 41.1],
  CT: [-73.8, 40.9, -71.7, 42.1],
  DC: [-77.2, 38.7, -76.8, 39.1],
  DE: [-75.9, 38.4, -74.9, 39.9],
  FL: [-87.7, 24.4, -79.9, 31.1],
  GA: [-85.7, 30.3, -80.7, 35.1],
  IA: [-96.7, 40.3, -90.1, 43.6],
  ID: [-117.3, 41.9, -110.9, 49.1],
  IL: [-91.6, 36.9, -87.4, 42.6],
  IN: [-88.2, 37.7, -84.7, 41.8],
  KS: [-102.2, 36.9, -94.5, 40.1],
  KY: [-89.6, 36.4, -81.9, 39.2],
  LA: [-94.1, 28.8, -88.7, 33.1],
  MA: [-73.6, 41.1, -69.8, 43.0],
  MD: [-79.5, 37.8, -74.9, 39.8],
  ME: [-71.2, 42.9, -66.8, 47.6],
  MI: [-90.5, 41.6, -82.1, 48.4],
  MN: [-97.3, 43.4, -89.4, 49.5],
  MO: [-95.9, 35.9, -89.0, 40.7],
  MS: [-91.7, 30.1, -88.0, 35.1],
  MT: [-116.2, 44.3, -103.9, 49.1],
  NC: [-84.4, 33.7, -75.3, 36.7],
  ND: [-104.1, 45.8, -96.5, 49.1],
  NE: [-104.1, 39.9, -95.2, 43.1],
  NH: [-72.6, 42.6, -70.6, 45.4],
  NJ: [-75.6, 38.9, -73.8, 41.4],
  NM: [-109.2, 31.2, -102.9, 37.1],
  NV: [-120.1, 34.9, -113.9, 42.1],
  NY: [-79.9, 40.4, -71.8, 45.1],
  OH: [-85.0, 38.3, -80.4, 42.4],
  OK: [-103.1, 33.6, -94.4, 37.1],
  OR: [-124.7, 41.9, -116.4, 46.4],
  PA: [-80.6, 39.6, -74.6, 42.3],
  RI: [-71.9, 41.1, -71.1, 42.1],
  SC: [-83.4, 32.0, -78.4, 35.3],
  SD: [-104.1, 42.4, -96.4, 46.0],
  TN: [-90.4, 34.9, -81.6, 36.7],
  TX: [-106.7, 25.8, -93.4, 36.6],
  UT: [-114.1, 36.9, -108.9, 42.1],
  VA: [-83.7, 36.5, -75.2, 39.5],
  VT: [-73.5, 42.7, -71.4, 45.1],
  WA: [-124.9, 45.5, -116.9, 49.1],
  WI: [-92.9, 42.4, -86.8, 47.2],
  WV: [-82.7, 37.1, -77.7, 40.7],
  WY: [-111.1, 40.9, -103.9, 45.1]
};

/**
 * Every state whose box overlaps the given viewport.
 *
 * Returns an empty list for a viewport entirely outside the US, which the
 * caller reads as "don't ask NWS at all".
 */
export const statesInBbox = (
  minLon: number, minLat: number, maxLon: number, maxLat: number
): string[] => {
  const out: string[] = [];
  for (const [code, [w, s, e, n]] of Object.entries(US_STATE_BBOX)) {
    if (e < minLon || w > maxLon || n < minLat || s > maxLat) continue;
    out.push(code);
  }
  return out;
};

/**
 * How far a state's centre is from a point, in rough degrees.
 *
 * WHY THIS EXISTS. Zone outlines are fetched under a hard budget — a winter
 * morning names more forecast zones than the serverless function has seconds
 * to resolve. The budget used to be spent in whatever order the alerts
 * happened to arrive, which at a wide zoom meant a viewport over Alberta
 * could burn its entire allowance on Florida and Texas and have nothing left
 * for Montana and Idaho. Those unresolved alerts have no geometry, and an
 * alert with no geometry is never drawn — so the states the camper was
 * actually looking at were the ones that silently got no cloud.
 *
 * Ranking by distance from the middle of the requested box spends the budget
 * on the middle of the screen first. Squared degrees, unprojected: this only
 * ever decides an ORDER, and nothing is ever placed on the map using it.
 */
export const stateDistanceRank = (code: string, lat: number, lon: number): number => {
  const box = US_STATE_BBOX[code];
  if (!box) return Number.POSITIVE_INFINITY;
  const [w, s, e, n] = box;
  const dLat = (s + n) / 2 - lat;
  const dLon = (w + e) / 2 - lon;
  return dLat * dLat + dLon * dLon;
};
