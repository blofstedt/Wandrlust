/**
 * Alert overlay helpers — the map's "what disaster is here" logic, kept out of
 * MapComponent so the geometry is testable on its own.
 *
 * Four jobs:
 *   1. Sorting every active alert into ONE OF TWO KINDS — a localized incident
 *      with a place (drawn as a teardrop pin) or a generalized weather event
 *      over a region (drawn as one merged area with a single badge at its
 *      centre). See EVENT_SCOPE, well down the file.
 *   2. A short badge word (Fire / Flood / Smoke …) for a POINT sitting inside an
 *      active alert — drawn on the campsite pins.
 *   3. Merging the separate forecast-zone parcels of one generalized event into
 *      a single shape, so the client draws only the outer boundary.
 *   4. Dissolving the shared edges between same-category land parcels, so
 *      adjacent public land reads as one shape rather than a web of lines.
 *
 * NOTHING HERE TOUCHES THE HAZARD CLASSIFIER. shared/hazards.ts still folds
 * wildfire smoke into the 'fire' family, and regional rainfall into 'flood',
 * because for pushing a warning each pair is one decision. Both are split back
 * out HERE, for display only, by re-reading the event text — so a camper can
 * tell "there's a fire" from "the air is bad", and "the river is up" from "it
 * is raining hard", without any change rippling into the database enums
 * downstream.
 *
 * Save to: src/utils/alertOverlay.ts
 */
import type { HazardAlert } from '../services/weatherService';
import { pointInGeometry } from './geo';

export type AlertBadge =
  | 'fire' | 'smoke' | 'flood' | 'rain' | 'storm' | 'winter' | 'heat' | 'wind';

/** Draw order / priority. The most decision-changing hazard leads. */
const BADGE_ORDER: AlertBadge[] = [
  'fire', 'smoke', 'flood', 'rain', 'storm', 'winter', 'heat', 'wind'
];

export const BADGE_LABEL: Record<AlertBadge, string> = {
  fire: 'Fire', smoke: 'Smoke', flood: 'Flood', rain: 'Heavy rain',
  storm: 'Storm', winter: 'Cold', heat: 'Heat', wind: 'Wind'
};

/**
 * ONE COLOUR PER EVENT KIND, AND IT MEANS THE SAME THING EVERYWHERE.
 *
 * The same hex paints the pin, the area, the centroid badge and the little dot
 * that sits over a campsite pin standing inside the event. Two families that a
 * camper has to tell apart at a glance never share a hue: flood is teal and
 * heavy rain is dark blue precisely because "the river is up" and "it is
 * raining hard over the region" are different decisions.
 */
export const BADGE_COLOR: Record<AlertBadge, string> = {
  // Localized — a place, drawn as a teardrop pin.
  fire: '#EA580C',   // red-orange
  flood: '#14B8A6',  // teal
  // Generalized — a region, drawn as one merged area with a badge at its centre.
  rain: '#1D4ED8',   // dark blue
  storm: '#7C3AED',  // purple
  heat: '#B91C1C',   // dark red
  winter: '#7DD3FC', // ice blue
  smoke: '#78716C',  // brown-grey
  wind: '#94A3B8'    // slate
};

/**
 * THE WASH A GENERALIZED AREA IS PAINTED IN, WHICH IS NOT THE BADGE COLOUR.
 *
 * A translucent layer over satellite imagery is only visible if it is a lot
 * LIGHTER or a lot darker than the ground under it. The badge colours are
 * mid-tone and saturated — right for a 44px disc with a white ring, useless
 * spread thin over a valley. Smoke's stone grey over green farmland lifted the
 * brightness by about a tenth, which is less than the imagery's own variation:
 * measurably drawn, genuinely invisible, and a warning nobody can see is the
 * same as no warning at all.
 *
 * So the wash is a light version of the family's colour, in the direction
 * weather actually looks from above — haze, not paint. Identity still comes
 * from the badge sitting in the middle of it, which keeps the saturated
 * colour, and from the wash's hue.
 */
export const CLOUD_TINT: Record<AlertBadge, string> = {
  fire: '#FDBA8C',   // unused for the wash today; fire draws as a pin
  flood: '#7FE3D4',  // likewise
  rain: '#93B4FF',
  storm: '#C9B0FC',
  heat: '#FCA5A5',
  winter: '#BAE6FD',
  smoke: '#DBD4CB',
  wind: '#CBD5E1'
};

/** Wildfire smoke and air-quality products, which the classifier files as fire. */
const SMOKE_TEXT = /smoke|air quality|air stagnation|blowing dust/i;

/**
 * Products whose own NAME is about the air itself.
 *
 * Narrower than SMOKE_TEXT on purpose: blowing dust stays in the wind family,
 * because a dust advisory is a driving-visibility warning and its card should
 * not say "smoke".
 */
const AIR_QUALITY_EVENT = /smoke|air quality|air stagnation/i;

/**
 * Water that has ARRIVED somewhere, as opposed to water still falling.
 *
 * `shared/hazards.ts` folds both into the 'flood' family, because for pushing a
 * warning they are one decision. On the map they are not: a flood warning is a
 * place you must not drive into, and a rainfall warning covers a whole forecast
 * region and changes nothing about where a road is. Drawing a regional rainfall
 * product as a pin on a single point was the thing that made the map claim to
 * know more than it does — the pin looked like someone had seen water there.
 *
 * Flood words are tested FIRST, so an alert that mentions both ("heavy rain and
 * flooding") stays a flood. Over-calling flood is the safe direction to err in.
 */
const FLOOD_TEXT = /flood|hydrologic|dam break|seiche|storm surge|tsunami|high water|ice jam/i;
const RAIN_TEXT = /rain/i;

/** The badge for one alert, or null for families the map does not badge. */
export const alertBadge = (alert: HazardAlert): AlertBadge | null => {
  const text = `${alert.event} ${alert.headline}`;

  /**
   * SMOKE IS CLAIMED BY ITS OWN NAME, BEFORE THE FAMILY IS EVEN LOOKED AT.
   *
   * This used to sit inside `case 'fire'`, which meant a smoke badge could only
   * ever come from an alert the classifier had already filed as fire — and the
   * classifier files by keyword. The product every agency actually issues for
   * wildfire smoke is called "Air Quality Alert" (NWS) or "Air Quality
   * Statement" (ECCC): neither says fire, neither says smoke, so both fell
   * through to the 'other' family, which is badged `null` and drawn nowhere.
   * Every air-quality warning in the country was invisible on the map and
   * missing from the pins, while the feed carried it perfectly.
   *
   * Matched on the EVENT NAME only, not the headline: a red flag warning whose
   * headline happens to mention smoke is still a fire warning, and demoting it
   * to a smoke badge would be the dangerous direction to be wrong in.
   */
  if (AIR_QUALITY_EVENT.test(alert.event)) return 'smoke';

  switch (alert.family) {
    case 'fire':
      return SMOKE_TEXT.test(text) ? 'smoke' : 'fire';
    case 'flood':
      if (FLOOD_TEXT.test(text)) return 'flood';
      return RAIN_TEXT.test(text) ? 'rain' : 'flood';
    case 'storm': return 'storm';
    case 'winter': return 'winter';
    case 'heat': return 'heat';
    case 'wind': return 'wind';
    default: return null; // 'other' — nothing distinct worth stamping on the map
  }
};

const order = (set: Set<AlertBadge>): AlertBadge[] => BADGE_ORDER.filter((b) => set.has(b));

/* ------------------------------------------------------------------ */
/* Points                                                              */
/* ------------------------------------------------------------------ */

/** Distinct badges whose alert polygon contains the point. */
export const badgesForPoint = (
  lat: number, lon: number, alerts: HazardAlert[]
): AlertBadge[] => {
  const found = new Set<AlertBadge>();
  for (const alert of alerts) {
    if (!alert.geometry) continue;
    if (!pointInGeometry(lat, lon, alert.geometry)) continue;
    const badge = alertBadge(alert);
    if (badge) found.add(badge);
  }
  return order(found);
};

/* ------------------------------------------------------------------ */
/* Parcels                                                             */
/* ------------------------------------------------------------------ */

type Geometry = unknown;

/** Centre of a geometry's bounding box, as [lat, lon]. */
const bboxCentre = (geometry: Geometry): [number, number] | null => {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    node.forEach(walk);
  };
  walk((geometry as { coordinates?: unknown })?.coordinates);
  if (minLon === Infinity) return null;
  return [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
};

/**
 * Distinct badges affecting a parcel.
 *
 * Cheap and approximate on purpose — this drives a subtle fill, not a safety
 * decision. A parcel counts as affected when its centre falls inside an alert,
 * or an alert's centre falls inside it. That catches both "small parcel inside a
 * big warning" and "big parcel under a small warning" without a full polygon
 * intersection on every pan.
 */
export const badgesForParcel = (
  geometry: Geometry, alerts: HazardAlert[]
): AlertBadge[] => {
  const centre = bboxCentre(geometry);
  const found = new Set<AlertBadge>();
  for (const alert of alerts) {
    if (!alert.geometry) continue;
    const hit =
      (centre !== null && pointInGeometry(centre[0], centre[1], alert.geometry)) ||
      (Array.isArray(alert.centroid) &&
        pointInGeometry(alert.centroid[0], alert.centroid[1], geometry));
    if (!hit) continue;
    const badge = alertBadge(alert);
    if (badge) found.add(badge);
  }
  return order(found);
};

/* ------------------------------------------------------------------ */
/* Dissolving internal borders                                         */
/* ------------------------------------------------------------------ */

/**
 * A grouping key that decides which parcels may share a dissolved outline.
 *
 * Same source, confidence, edge accuracy and camping basis — and the same
 * recorded rules. A parcel carrying its own stay limit, permit or fire ban gets
 * a different key, so the border between it and a plain neighbour survives. The
 * dissolve is cosmetic either way: taps still hit the true underlying parcel,
 * because the map resolves clicks against the real geometry, not this outline.
 */
export const dissolveKey = (properties: Record<string, any> | undefined): string => {
  const p = properties ?? {};
  return [
    p._source, p._confidence, p._edgeAccuracy, p._campingBasisKind,
    p._stayLimitDays ?? '', p._permitRequired ?? '', p._permitName ?? '',
    p._fireBanActive ?? ''
  ].join('|');
};

const walkRings = (geometry: Geometry, onRing: (ring: [number, number][]) => void): void => {
  const g = geometry as { type?: string; coordinates?: any };
  if (!g || !Array.isArray(g.coordinates)) return;
  if (g.type === 'Polygon') {
    (g.coordinates as [number, number][][]).forEach((ring) => onRing(ring));
  } else if (g.type === 'MultiPolygon') {
    (g.coordinates as [number, number][][][]).forEach((poly) =>
      poly.forEach((ring) => onRing(ring)));
  }
};

/**
 * Boundary edges with internal shared edges removed.
 *
 * The trick that makes this cheap enough to run on every pan without a geometry
 * library: an edge shared by two abutting parcels appears twice in the vertex
 * data, once from each side. Hash every segment (endpoints rounded and
 * order-normalised); the ones that appear exactly once are the true outer
 * boundary, the rest are internal seams to drop.
 *
 * Returns segments as [lon, lat] pairs, ready to hand to L.geoJSON as a
 * MultiLineString.
 */
export const dissolveSegments = (
  features: { geometry: Geometry }[],
  /**
   * Vertices are snapped to this grid (degrees) before edges are compared, so
   * two same-type parcels separated by a RAZOR-THIN gap — close but not exactly
   * touching — still cancel their near-parallel inner edges and merge into one
   * shape. Larger than the ~1 m default because a thin sliver of "nothing"
   * between two Crown-land blocks of the same designation is not a real border,
   * and drawing it is the mesh of lines this exists to remove. The kept outer
   * edges keep their ORIGINAL coordinates, so only the grouping is affected,
   * not the drawn outline's shape.
   */
  snap = 1e-5
): [number, number][][] => {
  const counts = new Map<string, { seg: [number, number][]; n: number }>();
  const round = (v: number) => Math.round(v / snap) * snap;
  features.forEach((f) =>
    walkRings(f.geometry, (ring) => {
      for (let i = 1; i < ring.length; i += 1) {
        const a = ring[i - 1];
        const b = ring[i];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const ka = `${round(a[0])},${round(a[1])}`;
        const kb = `${round(b[0])},${round(b[1])}`;
        // Both ends landed on the same grid cell: at this tolerance the edge
        // has no length. Skip it rather than hash it — two unrelated degenerate
        // edges elsewhere in the data would otherwise hash alike, "cancel" each
        // other, and take a real piece of somebody's outline with them. The
        // chain is unaffected: a step from a point to itself joins nothing.
        if (ka === kb) continue;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const existing = counts.get(key);
        if (existing) existing.n += 1;
        else counts.set(key, { seg: [a, b], n: 1 });
      }
    })
  );
  const out: [number, number][][] = [];
  counts.forEach(({ seg, n }) => {
    if (n === 1) out.push(seg);
  });
  return out;
};

/**
 * Reassemble dissolved segments into closed rings (polygon outlines).
 *
 * `dissolveSegments` returns the outer edges of a merged set of parcels
 * as a flat list of undirected segments. To draw a filled polygon from
 * them, we need to chain the segments back into closed loops — the
 * "rings" of a GeoJSON Polygon.
 *
 * The hash maps an endpoint to the segments that start or end there.
 * We walk the map from any unused endpoint, follow the next unused
 * segment, and continue until we return to the starting point. That
 * closed chain is a ring.
 *
 * WHY THIS WORKS, AND WHY IT IS CHEAP ENOUGH TO RUN ON EVERY PAN.
 *   - Segments are stored with both endpoints as keys, so the lookup is
 *     O(1) per step.
 *   - Each segment is used at most once across all rings, so the total
 *     work is O(N) in the number of segments.
 *   - A few hundred segments per dissolve group is well under any
 *     visible-frame budget on a modern phone.
 *
 * The snap tolerance comes from the same source as `dissolveSegments`:
 * vertices within `snap` degrees of each other are treated as the same
 * point. That keeps the chaining stable when two adjacent parcels
 * share an edge whose endpoints are not bit-exact (rasterised vector
 * tiles, the usual culprit, are off by a fraction of a degree).
 *
 * Returns an array of rings, each ring an array of `[lon, lat]` vertices
 * with the last vertex equal to the first (GeoJSON ring convention).
 * The outer ring of a merged shape comes first; any inner rings (holes
 * for genuine no-go zones the merged area surrounds) follow it. Holes
 * are detected by the orientation of the segments: a closed chain whose
 * vertices wind clockwise is a hole in the northern-hemisphere
 * convention used by GeoJSON. We do not currently classify orientation
 * — we return every ring, and let the caller sort outer/inner by area
 * if it cares.
 */
export const segmentsToRings = (
  segments: [number, number][][],
  snap = 1e-5
): [number, number][][] => {
  if (segments.length === 0) return [];

  // endpoint -> the segments that start or end there
  const hash = new Map<string, { to: [number, number]; index: number }[]>();
  const keyOf = (p: [number, number]) =>
    `${Math.round(p[0] / snap)},${Math.round(p[1] / snap)}`;

  segments.forEach(([a, b], index) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    let aList = hash.get(ka);
    if (!aList) { aList = []; hash.set(ka, aList); }
    aList.push({ to: [b[0], b[1]], index });
    let bList = hash.get(kb);
    if (!bList) { bList = []; hash.set(kb, bList); }
    bList.push({ to: [a[0], a[1]], index });
  });

  const used = new Set<number>();

  /**
   * WHICH WAY TO GO AT A JUNCTION.
   *
   * Three parcels meeting at a point put four or six unused segments on one
   * vertex, and the old code took whichever it happened to hash first. That is
   * how a walk hopped from one shape's boundary onto another's: the chain
   * wandered off, closed somewhere it shouldn't, and left the rest of the real
   * boundary behind as a second phantom ring — the extra polygon overlapping
   * the top of a shape, with a straight line cutting across it.
   *
   * Taking the sharpest turn instead keeps the walk hugging the SAME face of
   * the shape all the way round, which is the standard way to trace a polygon
   * out of a soup of edges. Angles are compared anticlockwise from the way we
   * came in, so the smallest one is the hardest right turn available.
   */
  const nextFrom = (
    from: [number, number], at: [number, number]
  ): { to: [number, number]; index: number } | null => {
    const candidates = (hash.get(keyOf(at)) ?? []).filter((c) => !used.has(c.index));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const incoming = Math.atan2(at[1] - from[1], at[0] - from[0]) + Math.PI;
    let best = candidates[0];
    let bestTurn = Infinity;
    for (const candidate of candidates) {
      const outgoing = Math.atan2(candidate.to[1] - at[1], candidate.to[0] - at[0]);
      let turn = outgoing - incoming;
      while (turn <= 1e-9) turn += Math.PI * 2;
      while (turn > Math.PI * 2) turn -= Math.PI * 2;
      if (turn < bestTurn) { bestTurn = turn; best = candidate; }
    }
    return best;
  };

  /**
   * Extend a chain from its last vertex until it closes or runs out.
   *
   * The cap is a safety valve: a chain running to tens of thousands of
   * vertices has gone wrong somewhere, and locking up the UI thread over it
   * would be worse than dropping it.
   */
  const MAX_CHAIN = 50000;
  const extend = (points: [number, number][]): boolean => {
    while (points.length < MAX_CHAIN) {
      const current = points[points.length - 1];
      if (points.length > 2 && keyOf(current) === keyOf(points[0])) return true;
      const next = nextFrom(points[points.length - 2], current);
      if (!next) return false;
      used.add(next.index);
      points.push([next.to[0], next.to[1]]);
    }
    return false;
  };

  const rings: [number, number][][] = [];

  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue;
    used.add(start);

    const [a0, b0] = segments[start];
    const points: [number, number][] = [[a0[0], a0[1]], [b0[0], b0[1]]];

    /**
     * BOTH DIRECTIONS, and this is the fix for the diagonal line across a
     * shape.
     *
     * The old walk only ran forwards. Seeded in the MIDDLE of an open chain —
     * which is where it lands most of the time, since segments come out of the
     * dissolve in no particular order — it collected one half, hit the far end,
     * and gave up. Half a boundary joined end to end is a shape with a chord
     * straight through it, and the other half was left to be picked up later as
     * a second bogus ring. Walking out of both ends of the seed collects the
     * whole chain before anything is closed.
     */
    let closed = extend(points);
    if (!closed) {
      points.reverse();
      closed = extend(points);
    }

    if (closed) {
      points.push([points[0][0], points[0][1]]);
      rings.push(points);
      continue;
    }

    /**
     * A chain that still won't close has a genuine gap in it.
     *
     * A small one is a near-miss — two parcels whose shared edge disagrees at
     * one end by a few metres — and joining it is invisible. A large one means
     * we are holding a fragment of a boundary, and joining THAT is the straight
     * line across the map that has no business being there. Fragments are
     * dropped instead; the group's other rings still draw, and the edge itself
     * is drawn by the outline layer, which never invents a segment.
     */
    if (points.length < 4) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const [minX, minY, maxX, maxY] = ringBbox(points);
    const span = Math.hypot(maxX - minX, maxY - minY);
    if (gap > Math.max(snap * 4, span * 0.2)) continue;

    points.push([first[0], first[1]]);
    rings.push(points);
  }

  return rings;
};

/**
 * The dissolved fill of a set of same-org, same-rule parcels.
 *
 * Walks every feature, finds its ring(s), and returns one GeoJSON
 * Feature per dissolve group, ready to hand to L.geoJSON as the fill.
 * A group whose merge produces several disjoint pieces (common when
 * the same agency manages land in two valleys with a strip of
 * private land between them) becomes a MultiPolygon with each piece
 * as its own Polygon — a group dissolves to one Feature, but that
 * Feature's geometry may be a MultiPolygon.
 *
 * The dissolve KEY is the caller-supplied grouping. The standard
 * grouping is `dissolveKey(properties)` (same org, same rules), so
 * adjacent Crown-land blocks that share every rule become one fill.
 * A private-inholding stays a separate group (different dissolve key)
 * and shows up as a different Feature drawn on top in its own colour.
 *
 * `snap` defaults to 1e-3 (about 100m at the equator). This is loose
 * enough to catch vertex mismatches between two adjacent parcels
 * from different source layers (rasterised vector tiles, the usual
 * culprit, are routinely off by 30-80m), and tight enough that two
 * real neighbouring parcels with a genuine ~100m gap are not
 * accidentally merged.
 *
 * `minRingArea` drops any ring smaller than this in raw degrees. It
 * is a safety valve against degenerate loops (a single segment that
 * closed on itself, two segments that share a vertex) producing a
 * sliver-shape that draws as a hairline.
 */
export const dissolvedFill = (
  features: { properties?: Record<string, any>; geometry: Geometry }[],
  keyOf: (p: Record<string, any> | undefined) => string,
  snap = 1e-3,
  minRingArea = 1e-9
): GeoJSON.Feature[] => {
  const groups = new Map<string, typeof features>();
  features.forEach((f) => {
    const k = keyOf(f.properties);
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(f);
  });

  const out: GeoJSON.Feature[] = [];
  groups.forEach((groupFeatures) => {
    const segments = dissolveSegments(groupFeatures, snap);
    if (segments.length === 0) return;
    const rings = segmentsToRings(segments, snap);
    const keptRings = rings.filter((r) => {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const point of r) {
        const lon = point[0];
        const lat = point[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      const extent = (maxLon - minLon) * (maxLat - minLat);
      return extent >= minRingArea;
    });
    /**
     * Nothing survived the dissolve: draw the parcels themselves instead.
     *
     * `segmentsToRings` refuses to close a boundary fragment across a real gap
     * rather than draw a line nobody surveyed, so a group whose edges are too
     * broken to chain now yields no rings at all. Falling back to the raw
     * parcels keeps the group's fill on the map — the internal seams are
     * invisible because the fill is drawn with no stroke — where dropping it
     * would silently erase public land from the map.
     */
    if (keptRings.length === 0) {
      const parts: unknown[] = [];
      groupFeatures.forEach((f) => {
        const g = f.geometry as { type?: string; coordinates?: unknown };
        if (g?.type === 'Polygon') parts.push(g.coordinates);
        else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
          parts.push(...(g.coordinates as unknown[]));
        }
      });
      if (parts.length === 0) return;
      out.push({
        type: 'Feature',
        properties: groupFeatures[0].properties ?? {},
        geometry: { type: 'MultiPolygon', coordinates: parts }
      } as any);
      return;
    }

    // Every kept ring becomes its own Polygon, and the group as a whole
    // becomes a MultiPolygon. This is what fixes the "yellow fill
    // missing" case: a group that dissolves into three disjoint
    // pieces previously shipped only the first ring; the other two
    // were silently dropped, and the user saw outlines with no fill.
    const polygons = keptRings.map((r) => [r]);
    out.push({
      type: 'Feature',
      properties: groupFeatures[0].properties ?? {},
      geometry: polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons }
    } as any);
  });

  return out;
};

/* ================================================================== */
/* THE TWO KINDS OF EVENT THE MAP DRAWS                                */
/* ================================================================== */
/**
 * Everything below exists to keep one distinction visible from across the
 * room, because it is the distinction a camper actually acts on:
 *
 *   LOCALIZED  — something is happening AT A PLACE. A fire. Water over a road.
 *                A bridge that is out. Drawn as a TEARDROP PIN on the point,
 *                tappable, opening the detail card.
 *
 *   GENERALIZED — something is happening OVER A REGION. Heavy rain, a storm,
 *                a heatwave, a cold snap, smoke. Drawn as ONE merged area with
 *                a semi-transparent fill and a solid outer stroke, and ONE
 *                badge at the centre of each merged piece.
 *
 * The old version drew every family as a soft tinted cloud with its glyph
 * TILED across the whole polygon, which is what put a dozen purple lightning
 * bolts across a valley for a single storm warning and made the satellite
 * imagery underneath unreadable. One area, one badge.
 *
 * The honesty rule is unchanged and is the reason a generalized event may
 * never be drawn as a pin: a rainfall warning covers a forecast region, and a
 * pin on a point inside it would claim someone looked at that point.
 */

/** Emoji + human label per family, for pin chips and lists. */
export const WARNING_EMOJI: Record<AlertBadge, string> = {
  heat: '\u{1F321}️', smoke: '\u{1F32B}️', winter: '❄️',
  fire: '\u{1F525}', flood: '\u{1F30A}', rain: '\u{1F327}️',
  storm: '⛈️', wind: '\u{1F4A8}'
};

export const WARNING_LABEL: Record<AlertBadge, string> = {
  heat: 'Heatwave', smoke: 'Smoke / air quality', winter: 'Cold snap',
  fire: 'Fire', flood: 'Flood', rain: 'Heavy rain', storm: 'Storm',
  wind: 'Wind'
};

export type EventScope = 'localized' | 'generalized';

/**
 * WHICH FAMILY IS WHICH, AND WHY.
 *
 * Fire and flood are the two things an agency draws around an actual event —
 * a perimeter, a flooded reach — so they earn a point on the map.
 *
 * Everything else is issued PER FORECAST REGION. Rain, storms, heat, cold and
 * smoke are all weather over an area; none of them has a point, and pretending
 * otherwise is the mistake this table exists to prevent.
 */
export const EVENT_SCOPE: Record<AlertBadge, EventScope> = {
  fire: 'localized',
  flood: 'localized',
  rain: 'generalized',
  storm: 'generalized',
  heat: 'generalized',
  winter: 'generalized',
  smoke: 'generalized',
  wind: 'generalized'
};

export const isGeneralized = (badge: AlertBadge): boolean =>
  EVENT_SCOPE[badge] === 'generalized';

export const isLocalized = (badge: AlertBadge): boolean =>
  EVENT_SCOPE[badge] === 'localized';

/* ------------------------------------------------------------------ */
/* Localized events — teardrop pins                                    */
/* ------------------------------------------------------------------ */

/**
 * The point-event families, shared by official alerts and camper reports.
 *
 * A washed-out road reported by a camper and a flood warning issued by an
 * agency are the same SHAPE of fact — something is wrong at this spot — so
 * they wear the same shape of marker. What separates them is what the card
 * says when you tap it, which is where the "one person's report, not verified"
 * wording lives.
 */
export type LocalizedKind = 'fire' | 'flood' | 'infrastructure' | 'other';

export const LOCALIZED_COLOR: Record<LocalizedKind, string> = {
  fire: BADGE_COLOR.fire,   // red-orange
  flood: BADGE_COLOR.flood, // teal
  infrastructure: '#475569', // dark grey — a closure is not a weather event
  other: '#EAB308'           // amber — everything else a camper flags
};

export const LOCALIZED_LABEL: Record<LocalizedKind, string> = {
  fire: 'Fire', flood: 'Flood', infrastructure: 'Road blocked', other: 'Hazard'
};

/**
 * Pin glyphs, drawn white inside the teardrop, on a 24x24 grid.
 *
 * PATHS, NOT EMOJI, and this is load-bearing. Colour emoji inside an SVG
 * `<text>` draws as a missing-glyph box on iOS Safari and several Android
 * WebViews — a camper looking for a flame gets a blank pin and the family the
 * pin exists to communicate is lost.
 */
const LOCALIZED_GLYPH: Record<LocalizedKind, string> = {
  // A flame with a hot inner tongue.
  fire:
    '<path d="M12 4.5c1.6 3.2 4.8 4.7 4.8 8.9A4.8 4.8 0 0 1 7.2 13.4c0-1.8.7-3.2 ' +
    '1.8-4.3.3 2.4 2.3 2.4 2.3 0 0-2.2.2-3.7.7-4.6z" fill="#FFFFFF"/>',
  // Three rising crests — water where it should not be.
  flood:
    '<path d="M2.5 8c1.9-1.9 4.1-1.9 6 0s4.1 1.9 6 0 4.1-1.9 6 0' +
    'M2.5 13c1.9-1.9 4.1-1.9 6 0s4.1 1.9 6 0 4.1-1.9 6 0' +
    'M2.5 18c1.9-1.9 4.1-1.9 6 0s4.1 1.9 6 0 4.1-1.9 6 0" ' +
    'fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round"/>',
  // A road barricade: two legs, a board across them, hazard stripes on the
  // board. Drawn legs-first so the board sits over them.
  infrastructure:
    '<path d="M7 11v9.5M17 11v9.5" stroke="#FFFFFF" stroke-width="2.4" ' +
    'stroke-linecap="round"/>' +
    '<rect x="2" y="4.5" width="20" height="7.5" rx="1.4" fill="#FFFFFF"/>' +
    '<path d="M5 12 8.4 4.5M10 12l3.4-7.5M15 12l3.4-7.5" stroke="#0F172A" ' +
    'stroke-width="1.8" opacity="0.55"/>',
  // The plain warning triangle, for kinds with no symbol of their own.
  other:
    '<path d="M12 4.2 21.6 20.8H2.4z" fill="#FFFFFF"/>' +
    '<path d="M12 10v4.4" stroke="#0F172A" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="17.6" r="1.2" fill="#0F172A"/>'
};

/**
 * A teardrop pin for a LOCALIZED event.
 *
 * Hard-edged on purpose: a point event has a place, and the pin claims one.
 * The dark outline keeps it readable over both bright snow and dark forest on
 * satellite imagery, which a white outline alone does not.
 *
 * `ring` draws a pale halo — used to mark a camper report several people have
 * confirmed. Nothing here sets pointer-events; whether a pin can be tapped is
 * decided by its pane and its Leaflet marker, not by this markup.
 */
export const localizedPinHtml = (opts: {
  kind: LocalizedKind;
  /** Overrides the family colour. Used by nothing today; kept for one-offs. */
  color?: string;
  /** Pin width in px; the height follows at the pin's own ratio. Default 36. */
  size?: number;
  ring?: boolean;
}): string => {
  const { kind, color = LOCALIZED_COLOR[kind], size = 36, ring = false } = opts;
  const height = Math.round((size * 44) / 36);
  const body =
    'M18 1.5C9.4 1.5 2.5 8.4 2.5 17c0 10.8 15.5 25.5 15.5 25.5S33.5 27.8 33.5 17' +
    'C33.5 8.4 26.6 1.5 18 1.5z';
  return `
    <div style="width:${size}px;height:${height}px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))">
      <svg width="${size}" height="${height}" viewBox="0 0 36 44" aria-hidden="true">
        <path d="${body}" fill="${color}" stroke="#0F172A" stroke-width="2"
              stroke-linejoin="round"/>
        ${ring ? `<path d="${body}" fill="none" stroke="#F8FAFC" stroke-width="2.4" opacity="0.95" transform="translate(18 17) scale(0.8) translate(-18 -17)"/>` : ''}
        <g transform="translate(7.8 6.3) scale(0.85)">${LOCALIZED_GLYPH[kind]}</g>
      </svg>
    </div>`;
};

/* ------------------------------------------------------------------ */
/* Generalized events — one merged area, one badge                     */
/* ------------------------------------------------------------------ */

/**
 * The ink a glyph is drawn in, given what it is drawn ON.
 *
 * Two of these families are PALE — a cold snap is ice blue and wind is slate —
 * and a white snowflake on ice blue is a white shape on a nearly white disc.
 * Perceived brightness decides: pale disc, dark ink; everything else white.
 */
const glyphInk = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  const brightness =
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return brightness > 0.62 ? '#0F172A' : '#FFFFFF';
};

/** Glyphs for the centroid badge, on a 24x24 grid, drawn in `ink`. */
const GENERALIZED_GLYPH: Record<string, (ink: string, color: string) => string> = {
  // Raincloud with heavy drops.
  rain: (ink) =>
    `<g fill="${ink}"><circle cx="9" cy="10.6" r="3.6"/><circle cx="14" cy="9" r="4.6"/>` +
    '<circle cx="18" cy="11.2" r="3.2"/><rect x="8.6" y="10.4" width="9.8" height="4.2" rx="2.1"/></g>' +
    '<path d="M9.5 17.4 8 21.4M14 17.4 12.5 21.4M18.5 17.4 17 21.4" fill="none" ' +
    `stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`,
  // Cloud with a lightning bolt.
  storm: (ink) =>
    `<g fill="${ink}"><circle cx="9" cy="8.8" r="3.4"/><circle cx="14" cy="7.2" r="4.4"/>` +
    '<circle cx="18" cy="9.4" r="3"/><rect x="8.6" y="8.6" width="9.8" height="4" rx="2"/></g>' +
    `<path d="M14.2 12.8 9.8 19.6h2.9L11.6 23.4 16.6 17.2h-3z" fill="${ink}"/>`,
  // Thermometer reading high — the mercury is the badge colour showing through.
  heat: (ink, color) =>
    `<path d="M9.6 6.4a2.6 2.6 0 0 1 5.2 0v7.9a4.4 4.4 0 1 1-5.2 0z" fill="${ink}"/>` +
    `<path d="M12.2 8.6v8.4" fill="none" stroke="${color}" stroke-width="2" ` +
    'stroke-linecap="round"/>',
  // Snowflake.
  winter: (ink) =>
    '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M12 7.4 9.4 4.8M12 7.4l2.6-2.6' +
    `M12 16.6l-2.6 2.6M12 16.6l2.6 2.6" fill="none" stroke="${ink}" stroke-width="2" ` +
    'stroke-linecap="round"/>',
  // Haze: layered, staggered lines.
  smoke: (ink) =>
    `<path d="M3.5 7.5h13M7 12h13.5M3.5 16.5h13M7.5 21h11" fill="none" stroke="${ink}" ` +
    'stroke-width="2.2" stroke-linecap="round"/>',
  // Gust lines.
  wind: (ink) =>
    '<path d="M3 8h9.5a2.6 2.6 0 1 0-2.6-2.6M3 13h13a2.6 2.6 0 1 1-2.6 2.6M3 18h8.5" ' +
    `fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round" ` +
    'stroke-linejoin="round"/>'
};

/**
 * The single badge dropped at the centre of a merged generalized area.
 *
 * A filled disc in the family colour with a WHITE RING around it. The white is
 * not decoration: a purple storm badge on a dark satellite tile is nearly
 * invisible without it, and this map is mostly dark satellite tiles.
 */
export const centroidBadgeHtml = (badge: AlertBadge): string => {
  const color = BADGE_COLOR[badge];
  const ink = glyphInk(color);
  const glyph =
    GENERALIZED_GLYPH[badge]?.(ink, color) ?? GENERALIZED_GLYPH.wind(ink, color);
  return `
    <div style="width:44px;height:44px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="16" fill="${color}" stroke="#FFFFFF" stroke-width="3"/>
        <g transform="translate(10.6 10.6) scale(0.95)">${glyph}</g>
      </svg>
    </div>`;
};

/**
 * Split a warning's geometry into its separate pieces, one GeoJSON Feature
 * each, ready to hand to `L.geoJSON` as a FeatureCollection.
 *
 * WHY THIS EXISTS. Environment Canada publishes a warning once per forecast
 * region, and the server merges those rows back into one alert whose geometry
 * is a MultiPolygon — a heat warning over the prairies arrives as a dozen
 * scattered blocks. Handed a MultiPolygon, Leaflet draws every piece into ONE
 * `<path>` element, and a `<path>` can only carry one fill.
 *
 * Holes are preserved: a Polygon's inner rings stay attached to their outer
 * ring, so a warned area with a genuine gap in the middle keeps the gap.
 * Anything that is not a Polygon or MultiPolygon is passed through untouched
 * rather than dropped — an unexpected geometry type should still draw.
 */
export const explodeToFeatures = (geometry: unknown): GeoJSON.FeatureCollection => {
  const g = geometry as { type?: string; coordinates?: any; geometries?: unknown[] };
  const features: GeoJSON.Feature[] = [];

  const push = (geom: unknown): void => {
    const node = geom as { type?: string; coordinates?: any; geometries?: unknown[] };
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MultiPolygon' && Array.isArray(node.coordinates)) {
      node.coordinates.forEach((polygon: unknown) => {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: polygon as any }
        } as GeoJSON.Feature);
      });
      return;
    }
    if (node.type === 'GeometryCollection' && Array.isArray(node.geometries)) {
      node.geometries.forEach(push);
      return;
    }
    features.push({
      type: 'Feature', properties: {}, geometry: node as any
    } as GeoJSON.Feature);
  };

  push(g);
  return { type: 'FeatureCollection', features };
};

/* ------------------------------------------------------------------ */
/* Ring maths — area, centroid, and a point that is actually inside    */
/* ------------------------------------------------------------------ */

/** Shoelace area of a `[lon, lat]` ring. Signed: negative means clockwise. */
const ringSignedArea = (ring: [number, number][]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
};

const ringBbox = (ring: [number, number][]): [number, number, number, number] => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
};

/** Area-weighted centroid as `[lon, lat]`; bbox centre for a degenerate ring. */
const ringCentroid = (ring: [number, number][]): [number, number] => {
  const area = ringSignedArea(ring);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-14) {
    const [minX, minY, maxX, maxY] = ringBbox(ring);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [cx / (6 * area), cy / (6 * area)];
};

/** Standard ray cast, on a `[lon, lat]` ring. */
const pointInRing = (lon: number, lat: number, ring: [number, number][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)) {
      const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lat !== yi && x > lon) inside = !inside;
    }
  }
  return inside;
};

/**
 * A point INSIDE the ring to hang the badge on, as `[lat, lon]`.
 *
 * The area centroid first, because for the compact blobs agencies actually
 * issue it is the point that reads as "the middle". A C-shaped or horseshoe
 * region puts its centroid in the empty middle, though — a heat badge floating
 * over a valley the warning explicitly does not cover — so when the centroid
 * falls outside, we sweep the horizontal line through it and take the middle
 * of the WIDEST stretch that is genuinely inside. That is cheap (one pass over
 * the edges) and always lands on painted ground.
 */
export const ringLabelPoint = (ring: [number, number][]): [number, number] => {
  const [lon, lat] = ringCentroid(ring);
  if (pointInRing(lon, lat, ring)) return [lat, lon];

  const crossings: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)) {
      crossings.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    }
  }
  crossings.sort((a, b) => a - b);

  let bestMid = lon;
  let bestWidth = -1;
  // Crossings pair up: [0,1] is inside, [1,2] outside, [2,3] inside, and so on.
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const width = crossings[i + 1] - crossings[i];
    if (width > bestWidth) {
      bestWidth = width;
      bestMid = (crossings[i] + crossings[i + 1]) / 2;
    }
  }
  return [lat, bestMid];
};

/* ------------------------------------------------------------------ */
/* Turning forecast zones into a cloud                                 */
/* ------------------------------------------------------------------ */

/**
 * ONE CONTIGUOUS WARNED AREA, DRAWN AS A CLOUD.
 *
 * A generalized warning arrives as forecast-region parcels — administrative
 * boxes with surveyed corners, stair-stepping along township lines. Drawing
 * those parcels is the thing this replaces. Smoke does not stop at a survey
 * line; nothing about the shape of an air-quality region is a statement about
 * where the air is bad. A hard-edged parcel says "the hazard ends here", which
 * is a claim nobody made.
 *
 * So the parcels are generalised into a soft blob: the small stair-steps are
 * simplified away, the corners are rounded off, and the map pane the cloud is
 * drawn in carries a blur so the edge fades instead of stopping. What is left
 * says "roughly this area, edges unknown" — which is exactly what the feed
 * said.
 */
export interface CloudPiece {
  /**
   * The smoothed shape, as one Feature holding every parcel in this piece.
   * Draw it with `fillRule: 'nonzero'`: overlapping parcels then union
   * themselves in the renderer instead of punching a hole where they cross,
   * and the internal edges between abutting parcels never draw at all.
   */
  shape: GeoJSON.Feature;
  /** Where this piece's single badge goes, as `[lat, lon]`. Always inside. */
  labelPoint: [number, number];
  /** Rough size in square degrees. Used to rank pieces and drop slivers. */
  extent: number;
}

/**
 * A cheap identity for a polygon, used to drop exact duplicates.
 *
 * THIS GUARD IS NOT OPTIONAL. The dissolve works by cancelling edges that
 * appear twice, so two IDENTICAL polygons — which the feeds do send, when a
 * region carries both a warning and a matching statement — cancel each other
 * completely and the whole outline disappears. Vertex count plus three sampled
 * vertices is enough: two genuinely different zone polygons agreeing on all
 * four does not happen.
 */
const polygonKey = (rings: [number, number][][]): string => {
  const outer = rings[0] ?? [];
  const at = (i: number) => {
    const p = outer[i];
    return p ? `${p[0].toFixed(4)},${p[1].toFixed(4)}` : '-';
  };
  return `${rings.length}:${outer.length}:${at(0)}:${at(Math.floor(outer.length / 2))}:${at(outer.length - 1)}`;
};

/* ---- Softening a parcel into a cloud ------------------------------- */

/** Perpendicular distance from `p` to the segment `a`–`b`, in degrees. */
const perpDistance = (
  p: [number, number], a: [number, number], b: [number, number]
): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/**
 * Douglas–Peucker, iterative rather than recursive.
 *
 * A forecast region can carry a few thousand vertices, and a recursive
 * implementation on the UI thread is one deep call stack away from a blown
 * stack on a phone. The explicit stack costs nothing and cannot overflow.
 */
const simplifyLine = (
  points: [number, number][], tolerance: number
): [number, number][] => {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    if (j <= i + 1) continue;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let k = i + 1; k < j; k += 1) {
      const d = perpDistance(points[k], points[i], points[j]);
      if (d > farthestDistance) { farthestDistance = d; farthest = k; }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([i, farthest], [farthest, j]);
  }

  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
};

const isClosed = (ring: [number, number][]): boolean =>
  ring.length > 2 &&
  ring[0][0] === ring[ring.length - 1][0] &&
  ring[0][1] === ring[ring.length - 1][1];

/**
 * Simplify a CLOSED ring without letting it collapse.
 *
 * Douglas–Peucker needs two fixed endpoints, and a ring's first and last
 * vertex are the same point — run it straight and the whole ring reduces to
 * that one vertex. Splitting at the vertex farthest from the start gives two
 * open halves with four real endpoints between them, which is the standard fix
 * and keeps the ring's overall extent intact.
 */
const simplifyRing = (
  ring: [number, number][], tolerance: number
): [number, number][] => {
  const open = isClosed(ring) ? ring.slice(0, -1) : ring.slice();
  // Below this there is no detail to remove and every vertex is load-bearing.
  if (open.length < 8) return ring.slice();

  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < open.length; i += 1) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > farthestDistance) { farthestDistance = d; farthest = i; }
  }

  const front = simplifyLine(open.slice(0, farthest + 1), tolerance);
  const back = simplifyLine([...open.slice(farthest), open[0]], tolerance);
  const merged = [...front, ...back.slice(1)];
  // Too little left to be a shape: keep the original rather than draw a sliver.
  return merged.length < 5 ? ring.slice() : merged;
};

/**
 * Chaikin corner cutting — what actually turns a surveyed box into a blob.
 *
 * Each pass replaces every corner with two points a quarter of the way along
 * its two edges, so a right angle becomes a bevel, then a curve. Three passes
 * over a simplified ring is enough that no straight survey line survives at
 * map zoom, and cheap: the work is linear in vertices, and the simplify pass
 * has already cut those to a few dozen.
 */
const chaikinRing = (
  ring: [number, number][], iterations: number
): [number, number][] => {
  let points = isClosed(ring) ? ring.slice(0, -1) : ring.slice();
  if (points.length < 3) return ring.slice();

  for (let pass = 0; pass < iterations && points.length < 3000; pass += 1) {
    const next: [number, number][] = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    points = next;
  }

  points.push([points[0][0], points[0][1]]);
  return points;
};

/**
 * One parcel ring, softened into part of a cloud.
 *
 * The simplify tolerance is a fraction of the ring's own size, so a
 * province-sized region and a single county both lose about the same
 * PROPORTION of their detail and both read as the same kind of soft shape.
 * A fixed tolerance would leave a big region looking surveyed and erase a
 * small one entirely.
 */
export const cloudRing = (ring: [number, number][]): [number, number][] => {
  const [minX, minY, maxX, maxY] = ringBbox(ring);
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  if (!Number.isFinite(diagonal) || diagonal <= 0) return ring.slice();

  const softened = chaikinRing(simplifyRing(ring, diagonal / 70), 3);

  /**
   * PUT BACK THE GROUND THE ROUNDING TOOK OFF.
   *
   * Cutting a corner always removes area, and on a blocky region with only a
   * few corners it removes a lot of it — a plain rectangle loses about a
   * quarter. Every acre of that is ground the agency warned about and the map
   * would have quietly stopped shading. Under-drawing a hazard is the one
   * direction this app is not allowed to be wrong in.
   *
   * So the softened ring is scaled about its own centre until it covers the
   * same area it started with. The shape stays round; only its extent is
   * restored. The cap stops a degenerate ring from ballooning, and growing
   * slightly is fine — over-including a warning is the safe way to be wrong.
   */
  const before = Math.abs(ringSignedArea(ring));
  const after = Math.abs(ringSignedArea(softened));
  if (!(before > 0) || !(after > 0) || after >= before) return softened;

  const scale = Math.min(1.15, Math.sqrt(before / after));
  const [cx, cy] = ringCentroid(softened);
  return softened.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]);
};

/* ---- Which parcels are the same warned area ------------------------ */

/**
 * Group parcels that belong to ONE warned area.
 *
 * This is what fixes two badges sitting on a single smoke area. The old code
 * counted areas by reconstructing the merged outline and treating every closed
 * ring it produced as a separate region — so one warning whose outline came
 * back as two chains got two badges, and a warned area with a hole in it got a
 * badge floating in the hole.
 *
 * Counting the parcels themselves is both simpler and steadier: two parcels
 * are the same area when their bounding boxes touch or overlap, allowing a few
 * kilometres of slack for regions digitised separately. Grouping is
 * transitive, so a chain of eleven abutting forecast zones collapses to one
 * area with one badge — while Environment Canada's prairie warnings, which
 * really are blocks hundreds of kilometres apart, stay separate and keep a
 * badge each.
 *
 * It errs toward MERGING, deliberately: two badges on one area is the bug,
 * and one badge on two areas that nearly touch is not.
 */
const TOUCH_TOLERANCE_DEG = 0.05; // ~5 km

const groupTouchingPolygons = (boxes: [number, number, number, number][]): number[][] => {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain of abutting zones stays cheap.
    let node = i;
    while (parent[node] !== node) { const up = parent[node]; parent[node] = root; node = up; }
    return root;
  };

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const apart =
        a[2] + TOUCH_TOLERANCE_DEG < b[0] || b[2] + TOUCH_TOLERANCE_DEG < a[0] ||
        a[3] + TOUCH_TOLERANCE_DEG < b[1] || b[3] + TOUCH_TOLERANCE_DEG < a[1];
      if (apart) continue;
      const rootA = find(i);
      const rootB = find(j);
      if (rootA !== rootB) parent[rootA] = rootB;
    }
  }

  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(i);
    else groups.set(root, [i]);
  });
  return [...groups.values()];
};

/**
 * How close two parcel edges must be to count as the same edge.
 *
 * ~110 m. Forecast zones are coarse administrative polygons digitised
 * independently, so two that abut on the ground rarely share bit-exact
 * vertices. The same tolerance the boundary layer dissolves Crown land with.
 */
const CLOUD_DISSOLVE_SNAP = 1e-3;

/**
 * ONE OUTLINE FOR A WHOLE WARNED AREA, WITH THE INTERNAL SEAMS GONE.
 *
 * This is the fix for the clouds falling apart as you zoom in.
 *
 * The parcels of an area were being softened ONE AT A TIME and handed to the
 * map as a MultiPolygon of separate shapes. Rounding a corner pulls the shape
 * back from it, so every place four forecast zones met, the four rounded
 * corners retreated from the junction and opened a little concave diamond of
 * bare ground between them. Zoomed out those gaps are sub-pixel and the pane
 * blur smears over them, so the area really does read as one cloud. Zoom in
 * and every one of them opens up: the "cloud" becomes a lattice of blobs with
 * holes punched at every junction — the exact mesh of forecast parcels the
 * cloud rendering exists to get rid of, reappearing at the zoom where the
 * camper is actually reading the map.
 *
 * Scaling each parcel up to bridge its neighbours would only paper over it,
 * and would claim ground nobody warned about. The real answer is to stop
 * having internal edges at all: cancel the edges the parcels share, chain what
 * is left into the outline of the whole area, and soften THAT. A merged
 * outline has no internal corners, so there is nothing left for the rounding
 * to open up, at any zoom.
 *
 * Returns null when the merge cannot be trusted, and the caller falls back to
 * per-parcel softening. The chaining can fail to close a ring on messy input
 * and close it with a straight chord instead, which would silently move the
 * edge of a warning — so the result is only accepted if it still covers about
 * the same ground the parcels did. Seams are a cosmetic problem; a warning
 * drawn over the wrong ground is not, and it is the one we refuse to trade for.
 */
const mergedOutline = (
  parcels: [number, number][][][]
): [number, number][][] | null => {
  // A single parcel has no seams to remove.
  if (parcels.length < 2) return null;

  const segments = dissolveSegments(
    parcels.map((rings) => ({ geometry: { type: 'Polygon', coordinates: rings } })),
    CLOUD_DISSOLVE_SNAP
  );
  if (segments.length === 0) return null;

  const rings = segmentsToRings(segments, CLOUD_DISSOLVE_SNAP)
    .filter((ring) => ring.length >= 4);
  if (rings.length === 0) return null;

  const before = parcels.reduce(
    (sum, rings2) => sum + Math.abs(ringSignedArea(rings2[0])), 0
  );
  const after = rings.reduce((sum, ring) => sum + Math.abs(ringSignedArea(ring)), 0);
  // Under-covering means the chain closed across the shape and cut a piece of
  // the warning off. Wildly over-covering means it wrapped something it should
  // not have. Either way the parcels themselves are the safer drawing.
  if (!(before > 0) || after < before * 0.9 || after > before * 1.3) return null;

  return rings;
};

/**
 * THE WARNED AREA, AS CLOUDS.
 *
 * Hand it every geometry of one family in view; get back one piece per
 * contiguous warned area, biggest first, each already softened and each
 * carrying the single point its badge belongs on.
 *
 * There is no outline in the result and that is the point. The previous
 * version returned the dissolved outer boundary as a MultiLineString and the
 * map stroked it — which drew the forecast regions' surveyed edges as a hard
 * line, and drew a straight chord across the shape whenever the dissolve could
 * not close a chain. Both were the map claiming to know an edge it does not.
 *
 * The dissolve is still used, but only to decide WHAT SHAPE TO SOFTEN — the
 * merged outline goes straight into `cloudRing` and is never stroked as an
 * edge. See `mergedOutline`.
 */
export const cloudPieces = (geometries: unknown[]): CloudPiece[] => {
  const polygons: [number, number][][][] = [];
  const seen = new Set<string>();

  geometries.forEach((geometry) => {
    explodeToFeatures(geometry).features.forEach((feature) => {
      const geom = feature.geometry as { type?: string; coordinates?: unknown };
      if (geom?.type !== 'Polygon' || !Array.isArray(geom.coordinates)) return;
      const rings = geom.coordinates as [number, number][][];
      if (!Array.isArray(rings[0]) || rings[0].length < 4) return;
      const key = polygonKey(rings);
      if (seen.has(key)) return;
      seen.add(key);
      polygons.push(rings);
    });
  });

  if (polygons.length === 0) return [];

  const boxes = polygons.map((rings) => ringBbox(rings[0]));

  return groupTouchingPolygons(boxes)
    .map((indices) => {
      const parcels = indices.map((i) => polygons[i]);
      const merged = mergedOutline(parcels);
      /**
       * Soften the merged outline when there is one, the parcels when there
       * is not. A merged result can be several rings — genuinely separate
       * blocks the grouping pulled together, or a hole the area curves
       * around. Each becomes its own softened polygon, which fills a hole
       * rather than preserving it: over-shading a warning is the direction
       * this app is allowed to be wrong in, and a softened hole was never a
       * real edge anyway.
       */
      const softened = merged
        ? merged.map((ring) => [cloudRing(ring)])
        : parcels.map((rings) => rings.map((ring) => cloudRing(ring)));

      // The badge goes in the BIGGEST parcel of the area, at a point proven to
      // be inside it — never at the average of several parcels, which for a
      // horseshoe of regions lands in the gap they curve around.
      let biggest = 0;
      let biggestArea = -1;
      let extent = 0;
      softened.forEach((rings, k) => {
        const area = Math.abs(ringSignedArea(rings[0]));
        extent += area;
        if (area > biggestArea) { biggestArea = area; biggest = k; }
      });

      return {
        shape: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiPolygon', coordinates: softened as any }
        } as GeoJSON.Feature,
        labelPoint: ringLabelPoint(softened[biggest][0]),
        extent
      };
    })
    .sort((a, b) => b.extent - a.extent);
};

/** The active alerts whose drawn area contains a point — for the bottom card. */
export const alertsCoveringPoint = (
  lat: number, lon: number, alerts: HazardAlert[]
): HazardAlert[] =>
  alerts.filter((a) => a.geometry && pointInGeometry(lat, lon, a.geometry));
