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

export const bboxOf = (geometry: any): [number, number, number, number] | null => {
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
 * ---------------------------------------------------------------------------
 * WELDING PARCELS THAT ONLY LOOK SEPARATE
 * ---------------------------------------------------------------------------
 *
 * A boolean union joins two parcels when they actually touch. Ontario's
 * General Use Areas DO actually touch — they are planning units that tile the
 * province — and they still failed to join, because by the time they reach
 * this file they are not the shapes the province drew.
 *
 * Each parcel is generalised INDEPENDENTLY by the upstream ArcGIS server
 * (`maxAllowableOffset`), so the two copies of a shared edge are thinned by
 * different amounts and end up a little apart. The union then correctly reports
 * two shapes with a hairline gap between them, over and over, all the way
 * across a province — which draws as the mesh of outlines this whole file
 * exists to stop.
 *
 * So coordinates are snapped to a grid first. Two edges that were meant to be
 * the same edge land on the same grid points, become bit-identical, and weld.
 *
 * THE GRID IS TIED TO WHAT THE VIEW CAN SHOW, WHICH IS WHY THIS IS HONEST. The
 * cell is a small multiple of the tolerance the geometry was already
 * generalised to — about a pixel at the zoom the merged shape is drawn at. An
 * edge can move by at most half a cell, in either direction, so this can no
 * more invent land than the generalisation that preceded it already did, and it
 * is never used at the zooms where a camper reads an edge.
 */
const snapMultiPoly = (mp: MultiPoly, cell: number): MultiPoly => {
  if (!(cell > 0)) return mp;

  const snapRing = (ring: unknown): Ring | null => {
    if (!Array.isArray(ring)) return null;
    const out: Ring = [];
    for (const point of ring) {
      if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
        return null;
      }
      const snapped: [number, number] = [
        Math.round(point[0] / cell) * cell,
        Math.round(point[1] / cell) * cell
      ];
      const previous = out[out.length - 1];
      // Rounding routinely collapses a run of vertices onto one grid point.
      if (previous && previous[0] === snapped[0] && previous[1] === snapped[1]) continue;
      out.push(snapped);
    }
    if (out.length > 2) {
      const [fx, fy] = out[0];
      const [lx, ly] = out[out.length - 1];
      if (fx !== lx || fy !== ly) out.push([fx, fy]);
    }
    // Fewer than four points is not a ring any more, it is a line.
    return out.length >= 4 ? out : null;
  };

  const result: MultiPoly = [];
  for (const poly of mp) {
    const outer = snapRing(poly?.[0]);
    // The outer ring collapsing means this part was smaller than one cell —
    // under a pixel where this is used. Its holes go with it: a ring list whose
    // first ring is a hole is not a polygon at all, and feeding one to the
    // clipper is how you get a shape turned inside out.
    if (!outer) continue;
    const holes = poly
      .slice(1)
      .map(snapRing)
      .filter((r): r is Ring => r !== null);
    result.push([outer, ...holes]);
  }
  return result;
};

/**
 * One shape from many parcels.
 *
 * Returns null when there is nothing to do or the union could not be trusted,
 * and the caller keeps the parcels it already had.
 */
/**
 * Parts welded in one go when the whole province will not go through at once.
 *
 * Sixty-four is small enough that a parcel the clipper chokes on takes only
 * its own neighbourhood down with it, and large enough that a province still
 * welds in a handful of passes.
 */
const WELD_CHUNK = 64;

const unionOnce = (group: MultiPoly): MultiPoly | null => {
  if (group.length === 0) return null;
  if (group.length === 1) return group;
  try {
    const merged = polygonClipping.union(
      [group[0]] as any,
      ...group.slice(1).map((p) => [p] as any)
    );
    return merged && merged.length > 0 ? (merged as MultiPoly) : null;
  } catch {
    return null;
  }
};

/**
 * WELD IN CHUNKS WHEN THE WHOLE THING WILL NOT GO.
 *
 * polygon-clipping refuses a whole batch over one bad ring — a parcel that
 * crosses itself after generalisation, a cadastral sliver of zero width — and
 * it does not say which. New Brunswick's five hundred Crown parcels were being
 * thrown out on that basis: the union returned nothing, the caller fell back to
 * loose parcels, the area filter cut those to the three biggest, and half a
 * province drew as three shapes.
 *
 * So a refusal is no longer the end of it. The parts are welded sixty-four at
 * a time, a chunk the clipper refuses keeps its parcels unwelded rather than
 * losing them, and the results are welded to each other. Worst case the
 * province draws as its own parcels, which is what the map did before any of
 * this existed — and never as nothing.
 */
const weld = (parts: MultiPoly, onFallback?: (reason: string) => void): MultiPoly | null => {
  const whole = unionOnce(parts);
  if (whole) return whole;

  onFallback?.('whole union refused, welding in chunks');
  const pieces: MultiPoly = [];
  for (let i = 0; i < parts.length; i += WELD_CHUNK) {
    const chunk = parts.slice(i, i + WELD_CHUNK);
    const merged = unionOnce(chunk);
    if (merged) pieces.push(...merged);
    else pieces.push(...chunk);
  }
  if (pieces.length === 0) return null;
  return unionOnce(pieces) ?? pieces;
};

export const unionParcels = (
  geometries: any[],
  options: {
    /**
     * Grid to snap to before unioning, in degrees. Zero unions the geometry
     * exactly as it arrived. See `snapMultiPoly`.
     */
    snapDegrees?: number;
    maxRings?: number;
    /** Called with a one-line reason whenever the straightforward path fails. */
    onFallback?: (reason: string) => void;
  } = {}
): MergeResult | null => {
  const { snapDegrees = 0, maxRings = MAX_RINGS_TO_UNION, onFallback } = options;

  let parts: MultiPoly = [];
  for (const g of geometries) {
    const mp = asMultiPoly(g);
    if (mp) parts.push(...mp);
  }
  // One part, and nothing to join it to. Note this counts PARTS, not features:
  // a single province-wide MultiPolygon is worth running through, because its
  // own pieces weld to each other exactly the way two parcels do.
  if (parts.length < 2) {
    onFallback?.('fewer than two parts');
    return null;
  }
  /*
   * SNAPPING IS AN AID TO THE WELD, NOT A CONDITION OF IT.
   *
   * The grid is a pixel wide, and a part narrower than one cell collapses on
   * it — correctly, since it could not be drawn. But a province made ENTIRELY
   * of such parts then collapses entirely, and Nova Scotia is exactly that:
   * Crown land in pieces a kilometre or two across, which at anything wider
   * than province zoom is every piece it has. The union came back with
   * nothing and the province drew as three specks on a map of a place that is
   * a third Crown land.
   *
   * So when the grid eats everything, the parcels are welded as they arrived
   * instead. They still join where they genuinely abut — which is the whole
   * job — and what is then too small to see is decided afterwards, by the
   * threshold that exists for it, rather than here by accident.
   */
  if (snapDegrees > 0) {
    const snapped = snapMultiPoly(parts, snapDegrees);
    if (snapped.length >= 2) parts = snapped;
    else onFallback?.('grid wider than every parcel, welding unsnapped');
  }
  if (ringCount(parts) > maxRings) {
    onFallback?.(`${ringCount(parts)} rings over the ${maxRings} budget`);
    return null;
  }

  const merged = weld(parts, onFallback);
  if (!merged) {
    onFallback?.('clipper returned nothing');
    return null;
  }
  return { geometry: fromMultiPoly(merged), merged: geometries.length };
};

/** Rings in one GeoJSON geometry. The cost of a union tracks this, not features. */
export const ringsIn = (geometry: any): number => {
  const mp = asMultiPoly(geometry);
  return mp ? ringCount(mp) : 0;
};

/** How many lakes the server knows about. Reported in `meta` for sanity. */
export const lakeCount = (): number => LAKES.length;
