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

/** Wildfire smoke and air-quality products, which the classifier files as fire. */
const SMOKE_TEXT = /smoke|air quality|air stagnation|blowing dust/i;

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

  // endpoint -> list of (otherEndpoint, segmentIndex)
  const hash = new Map<string, [number, number, number][]>();
  const keyOf = (p: [number, number]) =>
    `${Math.round(p[0] / snap)},${Math.round(p[1] / snap)}`;

  segments.forEach((seg, i) => {
    const [a, b] = seg;
    const ka = keyOf(a);
    const kb = keyOf(b);
    let aList = hash.get(ka);
    if (!aList) { aList = []; hash.set(ka, aList); }
    aList.push([b[0], b[1], i]);
    let bList = hash.get(kb);
    if (!bList) { bList = []; hash.set(kb, bList); }
    bList.push([a[0], a[1], i]);
  });

  const used = new Set<number>();
  const rings: [number, number][][] = [];

  // Walk from any unused segment. A chain that doesn't close is still
  // kept — we close it by appending the first vertex. Real-world data
  // has the occasional near-miss where two adjacent parcels' shared
  // edge differs by a fraction of a degree at one end, and dropping
  // the ring entirely means that whole group loses its fill. The
  // small straight line back to the start is invisible against the
  // heavy outline blur that draws the same group's edge.
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue;

    const ring: [number, number][] = [];
    const [a0, b0] = segments[start];
    ring.push([a0[0], a0[1]]);
    let current: [number, number] = [b0[0], b0[1]];
    used.add(start);

    const startKey = keyOf([a0[0], a0[1]]);
    // Hard cap on chain length. A chain that goes on for thousands of
    // vertices has gone wrong somewhere (a segment that double-counts,
    // a self-intersection) and we should bail rather than lock up the
    // UI thread.
    const MAX_CHAIN = 50000;
    let safety = MAX_CHAIN;

    while (safety-- > 0) {
      const ck = keyOf(current);
      if (ck === startKey && ring.length > 2) break;
      const candidates = hash.get(ck) ?? [];
      // Find the first candidate whose segment hasn't been used.
      let next: [number, number, number] | null = null;
      for (const c of candidates) {
        if (!used.has(c[2])) { next = c; break; }
      }
      if (!next) break; // dead end — close below
      used.add(next[2]);
      ring.push([current[0], current[1]]);
      current = [next[0], next[1]];
    }

    // Close the ring by appending the first vertex. If the chain
    // didn't loop back, this is a near-miss; if it did loop, this is
    // the conventional duplicate of the first point.
    ring.push([a0[0], a0[1]]);
    rings.push(ring);
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
    if (keptRings.length === 0) return;

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
/* Merging the parcels of one generalized event                        */
/* ------------------------------------------------------------------ */

export interface MergedArea {
  /**
   * Every source piece in ONE Feature. Draw it with `fillRule: 'nonzero'` and
   * overlapping pieces union themselves in the renderer — no seams, no holes
   * punched where two warnings overlap.
   */
  fill: GeoJSON.Feature;
  /**
   * The outer boundary only, as a MultiLineString. Internal edges between
   * abutting forecast zones are gone, so the merged area reads as one shape.
   */
  outline: GeoJSON.Feature;
  /** One badge position per merged piece, biggest first, as `[lat, lon]`. */
  labelPoints: [number, number][];
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

/**
 * MERGE THE PARCELS OF ONE GENERALIZED EVENT INTO ONE SHAPE.
 *
 * The redesign asks for a union — an `ST_Union`, if these polygons came from
 * our database. They do not: warning geometry arrives live from the National
 * Weather Service and Environment Canada, one polygon per forecast zone, and
 * there is no table to union it in. So the union happens here, on the client,
 * with the same segment-cancelling dissolve the boundary layer already uses:
 *
 *   FILL     — every source piece kept, drawn as one path with fill-rule
 *              nonzero. Overlaps merge instead of punching holes, and there is
 *              no internal division to see because it is a single fill.
 *   OUTLINE  — an edge shared by two abutting zones appears twice in the
 *              vertex data, once from each side. Hash every segment; the ones
 *              appearing exactly once are the true outer boundary. That is the
 *              only stroke drawn, so a rainfall warning over eleven zones is
 *              one outlined region rather than an eleven-cell honeycomb.
 *
 * The vertex-matching tolerance absorbs the mismatch between zones digitised
 * separately, which is what stops a hairline seam surviving between two blocks
 * that really do abut. It is derived from the shapes themselves — see
 * `autoSnap` in the body.
 *
 * Returns null when there is nothing drawable.
 */
export const mergeAreas = (
  geometries: unknown[],
  /**
   * Vertex-matching tolerance in degrees. Left unset it is derived from the
   * SMALLEST piece being merged — see `autoSnap` below, which is the guard
   * against a fixed 100 m tolerance eating a small warning's outline whole.
   */
  snap?: number,
  /** Rings whose bbox is smaller than this (in square degrees) are dropped. */
  minRingExtent = 1e-8
): MergedArea | null => {
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

  if (polygons.length === 0) return null;

  const fill: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polygons as any }
  } as GeoJSON.Feature;

  /**
   * TOLERANCE HAS TO SCALE WITH THE SHAPES, or it destroys the small ones.
   *
   * A flat 1e-3 (about 100 m) is right for a forecast zone the size of a
   * county, whose vertices sit kilometres apart. Handed a compact
   * storm-based polygon whose vertices are 50 m apart, the same tolerance
   * snaps neighbouring vertices onto one grid cell and the outline comes
   * apart. So the smallest piece in the set sets the tolerance — the safe
   * direction to err, because an exactly shared edge cancels at ANY
   * tolerance and only the near-miss case needs the slack.
   */
  const autoSnap = (): number => {
    let smallest = Infinity;
    for (const rings of polygons) {
      const [minX, minY, maxX, maxY] = ringBbox(rings[0]);
      smallest = Math.min(smallest, Math.max(maxX - minX, maxY - minY));
    }
    if (!Number.isFinite(smallest)) return 1e-3;
    return Math.min(1e-3, Math.max(1e-6, smallest / 400));
  };
  const tolerance = snap ?? autoSnap();

  const rings = segmentsToRings(
    dissolveSegments(
      polygons.map((coordinates) => ({ geometry: { type: 'Polygon', coordinates } })),
      tolerance
    ),
    tolerance
  ).filter((ring) => {
    if (ring.length < 4) return false;
    const [minX, minY, maxX, maxY] = ringBbox(ring);
    return (maxX - minX) * (maxY - minY) >= minRingExtent;
  });

  const outline: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiLineString', coordinates: rings as any }
  } as GeoJSON.Feature;

  /**
   * One badge per merged piece — not per source zone, and not one for the
   * whole event.
   *
   * Per zone is the scatter this refactor exists to remove. One for the whole
   * event is worse than it sounds: Environment Canada's prairie warnings come
   * as blocks hundreds of kilometres apart, and a single badge averaged across
   * them would sit over land no warning covers at all. A badge per merged
   * piece means every drawn area carries exactly one, wherever you have
   * panned to.
   *
   * Slivers left over from the dissolve are dropped by area, and the count is
   * capped so a pathological response cannot flood the DOM with markers.
   */
  const MAX_BADGES = 8;
  const byArea = rings
    .map((ring) => ({ ring, area: Math.abs(ringSignedArea(ring)) }))
    .sort((a, b) => b.area - a.area);
  const largest = byArea[0]?.area ?? 0;
  const labelPoints = byArea
    .filter(({ area }) => area >= largest * 0.04)
    .slice(0, MAX_BADGES)
    .map(({ ring }) => ringLabelPoint(ring));

  return { fill, outline, labelPoints };
};

/** The active alerts whose drawn area contains a point — for the bottom card. */
export const alertsCoveringPoint = (
  lat: number, lon: number, alerts: HazardAlert[]
): HazardAlert[] =>
  alerts.filter((a) => a.geometry && pointInGeometry(lat, lon, a.geometry));
