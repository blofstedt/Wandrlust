/**
 * MERGING PARCELS, AND TAKING THE WATER OUT OF THEM.
 *
 * Two jobs, one library, and both of them belong on the server.
 *
 * ---------------------------------------------------------------------------
 * WHY ONTARIO POPPED IN AND OUT AND ALBERTA NEVER DID
 * ---------------------------------------------------------------------------
 *
 * Alberta's Green Area arrives as ONE polygon and Saskatchewan's provincial
 * forest as one layer, so there is nothing to merge and nothing to get wrong.
 * Ontario arrives as hundreds of separate General Use Areas, and the map was
 * merging them in the browser by cancelling edges that two neighbours share —
 * which only works when both copies of that edge still line up. After the
 * upstream server generalises each parcel independently they do not, so the
 * merge half-succeeded, the ring chaining that follows it half-succeeded, and
 * the result flickered between a mesh of outlines, a filled shape, and an
 * outline with no fill at all as the numbers moved under it.
 *
 * A real boolean union has none of those failure modes. It does not care
 * whether vertices match, it produces exactly one set of rings, and the same
 * input always gives the same output — so the shape stops changing when
 * nothing about the land has.
 *
 * It costs about half a second for a few hundred parcels, which is far too
 * slow to run on a phone on every redraw and completely fine to run once here,
 * on a server, into a cache row that is then read for months. Same reason the
 * lake subtraction moved here: doing it properly is a real geometric
 * difference, not a hole dropped in and hoped over.
 *
 * NOTHING HERE MAY INVENT LAND. Every operation only ever removes area or
 * joins pieces that genuinely touch; a failure returns the input untouched
 * rather than a guess, so the worst case is the map as it was.
 */
import polygonClipping from 'polygon-clipping';
import lakeData from '../public/map/lakes-us-ca.json' with { type: 'json' };

type Ring = [number, number][];
type Poly = Ring[];
type MultiPoly = Poly[];

interface LakeRing {
  bbox: [number, number, number, number];
  ring: Ring;
}

const LAKES: LakeRing[] = Array.isArray((lakeData as any)?.lakes)
  ? ((lakeData as any).lakes as LakeRing[])
  : [];

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * Above this many rings the union is abandoned and the parcels are returned
 * as they came.
 *
 * polygon-clipping is O(n log n) in segments with a large constant, and a
 * pathological input — a whole province at full detail — can take long enough
 * to matter against a 30-second function budget. A merged shape is a nicety;
 * answering at all is not.
 */
const MAX_RINGS_TO_UNION = 4000;

/** Same idea for the lake subtraction, which is cheaper but not free. */
const MAX_LAKES_TO_SUBTRACT = 400;

const bboxOf = (geometry: any): [number, number, number, number] | null => {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (node: any): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      if (node[0] < minLon) minLon = node[0];
      if (node[0] > maxLon) maxLon = node[0];
      if (node[1] < minLat) minLat = node[1];
      if (node[1] > maxLat) maxLat = node[1];
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry?.coordinates);
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
};

const asMultiPoly = (geometry: any): MultiPoly | null => {
  if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates as Poly];
  }
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates as MultiPoly;
  }
  return null;
};

const fromMultiPoly = (mp: MultiPoly): any =>
  mp.length === 1
    ? { type: 'Polygon', coordinates: mp[0] }
    : { type: 'MultiPolygon', coordinates: mp };

const ringCount = (mp: MultiPoly): number =>
  mp.reduce((n, poly) => n + poly.length, 0);

/* ------------------------------------------------------------------ */
/* Taking the lakes out                                                */
/* ------------------------------------------------------------------ */

/**
 * Subtract every lake that overlaps this shape.
 *
 * THE PREVIOUS ATTEMPT ONLY HANDLED THE EASY HALF. It dropped a lake ring in
 * as an extra ring and let the even-odd fill rule turn it into a hole, which
 * requires the lake to sit ENTIRELY inside one polygon — otherwise the part
 * hanging over the edge paints green across open water instead. Ontario's
 * parcels are fragmented and its lakes are enormous, so almost every lake
 * straddled a boundary, almost every lake was skipped, and the water stayed
 * painted.
 *
 * A real difference has no such condition: a lake half in and half out removes
 * exactly the half that is in.
 */
export const subtractLakes = (geometry: any): any => {
  const subject = asMultiPoly(geometry);
  if (!subject) return geometry;

  const box = bboxOf(geometry);
  if (!box) return geometry;
  const [minLon, minLat, maxLon, maxLat] = box;

  const overlapping = LAKES.filter(({ bbox }) =>
    bbox[2] >= minLon && bbox[0] <= maxLon && bbox[3] >= minLat && bbox[1] <= maxLat
  );
  if (overlapping.length === 0) return geometry;
  if (overlapping.length > MAX_LAKES_TO_SUBTRACT) return geometry;

  try {
    const cut = polygonClipping.difference(
      subject as any,
      ...overlapping.map((l) => [l.ring] as any)
    );
    // An empty result means the shape was ALL water. That is a real answer —
    // a parcel that is entirely lake should not be painted as campable — but
    // it is also what a degenerate input looks like, so it is refused: this
    // function may only ever trim a shape, never erase one.
    if (!cut || cut.length === 0) return geometry;
    return fromMultiPoly(cut as MultiPoly);
  } catch {
    // Self-intersecting source geometry is common in government data and
    // makes the clipper throw. The uncut shape is the honest fallback.
    return geometry;
  }
};

/* ------------------------------------------------------------------ */
/* Merging parcels into the shape of a region                          */
/* ------------------------------------------------------------------ */

export interface MergeResult {
  geometry: any;
  /** How many parcels went in. Reported so the merge can be seen working. */
  merged: number;
}

/**
 * One shape from many parcels.
 *
 * Returns null when there is nothing to do or the union could not be trusted,
 * and the caller keeps the parcels it already had.
 */
export const unionParcels = (geometries: any[]): MergeResult | null => {
  const parts: MultiPoly = [];
  for (const g of geometries) {
    const mp = asMultiPoly(g);
    if (mp) parts.push(...mp);
  }
  if (parts.length < 2) return null;
  if (ringCount(parts) > MAX_RINGS_TO_UNION) return null;

  try {
    const merged = polygonClipping.union(
      [parts[0]] as any,
      ...parts.slice(1).map((p) => [p] as any)
    );
    if (!merged || merged.length === 0) return null;
    return { geometry: fromMultiPoly(merged as MultiPoly), merged: geometries.length };
  } catch {
    return null;
  }
};

/** How many lakes the server knows about. Reported in `meta` for sanity. */
export const lakeCount = (): number => LAKES.length;
