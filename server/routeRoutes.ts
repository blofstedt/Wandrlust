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
 * ---------------------------------------------------------------------------
 * AIMING AT ROADS THE ENGINE DID NOT PICK
 * ---------------------------------------------------------------------------
 *
 * Even with tracks turned all the way up, a route can end kilometres short
 * while an ordinary forest road — drawn on the basemap, right there — passes a
 * few hundred metres from the pin. That is not the router failing to find a
 * way; it is the router choosing where to give up. Handed a single coordinate,
 * every engine snaps it to whatever piece of network IT can reach and routes
 * to that, silently, with no second opinion. If the reachable piece is on the
 * far side of a ridge, that is where the trip ends.
 *
 * So a bad ending is no longer accepted first time. When the gap is big enough
 * to matter, `roadNetwork.ts` asks OpenStreetMap what is actually near the pin,
 * and the nearest points on the nearest few roads are retried as explicit
 * waypoints. Whichever attempt ENDS closest to the pin wins — measured against
 * the pin every time, so a retry can never flatter itself.
 *
 * Two things this deliberately does not do. It does not accept a route that
 * ends nearer at the cost of a wildly longer drive without saying so, and it
 * does not stay quiet when nothing could be routed to: a road OSM knows about
 * and no engine could reach is reported as exactly that, because "there is a
 * track 300 m away that nothing will route onto" is the sentence a camper
 * needs, and it is not a sentence a router will ever produce.
 *
 * Proxied rather than called from the browser for the usual three reasons:
 * CORS, caching, and the User-Agent that FOSSGIS asks public users to send.
 */
import { findApproachRoads, type ApproachRoad } from './roadNetwork.js';
// `Response` is aliased: express exports one and `fetch` returns another, and
// an unaliased import silently shadows the fetch type in every helper below.
import type { Express, Request, Response as ExpressResponse } from 'express';

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

interface RouteWarning {
  severity: 'info' | 'caution' | 'critical';
  message: string;
  /**
   * Stable identifier for the warnings that get rewritten later in the
   * request, once the approach pass knows more than the first attempt did.
   */
  key?: string;
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
  /**
   * The mapped road the route actually ends on, when one was identified.
   *
   * Null means we could not reach OpenStreetMap, or nothing driveable is
   * mapped near the pin at all — never "the route ends nowhere in particular".
   */
  approach: ApproachRoad | null;
  /**
   * The nearest driveable road OSM has to the pin, whether or not any engine
   * could route onto it.
   *
   * This is what answers "why did it stop so far away when there is clearly a
   * road right there" — and it carries its own geometry so the map can DRAW
   * the road the router refused to use, which is the only version of that
   * answer worth reading. Null when the lookup did not run or failed.
   */
  nearestRoad: ApproachRoad | null;
  warnings: RouteWarning[];
  message: string;
}

const EMPTY: RouteBody = {
  ok: false, geometry: [], distanceKm: 0, durationMin: 0, provider: 'none',
  dimensionAware: false, routesTracks: false, gapToDestinationKm: 0,
  approach: null, nearestRoad: null, warnings: [], message: 'No route'
};

/**
 * One attempt at one trip.
 *
 * `to` and `pin` are separate on purpose. `to` is where the ROUTER is told to
 * go, which on a retry is a point on some road OSM knows about. `pin` is where
 * the camper actually wants to be, and the shortfall is measured to it every
 * single time — so a retry aimed at a convenient waypoint can never report a
 * smaller gap than it earned.
 */
interface Leg {
  from: [number, number];
  to: [number, number];
  pin: [number, number];
  rig: Rig;
  /** Wall-clock budget for this attempt. Retries get less than the first try. */
  budgetMs: number;
}

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

/** Metres under a kilometre, kilometres above it. Nobody reads "0.3 km". */
const readable = (km: number): string =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

/** What to call a road that OSM never named, by what kind of road it is. */
const KIND_NOUN: Record<string, string> = {
  track: 'an unnamed track',
  service: 'an unnamed service road',
  unclassified: 'an unnamed back road',
  residential: 'a residential street',
  living_street: 'a residential street',
  tertiary: 'a minor road',
  tertiary_link: 'a minor road',
  secondary: 'a secondary road',
  secondary_link: 'a secondary road',
  road: 'an unclassified road'
};

const describeRoad = (road: ApproachRoad): string =>
  road.name ?? KIND_NOUN[road.kind] ?? 'an unnamed road';

/**
 * 150 m is roughly where a snap stops being "the road outside the spot" and
 * starts being "somewhere else entirely".
 */
const GAP_WORTH_MENTIONING_KM = 0.15;

/**
 * The shortfall, said as precisely as what we know allows.
 *
 * Three different sentences, because three different things can be true, and
 * flattening them into one costs a camper the only actionable part. The route
 * ending on a named forest road with 400 m of two-track left is a different
 * evening from the route ending on the wrong side of a ridge with nothing
 * mapped anywhere near the pin.
 */
const gapWarning = (
  gap: number,
  approach: ApproachRoad | null,
  nearestRoad: ApproachRoad | null
): RouteWarning | null => {
  if (gap <= GAP_WORTH_MENTIONING_KM) return null;

  const severity: RouteWarning['severity'] = gap > 2 ? 'critical' : 'caution';
  const stops = `The route stops ${readable(gap)} short of your spot.`;

  // A road OSM knows about, closer than the route managed to get. Worth
  // naming: it is the thing the camper can see on the basemap and is
  // wondering about.
  const closer =
    nearestRoad && nearestRoad.distanceKm < gap - GAP_WORTH_MENTIONING_KM
      ? nearestRoad
      : null;

  if (approach) {
    const gate = approach.gated
      ? ' OpenStreetMap records a gate or seasonal closure on it, so it may not be open.'
      : '';
    return {
      key: 'gap',
      severity,
      message:
        `${stops} It ends on ${describeRoad(approach)}, the closest road any ` +
        `engine could actually route onto.${gate} The last stretch isn't on ` +
        `a road anybody has mapped — check satellite imagery before you ` +
        `commit to it.`
    };
  }

  if (closer) {
    return {
      key: 'gap',
      severity,
      message:
        `${stops} OpenStreetMap does show ${describeRoad(closer)} about ` +
        `${readable(closer.distanceKm)} from the spot, but no routing engine ` +
        `could find a way onto it — it may be gated, unconnected in the map ` +
        `data, or simply not joined to anything driveable. Check satellite ` +
        `imagery for that section before you commit.`
    };
  }

  return {
    key: 'gap',
    severity,
    message:
      `${stops} The last stretch isn't on any road this router carries — ` +
      `usually an unmapped two-track or a gated spur. Check satellite imagery ` +
      `for that section before you commit to it.`
  };
};

/**
 * Finish a route: measure the shortfall and say what the engine can't do.
 *
 * Every provider ends here, so the gap is measured identically for all of
 * them and no engine can quietly skip the disclosure. The shortfall is always
 * measured to `leg.pin` — the camper's coordinate — never to the waypoint a
 * retry happened to aim at.
 */
const finalise = (
  body: Omit<RouteBody, 'gapToDestinationKm' | 'ok' | 'warnings' | 'approach' | 'nearestRoad'>,
  leg: Leg,
  extraWarnings: RouteWarning[]
): RouteBody => {
  const end = body.geometry[body.geometry.length - 1];
  const gap = end ? distanceKm(end[0], end[1], leg.pin[0], leg.pin[1]) : 0;
  const warnings = [...extraWarnings, ...staticRigWarnings(leg.rig)];

  // Approach details are unknown at this point — the pass that finds them runs
  // after a route exists to judge. `describeApproach` fills them in.
  const gapNote = gapWarning(gap, null, null);
  if (gapNote) warnings.unshift(gapNote);

  return {
    ...body,
    ok: body.geometry.length >= 2,
    gapToDestinationKm: Number(gap.toFixed(2)),
    approach: null,
    nearestRoad: null,
    warnings
  };
};

/**
 * Attach what the road scan learned, and rewrite the shortfall sentence in
 * light of it.
 *
 * The first attempt could only say "it stops 5.2 km short". Once the roads
 * near the pin are known, the same route can say which road it ends on, or
 * that a nearer one exists that nothing would route onto. Same number, an
 * answer instead of a shrug.
 */
const describeApproach = (
  body: RouteBody,
  approach: ApproachRoad | null,
  nearestRoad: ApproachRoad | null
): RouteBody => {
  const rest = body.warnings.filter((w) => w.key !== 'gap');
  const gapNote = gapWarning(body.gapToDestinationKm, approach, nearestRoad);

  return {
    ...body,
    approach,
    nearestRoad,
    warnings: gapNote ? [gapNote, ...rest] : rest
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

const viaOrs = async (leg: Leg, apiKey: string): Promise<RouteBody | null> => {
  const { from, to, rig } = leg;
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
    leg.budgetMs
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
    leg,
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

const viaValhalla = async (leg: Leg): Promise<RouteBody | null> => {
  const { from, to, rig } = leg;
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
    leg.budgetMs
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
    leg,
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

const viaOsrm = async (leg: Leg): Promise<RouteBody | null> => {
  const { from, to } = leg;
  const res = await fetchWithTimeout(
    `https://router.project-osrm.org/route/v1/driving/` +
      `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`,
    { headers: { 'User-Agent': userAgent() } },
    leg.budgetMs
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
    leg,
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
/* The ladder, and the second opinion                                  */
/* ------------------------------------------------------------------ */

/**
 * Tried in order, first success wins. A provider returning null means it was
 * unreachable or gave nothing usable, never that there is no route.
 */
const routeVia = async (leg: Leg, orsKey: string | undefined): Promise<RouteBody | null> =>
  (orsKey ? await viaOrs(leg, orsKey) : null) ??
  (await viaValhalla(leg)) ??
  (await viaOsrm(leg));

/** Below this the route effectively arrived; there is nothing to improve. */
const GAP_WORTH_RETRYING_KM = 0.25;

/** A retry has to beat the first attempt by this much to be worth swapping in. */
const IMPROVEMENT_KM = 0.1;

/** At most this many roads get retried. Each one costs a round trip. */
const MAX_CANDIDATES = 3;

/**
 * Don't trade a sane drive for a slightly better ending.
 *
 * Reaching the closest road sometimes means going round the whole massif. Up
 * to this much extra is worth it — arriving matters more than an hour — but
 * past it the original route is kept and the closer road is reported as
 * information rather than silently driven to.
 */
const acceptableDetour = (original: number, candidate: number): boolean =>
  candidate <= original * 2 + 25;

/** Enough left in the request budget to be worth starting the second pass. */
const SECOND_PASS_MS = 14_000;

/**
 * Try to end nearer the pin by aiming at roads OSM knows and the engine did
 * not pick.
 *
 * Returns the body to send — possibly the original one, always with the road
 * scan's findings attached. The scan is worth running even when no retry wins,
 * because naming the road the route ends on, or the nearer one nothing could
 * reach, is most of the value.
 */
const improveApproach = async (
  first: RouteBody,
  from: [number, number],
  pin: [number, number],
  rig: Rig,
  orsKey: string | undefined,
  msLeft: number
): Promise<RouteBody> => {
  // Look a little past where the route gave up: the useful road is usually
  // between the pin and the shortfall, but not always on that line.
  const scan = await findApproachRoads(
    pin[0], pin[1],
    Math.min(first.gapToDestinationKm + 1, 8),
    Math.min(9_000, Math.max(4_000, msLeft - SECOND_PASS_MS + 4_000))
  );

  if (!scan.ok || scan.roads.length === 0) return describeApproach(first, null, null);

  const nearestRoad = scan.roads[0];

  // Only roads that would actually be an improvement are worth a round trip.
  const candidates = scan.roads
    .filter((road) => road.distanceKm < first.gapToDestinationKm - IMPROVEMENT_KM)
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    // The route already ends on or beside the closest thing OSM has. Say which
    // road that is, if the ending is sitting on one.
    const end = first.geometry[first.geometry.length - 1];
    const endsOn = end
      ? scan.roads.find((road) => distanceKm(end[0], end[1], road.lat, road.lon) < 0.1) ?? null
      : null;
    return describeApproach(first, endsOn, nearestRoad);
  }

  /**
   * All at once, not one after another.
   *
   * The whole API is one serverless function with a thirty-second ceiling, and
   * three sequential twelve-second attempts blow through it. In parallel the
   * pass costs one attempt's worth of wall clock.
   */
  const budgetMs = Math.max(5_000, Math.min(11_000, msLeft - 3_000));
  const attempts = await Promise.all(
    candidates.map((road) =>
      routeVia({ from, to: [road.lat, road.lon], pin, rig, budgetMs }, orsKey)
        .then((body) => ({ body, road }))
        .catch(() => ({ body: null, road }))
    )
  );

  let best = first;
  let bestRoad: ApproachRoad | null = null;

  for (const { body, road } of attempts) {
    if (!body?.ok) continue;
    // Measured against the pin, like every other gap in this file.
    if (body.gapToDestinationKm > best.gapToDestinationKm - IMPROVEMENT_KM) continue;
    if (!acceptableDetour(first.distanceKm, body.distanceKm)) continue;
    best = body;
    bestRoad = road;
  }

  if (best === first) {
    /**
     * Nothing routable, but the road is still there.
     *
     * This is the case the whole file exists for: OSM draws a track four
     * hundred metres from the pin, the basemap shows it, and no engine will
     * touch it. `gapWarning` turns that into a sentence rather than leaving
     * the camper to assume the app cannot see what they can.
     */
    return describeApproach(first, null, nearestRoad);
  }

  const detour = best.distanceKm - first.distanceKm;
  if (detour > Math.max(8, first.distanceKm * 0.25)) {
    best.warnings.push({
      severity: 'info',
      message:
        `This route drives about ${Math.round(detour)} km further than the most ` +
        `direct line. The closest road to your spot is reached from another ` +
        `direction, and going that way ends ${readable(best.gapToDestinationKm)} ` +
        `from the pin instead of ${readable(first.gapToDestinationKm)}.`
    });
  }

  return describeApproach(best, bestRoad, nearestRoad);
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
  /**
   * The nearest mapped track to a point.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS A ROUTE AND NOT A FETCH FROM THE BROWSER
   * ---------------------------------------------------------------------------
   *
   * The map already asks this question — it is what the road chip's "show me
   * the track" does — and it used to ask Overpass itself, from the phone. That
   * worked some of the time, which is the worst way for something to work.
   * Three things were wrong with it and all three are fixed by asking from
   * here instead:
   *
   *   THE FILTERING WAS ON THE WRONG SIDE. The query asked for every `highway`
   *   within two kilometres and threw away the wrong kinds after they arrived,
   *   under a 120-element cap. Two kilometres of anywhere with houses on it is
   *   more than 120 ways, Overpass fills the cap in its own order rather than
   *   by distance, and the track the camper was standing beside was routinely
   *   not in what came back — so the app said "no mapped track within 2 km"
   *   with a road plainly drawn on the screen underneath it. `findApproachRoads`
   *   filters in the query, so the cap is never the thing that decides.
   *
   *   NOTHING BOUNDED THE WAIT. There was no timeout on the request and no
   *   abort, so a mirror having a bad minute left "Looking for the track…"
   *   sitting on the map until it gave up on its own. Each mirror here gets a
   *   hard nine seconds and then the next one is tried.
   *
   *   EVERY CAMPER PAID FOR EVERY LOOKUP. Overpass mirrors rate-limit by IP and
   *   ask people not to hammer them; a phone asking directly gets no benefit
   *   from the answer any other phone already got. This path is cached for six
   *   hours per point, which is conservative for something that changes on a
   *   timescale of years.
   *
   * It answers with the same honesty as everything else that reads OSM:
   * `ok: false` means we could not check, and `road: null` with `ok: true`
   * means nobody has mapped one — which is not the same as there not being one,
   * and the caller says so.
   */
  app.get('/api/roads/nearest', async (req: Request, res: ExpressResponse) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({
        ok: false, road: null, message: 'lat and lon are required numbers.'
      });
    }

    const asked = parseFloat(req.query.radiusKm as string);
    const radiusKm = Number.isFinite(asked) ? Math.max(0.3, Math.min(asked, 8)) : 2;

    // Seven seconds a mirror, not the nine the router allows itself. Somebody
    // is watching a "Looking for the track…" label while this runs.
    const scan = await findApproachRoads(lat, lon, radiusKm, 7000);

    /**
     * THE CHIP IS ABOUT A TRACK, NOT ABOUT ANY ROAD.
     *
     * `findApproachRoads` casts wider than this on purpose — it exists to give
     * a ROUTER somewhere better to aim, and a secondary highway is a perfectly
     * good thing to aim at. The chip is answering a different question: can a
     * vehicle get in HERE, on the kind of surface a dispersed site sits off.
     * Naming a paved secondary two hundred metres away as "the nearest track"
     * when there is a forest road four hundred metres away is the wrong answer
     * to what was asked, so the narrower kinds are preferred and the wider ones
     * are only used when there is nothing else.
     */
    const CAMPING_ACCESS = /^(track|unclassified|service|residential|tertiary)$/;
    const nearest =
      scan.roads.find((road) => CAMPING_ACCESS.test(road.kind)) ?? scan.roads[0] ?? null;

    return res.json({
      ok: scan.ok,
      road: nearest && {
        name: nearest.name,
        kind: nearest.kind,
        lat: nearest.lat,
        lon: nearest.lon,
        distanceKm: nearest.distanceKm,
        line: nearest.line,
        gated: nearest.gated
      }
    });
  });

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
    //
    // The rig half is built from sorted keys rather than JSON.stringify'd
    // directly: stringify preserves insertion order, so two identical rigs
    // built by different code paths would key differently and each pay for
    // the same route.
    const rigKey = Object.entries(rig)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    const cacheKey = `${nums.map((n) => n.toFixed(5)).join(',')}|${rigKey}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.body);

    const orsKey = process.env.ORS_API_KEY || process.env.VITE_ORS_API_KEY;

    /**
     * The whole request has to finish inside one serverless invocation, so the
     * budget is spent rather than assumed: the first attempt gets the long
     * timeout, and the second pass only starts if there is genuinely time for
     * it. Running out of clock costs a camper the entire route, which is a far
     * worse outcome than an unimproved one.
     */
    const deadline = Date.now() + 25_000;
    const msLeft = (): number => deadline - Date.now();

    const first = await routeVia({ from, to, pin: to, rig, budgetMs: 13_000 }, orsKey);

    if (!first) {
      return res.json({
        ...EMPTY,
        message:
          'No routing engine could be reached. Check your connection, or use the ' +
          'coordinates with an offline map app.'
      });
    }

    // A route that arrived needs no second opinion, and neither does one with
    // no time left to get one.
    const body =
      first.ok &&
      first.gapToDestinationKm > GAP_WORTH_RETRYING_KM &&
      msLeft() > SECOND_PASS_MS
        ? await improveApproach(first, from, to, rig, orsKey, msLeft())
        : first;

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, { at: Date.now(), body });

    return res.json(body);
  });
};
