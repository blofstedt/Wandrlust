/**
 * The backroads layer: unpaved and minor roads for the viewport.
 *
 * Everything about what these lines mean — and the three surface states they
 * are allowed to report — lives in `server/backroadRoutes.ts`. Read that
 * before changing anything here.
 *
 * This half does three jobs and nothing else:
 *
 *   1. SNAP THE BOX. The viewport moves by a pixel every time a finger
 *      touches the screen, and asking about a box that changes by a pixel is
 *      asking a new question every time. Snapping to a grid means an ordinary
 *      pan is the SAME question, which is what makes the memory cache here,
 *      the cache on the server, and the CDN in between all hit at once.
 *
 *   2. NEVER ASK TWICE AT ONCE. Two effects racing for the same box share one
 *      in-flight promise.
 *
 *   3. FAIL SOFT. No server, no signal, an Overpass outage: `ok: false` and
 *      an empty list, which the map renders as "couldn't check". It never
 *      throws and it never reports an outage as "no roads here".
 */
import type { BackroadScan } from '../types';
import type { BoundingBox } from '../config/coverage';

const EMPTY: BackroadScan = { ok: false, tooWide: false, truncated: false, roads: [] };

/**
 * The snap grid, in degrees.
 *
 * Coarse enough that a normal pan stays inside the box already fetched, fine
 * enough that the box is never wildly bigger than the screen. At zoom 12 a
 * phone viewport is roughly 0.1° across, so this rounds it up to two or three
 * cells and holds still while you drag.
 */
const GRID_DEG = 0.05;

/**
 * How much ground beyond the screen to ask for.
 *
 * A quarter viewport of headroom on each side means roads are already drawn
 * where you are panning towards, instead of arriving after you get there.
 */
const PAD_FRACTION = 0.25;

/** Matches MAX_AREA_SQ_DEG on the server; asking bigger is a wasted trip. */
const MAX_AREA_SQ_DEG = 1.2;

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const MEM_MAX_ENTRIES = 12;

const memCache = new Map<string, { at: number; scan: BackroadScan }>();
const inFlight = new Map<string, Promise<BackroadScan | null>>();

const floorTo = (value: number, step: number) => Math.floor(value / step) * step;
const ceilTo = (value: number, step: number) => Math.ceil(value / step) * step;

/**
 * Pad the viewport, then snap it outward onto the grid.
 *
 * Rounded to three decimals at the end so the same box always produces the
 * same URL string — floating-point drift in the padding is enough to miss a
 * cache that should have hit.
 */
export const backroadRequestBox = (view: BoundingBox): BoundingBox => {
  const latPad = (view.maxLat - view.minLat) * PAD_FRACTION;
  const lonPad = (view.maxLon - view.minLon) * PAD_FRACTION;

  const box = {
    minLat: floorTo(view.minLat - latPad, GRID_DEG),
    minLon: floorTo(view.minLon - lonPad, GRID_DEG),
    maxLat: ceilTo(view.maxLat + latPad, GRID_DEG),
    maxLon: ceilTo(view.maxLon + lonPad, GRID_DEG)
  };

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    minLat: round(box.minLat), minLon: round(box.minLon),
    maxLat: round(box.maxLat), maxLon: round(box.maxLon)
  };
};

/** True when the box already fetched still covers everything on screen. */
export const backroadBoxCovers = (held: BoundingBox | null, view: BoundingBox): boolean =>
  !!held &&
  held.minLat <= view.minLat && held.minLon <= view.minLon &&
  held.maxLat >= view.maxLat && held.maxLon >= view.maxLon;

const keyFor = (box: BoundingBox) =>
  `${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}`;

/**
 * Every unpaved and minor road inside `box`.
 *
 * Returns `null` — and only `null` — when the request was superseded by a
 * newer one. Callers keep what is on screen in that case rather than blanking
 * the layer between one viewport and the next.
 */
export const fetchBackroads = async (
  box: BoundingBox,
  signal?: AbortSignal
): Promise<BackroadScan | null> => {
  const key = keyFor(box);

  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.scan;

  if ((box.maxLat - box.minLat) * (box.maxLon - box.minLon) > MAX_AREA_SQ_DEG) {
    return { ok: true, tooWide: true, truncated: false, roads: [] };
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const params = new URLSearchParams({
    minLat: String(box.minLat), minLon: String(box.minLon),
    maxLat: String(box.maxLat), maxLon: String(box.maxLon)
  });

  const attempt = (async (): Promise<BackroadScan | null> => {
    try {
      const res = await fetch(`/api/backroads?${params}`, { signal });
      if (!res.ok) return EMPTY;

      const data = (await res.json()) as Partial<BackroadScan> | null;
      if (!data || !Array.isArray(data.roads)) return EMPTY;

      const scan: BackroadScan = {
        ok: data.ok !== false,
        tooWide: data.tooWide === true,
        truncated: data.truncated === true,
        roads: data.roads
      };

      // Only an answer worth reusing is kept. An outage must not sit in the
      // cache for six hours telling every later pan there are no roads.
      if (scan.ok) {
        if (memCache.size >= MEM_MAX_ENTRIES) {
          const oldest = memCache.keys().next().value;
          if (oldest) memCache.delete(oldest);
        }
        memCache.set(key, { at: Date.now(), scan });
      }

      return scan;
    } catch (error) {
      // An abort is the viewport having moved on, not a failure to report.
      if ((error as { name?: string })?.name === 'AbortError') return null;
      return EMPTY;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, attempt);
  return attempt;
};
