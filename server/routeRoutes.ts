/**
 * Routing.
 *
 *   GET /api/route?fromLat=&fromLon=&toLat=&toLon=&[rig dimensions]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MOVED TO THE SERVER, AND WHY THE ENGINE CHANGED
 * ---------------------------------------------------------------------------
 *
 * THE BUG THIS FIXES: routes stopped short of the campsite, often by
 * kilometres, and there was no path from the vehicle to the spot.
 *
 * The cause is OSRM's car profile. Its speed table covers motorway down to
 * `service`, and that is the whole list — `highway=track` is not in it. Forest
 * service roads, BLM two-tracks and the spur you actually camp down are almost
 * all tagged `track` in OpenStreetMap. To OSRM those roads do not exist, so it
 * snaps both ends of the trip onto the nearest road it does know and returns a
 * route between those, silently. On a dispersed camping app — where the last
 * ten kilometres are the entire point — that is close to useless.
 *
 * So the ladder is now, in order of preference:
 *
 *   1. OpenRouteService, when ORS_API_KEY is set. Its `driving-car` profile
 *      includes tracks, and its HGV profile honours real rig dimensions.
 *   2. Valhalla on the FOSSGIS public instance. No key, and crucially it has
 *      an explicit `use_tracks` cost knob which we turn all the way up.
 *   3. OSRM. Kept only as a last resort, and the response says plainly that
 *      it ignores unpaved tracks so the shortfall is never a mystery.
 *
 * AND, WHATEVER THE ENGINE: every route reports how far its end landed from
 * the point that was actually asked for. No router covers every track, so the
 * gap is a permanent fact of this problem, not a bug to be hidden. It is
 * measured, returned as `gapToDestinationKm`, and drawn on the map as a dashed
 * line the app refuses to call a route.
 *
 * Proxied rather than called from the browser for the usual three reasons:
 * CORS, caching, and the User-Agent that FOSSGIS asks public users to send.
 */
// `Response` is aliased: express exports one and `fetch` returns another, and
// an unaliased import silently shadows the fetch type in every helper below.
import type { Express, Request, Response as ExpressResponse } from 'express';

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

interface RouteWarning {
  severity: 'info' | 'caution' | 'critical';
  message: string;
}

interface RouteBody {
  ok: boolean;
  /** [lat, lon] pairs. */
  geometry: [number, number][];
  distanceKm: number;
  durationMin: number;
  provider: string;
  /** True when the engine applied the rig's real dimensions. */
  dimensionAware: boolean;
  /** True when the engine will route over unpaved tracks and forest roads. */
  routesTracks: boolean;
  /**
   * How far the route's end is from the coordinates asked for, in km.
   *
   * Anything above a few hundred metres means the last stretch is on
   * something the router does not carry. Never silently rounded away.
   */
  gapToDestinationKm: number;
  warnings: RouteWarning[];
  message: string;
}

const EMPTY: RouteBody = {
  ok: false, geometry: [], distanceKm: 0, durationMin: 0, provider: 'none',
  dimensionAware: false, routesTracks: false, gapToDestinationKm: 0,
  warnings: [], message: 'No route'
};

interface Rig {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
  clearanceCm?: number;
  is4wd?: boolean;
  hasTrailer?: boolean;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Google's encoded polyline, at whatever precision the engine used.
 *
 * Valhalla encodes at 1e6, everyone else at 1e5. Getting this wrong does not
 * throw — it silently yields a route ten times too small sitting off the coast
 * of Africa — so the precision is always passed explicitly.
 */
const decodePolyline = (encoded: string, precision: number): [number, number][] => {
  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / factor, lon / factor]);
  }

  return points;
};

/** Dimension checks that need no routing engine at all. */
const staticRigWarnings = (rig: Rig): RouteWarning[] => {
  const out: RouteWarning[] = [];

  if (rig.heightCm && rig.heightCm > 411) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.heightCm / 100).toFixed(2)} m you exceed the 13'6" (4.11 m) clearance common on older US bridges and many forest roads.`
    });
  }
  if (rig.lengthCm && rig.lengthCm > 1067) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.lengthCm / 100).toFixed(1)} m you exceed the 35 ft limit posted at many national forest campgrounds and switchback roads.`
    });
  }
  if (rig.weightKg && rig.weightKg > 11793) {
    out.push({
      severity: 'caution',
      message: `At ${(rig.weightKg / 1000).toFixed(1)} t you may exceed posted limits on secondary bridges and seasonal-load-restricted roads.`
    });
  }
  if (rig.clearanceCm && rig.clearanceCm < 20 && !rig.is4wd) {
    out.push({
      severity: 'caution',
      message: 'Low clearance and 2WD: this route may include unpaved tracks. Scout the last few kilometres before committing.'
    });
  }
  if (rig.hasTrailer) {
    out.push({
      severity: 'info',
      message: 'Towing: check turnaround space before committing to a spur road.'
    });
  }
  return out;
};

/**
 * Finish a route: measure the shortfall and say what the engine can't do.
 *
 * Every provider ends here, so the gap is measured identically for all of
 * them and no engine can quietly skip the disclosure.
 */
const finalise = (
  body: Omit<RouteBody, 'gapToDestinationKm' | 'ok' | 'warnings'>,
  to: [number, number],
  rig: Rig,
  extraWarnings: RouteWarning[]
): RouteBody => {
  const end = body.geometry[body.geometry.length - 1];
  const gap = end ? distanceKm(end[0], end[1], to[0], to[1]) : 0;
  const warnings = [...extraWarnings, ...staticRigWarnings(rig)];

  // 150 m is roughly where a snap stops being "the road outside" and starts
  // being "somewhere else entirely".
  if (gap > 0.15) {
    warnings.unshift({
      severity: gap > 2 ? 'critical' : 'caution',
      message:
        `The route stops ${gap < 1 ? `${Math.round(gap * 1000)} m` : `${gap.toFixed(1)} km`} ` +
        `short of your spot. The last stretch isn't on any road this router ` +
        `carries — usually an unmapped two-track or a gated spur. Check ` +
        `satellite imagery for that section before you commit to it.`
    });
  }

  return {
    ...body,
    ok: body.geometry.length >= 2,
    gapToDestinationKm: Number(gap.toFixed(2)),
    warnings
  };
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  ms: number
): Promise<globalThis.Response | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Identify ourselves. FOSSGIS asks public users of its instances to send a
 * contact so they can get in touch before they block you.
 */
const userAgent = (): string =>
  process.env.NWS_USER_AGENT || 'wandrlust (contact not configured)';

/* ------------------------------------------------------------------ */
/* 1. OpenRouteService — dimension aware, routes tracks                */
/* ------------------------------------------------------------------ */

const viaOrs = async (
  from: [number, number],
  to: [number, number],
  rig: Rig,
  apiKey: string
): Promise<RouteBody | null> => {
  const hasDimensions = Boolean(rig.heightCm || rig.widthCm || rig.lengthCm || rig.weightKg);
  // The HGV profile is the only one that honours dimensions, but it also
  // avoids a lot of the small roads a van is perfectly happy on. Only reach
  // for it when the user has actually told us they drive something big.
  const profile = hasDimensions ? 'driving-hgv' : 'driving-car';

  const body: Record<string, unknown> = {
    coordinates: [[from[1], from[0]], [to[1], to[0]]],
    // Get us as close as the network allows rather than giving up early.
    radiuses: [-1, -1],
    instructions: false
  };

  if (hasDimensions) {
    const restrictions: Record<string, number> = {};
    if (rig.heightCm) restrictions.height = rig.heightCm / 100;
    if (rig.widthCm) restrictions.width = rig.widthCm / 100;
    if (rig.lengthCm) restrictions.length = rig.lengthCm / 100;
    if (rig.weightKg) restrictions.weight = rig.weightKg / 1000;
    body.options = { profile_params: { restrictions }, vehicle_type: 'hgv' };
  }

  const res = await fetchWithTimeout(
    `https://api.openrouteservice.org/v2/directions/${profile}/geojson`,
    {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    12_000
  );
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null);
  const feature = data?.features?.[0];
  if (!feature) return null;

  const geometry: [number, number][] = (feature.geometry?.coordinates ?? []).map(
    ([lon, lat]: [number, number]) => [lat, lon] as [number, number]
  );
  if (geometry.length < 2) return null;

  const summary = feature.properties?.summary ?? {};

  return finalise(
    {
      geometry,
      distanceKm: Number(((summary.distance ?? 0) / 1000).toFixed(1)),
      durationMin: Math.round((summary.duration ?? 0) / 60),
      provider: `OpenRouteService (${hasDimensions ? 'HGV' : 'car'})`,
      dimensionAware: hasDimensions,
      routesTracks: true,
      message: hasDimensions
        ? 'Route calculated with your rig restrictions'
        : 'Route calculated including unpaved tracks'
    },
    to,
    rig,
    hasDimensions
      ? [{
          severity: 'info',
          message:
            'Route respects your rig height, width, length and weight where the ' +
            'underlying map data records restrictions. Unmapped restrictions still exist.'
        }]
      : []
  );
};

/* ------------------------------------------------------------------ */
/* 2. Valhalla — no key, and it will drive a forest road               */
/* ------------------------------------------------------------------ */

const VALHALLA_URL =
  process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de/route';

const viaValhalla = async (
  from: [number, number],
  to: [number, number],
  rig: Rig
): Promise<RouteBody | null> => {
  /**
   * `use_tracks: 1` is the whole reason this provider is here.
   *
   * Valhalla scores `highway=track` with a penalty controlled by this knob,
   * from 0 (avoid entirely — its default is 0.5, i.e. quite reluctant) to 1
   * (treat as an ordinary road). Turned all the way up, because for this app
   * the track IS the destination road, not a shortcut to be avoided.
   *
   * `use_living_streets` gets the same treatment for the same reason, and
   * `use_highways` is left near default: a camper is not in a hurry and the
   * scenic secondary is usually the right call anyway.
   */
  const auto: Record<string, unknown> = {
    use_tracks: 1,
    use_living_streets: 1,
    use_highways: 0.6
  };

  // Valhalla applies these as hard exclusions on the graph where OSM records
  // them, which is genuinely dimension-aware routing without an API key.
  if (rig.heightCm) auto.height = rig.heightCm / 100;
  if (rig.widthCm) auto.width = rig.widthCm / 100;
  if (rig.weightKg) auto.weight = rig.weightKg / 1000;

  const res = await fetchWithTimeout(
    VALHALLA_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify({
        // `break` at both ends; `search_filter` keeps Valhalla from refusing
        // to snap to a minor road when a highway happens to be nearer.
        locations: [
          { lat: from[0], lon: from[1], type: 'break' },
          { lat: to[0], lon: to[1], type: 'break', search_cutoff: 5000 }
        ],
        costing: 'auto',
        costing_options: { auto },
        directions_type: 'none',
        units: 'kilometers'
      })
    },
    15_000
  );
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null);
  const trip = data?.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) return null;

  // Valhalla encodes shapes at 1e6, not the usual 1e5.
  const geometry: [number, number][] = [];
  for (const leg of trip.legs) {
    if (typeof leg?.shape !== 'string') continue;
    const points = decodePolyline(leg.shape, 6);
    // Legs share their join point; dropping the duplicate keeps the line clean.
    geometry.push(...(geometry.length > 0 ? points.slice(1) : points));
  }
  if (geometry.length < 2) return null;

  const summary = trip.summary ?? {};
  const dimensionAware = Boolean(rig.heightCm || rig.widthCm || rig.weightKg);

  return finalise(
    {
      geometry,
      distanceKm: Number((summary.length ?? 0).toFixed(1)),
      durationMin: Math.round((summary.time ?? 0) / 60),
      provider: 'Valhalla (OpenStreetMap)',
      dimensionAware,
      routesTracks: true,
      message: 'Route includes unpaved tracks and forest roads'
    },
    to,
    rig,
    [{
      severity: dimensionAware ? 'info' : 'caution',
      message: dimensionAware
        ? 'Height, width and weight limits are applied where OpenStreetMap records ' +
          'them. Most forest roads record nothing, so unposted limits still exist.'
        : 'This route may use unpaved tracks and forest roads. It does not know ' +
          'your rig dimensions — add your rig in Settings to have clearances checked.'
    }]
  );
};

/* ------------------------------------------------------------------ */
/* 3. OSRM — last resort, and it cannot see a forest road              */
/* ------------------------------------------------------------------ */

const viaOsrm = async (
  from: [number, number],
  to: [number, number],
  rig: Rig
): Promise<RouteBody | null> => {
  const res = await fetchWithTimeout(
    `https://router.project-osrm.org/route/v1/driving/` +
      `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`,
    { headers: { 'User-Agent': userAgent() } },
    12_000
  );
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null);
  const route = data?.routes?.[0];
  if (!route) return null;

  const geometry: [number, number][] = (route.geometry?.coordinates ?? []).map(
    ([lon, lat]: [number, number]) => [lat, lon] as [number, number]
  );
  if (geometry.length < 2) return null;

  return finalise(
    {
      geometry,
      distanceKm: Number((route.distance / 1000).toFixed(1)),
      durationMin: Math.round(route.duration / 60),
      provider: 'OSRM',
      dimensionAware: false,
      routesTracks: false,
      message: 'Route calculated on paved and gravel roads only'
    },
    to,
    rig,
    [{
      severity: 'critical',
      message:
        'This engine does not route over unpaved tracks or forest roads, and ' +
        'ignores your rig dimensions entirely. Expect the route to stop where ' +
        'the maintained road ends, well short of most dispersed sites.'
    }]
  );
};

/* ------------------------------------------------------------------ */

interface CacheEntry { at: number; body: RouteBody; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const readRig = (req: Request): Rig => {
  const num = (key: string): number | undefined => {
    const v = parseFloat(req.query[key] as string);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    heightCm: num('heightCm'),
    widthCm: num('widthCm'),
    lengthCm: num('lengthCm'),
    weightKg: num('weightKg'),
    clearanceCm: num('clearanceCm'),
    is4wd: req.query.is4wd === 'true',
    hasTrailer: req.query.hasTrailer === 'true'
  };
};

export const registerRouteRoutes = (app: Express): void => {
  app.get('/api/route', async (req: Request, res: ExpressResponse) => {
    const nums = ['fromLat', 'fromLon', 'toLat', 'toLon'].map((k) =>
      parseFloat(req.query[k] as string)
    );
    if (nums.some((n) => Number.isNaN(n))) {
      return res.status(400).json({
        ...EMPTY,
        message: 'fromLat, fromLon, toLat and toLon are required numeric query params.'
      });
    }

    const from: [number, number] = [nums[0], nums[1]];
    const to: [number, number] = [nums[2], nums[3]];
    const rig = readRig(req);

    // Five decimal places is about a metre — finer than any of these engines
    // resolves, and enough that nudging a pin re-queries.
    const cacheKey = `${nums.map((n) => n.toFixed(5)).join(',')}|${JSON.stringify(rig)}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.body);

    const orsKey = process.env.ORS_API_KEY || process.env.VITE_ORS_API_KEY;

    // Tried in order, first success wins. A provider returning null means it
    // was unreachable or gave nothing usable, never that there is no route.
    const body =
      (orsKey ? await viaOrs(from, to, rig, orsKey) : null) ??
      (await viaValhalla(from, to, rig)) ??
      (await viaOsrm(from, to, rig));

    if (!body) {
      return res.json({
        ...EMPTY,
        message:
          'No routing engine could be reached. Check your connection, or use the ' +
          'coordinates with an offline map app.'
      });
    }

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, { at: Date.now(), body });

    return res.json(body);
  });
};