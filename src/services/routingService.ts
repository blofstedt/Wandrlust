import type { Rig } from './dataService';

/**
 * Routing, as far as the browser is concerned.
 *
 * The engine ladder, the track handling and the shortfall measurement all live
 * in `server/routeRoutes.ts` — read that file for why any of it works the way
 * it does. This side just asks and renders what comes back.
 *
 * It moved off the client for three reasons: the Valhalla instance we rely on
 * for forest-road routing asks for a User-Agent a browser cannot set, routes
 * are worth caching across users, and an API key has no business in a bundle.
 *
 * Never throws. With no server or no connection you get `ok: false` and a
 * message saying so.
 */

export interface RouteRequest {
  from: [number, number]; // [lat, lon]
  to: [number, number];
  rig?: Rig | null;
}

export interface RouteWarning {
  severity: 'info' | 'caution' | 'critical';
  message: string;
  /** Set on the warnings the server rewrites as it learns more. */
  key?: string;
}

/**
 * A road OpenStreetMap has near the spot.
 *
 * This is what the map is drawing and the router refused to use — see
 * `server/roadNetwork.ts`. It is a mapped line and a distance to it, and
 * nothing else: not a way in, not passable, not legal to drive.
 */
export interface RouteApproach {
  /** OSM's name or ref. Most tracks have neither, and null says so. */
  name: string | null;
  /** The raw OSM `highway` value — `track`, `service`, `unclassified`… */
  kind: string;
  /** The point on this road nearest the spot. */
  lat: number;
  lon: number;
  /** From the spot to the nearest point on this road, in km. */
  distanceKm: number;
  /** The stretch of road near the spot, [lat, lon] pairs, for drawing. */
  line: [number, number][];
  /** OSM records a gate, permit or seasonal closure on this way. */
  gated: boolean;
}

export interface RouteResult {
  ok: boolean;
  geometry: [number, number][]; // [lat, lon]
  distanceKm: number;
  durationMin: number;
  provider: string;
  /** True when the engine actually applied the rig's dimensions. */
  dimensionAware: boolean;
  /** True when the engine will drive an unpaved track to get there. */
  routesTracks: boolean;
  /**
   * How far short of your pin the route ends, in km.
   *
   * Almost never zero, and that is honest rather than broken: no router
   * carries every two-track. Anything above ~0.15 km is surfaced in the UI and
   * drawn as a dashed line that is explicitly not called a route.
   */
  gapToDestinationKm: number;
  /**
   * The mapped road the route ends on, when the server could identify one.
   *
   * Null means OpenStreetMap could not be reached, or there is nothing
   * driveable mapped near the spot — never "the route ends nowhere".
   */
  approach: RouteApproach | null;
  /**
   * The nearest driveable road OSM knows about, whether or not any engine
   * could route onto it — geometry included, so the map can draw it.
   *
   * When its distance is much smaller than `gapToDestinationKm`, the road you
   * can see on the map is real and simply unroutable: gated, or unconnected in
   * the map data. Null when the lookup did not run or failed.
   */
  nearestRoad: RouteApproach | null;
  warnings: RouteWarning[];
  message: string;
}

export const EMPTY_ROUTE: RouteResult = {
  ok: false,
  geometry: [],
  distanceKm: 0,
  durationMin: 0,
  provider: 'none',
  dimensionAware: false,
  routesTracks: false,
  gapToDestinationKm: 0,
  approach: null,
  nearestRoad: null,
  warnings: [],
  message: 'No route'
};

export const calculateRoute = async (
  req: RouteRequest,
  signal?: AbortSignal
): Promise<RouteResult> => {
  const params = new URLSearchParams({
    fromLat: req.from[0].toFixed(6),
    fromLon: req.from[1].toFixed(6),
    toLat: req.to[0].toFixed(6),
    toLon: req.to[1].toFixed(6)
  });

  // Only send what the user has actually recorded. A zero here would read as
  // "this vehicle is 0 cm tall" and quietly change which roads are allowed.
  const rig = req.rig;
  if (rig?.height_cm) params.set('heightCm', String(rig.height_cm));
  if (rig?.width_cm) params.set('widthCm', String(rig.width_cm));
  if (rig?.length_cm) params.set('lengthCm', String(rig.length_cm));
  if (rig?.gross_weight_kg) params.set('weightKg', String(rig.gross_weight_kg));
  if (rig?.ground_clearance_cm) params.set('clearanceCm', String(rig.ground_clearance_cm));
  if (rig?.is_4wd) params.set('is4wd', 'true');
  if (rig?.has_trailer) params.set('hasTrailer', 'true');

  try {
    const res = await fetch(`/api/route?${params}`, { signal });
    if (!res.ok) return { ...EMPTY_ROUTE, message: `Routing failed (${res.status})` };

    // Spread over the empty result so a response from an older deployment —
    // one with no approach fields — reads as "we did not check" rather than
    // arriving as undefined and blowing up a `.toFixed` three components away.
    return { ...EMPTY_ROUTE, ...((await res.json()) as Partial<RouteResult>) };
  } catch {
    return { ...EMPTY_ROUTE, message: 'Routing unavailable offline' };
  }
};