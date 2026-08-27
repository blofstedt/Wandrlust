/**
 * Pure geometry helpers for public-land boundaries — no caching, no network,
 * no shared state. Split out of boundaryRoutes.ts (which is still the file
 * for query building, caching, and the ingest pipeline) purely to make this
 * enormous module smaller; nothing here behaves any differently than it did
 * inline.
 */
import { subtractLakes } from './landGeometry.js';

/**
 * Rough area of a GeoJSON polygon in km².
 *
 * Shoelace on the outer rings, scaled from degrees by the latitude of the
 * shape. It is not a survey figure and is not shown to anyone — it exists only
 * to answer "is this parcel big enough to be worth a pixel at zoom 4?", which
 * it does to well within the order of magnitude that question needs.
 */
export const approxAreaSqKm = (geometry: any): number => {
  if (!geometry) return 0;

  const ringArea = (ring: any[]): number => {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let sum = 0;
    let latSum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[j];
      const b = ring[i];
      if (!Array.isArray(a) || !Array.isArray(b)) return 0;
      sum += a[0] * b[1] - b[0] * a[1];
      latSum += b[1];
    }
    const meanLat = latSum / ring.length;
    // 1° of latitude is ~111.32 km; 1° of longitude shrinks with the cosine.
    return (Math.abs(sum) / 2) * 111.32 * 111.32 * Math.cos((meanLat * Math.PI) / 180);
  };

  if (geometry.type === 'Polygon') return ringArea(geometry.coordinates?.[0]);
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates ?? []).reduce(
      (total: number, poly: any) => total + ringArea(poly?.[0]),
      0
    );
  }
  return 0;
};

/* -------------------------------------------------------------------------- */
/* Parts of a parcel that are too small to see                                 */
/* -------------------------------------------------------------------------- */

/**
 * THE THOUSANDS OF TINY SHAPES WERE NEVER THOUSANDS OF PARCELS.
 *
 * The area filter above works on FEATURES, and a feature is not a shape. One
 * Ontario General Use Area is a single MultiPolygon whose coordinates hold
 * every scrap of Crown land in that planning unit — the big blocks, and then
 * several hundred slivers between a lake and a road, each one a fraction of a
 * pixel wide at the zoom anyone looks at a province from.
 *
 * `approxAreaSqKm` sums all of them, so the feature sails through the filter
 * and brings its whole confetti of parts along. That is what a camper sees as
 * "thousands of individual parcels instead of grouping like Alberta does", and
 * it is the same confetti the browser is paying for: every part is vertices to
 * transfer, an outline to dissolve, and a path to draw. Alberta looks clean
 * because the Green Area genuinely IS one shape, not because it is treated
 * differently.
 *
 * So parts below what a screen can resolve are dropped from the geometry
 * itself, before the response is built. Nothing about which LAND is included
 * changes — only whether a shape too small to see is sent to be drawn.
 *
 * A FEATURE NEVER COMES BACK EMPTY. If every part is below the threshold the
 * biggest one is kept regardless. A parcel that draws as two pixels is honest;
 * a parcel that silently disappears is the empty-province failure this file
 * exists to prevent.
 */
const partAreaDeg2 = (ring: any[]): number => {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
};

/**
 * Drop sub-pixel parts of a MultiPolygon.
 *
 * `minPartDeg2` is in square degrees rather than km² on purpose: it is derived
 * from the same simplification tolerance the source was queried with, so it
 * scales with the zoom automatically and needs no latitude correction to
 * answer the only question being asked — "is this bigger than a few pixels?"
 *
 * `maxParts` is the backstop for a parcel that is genuinely made of hundreds
 * of visible pieces: keep the largest, drop the tail.
 */
export const pruneTinyParts = (geometry: any, minPartDeg2: number, maxParts: number): any => {
  if (geometry?.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) {
    return geometry;
  }
  const parts = geometry.coordinates as any[];
  if (parts.length <= 1) return geometry;

  const sized = parts
    .map((poly) => ({ poly, area: partAreaDeg2(poly?.[0]) }))
    .sort((a, b) => b.area - a.area);

  let kept = sized.filter((x) => x.area >= minPartDeg2).slice(0, maxParts);
  // Never nothing: the biggest piece survives whatever the threshold says.
  if (kept.length === 0) kept = sized.slice(0, 1);
  if (kept.length === parts.length) return geometry;

  return kept.length === 1
    ? { type: 'Polygon', coordinates: kept[0].poly }
    : { type: 'MultiPolygon', coordinates: kept.map((x) => x.poly) };
};

/** How many separate pieces one parcel may draw as. */
export const MAX_PARTS_DETAIL = 160;
/**
 * A merged overview shape is not a parcel — it is every parcel one source has
 * in view, welded into one feature covering a province or a whole agency. So
 * its allowance is per SOURCE rather than per parcel, and it has to be
 * generous: an archipelago of Crown land around a hundred northern lakes is
 * genuinely a hundred pieces, and capping it at a couple of dozen is how a
 * province ends up looking emptier than it is.
 *
 * It is still far fewer shapes than the overview used to draw — two dozen
 * parts each across two hundred separate parcels.
 */
export const MAX_PARTS_MERGED = 250;
/**
 * Parts kept per parcel on the way INTO the merge.
 *
 * Nothing here is about what is legible; it is about what the union can afford
 * to chew on. The threshold that decides what a camper actually sees is
 * applied afterwards, once neighbours have had their chance to join up.
 */
export const MAX_PARTS_FOR_MERGE = 400;

/**
 * FOUR SIMPLIFICATION STEPS ON A SIDE.
 *
 * `simplifyDegrees` is already the tolerance the source is being asked to
 * generalise to — about one screen pixel on a phone at the view in question —
 * so four of them is a blob roughly four pixels across. Below that there is
 * nothing to look at and nothing to tap.
 */
/**
 * How small a piece of a welded shape has to be before it is not worth drawing.
 *
 * The tolerance is about a four-hundredth of the viewport, so a screen a
 * thousand pixels wide renders it as roughly two and a half pixels. The
 * multiplier is therefore in pixels, near enough, and it used to be FOUR —
 * which threw away every welded block under about ten pixels across.
 *
 * On Ontario and Alberta that changed nothing: their blocks are enormous. On
 * New Brunswick and Nova Scotia, whose Crown land is thousands of parcels a
 * few kilometres wide welded into modest blocks, it threw away the province.
 * Five hundred New Brunswick parcels came back as a single blob twenty-five
 * kilometres across, on a map of a province with thirty thousand square
 * kilometres of Crown land.
 *
 * Four pixels was not enough either. Nova Scotia's Crown land is roughly a
 * third of the province in pieces a kilometre or two across; welded, most of
 * its blocks are still only two or three pixels at province scale, and the
 * province drew as ONE triangle. So the floor is now about a pixel.
 *
 * That sounds like the confetti this pipeline was tuned to prevent, and it is
 * not, because the two cases differ in what the specks MEAN. Ontario's specks
 * were an arbitrary sample of a province carpeted in Crown land — the map
 * showing a hundredth of the truth and implying it was all there was. Nova
 * Scotia's specks ARE the truth: the land is scattered, and drawing it
 * scattered is the only honest picture of it. Provinces with big blocks are
 * unaffected either way, since their parts clear any of these thresholds.
 *
 * The count stays bounded — the biggest `MAX_PARTS_MERGED` survive and the
 * rest are dropped — so the cost of being less brutal is bounded too.
 */
export const visiblePartDeg2 = (simplifyDegrees: number): number => (0.5 * simplifyDegrees) ** 2;

export const prunedFeatures = (features: any[], minPartDeg2: number, maxParts: number): any[] =>
  features.map((f) => {
    const geometry = pruneTinyParts(f?.geometry, minPartDeg2, maxParts);
    return geometry === f?.geometry ? f : { ...f, geometry };
  });

/**
 * DROP THE HOLES NOBODY CAN SEE, ON THE WAY INTO THE WELD.
 *
 * A cadastral Crown land parcel is riddled with them. New Brunswick's ship
 * five hundred parcels carrying a swarm of interior rings each — a right of
 * way, a woodlot, a survey artefact so small its four corners round to the
 * same coordinate — and every one of those rings costs the clipper exactly as
 * much as a real one. That is how a province with thirty thousand square
 * kilometres of Crown land blew the ring budget, failed to weld, and fell back
 * to drawing the three parcels big enough to survive the area filter.
 *
 * At overview zoom a hole this size cannot be drawn: the generalisation
 * tolerance has already moved every edge in the shape further than the hole is
 * wide. So keeping it buys a camper nothing and costs the province its weld.
 * The threshold is the same one that decides whether a PIECE is visible, and
 * this only ever runs on the overview — at the zooms where an edge is read,
 * every ring survives untouched.
 */
const withoutTinyHoles = (geometry: any, minHoleDeg2: number): any => {
  const type = geometry?.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return geometry;

  let dropped = 0;
  const prunePoly = (poly: any): any => {
    if (!Array.isArray(poly) || poly.length < 2) return poly;
    const kept = [poly[0]];
    for (let i = 1; i < poly.length; i += 1) {
      if (partAreaDeg2(poly[i]) >= minHoleDeg2) kept.push(poly[i]);
      else dropped += 1;
    }
    return kept;
  };

  const coordinates =
    type === 'Polygon'
      ? prunePoly(geometry.coordinates)
      : (geometry.coordinates as any[]).map(prunePoly);

  return dropped === 0 ? geometry : { ...geometry, coordinates };
};

export const withoutTinyHolesIn = (features: any[], minHoleDeg2: number): any[] =>
  features.map((f) => {
    const geometry = withoutTinyHoles(f?.geometry, minHoleDeg2);
    return geometry === f?.geometry ? f : { ...f, geometry };
  });

/**
 * TAKE THE WATER OUT, AT EVERY ZOOM.
 *
 * A Crown land or BLM polygon includes the lakes inside it, correctly — the
 * province owns the lakebed. Painted as this app's "you can sleep here" wash
 * it tells campers to pitch on open water, so it is cut out of the geometry
 * before the response is built. Server-side rather than in the browser
 * because a real geometric difference costs a couple of hundred milliseconds
 * and this answer is about to sit in a cache row for months.
 */
export const withoutWater = (features: any[]): any[] =>
  features.map((f) => {
    const geometry = subtractLakes(f?.geometry);
    return geometry === f?.geometry ? f : { ...f, geometry };
  });

/**
 * Douglas–Peucker on one ring, iteratively.
 *
 * Iteratively, not recursively, because these rings arrive ungeneralised: a
 * provincial forest boundary can be tens of thousands of vertices, and the
 * recursive form of this algorithm is a stack overflow waiting for the one
 * input nobody tested with. A crash here would take the whole API down, not
 * just this source.
 */
const simplifyRing = (ring: number[][], tolerance: number): number[][] => {
  if (!Array.isArray(ring) || ring.length <= 4 || tolerance <= 0) return ring;

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;

  const stack: [number, number][] = [[0, ring.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;

    const [ax, ay] = ring[first];
    const [bx, by] = ring[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let farthest = -1;
    let farthestSq = toleranceSq;

    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = ring[i];
      let distSq: number;
      if (lengthSq === 0) {
        distSq = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        // Perpendicular distance to the segment, squared — no square roots in
        // the inner loop of something that runs over a million vertices.
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
        distSq = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (distSq > farthestSq) {
        farthest = i;
        farthestSq = distSq;
      }
    }

    if (farthest > 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const kept: number[][] = [];
  for (let i = 0; i < ring.length; i += 1) if (keep[i]) kept.push(ring[i]);
  return kept;
};

/**
 * The ring as its own bounding box.
 *
 * The fallback for a shape that the tolerance dissolves entirely. Dropping it
 * instead would be a parcel silently disappearing, which this file has a rule
 * against; drawing a box is honest at a zoom where the real outline is smaller
 * than the generalisation itself.
 */
const ringBox = (ring: number[][]): number[][] => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    if (!Array.isArray(point)) continue;
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return ring;
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
};

/**
 * What the ArcGIS sources get for free: a shape generalised to the tolerance
 * this zoom can show, with the digits below it thrown away.
 */
export const generaliseGeometry = (geometry: any, tolerance: number, precision: number): any => {
  const factor = 10 ** precision;
  const round = (v: number): number => Math.round(v * factor) / factor;

  const ring = (input: any): number[][] | null => {
    if (!Array.isArray(input) || input.length < 4) return null;
    let simplified = simplifyRing(input as number[][], tolerance);
    if (simplified.length < 4) simplified = ringBox(input as number[][]);

    const rounded: number[][] = [];
    for (const point of simplified) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const next = [round(point[0]), round(point[1])];
      const last = rounded[rounded.length - 1];
      // Rounding lands neighbouring vertices on the same spot. A duplicated
      // point is a zero-length segment, which some polygon maths treats as a
      // degenerate ring — cheaper to drop it here than to debug it there.
      if (!last || last[0] !== next[0] || last[1] !== next[1]) rounded.push(next);
    }
    if (rounded.length < 4) return ringBox(input as number[][]);

    // Rounding can also unclose the ring. Close it again.
    const first = rounded[0];
    const final = rounded[rounded.length - 1];
    if (first[0] !== final[0] || first[1] !== final[1]) rounded.push([first[0], first[1]]);
    return rounded;
  };

  const polygon = (rings: any): number[][][] | null => {
    if (!Array.isArray(rings) || rings.length === 0) return null;
    const outer = ring(rings[0]);
    if (!outer) return null;
    const holes = rings.slice(1).map(ring).filter(Boolean) as number[][][];
    return [outer, ...holes];
  };

  if (geometry?.type === 'Polygon') {
    const rings = polygon(geometry.coordinates);
    return rings ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geometry?.type === 'MultiPolygon') {
    const parts = (geometry.coordinates ?? []).map(polygon).filter(Boolean) as number[][][][];
    return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
  }
  return geometry;
};

/**
 * Prove the coordinates are longitude-then-latitude before drawing them.
 *
 * THE ONE THING OGC SERVICES DISAGREE ABOUT. WFS 2.0 with `EPSG:4326` means
 * latitude first to the specification and longitude first to a good deal of
 * software, and a server that quietly ignores `srsName` answers in its own
 * projection — for a BC service, metres in BC Albers. The request below asks
 * in CRS84, which is unambiguous, and this checks that the answer honoured it.
 *
 * A swap is corrected. Anything else is REJECTED, not drawn: a polygon in the
 * wrong hemisphere would paint public land across the Indian Ocean, and metres
 * read as degrees would paint it nowhere at all. Both are worse than a source
 * that says it is unavailable.
 */
export const orientToLonLat = (
  features: any[],
  extent: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  sourceId: string
): any[] | null => {
  const sample = (() => {
    for (const feature of features) {
      let node: any = feature?.geometry?.coordinates;
      while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
      if (Array.isArray(node) && typeof node[0] === 'number' && typeof node[1] === 'number') {
        return node as number[];
      }
    }
    return null;
  })();
  if (!sample) return features;

  // Generous slack: a parcel may legitimately straddle the edge of the extent
  // we declared for it, and this test only has to tell a hemisphere from a
  // hemisphere.
  const inside = (lon: number, lat: number): boolean =>
    lon >= extent.minLon - 3 && lon <= extent.maxLon + 3 &&
    lat >= extent.minLat - 3 && lat <= extent.maxLat + 3;

  if (inside(sample[0], sample[1])) return features;

  if (inside(sample[1], sample[0])) {
    console.info(`[boundaries] ${sourceId}: response was latitude-first — swapping axes.`);
    const swap = (node: any): any =>
      Array.isArray(node[0])
        ? node.map(swap)
        : [node[1], node[0], ...node.slice(2)];
    return features.map((feature) => ({
      ...feature,
      geometry: feature?.geometry?.coordinates
        ? { ...feature.geometry, coordinates: swap(feature.geometry.coordinates) }
        : feature.geometry
    }));
  }

  console.warn(
    `[boundaries] ${sourceId}: coordinates are not degrees in this extent ` +
      `(first vertex ${sample[0]}, ${sample[1]}) — refusing to draw them.`
  );
  return null;
};

/**
 * Esri JSON rings back into GeoJSON polygons.
 *
 * Esri puts every ring of a feature in one flat list and tells the outers from
 * the holes by winding: clockwise is an outer ring, counter-clockwise is a
 * hole in whichever outer ring contains it. GeoJSON wants that structure made
 * explicit, so this rebuilds it.
 *
 * IF THE WINDING IS NOT WHAT IT CLAIMS — some services publish everything one
 * way round — every ring is treated as its own outer ring rather than thrown
 * away. A hole drawn as solid land overstates by the area of a lake; a feature
 * dropped for a winding rule overstates nothing and shows nothing, which on a
 * map of where you may sleep is the worse of the two.
 */
const ringIsClockwise = (ring: number[][]): boolean => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[i][0] - ring[j][0]) * (ring[i][1] + ring[j][1]);
  }
  return sum > 0;
};

const pointInRing = (point: number[], ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

export const esriRingsToGeoJson = (rings: any): any | null => {
  if (!Array.isArray(rings) || rings.length === 0) return null;

  const usable = rings.filter(
    (r: any) => Array.isArray(r) && r.length >= 4 && Array.isArray(r[0])
  ) as number[][][];
  if (usable.length === 0) return null;

  let outers = usable.filter(ringIsClockwise);
  const holes = usable.filter((r) => !ringIsClockwise(r));
  // Nothing wound the way Esri says: keep the land, lose the holes.
  if (outers.length === 0) outers = usable;

  const polygons: number[][][][] = outers.map((outer) => [outer]);
  if (outers.length === usable.length) {
    // No holes to place.
  } else {
    for (const hole of holes) {
      const owner = polygons.find((poly) => pointInRing(hole[0], poly[0]));
      // A "hole" inside nothing is not a hole — it is an outer ring wound the
      // other way. Keeping it as its own polygon loses no land; dropping it
      // would, quietly.
      if (owner) owner.push(hole);
      else polygons.push([hole]);
    }
  }

  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
};
