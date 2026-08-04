import type { Rig } from './dataService';

/**
 * Rig-aware routing.
 *
 * WHY THIS IS A THIN WRAPPER AND NOT A ROUTING ENGINE
 *
 * Vehicle-dimension routing needs a road graph carrying height, weight and
 * width restrictions. Building that is a multi-year project — OSM's coverage
 * of `maxheight` / `maxweight` tags is patchy, and the consequence of an error
 * is a wedged rig under a bridge.
 *
 * So we delegate, and default to OSRM, which is free but has NO dimension
 * awareness. That distinction is surfaced to the user rather than hidden: a
 * route from a non-restriction-aware engine is explicitly labelled as such.
 *
 * For real clearance routing set VITE_ROUTING_PROVIDER=openrouteservice and
 * VITE_ORS_API_KEY. ORS supports an HGV profile with real restrictions.
 */

export interface RouteRequest {
  from: [number, number]; // [lat, lon]
  to: [number, number];
  rig?: Rig | null;
  avoidUnpaved?: boolean;
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
  warnings: RouteWarning[];
  message: string;
}

const EMPTY_ROUTE: RouteResult = {
  ok: false,
  geometry: [],
  distanceKm: 0,
  durationMin: 0,
  provider: 'none',
  dimensionAware: false,
  warnings: [],
  message: 'No route'
};

/** Dimension checks we can make without a routing engine at all. */
export const staticRigWarnings = (rig: Rig | null | undefined): RouteWarning[] => {
  if (!rig) return [];
  const out: RouteWarning[] = [];

  if (rig.height_cm && rig.height_cm > 411) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.height_cm / 100).toFixed(2)} m you exceed the 13'6" (4.11 m) clearance common on older US bridges and many forest roads.`
    });
  }
  if (rig.length_cm && rig.length_cm > 1067) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.length_cm / 100).toFixed(1)} m you exceed the 35 ft limit posted at many national forest campgrounds and switchback roads.`
    });
  }
  if (rig.gross_weight_kg && rig.gross_weight_kg > 11793) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.gross_weight_kg / 1000).toFixed(1)} t you may exceed posted limits on secondary bridges and seasonal-load-restricted roads.`
    });
  }
  if (rig.ground_clearance_cm && rig.ground_clearance_cm < 20 && !rig.is_4wd) {
    out.push({
      severity: 'caution',
      message: 'Low clearance and 2WD: avoid high-clearance and 4x4-rated access roads.'
    });
  }
  if (rig.has_trailer) {
    out.push({
      severity: 'info',
      message: 'Towing: check turnaround space before committing to a spur road.'
    });
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* OSRM — free, no key, NOT dimension aware                            */
/* ------------------------------------------------------------------ */

const routeViaOsrm = async (req: RouteRequest): Promise<RouteResult> => {
  const [fromLat, fromLon] = req.from;
  const [toLat, toLon] = req.to;

  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLon},${fromLat};${toLon},${toLat}` +
      `?overview=full&geometries=geojson`;

    const res = await fetch(url);
    if (!res.ok) return { ...EMPTY_ROUTE, message: `Routing failed (${res.status})` };

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return { ...EMPTY_ROUTE, message: 'No route found' };

    const coords: [number, number][] = (route.geometry?.coordinates ?? []).map(
      ([lon, lat]: [number, number]) => [lat, lon] as [number, number]
    );

    const warnings = staticRigWarnings(req.rig);
    warnings.unshift({
      severity: 'critical',
      message:
        'This route does NOT account for your rig dimensions. It ignores height, ' +
        'weight and width restrictions. Verify clearances yourself, especially on ' +
        'forest and secondary roads.'
    });

    return {
      ok: true,
      geometry: coords,
      distanceKm: Number((route.distance / 1000).toFixed(1)),
      durationMin: Math.round(route.duration / 60),
      provider: 'OSRM',
      dimensionAware: false,
      warnings,
      message: 'Route calculated without dimension restrictions'
    };
  } catch {
    return { ...EMPTY_ROUTE, message: 'Routing unavailable offline' };
  }
};

/* ------------------------------------------------------------------ */
/* OpenRouteService — HGV profile, genuinely dimension aware           */
/* ------------------------------------------------------------------ */

const routeViaOrs = async (req: RouteRequest, apiKey: string): Promise<RouteResult> => {
  const [fromLat, fromLon] = req.from;
  const [toLat, toLon] = req.to;
  const rig = req.rig;

  const restrictions: Record<string, number> = {};
  if (rig?.height_cm) restrictions.height = rig.height_cm / 100;
  if (rig?.width_cm) restrictions.width = rig.width_cm / 100;
  if (rig?.length_cm) restrictions.length = rig.length_cm / 100;
  if (rig?.gross_weight_kg) restrictions.weight = rig.gross_weight_kg / 1000;

  const body: Record<string, unknown> = {
    coordinates: [
      [fromLon, fromLat],
      [toLon, toLat]
    ],
    profile: 'driving-hgv',
    format: 'geojson'
  };

  if (Object.keys(restrictions).length > 0) {
    body.options = { profile_params: { restrictions }, vehicle_type: 'hgv' };
  }
  if (req.avoidUnpaved) {
    body.options = { ...(body.options as object), avoid_features: ['unpavedroads'] };
  }

  try {
    const res = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson',
      {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!res.ok) {
      // Fall back rather than leaving the user with nothing.
      const fallback = await routeViaOsrm(req);
      return {
        ...fallback,
        message: `Dimension routing failed (${res.status}); showing an unrestricted route instead.`
      };
    }

    const data = await res.json();
    const feature = data?.features?.[0];
    if (!feature) return { ...EMPTY_ROUTE, message: 'No route found for this rig' };

    const coords: [number, number][] = (feature.geometry?.coordinates ?? []).map(
      ([lon, lat]: [number, number]) => [lat, lon] as [number, number]
    );
    const summary = feature.properties?.summary ?? {};

    const warnings = staticRigWarnings(req.rig);
    warnings.unshift({
      severity: 'info',
      message:
        'Route respects your rig height, width, length and weight where the ' +
        'underlying map data records restrictions. Unmapped restrictions still exist.'
    });

    return {
      ok: true,
      geometry: coords,
      distanceKm: Number(((summary.distance ?? 0) / 1000).toFixed(1)),
      durationMin: Math.round((summary.duration ?? 0) / 60),
      provider: 'OpenRouteService (HGV)',
      dimensionAware: true,
      warnings,
      message: 'Route calculated with rig restrictions'
    };
  } catch {
    return routeViaOsrm(req);
  }
};

/* ------------------------------------------------------------------ */

export const calculateRoute = async (req: RouteRequest): Promise<RouteResult> => {
  const provider = import.meta.env.VITE_ROUTING_PROVIDER;
  const orsKey = import.meta.env.VITE_ORS_API_KEY;

  if (provider === 'openrouteservice' && orsKey) return routeViaOrs(req, orsKey);
  return routeViaOsrm(req);
};

/** Does the app currently have dimension-aware routing available? */
export const hasDimensionRouting = (): boolean =>
  import.meta.env.VITE_ROUTING_PROVIDER === 'openrouteservice' &&
  Boolean(import.meta.env.VITE_ORS_API_KEY);
