/**
 * The two official alert feeds, and how we read them.
 *
 *   US      api.weather.gov   (NWS — asks for a contact string in User-Agent)
 *   Canada  api.weather.gc.ca (ECCC GeoMet, OGC API Features)
 *
 * This module used to live inside weatherRoutes.ts. It moved out when the
 * background ingest needed the same parsers: two copies of a classifier that
 * decides whether something is a fire warning is exactly the kind of thing
 * that drifts, and shared/hazards.ts already exists for that reason.
 *
 * Nothing here throws. A feed that is down returns an empty list, and the
 * caller reports the outage rather than pretending there are no alerts.
 */
// `.js` is required: this module is loaded under strict ESM on Vercel, where
// an extensionless relative import throws. See the note in weatherRoutes.ts.
import { classifyHazard, normaliseSeverity, normaliseUrgency } from '../shared/hazards.js';
import type { HazardFamily, AlertSeverity } from '../shared/hazards.js';
import { stateDistanceRank } from './usStates.js';

export const NWS_BASE = 'https://api.weather.gov';
export const ECCC_ALERTS = 'https://api.weather.gc.ca/collections/weather-alerts/items';

/**
 * ---------------------------------------------------------------------------
 * NEVER PUT `limit` ON `/alerts/active`. IT IS NOT A PAGINATED ENDPOINT.
 * ---------------------------------------------------------------------------
 *
 * `/alerts` accepts `limit` and `cursor`. `/alerts/active` accepts neither,
 * and it does not ignore them — it answers 400:
 *
 *     { "parameterErrors": [ { "parameter": "query.limit",
 *         "message": "Query parameter \"limit\" is not recognized" } ] }
 *
 * Both the viewport query and the nationwide ingest sent `&limit=500`, so
 * EVERY American alert lookup this app has ever made was rejected before it
 * left the building. Not intermittently, not under load — always, since the
 * day the by-state query was written. The map has never once drawn a warning
 * from the National Weather Service.
 *
 * It looked exactly like an outage because of how carefully everything
 * downstream handles one: a 400 became `null`, `null` became "we could not
 * reach the feed", and the honest empty answer that follows is
 * indistinguishable from a genuinely quiet sky. Two whole rounds of
 * investigation went into flakiness that was not there — the fix was deleting
 * eleven characters, and the reason it took so long is that nothing in the
 * pipeline ever read the sentence NWS was sending back explaining itself.
 * That is why `getJson` now keeps the body of a refusal.
 *
 * `/alerts/active` returns every alert matching the filter with no cap, which
 * is what we wanted anyway. `/zones` below is genuinely paginated and its
 * `limit` is correct.
 */

/**
 * ---------------------------------------------------------------------------
 * THE USER-AGENT IS PART OF THE API CONTRACT, NOT A NICETY
 * ---------------------------------------------------------------------------
 *
 * The National Weather Service requires a User-Agent identifying the
 * application and giving a way to contact whoever runs it, and refuses
 * requests that do not supply one it likes. The default here used to be the
 * literal string
 *
 *     'wandrlust-app (contact: set NWS_USER_AGENT in .env)'
 *
 * which is a to-do note, not a contact. On a deployment where NWS_USER_AGENT
 * was never set — which is every deployment of this app so far — that is what
 * went out on the wire, and it is a very good way to be shown the door.
 *
 * The default is now a real, valid agent string with a real contact: the
 * project's own public repository, which is where anybody at NWS with a
 * complaint would actually be able to reach somebody. NWS_USER_AGENT still
 * overrides it, so setting a personal email is still worth doing — but the
 * app is no longer BROKEN until somebody does.
 */
export const USER_AGENT =
  process.env.NWS_USER_AGENT?.trim() ||
  'Wandrlust/1.0 (free dispersed camping map; +https://github.com/blofstedt/Wandrlust)';

const UA = USER_AGENT;
const jsonHeaders = { 'User-Agent': UA, Accept: 'application/geo+json' };

/**
 * WHY A LOOKUP FAILED, WHICH USED TO BE THROWN AWAY.
 *
 * `getJson` collapsed a 403, a timeout and a DNS failure into the same `null`.
 * Every caller then folded that into "we could not check", which is the right
 * thing to tell a camper and useless for working out what is actually wrong —
 * so a feed that had been refusing this deployment for its entire life looked
 * identical to a phone with no signal, and could only be diagnosed by guessing.
 */
export interface FetchFailure {
  /** 'status' — it answered and said no. 'timeout' / 'network' — it did not answer. */
  kind: 'status' | 'timeout' | 'network';
  /** HTTP status, when there was one. */
  status?: number;
  /** The first line of the body or the error, trimmed. Never shown to a camper. */
  detail?: string;
}

export const describeFailure = (failure: FetchFailure | null): string | undefined => {
  if (!failure) return undefined;
  if (failure.kind === 'status') {
    return `HTTP ${failure.status}${failure.detail ? ` — ${failure.detail}` : ''}`;
  }
  return failure.kind === 'timeout' ? 'timed out' : `no answer${failure.detail ? ` — ${failure.detail}` : ''}`;
};

/** Statuses worth one immediate second attempt: throttling and transient 5xx. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface NormalisedAlert {
  id: string;
  family: HazardFamily;
  event: string;
  headline: string;
  description: string;
  instruction: string | null;
  severity: AlertSeverity | 'severe' | 'moderate' | 'minor';
  urgency: string;
  certainty: string | null;
  areaDescription: string;
  sender: string;
  effective: string | null;
  expires: string | null;
  source: 'nws' | 'eccc';
  geometry?: unknown;
  centroid?: [number, number];
  /**
   * Where `geometry` came from.
   *
   *   'polygon' — the agency drew this exact shape for this exact alert.
   *   'zone'    — the alert named forecast zones instead, and we fetched those
   *               zones' published outlines. Still the agency's own geometry,
   *               but it is the shape of the ZONE, not of the hazard inside it.
   *
   * The UI must say which, because a zone outline is a coarser claim and the
   * user is entitled to know that before deciding where to sleep.
   */
  areaSource?: 'polygon' | 'zone';
  /**
   * The `affectedZones` links this alert names, kept so each zone's published
   * outline can be fetched after the alerts are in. Full URLs rather than bare
   * ids — see `zoneUrlsOf` for why that distinction is the difference between
   * every American cloud drawing and none of them.
   */
  zoneUrls?: string[];
  /**
   * How many separate forecast regions this one alert covers.
   *
   * Only ECCC sets it, because only ECCC fans a single alert out into one row
   * per region. It is what lets the UI say "12 areas" instead of drawing
   * twelve markers that all mean the same thing.
   */
  zoneCount?: number;
}

/**
 * One GET, JSON out, null on any failure — and the failure handed to
 * `onFailure` rather than dropped on the floor. See FetchFailure.
 *
 * A throttled or transiently-broken feed gets ONE more go. Both agencies rate
 * limit by IP, and a serverless deployment shares its address with whoever
 * else is on that machine, so a first-attempt 429 is routine and permanent
 * failure is not what it means. One retry, not a loop: this runs inside a
 * request with a hard ceiling, and a feed that says no twice in a row is
 * saying no.
 */
export const getJson = async (
  url: string,
  timeoutMs = 9000,
  onFailure?: (failure: FetchFailure) => void
): Promise<any | null> => {
  const deadline = Date.now() + timeoutMs;
  let last: FetchFailure = { kind: 'network', detail: 'not attempted' };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = deadline - Date.now();
    if (left < 500) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const res = await fetch(url, { headers: jsonHeaders, signal: controller.signal });

      if (!res.ok) {
        // The body of a refusal is where the agency says WHY — NWS in
        // particular explains a rejected User-Agent in plain English.
        const body = await res.text().catch(() => '');
        last = {
          kind: 'status',
          status: res.status,
          detail: body.slice(0, 200).replace(/\s+/g, ' ').trim() || undefined
        };
        if (!RETRYABLE.has(res.status) || attempt === 1) break;
        continue;
      }

      return await res.json();
    } catch (err: any) {
      last = controller.signal.aborted
        ? { kind: 'timeout' }
        : { kind: 'network', detail: String(err?.message ?? err).slice(0, 200) };
      // A timeout has already spent the budget; trying again cannot help.
      if (last.kind === 'timeout' || attempt === 1) break;
    } finally {
      clearTimeout(timer);
    }
  }

  onFailure?.(last);
  return null;
};

/** Every outer ring in a Polygon or MultiPolygon, as [lon, lat] pairs. */
const outerRings = (geometry: any): [number, number][][] => {
  if (!geometry?.coordinates) return [];

  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0];
    return Array.isArray(ring) ? [ring] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygon: any) => polygon?.[0])
      .filter((ring: any) => Array.isArray(ring));
  }
  return [];
};

/** Shoelace area in square degrees. Only ever used to rank rings by size. */
const ringArea = (ring: [number, number][]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2);
};

/**
 * Mean of a ring's vertices, ignoring the repeated closing point.
 *
 * A GeoJSON ring states its first vertex twice, once to open and once to
 * close. Averaging it twice pulls the result toward that one corner — enough
 * to shift a marker several kilometres off the middle of a forecast region,
 * and always in the same direction.
 */
const ringCentroid = (ring: [number, number][]): [number, number] => {
  const closed =
    ring.length > 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const points = closed ? ring.slice(0, -1) : ring;
  if (points.length === 0) return [ring[0][1], ring[0][0]];

  let lon = 0;
  let lat = 0;
  for (const [x, y] of points) { lon += x; lat += y; }
  return [lat / points.length, lon / points.length];
};

/**
 * Where an alert applies, when the feed actually says.
 *
 * Both feeds return a GeoJSON geometry per alert — but not always. NWS in
 * particular sends `geometry: null` for zone-based products, naming the
 * affected zones by URL instead. We keep the polygon when there is one and
 * return null when there isn't.
 *
 * We do NOT fall back to the centre of the requested viewport, or to anything
 * else. A fire warning drawn in the wrong valley is worse than a fire warning
 * that only appears in the list, and this app's whole premise is not showing
 * people things it cannot stand behind.
 */
export const alertLocation = (
  feature: any
): { geometry: unknown; centroid: [number, number] } | null => {
  const geometry = feature?.geometry;
  if (!geometry || !geometry.type || !geometry.coordinates) return null;

  /**
   * The marker goes in the BIGGEST piece of the warned area, not the average
   * of all of them.
   *
   * Averaging every vertex was fine for one compact polygon and wrong the
   * moment an alert covers several separate regions — a warning for Vancouver
   * Island and the Rockies would put its marker in the water between them,
   * pointing at somewhere the warning explicitly does not cover. Taking the
   * largest ring guarantees the marker lands inside an area that is genuinely
   * under this alert.
   */
  const rings = outerRings(geometry);
  if (rings.length > 0) {
    const largest = rings.reduce((best, r) => (ringArea(r) > ringArea(best) ? r : best));
    if (largest.length > 0) return { geometry, centroid: ringCentroid(largest) };
  }

  // Anything that is not a polygon (a bare Point, mostly) still gets placed.
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  const walk = (node: any): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumLon += node[0];
      sumLat += node[1];
      count += 1;
      return;
    }
    node.forEach(walk);
  };
  walk(geometry.coordinates);

  if (count === 0) return null;
  return { geometry, centroid: [sumLat / count, sumLon / count] };
};

/**
 * The zone code at the end of an `affectedZones` URL.
 *
 * `https://api.weather.gov/zones/forecast/CAZ070` → `CAZ070`. Six characters:
 * two-letter state, Z or C, three digits. Returns null for anything else, so a
 * malformed entry is skipped rather than fetched.
 */
export const zoneCodeOf = (url: string): string | null => {
  const tail = url.split('/').pop()?.trim() ?? '';
  return /^[A-Z]{2}[ZC]\d{3}$/.test(tail) ? tail : null;
};

/**
 * The zone RESOURCE URLS an NWS alert names, straight out of `affectedZones`.
 *
 * ---------------------------------------------------------------------------
 * THE URLS ARE KEPT, NOT REDUCED TO IDS. THIS IS THE WHOLE FIX.
 * ---------------------------------------------------------------------------
 *
 * This used to throw the URLs away and keep bare ids, because the lookup that
 * followed asked the COLLECTION endpoint for fifty ids at a time. That lookup
 * never worked. Not intermittently — never, in production, on every request
 * this app has ever made: the deployment's own logs read
 *
 *     [alerts] resolved 0/50 zone outlines
 *     [alerts] resolved 0/128 zone outlines
 *
 * with no failure recorded beside them, which means the endpoint answered 200
 * and handed back nothing this code could use. Whatever the reason — the exact
 * shape it wants for a list of ids, or geometry it declines to include on a
 * collection — the answer is not to keep guessing at it. Every zone-based US
 * product is issued with `geometry: null`, so a lookup that returns nothing is
 * a map with no American heat, cold, wind, smoke or air-quality warnings on it
 * at all, which is exactly what was reported: a smoke area that stops dead at
 * the 49th parallel because only the Canadian half was ever drawn.
 *
 * `affectedZones` is a list of links the feed itself publishes, one per zone,
 * and the resource at the end of each one carries that zone's outline. Asking
 * NWS for the thing it just pointed at cannot be wrong about the parameters.
 * It costs one request per zone instead of one per fifty, which is why the
 * lookup below is bounded by a clock rather than a batch count.
 *
 * The host is checked because these strings are about to be fetched, and they
 * arrive over the wire.
 */
const zoneUrlsOf = (p: any): string[] => {
  const zones = p?.affectedZones;
  if (!Array.isArray(zones)) return [];
  const out: string[] = [];
  for (const url of zones) {
    if (typeof url !== 'string') continue;
    if (!/^https:\/\/api\.weather\.gov\/zones\//.test(url)) continue;
    if (!zoneCodeOf(url)) continue;
    out.push(url);
  }
  return out;
};

export const nwsAlertToHazard = (feature: any): NormalisedAlert => {
  const p = feature?.properties ?? {};
  const event = p.event ?? 'Weather alert';
  const located = alertLocation(feature);
  return {
    id: String(p.id ?? feature?.id ?? `${event}-${p.effective ?? ''}`),
    family: classifyHazard(event),
    event,
    headline: p.headline ?? event,
    description: p.description ?? '',
    instruction: p.instruction ?? null,
    severity: normaliseSeverity(p.severity),
    urgency: normaliseUrgency(p.urgency),
    certainty: p.certainty ?? null,
    areaDescription: p.areaDesc ?? '',
    sender: p.senderName ?? 'NWS',
    effective: p.effective ?? p.onset ?? null,
    expires: p.expires ?? p.ends ?? null,
    source: 'nws',
    zoneUrls: zoneUrlsOf(p),
    ...(located ?? {}),
    ...(located ? { areaSource: 'polygon' as const } : {})
  };
};

/* ---------------------------------------------------------------------------
 * NWS ZONE GEOMETRY — the reason heat, smoke and cold never reached the map
 * ---------------------------------------------------------------------------
 *
 * NWS issues two kinds of product:
 *
 *   Storm-based  Tornado, Severe Thunderstorm, Flash Flood. A polygon is drawn
 *                for the specific storm, and it arrives in the alert's
 *                `geometry`.
 *
 *   Zone-based   Heat Advisory, Excessive Heat Warning, Wind Chill / Extreme
 *                Cold, Winter Storm, Air Quality, Red Flag, Freeze, High Wind.
 *                `geometry` is NULL. The alert names the forecast zones it
 *                covers, by URL, in `affectedZones`.
 *
 * Every diffuse family this map draws as a cloud — smoke, heat, cold, wind —
 * is zone-based, so every one of them arrived with a null geometry, was
 * correctly refused a guessed position, and was silently counted as
 * "unplaceable". The map showed almost nothing while the feed was working
 * perfectly.
 *
 * The fix is not to invent a location. It is to go and fetch the zones the
 * alert itself names, at the URLs it names them by — one request per zone,
 * bounded by a clock and nearest the middle of the screen first.
 *
 * IT USED TO BATCH THEM, AND THAT IS WHY THIS COMMENT IS WORTH READING TWICE.
 * `api.weather.gov/zones?id=…&include_geometry=true` asks for fifty at a time
 * and looks obviously better. It returned nothing usable on every request this
 * app ever made — the deployment's logs read `resolved 0/50 zone outlines`,
 * over and over, with no failure recorded beside them, which means the endpoint
 * answered and handed back nothing we could read. So the map had no American
 * heat, cold, wind, smoke or air-quality warning on it at all, and a smoke area
 * over the border stopped dead at the 49th parallel with only the Canadian half
 * drawn. Fifty requests that work beat one that does not, and following the
 * link the feed just published cannot be wrong about how to ask.
 *
 * The result is flagged `areaSource: 'zone'` all the way to the UI. A zone
 * outline is a coarser claim than a drawn polygon and the app says so out loud
 * rather than letting the two look identical — which is also why it is safe to
 * coarsen the outline on the way out. See ZONE_SIMPLIFY_DEG.
 */

/** Zone outlines, cached hard — zone boundaries change on a scale of years. */
const zoneGeometryCache = new Map<string, { at: number; geometry: unknown | null }>();
const ZONE_TTL_MS = 24 * 60 * 60 * 1000;
const ZONE_CACHE_MAX = 4000;

/**
 * THE BUDGET IS A CLOCK, NOT A COUNT.
 *
 * One request per zone means the limit that matters is the thirty seconds this
 * function is allowed to live, shared with the alert queries that come before
 * it. So the lookup runs a fixed number of workers against a deadline and stops
 * issuing new requests when the time is gone, whatever it has managed by then.
 *
 * Everything about that is safe to do because of what happens to the leftovers:
 * a zone that was never asked about stays UNCACHED and its alert stays
 * unplaced, which the response already reports honestly and the client already
 * retries. `near` in `resolveNwsZoneGeometry` is what makes the deadline
 * acceptable rather than arbitrary — the zones under the middle of the screen
 * are asked about first, so what runs out of time is the far corner of the
 * viewport rather than the valley the camper is looking at.
 *
 * Ten at a time is roughly what a browser opens to one host and well inside
 * what NWS asks for. The count cap is a backstop for a winter morning naming
 * thousands of zones; the clock is what actually binds.
 */
const ZONE_CONCURRENCY = 10;
const ZONE_MAX_LOOKUPS = 300;
const ZONE_DEADLINE_MS = 8000;
/** Per-zone timeout. Short: one slow zone must not eat the whole deadline. */
const ZONE_TIMEOUT_MS = 6000;

const rememberZone = (id: string, geometry: unknown | null): void => {
  if (zoneGeometryCache.size >= ZONE_CACHE_MAX) {
    const oldest = zoneGeometryCache.keys().next().value;
    if (oldest) zoneGeometryCache.delete(oldest);
  }
  zoneGeometryCache.set(id, { at: Date.now(), geometry });
};

const cachedZone = (id: string): { geometry: unknown | null } | null => {
  const hit = zoneGeometryCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > ZONE_TTL_MS) { zoneGeometryCache.delete(id); return null; }
  return hit;
};

/**
 * Outlines for a set of zone URLs, one request each, keyed by zone code.
 *
 * Never throws. A zone that could not be fetched simply is not in the returned
 * map, and its alert stays unplaced rather than being drawn somewhere invented.
 */
const fetchZoneGeometries = async (urls: string[]): Promise<Map<string, unknown>> => {
  const found = new Map<string, unknown>();
  /** code → URL, in the order given, deduplicated. */
  const pending = new Map<string, string>();

  for (const url of urls) {
    const code = zoneCodeOf(url);
    if (!code || found.has(code) || pending.has(code)) continue;
    const hit = cachedZone(code);
    if (hit) {
      if (hit.geometry) found.set(code, hit.geometry);
      continue;
    }
    pending.set(code, url);
  }
  if (pending.size === 0) return found;

  const queue = [...pending.entries()].slice(0, ZONE_MAX_LOOKUPS);
  const deadline = Date.now() + ZONE_DEADLINE_MS;
  let next = 0;
  /** Refusals, reported once at the end rather than three hundred times. */
  const refusals: FetchFailure[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queue.length) return;

      // Out of time. Everything left is UNRESOLVED, not unavailable: nothing is
      // written to the cache for it, so the next request starts by asking.
      const left = deadline - Date.now();
      if (left < 600) return;

      const [code, url] = queue[index];
      const failed: FetchFailure[] = [];
      const data = await getJson(
        url, Math.min(left, ZONE_TIMEOUT_MS), (f) => { failed.push(f); }
      );

      const geometry = data?.geometry ?? null;
      if (geometry) {
        rememberZone(code, geometry);
        found.set(code, geometry);
        continue;
      }

      /**
       * NWS ANSWERED AND HAD NO OUTLINE — remember that, so we ask once rather
       * than on every pan. A TIMEOUT OR A DROPPED CONNECTION IS NOT AN ANSWER,
       * and caching it would blacklist a real zone for a day over one bad
       * moment on the network. That distinction is the same one the whole
       * alert path is built around, one level down.
       */
      const failure = failed[0];
      if (!failure) rememberZone(code, null);
      else {
        refusals.push(failure);
        if (failure.kind === 'status') rememberZone(code, null);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(ZONE_CONCURRENCY, queue.length) }, () => worker())
  );

  /*
   * Logged, not swallowed. `/alerts/active` was rejecting every request for an
   * unrecognised query parameter and nothing noticed for months, because the
   * refusal was turned into `null` and `null` reads as "the feed is down". A
   * zone lookup that fails takes the CLOUDS off the map while leaving the
   * alerts in the list, which is an even quieter way to be broken.
   */
  if (refusals.length > 0) {
    console.warn(
      `[alerts] ${refusals.length}/${queue.length} zone outlines unavailable: ` +
      `${describeFailure(refusals[0])}`
    );
  }

  return found;
};

/* ---- Keeping the response a size a phone can actually receive ------- */

/** Perpendicular distance from `p` to the segment `a`–`b`, in degrees. */
const perpDistance = (
  p: [number, number], a: [number, number], b: [number, number]
): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/**
 * HOW COARSE A ZONE OUTLINE IS ALLOWED TO GET. ~100 m.
 *
 * NWS forecast and county zones are surveyed administrative polygons that
 * follow section lines with vertices metres apart — a single zone runs to
 * thousands of points, and one alert can name a hundred zones. Sent whole, a
 * busy summer viewport is several megabytes of coordinates down a phone's
 * connection, and this app is used where that connection is one bar.
 *
 * A hundred metres is nothing against a zone tens of kilometres across, and
 * the app has never claimed this edge to that precision: an outline resolved
 * this way is flagged `areaSource: 'zone'` all the way to the UI, which says
 * out loud that the shape is the REGION under warning and not the edge of the
 * hazard. The map then softens it further and draws it blurred, precisely so
 * nobody reads a survey line as a place where the weather stops.
 *
 * What it must not do is drop a zone. Rings that are already small are left
 * exactly as they are.
 */
const ZONE_SIMPLIFY_DEG = 0.001;
const ZONE_SIMPLIFY_MIN_POINTS = 40;

/**
 * Douglas–Peucker on one ring, iterative rather than recursive — a ring with a
 * few thousand vertices is one deep call stack away from a blown one.
 */
const coarsenRing = (ring: [number, number][]): [number, number][] => {
  if (!Array.isArray(ring) || ring.length < ZONE_SIMPLIFY_MIN_POINTS) return ring;

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;

  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    if (j <= i + 1) continue;
    let farthest = -1;
    let farthestDistance = ZONE_SIMPLIFY_DEG;
    for (let k = i + 1; k < j; k += 1) {
      const d = perpDistance(ring[k], ring[i], ring[j]);
      if (d > farthestDistance) { farthestDistance = d; farthest = k; }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([i, farthest], [farthest, j]);
  }

  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 1) if (keep[i]) out.push(ring[i]);
  // Too little left to be a shape. Keep the original rather than send a sliver.
  return out.length < 5 ? ring : out;
};

/** Every ring of every polygon in a zone-built MultiPolygon, coarsened. */
const coarsenParts = (parts: any[]): any[] =>
  parts.map((rings) => (Array.isArray(rings) ? rings.map(coarsenRing) : rings));

/** Every polygon ring in a geometry, flattened for merging. */
const polygonParts = (geometry: any): any[] => {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

/**
 * Give zone-based alerts the outline of the zones they name.
 *
 * Alerts that already carry a polygon are returned untouched. Alerts we still
 * cannot place — no zones, or a zone lookup that failed — are returned
 * unplaced, and the UI keeps counting them as unplaceable. That count staying
 * honest is the point; this just makes it small.
 */
export const resolveNwsZoneGeometry = async (
  alerts: NormalisedAlert[],
  /**
   * The middle of the viewport that asked, when the caller knows it.
   *
   * Zone lookups run under a hard budget (see ZONE_MAX_BATCHES), and which
   * zones get resolved decides which alerts can be DRAWN — an alert with no
   * geometry is skipped by the map entirely. Without this the budget went in
   * arrival order, so a wide viewport over the Rockies could spend all of it
   * on the Gulf coast and leave every heat and smoke product on screen
   * unplaced. Nearest-first spends it where the camper is looking.
   */
  near?: { lat: number; lon: number }
): Promise<NormalisedAlert[]> => {
  const needsGeometry = alerts.filter((a) => !a.geometry && (a.zoneUrls?.length ?? 0) > 0);
  if (needsGeometry.length === 0) return alerts;

  let wanted = [...new Set(needsGeometry.flatMap((a) => a.zoneUrls ?? []))];

  if (near) {
    /* An NWS zone code starts with its state: "COZ034" is Colorado zone 34.
       That prefix is the only locating information available before the outline
       is fetched, and it is enough to sort by. */
    wanted = wanted
      .map((url) => ({
        url,
        rank: stateDistanceRank((zoneCodeOf(url) ?? '').slice(0, 2), near.lat, near.lon)
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.url);
  }

  const outlines = await fetchZoneGeometries(wanted);
  /*
   * An alert with no geometry is never drawn — the map refuses to invent a
   * position for it — so a zone lookup that comes back empty takes every US
   * cloud off the map while leaving the warnings in the list. That is a very
   * quiet way to be broken, and it is worth one line saying so.
   */
  if (outlines.size < wanted.length) {
    console.warn(
      `[alerts] resolved ${outlines.size}/${wanted.length} zone outlines` +
      `${outlines.size === 0 ? ` — first few wanted: ${wanted.slice(0, 5).join(',')}` : ''}`
    );
  }
  if (outlines.size === 0) return alerts;

  return alerts.map((alert) => {
    if (alert.geometry || !alert.zoneUrls?.length) return alert;

    const parts = alert.zoneUrls.flatMap((url) => {
      const code = zoneCodeOf(url);
      return code ? polygonParts(outlines.get(code)) : [];
    });
    if (parts.length === 0) return alert;

    const geometry = { type: 'MultiPolygon', coordinates: coarsenParts(parts) };
    const placed = alertLocation({ geometry });
    if (!placed) return alert;

    return {
      ...alert,
      geometry,
      centroid: placed.centroid,
      areaSource: 'zone' as const,
      // How many zones this alert actually covers, so the UI can say
      // "6 forecast zones" the same way it does for Environment Canada.
      zoneCount: alert.zoneCount ?? alert.zoneUrls.length
    };
  });
};

/**
 * Drop the zone links before the alerts go down the wire.
 *
 * They are a server-side handoff between parsing an alert and fetching its
 * outline, and nothing on the client has ever read them. A single heat advisory
 * can name a hundred zones, so leaving them on is tens of kilobytes of URLs
 * sent to a phone that will not look at them.
 */
export const withoutZoneUrls = (alerts: NormalisedAlert[]): NormalisedAlert[] =>
  alerts.map(({ zoneUrls, ...alert }) => alert);

/**
 * ---------------------------------------------------------------------------
 * THE ECCC FIELD NAMES. GET THESE WRONG AND THE MAP LIES.
 * ---------------------------------------------------------------------------
 *
 * This parser previously read `alert_type` as the event name, and `alert_type`
 * is not the event — it is the SEVERITY WORD: "warning", "watch", "advisory",
 * "statement". So every Canadian alert in the app was titled "warning",
 * described as "warning", classified as 'other' because "warning" matches no
 * hazard keyword, and drawn as an identical grey triangle. Thirty-odd of them
 * across the Rockies, every one useless.
 *
 * The real names, from ECCC's own pygeoapi config and the GeoMet alerts docs:
 *
 *   alert_name_en        the event — "wind warning", "Special Weather Statement"
 *   alert_short_name_en  a terser form of the same
 *   alert_type           warning | watch | advisory | statement | ended
 *   alert_coverage_en    what the alert covers
 *   feature_name_en      the affected region — "Alma - Desbiens area"
 *   province             two-letter province code
 *   status_en            issued | continued | ended | ...
 *   risk_colour_en       yellow | orange | red, ECCC's own severity ramp
 *   impact_en            minor | moderate | major | severe
 *   expiration_datetime / event_end_datetime
 *   effective_datetime / event_start_datetime
 *
 * Note there is NO long description field in this collection — it is an index,
 * not the full CAP bulletin. So `description` is deliberately left empty rather
 * than stuffed with a repeat of the title, and the UI must cope with that.
 */
const pick = (p: any, names: string[]): string | undefined => {
  for (const name of names) {
    const value = p?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

/**
 * ECCC's severity, from the strongest signal available.
 *
 * `risk_colour_en` and `impact_en` are the real severity fields; `alert_type`
 * is the fallback ladder (warning > watch > advisory > statement) and is what
 * most products actually carry.
 */
const ecccSeverity = (p: any): NormalisedAlert['severity'] => {
  const colour = String(p?.risk_colour_en ?? '').toLowerCase();
  if (colour === 'red') return 'extreme';
  if (colour === 'orange') return 'severe';

  const impact = String(p?.impact_en ?? '').toLowerCase();
  if (impact === 'severe' || impact === 'extreme') return 'extreme';
  if (impact === 'major') return 'severe';
  if (impact === 'moderate') return 'moderate';

  const kind = String(p?.alert_type ?? '').toLowerCase();
  if (kind.includes('warning')) return 'severe';
  if (kind.includes('watch')) return 'moderate';
  return 'minor';
};

/** True once ECCC has stood an alert down. These must never reach the map. */
export const isEndedEcccAlert = (feature: any): boolean => {
  const p = feature?.properties ?? {};
  return String(p.status_en ?? '').toLowerCase() === 'ended' ||
    String(p.alert_type ?? '').toLowerCase() === 'ended';
};

export const ecccAlertToHazard = (feature: any): NormalisedAlert => {
  const p = feature?.properties ?? {};
  const located = alertLocation(feature);

  const event = pick(p, ['alert_name_en', 'alert_short_name_en']) ??
    // Last resort only. If we ever land here the title reads like the old bug,
    // so it is worth it being obviously a fallback rather than silently wrong.
    (p.alert_type ? `Weather ${String(p.alert_type).toLowerCase()}` : 'Weather alert');

  const area = pick(p, ['feature_name_en', 'area', 'location']) ??
    (typeof p.province === 'string' ? p.province : '');

  /**
   * The identity of the ALERT, not of this row.
   *
   * ECCC returns one feature per affected region, so a single wind warning
   * arrives as a dozen rows sharing an `alert_code`. Keying on that is what
   * lets `mergeZoneAlerts` put them back together into one thing on the map.
   */
  const identity = pick(p, ['alert_code', 'identifier']) ??
    `${event}|${p.alert_type ?? ''}|${p.expiration_datetime ?? ''}`;

  return {
    id: String(identity),
    family: classifyHazard(`${event} ${pick(p, ['alert_coverage_en']) ?? ''}`),
    event,
    headline: pick(p, ['headline_en', 'headline', 'alert_coverage_en']) ?? event,
    description: pick(p, ['descrip_en', 'description_en', 'description']) ?? '',
    instruction: pick(p, ['instruction_en', 'instruction']) ?? null,
    severity: ecccSeverity(p),
    urgency: 'expected',
    certainty: null,
    areaDescription: area,
    sender: 'Environment and Climate Change Canada',
    effective: pick(p, ['effective_datetime', 'event_start_datetime', 'effective']) ?? null,
    expires: pick(p, ['expiration_datetime', 'event_end_datetime', 'expires']) ?? null,
    source: 'eccc',
    ...(located ?? {}),
    // ECCC publishes the forecast region's own outline with every alert, which
    // is the same kind of claim as an NWS zone: the region warned, not a shape
    // drawn around the hazard.
    ...(located ? { areaSource: 'zone' as const } : {})
  };
};

/**
 * One alert per alert, however many regions it covers.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * ECCC publishes weather alerts one row PER AFFECTED FORECAST REGION. A single
 * snowfall warning over the Rockies is thirty-odd features, each with its own
 * polygon and its own region name, all sharing one `alert_code`. Drawing a
 * marker per feature blanketed the map in identical triangles — and every one
 * of them opened the same popup, so the map looked like thirty emergencies and
 * told you nothing about any of them.
 *
 * Merging them is not cosmetic. Thirty triangles reads as thirty hazards; it
 * overstates what the feed said, which is the one thing this app does not do.
 *
 * The merged alert keeps EVERY region's polygon (as a MultiPolygon, so the
 * drawn area is still exactly what ECCC warned about) and every region's name,
 * and takes its marker position from the largest of them.
 */
export const mergeZoneAlerts = (alerts: NormalisedAlert[]): NormalisedAlert[] => {
  const byIdentity = new Map<string, NormalisedAlert & { _areas: string[] }>();

  for (const alert of alerts) {
    const existing = byIdentity.get(alert.id);

    if (!existing) {
      byIdentity.set(alert.id, {
        ...alert,
        _areas: alert.areaDescription ? [alert.areaDescription] : []
      });
      continue;
    }

    if (alert.areaDescription && !existing._areas.includes(alert.areaDescription)) {
      existing._areas.push(alert.areaDescription);
    }

    // Collect this region's polygons alongside the ones already gathered.
    const parts = [existing.geometry, alert.geometry]
      .flatMap((g: any) => {
        if (!g) return [];
        if (g.type === 'Polygon') return [g.coordinates];
        if (g.type === 'MultiPolygon') return g.coordinates;
        return [];
      });

    if (parts.length > 0) {
      existing.geometry = { type: 'MultiPolygon', coordinates: parts };
      const placed = alertLocation({ geometry: existing.geometry });
      if (placed) existing.centroid = placed.centroid;
    }

    // The worst severity any region was given governs the merged alert.
    if (SEVERITY_ORDER[alert.severity] > SEVERITY_ORDER[existing.severity]) {
      existing.severity = alert.severity;
    }
  }

  return [...byIdentity.values()].map(({ _areas, ...alert }) => ({
    ...alert,
    zoneCount: _areas.length,
    // Three names is enough to recognise where this is; the rest is a count.
    areaDescription: _areas.length > 3
      ? `${_areas.slice(0, 3).join(', ')} and ${_areas.length - 3} more areas`
      : _areas.join(', ')
  }));
};

const SEVERITY_ORDER: Record<string, number> = {
  extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: 0
};

/** Alerts active at a single point (used by the per-site weather lookup). */
export const fetchNwsAlertsAtPoint = async (lat: number, lon: number): Promise<NormalisedAlert[]> => {
  const data = await getJson(`${NWS_BASE}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
  // Nothing here is drawn — the point is already known — so the zone links are
  // pure weight on the wire. See `withoutZoneUrls`.
  return Array.isArray(data?.features)
    ? withoutZoneUrls(data.features.map(nwsAlertToHazard))
    : [];
};

/**
 * Every actual alert in force across a set of states.
 *
 * The NWS API has no bbox query — it answers for one point, or for a list of
 * states. Asking by state is how a viewport gets the alerts that are on screen
 * but not directly under its centre; the caller filters the result back down to
 * the real viewport once the geometry is attached.
 *
 * Returns NULL when the feed could not be reached, so the caller can tell
 * "nothing in force" apart from "we did not get an answer". It used to return
 * `[]` for both, which the route then cached for five minutes and served to
 * every camper in the region as a clear sky.
 */
export const fetchNwsAlertsForStates = async (
  states: string[],
  onFailure?: (failure: FetchFailure) => void
): Promise<NormalisedAlert[] | null> => {
  if (states.length === 0) return [];
  const data = await getJson(
    `${NWS_BASE}/alerts/active?status=actual&message_type=alert` +
    `&area=${states.join(',')}`,
    15000,
    onFailure
  );
  if (!data) return null;
  return Array.isArray(data.features) ? data.features.map(nwsAlertToHazard) : [];
};

/**
 * Every actual alert currently in force across the NWS.
 *
 * `status=actual` drops exercise and test products — we do not want a drill
 * waking somebody at 3am. `message_type=alert` drops the update/cancel
 * bookkeeping messages, which carry no new information for a camper.
 */
export const fetchNwsActiveAlerts = async (): Promise<NormalisedAlert[] | null> => {
  const data = await getJson(
    `${NWS_BASE}/alerts/active?status=actual&message_type=alert`,
    20000
  );
  if (!data) return null;
  return Array.isArray(data.features) ? data.features.map(nwsAlertToHazard) : [];
};

/**
 * ECCC alerts around a point.
 *
 * ---------------------------------------------------------------------------
 * THE LIMIT IS ROWS, NOT ALERTS, AND 50 WAS NOT ENOUGH.
 * ---------------------------------------------------------------------------
 *
 * Environment Canada publishes one row PER AFFECTED FORECAST REGION, so a
 * single smoke advisory over British Columbia can be forty rows on its own. At
 * `limit=50` a busy fire-season viewport hit the ceiling constantly, and which
 * alerts made the cut depended on where the box happened to sit — so panning a
 * few kilometres swapped one warning out for another and the smoke area
 * appeared and disappeared as you dragged. The nationwide ingest already asks
 * for 500; the viewport query has no reason to ask for less.
 */
export const fetchEcccAlerts = async (
  lat: number, lon: number,
  spanLatDeg = 1.0,
  /**
   * Half-width, when the area of interest is not square.
   *
   * A viewport is almost never square, and passing the LARGER half-dimension
   * for both — which is what a single `spanDeg` forced the caller to do — asked
   * GeoMet about a great deal of ground the camper cannot see. On a wide
   * landscape view that meant hundreds of extra kilometres of latitude, five
   * hundred rows of forecast-region geometry to serialise, and a query slow
   * enough to lose its own timeout. Defaults to the height, so the old
   * square-box callers are unchanged.
   */
  spanLonDeg = spanLatDeg,
  onFailure?: (failure: FetchFailure) => void
): Promise<NormalisedAlert[] | null> => {
  const bbox = [
    (lon - spanLonDeg).toFixed(3), (lat - spanLatDeg).toFixed(3),
    (lon + spanLonDeg).toFixed(3), (lat + spanLatDeg).toFixed(3)
  ].join(',');

  /*
   * FIFTEEN SECONDS, NOT NINE.
   *
   * GeoMet is the slower of the two feeds by a long way — it is answering a
   * spatial query over every alert in the country, and five hundred rows of
   * forecast-region geometry is a big response. The nine-second default was
   * losing the race often enough that Canada was simply missing from the map
   * on any view wider than a valley, and the caller could not tell a slow feed
   * from a quiet sky. Both feeds now run in parallel (see weatherRoutes), so
   * the extra six seconds cost the request nothing.
   */
  const data = await getJson(
    `${ECCC_ALERTS}?bbox=${bbox}&lang=en&limit=500&f=json`, 15_000, onFailure
  );
  // Null, not [], when GeoMet could not be reached — see the note on
  // fetchNwsAlertsForStates. A cached empty sky is the worst outcome here.
  if (!data) return null;
  if (!Array.isArray(data.features)) return [];
  return mergeZoneAlerts(
    data.features.filter((f: any) => !isEndedEcccAlert(f)).map(ecccAlertToHazard)
  );
};

/**
 * Every ECCC alert inside the app's Canadian coverage.
 *
 * One bbox spanning the provinces, capped at the 60th parallel to match
 * config/coverage.ts. Returns null when the feed could not be reached, so the
 * caller can tell "nothing active" apart from "we did not get an answer".
 */
export const fetchEcccActiveAlerts = async (): Promise<NormalisedAlert[] | null> => {
  const data = await getJson(
    `${ECCC_ALERTS}?bbox=-141.0,41.0,-52.0,60.0&lang=en&limit=500&f=json`,
    20000
  );
  if (!data) return null;
  if (!Array.isArray(data.features)) return [];
  return mergeZoneAlerts(
    data.features.filter((f: any) => !isEndedEcccAlert(f)).map(ecccAlertToHazard)
  );
};

/** Rough test for "is this coordinate in the contiguous US". */
export const looksUS = (lat: number, lon: number): boolean =>
  lat >= 24.4 && lat <= 49.5 && lon >= -125.1 && lon <= -66.8;