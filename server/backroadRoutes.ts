/**
 * The little roads, drawn on the map.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The default basemap is satellite imagery, and satellite imagery has no
 * roads on it at all — you can SEE a two-track scratched across a mesa, but
 * nothing tells you it is a road, where it goes, or that it dead-ends at a
 * gate. Switch to the street basemap and the opposite problem shows up: the
 * cartography that renders well at city scale drops most tracks, and the ones
 * it keeps are drawn as faint hairlines under everything else.
 *
 * Meanwhile the roads that matter for dispersed camping are precisely the
 * ones nobody renders: forest service spurs, BLM two-tracks, gravel section
 * roads, the grass line through a cutblock. OpenStreetMap has them — hundreds
 * of thousands of miles of them, tagged `highway=track` or carrying a
 * `surface` that says gravel, dirt, ground or grass. This route asks OSM for
 * the ones inside the viewport and hands them to the map to draw.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LINE ON THIS LAYER MEANS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It means: a volunteer recorded a road here at some point.
 *
 * It does NOT mean the road is passable, maintained, ungated, legal to drive,
 * open this season, or suitable for whatever the camper is towing. OSM's
 * coverage of the backcountry is patchy and its surface tags are missing far
 * more often than they are present — so this layer reports three states, not
 * two: known unpaved, known paved, and NOT RECORDED. Never collapse the third
 * into either of the others. A minor road with no surface tag is a road whose
 * surface nobody has written down, and the map draws it dotted to say so.
 *
 * Nothing here throws. An Overpass outage is `ok: false` with no roads, which
 * the client renders as "couldn't check", never as "no roads here".
 */
import type { Express, Request, Response } from 'express';
import { USER_AGENT } from './alertSources.js';

/* Same three mirrors, same reasoning, as server/roadNetwork.ts:
   overpass.osm.ch is Switzerland-only and answers for other continents with a
   fast, confident zero. */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/**
 * The kinds worth drawing without asking about surface.
 *
 * `track` is the whole point of the layer — it is what OSM calls a road built
 * for forestry, agriculture or resource access, which is nearly every road a
 * dispersed site sits off. The rest are the rural minor classes: an unnamed
 * `unclassified` county road through a national forest and a gravel
 * `service` spur to a gravel pit are both roads a camper might drive in on.
 */
const MINOR_KINDS =
  '^(track|unclassified|service|residential|living_street|road)$';

/**
 * Surfaces that mean "not pavement".
 *
 * `compacted` and `fine_gravel` are in here because they are what a graded
 * forest road gets tagged when somebody is being precise, and a camper
 * reading "unpaved" about them is not being misled.
 */
const UNPAVED_SURFACES = new Set([
  'unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'earth', 'ground',
  'grass', 'sand', 'mud', 'rock', 'pebblestone', 'woodchips', 'shells',
  'stepping_stones', 'clay'
]);

const PAVED_SURFACES = new Set([
  'paved', 'asphalt', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'sett', 'cobblestone', 'chipseal', 'metal', 'wood'
]);

const MINOR_KIND_RE = new RegExp(MINOR_KINDS);

/** The same regex, for the bigger classes we only want when they are gravel. */
const MAJOR_KINDS = '^(tertiary|secondary|primary)(_link)?$';

/**
 * How much ground one request may cover.
 *
 * A degree square of the Rockies holds tens of thousands of tracks, which is
 * both more than Overpass will happily assemble and far more than anything
 * legible on a phone. The client only asks at zoom 12 and above, where even a
 * wide desktop viewport is well inside this; the cap is here so a hand-made
 * request for half a continent is refused politely instead of timing out.
 */
const MAX_AREA_SQ_DEG = 1.2;

/** Ways per answer. Beyond this the answer is marked truncated. */
const MAX_WAYS = 700;

/** Total vertices per answer, across every way. Payload, not pedantry. */
const MAX_POINTS = 26_000;

/** Shorter than this is a driveway stub or a digitising artefact. */
const MIN_LENGTH_M = 45;

export type BackroadSurface = 'unpaved' | 'paved' | 'unrecorded';
export type BackroadAccess = 'open' | 'permit' | 'private';

export interface BackroadWay {
  /** OSM way id. Stable enough to key a React render on. */
  id: number;
  /** Name or road number. Most tracks have neither, and that is normal. */
  name: string | null;
  /** The raw `highway` value — `track`, `service`, `unclassified`… */
  kind: string;
  /** What OSM records about the surface. `unrecorded` is a real answer. */
  surface: BackroadSurface;
  /** The raw tag, for the one line of text the map shows. */
  surfaceTag: string | null;
  /** OSM says a permit or permission is needed, or that it is private. */
  access: BackroadAccess;
  /** A gate, bollard or barrier is recorded on the way. */
  gated: boolean;
  /** Seasonal access, or explicitly not ploughed. */
  seasonal: boolean;
  /** `4wd_only=yes`, or smoothness bad enough to mean the same thing. */
  fourWheelDrive: boolean;
  /** [lat, lon] pairs, simplified for drawing. */
  line: [number, number][];
}

export interface BackroadScan {
  /** False means we could not check — never "there are no roads here". */
  ok: boolean;
  /** True when the box was too big to ask about. */
  tooWide: boolean;
  /** True when roads were dropped to keep the answer drawable. */
  truncated: boolean;
  roads: BackroadWay[];
}

const EMPTY: BackroadScan = { ok: false, tooWide: false, truncated: false, roads: [] };

interface OverpassWay {
  type: string;
  id?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Reading the tags                                                    */
/* ------------------------------------------------------------------ */

const surfaceOf = (tags: Record<string, string>): { surface: BackroadSurface; tag: string | null } => {
  const raw = tags.surface?.trim().toLowerCase();
  if (raw && UNPAVED_SURFACES.has(raw)) return { surface: 'unpaved', tag: raw };
  if (raw && PAVED_SURFACES.has(raw)) return { surface: 'paved', tag: raw };

  /**
   * `tracktype` grades a track from grade1 (solid, often gravel) to grade5
   * (soft, mud or sand). Every grade below 1 is unpaved by definition, and
   * grade1 covers both a gravel road and a paved farm lane — so grade1 alone
   * is NOT read as an answer about the surface.
   */
  const grade = tags.tracktype?.trim().toLowerCase();
  if (grade && /^grade[2-5]$/.test(grade)) return { surface: 'unpaved', tag: grade };

  return { surface: 'unrecorded', tag: raw ?? null };
};

const accessOf = (tags: Record<string, string>): BackroadAccess => {
  const values = [tags.access, tags.motor_vehicle, tags.vehicle, tags.motorcar]
    .filter(Boolean)
    .map((v) => v!.trim().toLowerCase());

  if (values.some((v) => v === 'private' || v === 'no')) return 'private';
  if (values.some((v) => v === 'permit' || v === 'permissive' || v === 'destination' || v === 'customers')) {
    return 'permit';
  }
  return 'open';
};

const isGated = (tags: Record<string, string>): boolean =>
  tags.barrier === 'gate' || tags.barrier === 'lift_gate' || tags.barrier === 'bollard' ||
  tags.barrier === 'block' || tags.gate === 'yes' || tags.locked === 'yes';

const isSeasonal = (tags: Record<string, string>): boolean =>
  Boolean(tags.seasonal) || tags.snowplowing === 'no' || Boolean(tags['motor_vehicle:conditional']);

const needsFourWheelDrive = (tags: Record<string, string>): boolean =>
  tags['4wd_only'] === 'yes' ||
  tags.smoothness === 'very_bad' || tags.smoothness === 'horrible' ||
  tags.smoothness === 'very_horrible' || tags.smoothness === 'impassable' ||
  tags.tracktype === 'grade5';

/**
 * Service roads worth drawing, and the two kinds that are pure clutter.
 *
 * A supermarket car park's aisles and the driveway to a farmhouse are both
 * `highway=service`, and drawing either over satellite imagery adds noise
 * without adding a way in.
 */
const isClutterService = (tags: Record<string, string>): boolean =>
  tags.highway === 'service' &&
  (tags.service === 'parking_aisle' || tags.service === 'driveway' ||
   tags.service === 'drive-through' || tags.service === 'emergency_access');

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Flat-earth metres. Over one way's length the error is far below anything
    downstream claims. */
const metresBetween = (
  aLat: number, aLon: number, bLat: number, bLon: number
): number => {
  const kx = 111_320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  const ky = 110_540;
  const dx = (bLon - aLon) * kx;
  const dy = (bLat - aLat) * ky;
  return Math.sqrt(dx * dx + dy * dy);
};

const lengthMetres = (points: { lat: number; lon: number }[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += metresBetween(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
};

/**
 * Douglas–Peucker, in degrees, iteratively.
 *
 * A forest road can be six hundred points long and none of them are visible
 * as separate bends at the zoom this layer draws at. Dropping the ones inside
 * a tolerance keeps the shape and cuts the payload by an order of magnitude.
 *
 * Written as a stack rather than a recursion on purpose: a way with several
 * thousand vertices — a river-following logging road, say — is enough to blow
 * the call stack on a serverless runtime, and the whole request would die
 * with it.
 */
const simplify = (
  points: { lat: number; lon: number }[],
  tolerance: number
): { lat: number; lon: number }[] => {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const ax = points[first].lon;
    const ay = points[first].lat;
    const bx = points[last].lon;
    const by = points[last].lat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstIndex = first;

    for (let i = first + 1; i < last; i += 1) {
      const px = points[i].lon;
      const py = points[i].lat;

      let distSq: number;
      if (lenSq === 0) {
        distSq = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      }

      if (distSq > worst) { worst = distSq; worstIndex = i; }
    }

    if (worst > tolerance * tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * Keyed on the box the client asked for, which it snaps to a grid before
 * asking — so an ordinary pan is the same question and costs nothing.
 *
 * Roads change on a timescale of years; twelve hours is conservative. The
 * cache is small because each entry holds real geometry, and a serverless
 * instance that hoards forty of them is a serverless instance being killed
 * for memory.
 */
interface CacheEntry { at: number; scan: BackroadScan; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 24;

/* ------------------------------------------------------------------ */

const scanBox = async (
  minLat: number, minLon: number, maxLat: number, maxLon: number,
  timeoutMs: number
): Promise<BackroadScan> => {
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;

  if (latSpan * lonSpan > MAX_AREA_SQ_DEG) {
    return { ok: true, tooWide: true, truncated: false, roads: [] };
  }

  const key = [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(3)).join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scan;

  const bbox = `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`;

  /**
   * Two clauses, not one.
   *
   * The minor kinds come back whatever their surface, because an unnamed
   * county road with no surface tag is exactly the road this layer exists to
   * show. The bigger classes come back ONLY when they are tagged unpaved —
   * a paved secondary highway is already on every basemap ever drawn, and
   * pulling its geometry would cost more than the rest of the answer put
   * together.
   */
  const query =
    `[out:json][timeout:25];` +
    `(` +
    `way["highway"~"${MINOR_KINDS}"](${bbox});` +
    `way["highway"~"${MAJOR_KINDS}"]["surface"](${bbox});` +
    `);` +
    `out geom ${MAX_WAYS * 3};`;

  let ways: OverpassWay[] | null = null;

  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { elements?: unknown };
      if (!Array.isArray(data?.elements)) continue;

      ways = data.elements as OverpassWay[];
      break;
    } catch {
      // Next mirror. Only every mirror failing is an outage.
    } finally {
      clearTimeout(timer);
    }
  }

  // An outage is `ok: false`. It is never an empty-but-confident answer.
  if (!ways) return EMPTY;

  /**
   * Simplify to about a fifth of a screen pixel at the zoom this box implies.
   * Anything finer is invisible and is paid for twice — once on the wire and
   * once every time the canvas redraws during a pan.
   */
  const tolerance = Math.max(lonSpan, latSpan) / 4000;

  interface Scored { way: BackroadWay; metres: number; }
  const scored: Scored[] = [];

  for (const way of ways) {
    const tags = way.tags ?? {};
    const geometry = way.geometry ?? [];
    if (geometry.length < 2) continue;
    if (isClutterService(tags)) continue;

    const { surface, tag } = surfaceOf(tags);

    /**
     * A major road only earns its place by being unpaved. The Overpass clause
     * above asked for every tagged surface rather than a regex of unpaved
     * ones, because OSM's surface values are a long tail and the tail is
     * where the gravel highways live — so the decision is made here, where
     * the full vocabulary is in one place.
     */
    const isMajor = !MINOR_KIND_RE.test(tags.highway ?? '');
    if (isMajor && surface !== 'unpaved') continue;

    const metres = lengthMetres(geometry);
    if (metres < MIN_LENGTH_M) continue;

    const line = simplify(geometry, tolerance)
      .map((p) => [
        Math.round(p.lat * 1e5) / 1e5,
        Math.round(p.lon * 1e5) / 1e5
      ] as [number, number]);
    if (line.length < 2) continue;

    scored.push({
      metres,
      way: {
        id: way.id ?? 0,
        name: tags.name?.trim() || tags.ref?.trim() || null,
        kind: tags.highway ?? 'road',
        surface,
        surfaceTag: tag,
        access: accessOf(tags),
        gated: isGated(tags),
        seasonal: isSeasonal(tags),
        fourWheelDrive: needsFourWheelDrive(tags),
        line
      }
    });
  }

  /**
   * WHEN THERE IS TOO MUCH, KEEP THE LONGEST — the same lesson the boundary
   * layer learned the hard way. Taking whatever the server listed first turns
   * a fully-mapped forest into a scatter of disconnected fragments, which
   * reads as "there are barely any roads here" over ground that is nothing
   * but roads. The longest ways are the ones that still make a network when
   * you can only draw some of them.
   */
  let truncated = false;
  if (scored.length > MAX_WAYS) {
    scored.sort((a, b) => b.metres - a.metres);
    scored.length = MAX_WAYS;
    truncated = true;
  }

  const roads: BackroadWay[] = [];
  let points = 0;
  for (const { way } of scored) {
    if (points + way.line.length > MAX_POINTS) { truncated = true; break; }
    points += way.line.length;
    roads.push(way);
  }

  const scan: BackroadScan = { ok: true, tooWide: false, truncated, roads };

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), scan });

  return scan;
};

export const registerBackroadRoutes = (app: Express): void => {
  /**
   * Every unpaved and minor road OSM has inside a box.
   *
   * The client snaps the box to a grid before asking, which is what makes
   * both caches — this one and the CDN's — hit on an ordinary pan.
   */
  app.get('/api/backroads', async (req: Request, res: Response) => {
    const nums = ['minLat', 'minLon', 'maxLat', 'maxLon'].map((k) =>
      parseFloat(req.query[k] as string)
    );
    if (nums.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({
        ...EMPTY,
        message: 'minLat, minLon, maxLat and maxLon are required numeric query params.'
      });
    }

    const [minLat, minLon, maxLat, maxLon] = nums;
    if (maxLat <= minLat || maxLon <= minLon) {
      return res.status(400).json({ ...EMPTY, message: 'Box is inside out.' });
    }

    // Ten seconds a mirror. Somebody is watching a spinner in the layer menu,
    // and three mirrors at ten is still inside Vercel's thirty-second cap.
    const scan = await scanBox(minLat, minLon, maxLat, maxLon, 10_000);

    /**
     * Only a real answer is cached at the edge. A failed one gets `no-store`,
     * so an Overpass outage lasting a minute does not become an hour of every
     * phone being told there are no roads.
     */
    res.setHeader(
      'Cache-Control',
      scan.ok
        ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
        : 'no-store'
    );

    return res.json(scan);
  });
};
