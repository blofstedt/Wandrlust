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
    return (await res.json()) as RouteResult;
  } catch {
    return { ...EMPTY_ROUTE, message: 'Routing unavailable offline' };
  }
};