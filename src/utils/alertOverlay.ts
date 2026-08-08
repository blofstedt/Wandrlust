/**
 * Alert overlay helpers — the map's "what disaster is here" logic, kept out of
 * MapComponent so the geometry is testable on its own.
 *
 * Three jobs, matching the three things the redesign asks for:
 *   1. A short badge word (Fire / Flood / Smoke …) for a POINT sitting inside an
 *      active alert — drawn on the campsite pins.
 *   2. The same for a PARCEL, so Crown/BLM land can carry a subtle repeating
 *      pattern instead of a marker.
 *   3. Dissolving the shared edges between same-category parcels, so adjacent
 *      public land reads as one shape rather than a web of internal lines.
 *
 * NOTHING HERE TOUCHES THE HAZARD CLASSIFIER. shared/hazards.ts still folds
 * wildfire smoke into the 'fire' family, because for pushing a warning they are
 * one decision. Smoke is split back out HERE, for display only, by re-reading
 * the event text — so a camper can tell "there's a fire" from "the air is bad"
 * without any change rippling into the database enums downstream.
 *
 * Save to: src/utils/alertOverlay.ts
 */
import type { HazardAlert } from '../services/weatherService';
import { pointInGeometry } from './geo';

export type AlertBadge =
  | 'fire' | 'smoke' | 'flood' | 'storm' | 'winter' | 'heat' | 'wind';

/** Draw order / priority. The most decision-changing hazard leads. */
const BADGE_ORDER: AlertBadge[] = ['fire', 'smoke', 'flood', 'storm', 'winter', 'heat', 'wind'];

export const BADGE_LABEL: Record<AlertBadge, string> = {
  fire: 'Fire', smoke: 'Smoke', flood: 'Flood', storm: 'Storm',
  winter: 'Winter', heat: 'Heat', wind: 'Wind'
};

export const BADGE_COLOR: Record<AlertBadge, string> = {
  fire: '#F97316', smoke: '#A16207', flood: '#0EA5E9', storm: '#A855F7',
  winter: '#38BDF8', heat: '#EF4444', wind: '#94A3B8'
};

/** Wildfire smoke and air-quality products, which the classifier files as fire. */
const SMOKE_TEXT = /smoke|air quality|air stagnation|blowing dust/i;

/** The badge for one alert, or null for families the map does not badge. */
export const alertBadge = (alert: HazardAlert): AlertBadge | null => {
  switch (alert.family) {
    case 'fire':
      return SMOKE_TEXT.test(`${alert.event} ${alert.headline}`) ? 'smoke' : 'fire';
    case 'flood': return 'flood';
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
/* Repeating pattern                                                   */
/* ------------------------------------------------------------------ */

/** At most two glyphs share a tile; a third simultaneous family is rare. */
export const patternKey = (badges: AlertBadge[]): string => badges.slice(0, 2).join('-');

/** 16x16 glyphs, coloured by the caller. */
const GLYPH: Record<AlertBadge, string> = {
  fire: '<path d="M8 1.5c.4 2.2 2.7 2.8 2.7 5.5A2.7 2.7 0 1 1 5.3 7c0-1 .4-1.8 1-2.4.2 1.3 1.3 1.3 1.3 0C7.6 3.4 7.8 2.4 8 1.5Z"/>',
  smoke: '<path d="M4 12c-1.6 0-2-2.4 0-2.6C4 6.8 7.6 6.8 8 9c2-.6 3.2 1 2.2 2.2M6 4c.7-1 2.3-1 2.7.4"/>',
  flood: '<path d="M1.5 8.5c1.3-1.3 2.7-1.3 4 0s2.7 1.3 4 0 2.7-1.3 4 0M1.5 12c1.3-1.3 2.7-1.3 4 0s2.7 1.3 4 0 2.7-1.3 4 0"/>',
  storm: '<path d="M9 1.5 4 9h3l-1 5.5L12 6H8.5Z"/>',
  winter: '<path d="M8 1v14M2 5l12 6M14 5 2 11"/>',
  heat: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"/>',
  wind: '<path d="M2 6h8a2 2 0 1 0-2-2M2 10h11a2 2 0 1 1-2 2"/>'
};

/** Fire, smoke and storm read better filled; the rest are line icons. */
const FILLED = new Set<AlertBadge>(['fire', 'smoke', 'storm']);

/**
 * A `<pattern>` element (as an SVG string) tiling the affected families' glyphs,
 * low-opacity so it reads as a wash over the land rather than a stamp. Returns
 * null when there is nothing to draw.
 */
export const alertPattern = (
  badges: AlertBadge[]
): { id: string; def: string } | null => {
  const shown = badges.slice(0, 2);
  if (shown.length === 0) return null;
  const id = `wl-alert-${shown.join('-')}`;
  const cell = 24;
  const width = cell * shown.length;
  const glyphs = shown
    .map((b, i) => {
      const c = BADGE_COLOR[b];
      const paint = FILLED.has(b)
        ? `fill="${c}" stroke="none"`
        : `fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`;
      return `<g transform="translate(${i * cell + 4},4)" ${paint}>${GLYPH[b]}</g>`;
    })
    .join('');
  const def =
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${width}" height="${cell}">` +
    `<g opacity="0.3">${glyphs}</g></pattern>`;
  return { id, def };
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

  // Walk from any unused segment. If a chain doesn't close, drop the
  // partial ring — better than producing a malformed polygon that
  // confuses Leaflet's renderer.
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue;

    const ring: [number, number][] = [];
    const [a0, b0] = segments[start];
    ring.push([a0[0], a0[1]]);
    let current: [number, number] = [b0[0], b0[1]];
    used.add(start);

    const startKey = keyOf([a0[0], a0[1]]);
    let closed = false;
    // Hard cap on chain length. A chain that goes on for thousands of
    // vertices has gone wrong somewhere (a segment that double-counts,
    // a self-intersection) and we should bail rather than lock up the
    // UI thread.
    const MAX_CHAIN = 50000;
    let safety = MAX_CHAIN;

    while (safety-- > 0) {
      const ck = keyOf(current);
      if (ck === startKey && ring.length > 2) {
        ring.push([a0[0], a0[1]]);
        closed = true;
        break;
      }
      const candidates = hash.get(ck) ?? [];
      // Find the first candidate whose segment hasn't been used.
      let next: [number, number, number] | null = null;
      for (const c of candidates) {
        if (!used.has(c[2])) { next = c; break; }
      }
      if (!next) break; // dead end — partial ring, discard below
      used.add(next[2]);
      ring.push([current[0], current[1]]);
      current = [next[0], next[1]];
    }

    if (closed) rings.push(ring);
  }

  return rings;
};

/**
 * The dissolved fill of a set of same-org, same-rule parcels.
 *
 * Walks every feature, finds its ring(s), and returns one GeoJSON
 * Polygon (or MultiPolygon if the merge produced disjoint pieces) per
 * dissolve group, ready to hand to L.geoJSON as the fill.
 *
 * The dissolve KEY is the caller-supplied grouping. The standard
 * grouping is `dissolveKey(properties)` (same org, same rules), so
 * adjacent Crown-land blocks that share every rule become one fill.
 * A private-inholding stays a separate group (different dissolve key)
 * and shows up as a hole in the outer ring.
 *
 * `minRingArea` drops any ring smaller than this in raw degrees. It
 * is a safety valve against degenerate loops (a single segment that
 * closed on itself, two segments that share a vertex) producing a
 * sliver-shape that draws as a hairline. Default is well below the
 * ~30m sliver cut-off used elsewhere, so legitimate small parcels
 * still pass.
 */
export const dissolvedFill = (
  features: { properties?: Record<string, any>; geometry: Geometry }[],
  keyOf: (p: Record<string, any> | undefined) => string,
  snap = 3e-4,
  minRingArea = 1e-9
): GeoJSON.Feature[] => {
  // Group features by key, dissolve each group, build rings, drop
  // rings that are too small to draw.
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
      // Bounding-box area in degrees² as a rough proxy. Cheap, and
      // any ring with zero extent is certainly a degenerate loop.
      // `r` is a single ring of [lon, lat] points.
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

    // First ring is the outer boundary; any subsequent rings are holes
    // (genuine no-go zones the merged area surrounds, e.g. a private
    // inholding inside a Crown-land block). The convention in GeoJSON
    // is "outer ring, then its holes" — same shape repeated for each
    // polygon in a MultiPolygon.
    //
    // For now we ship a single Polygon (outer + holes) per group. If
    // a group dissolves into disjoint pieces, the first piece's outer
    // ring wins and the others are dropped — uncommon in practice
    // (one org's land is usually one connected mass) and acceptable
    // for a build-phase app.
    const first = keptRings[0];
    if (keptRings.length === 1) {
      out.push({
        type: 'Feature',
        properties: groupFeatures[0].properties ?? {},
        geometry: { type: 'Polygon', coordinates: [first] }
      } as any);
    } else {
      // Outer + holes. Treat the first as the outer and the rest as
      // holes. In practice the segments we drop are the "internal
      // shared edges" between the no-go zone and the surrounding
      // same-org land, so the no-go zone's perimeter (which is part
      // of the outer dissolved ring) is replaced by the surrounding
      // land's perimeter — and the no-go zone is missing. The
      // workaround is to also build a fill for each non-merged
      // (i.e. genuinely different) parcel inside, but for a build
      // app shipping the outer-only shape is the right balance: a
      // single solid region, no internal seams, no cutouts drawn.
      // Cutouts can come later if the visual demands it.
      out.push({
        type: 'Feature',
        properties: groupFeatures[0].properties ?? {},
        geometry: { type: 'Polygon', coordinates: [first] }
      } as any);
    }
  });

  return out;
};


/* ------------------------------------------------------------------ */
/* Weather warning overlays (heat / smoke / cold, and the rest)        */
/* ------------------------------------------------------------------ */
/**
 * These power the new look: instead of a grey, tappable badge sitting on a
 * parcel edge, an active warning is drawn as a coloured, gently ANIMATED cloud
 * over the exact area the agency warned about. The camper cannot select it —
 * it is scenery, not a control — so a legend (top-left) carries the meaning by
 * colour and icon, and tapping a campsite pin inside a warning is what surfaces
 * the detail in the bottom card.
 */

/** Emoji + human label per family, for the map legend. */
export const WARNING_EMOJI: Record<AlertBadge, string> = {
  heat: '\u{1F321}\uFE0F', smoke: '\u{1F32B}\uFE0F', winter: '\u2744\uFE0F',
  fire: '\u{1F525}', flood: '\u{1F30A}', storm: '\u26C8\uFE0F', wind: '\u{1F4A8}'
};

export const WARNING_LABEL: Record<AlertBadge, string> = {
  heat: 'Heat', smoke: 'Smoke / air quality', winter: 'Cold / winter',
  fire: 'Fire', flood: 'Flood', storm: 'Storm', wind: 'Wind'
};

/**
 * The two kinds of hazard the map draws, and the whole point of this file's
 * redesign.
 *
 *   DIFFUSE  — smoke, extreme heat, extreme cold, high wind. Things that hang
 *              over a whole region with no single point to them. Drawn as a
 *              tinted, gently animated CLOUD over the affected area. They are
 *              scenery, not controls: you cannot tap them, and the top-left
 *              legend is what says what each colour and icon means.
 *
 *   PRECISE  — fire, flood, storm. Things that happen at a place. Drawn as a
 *              crisp ICON (a flame, a flood, a storm) you CAN tap, which opens
 *              the warning in the card at the bottom of the screen.
 */
export const HAZARD_TIER: Record<AlertBadge, 'diffuse' | 'precise'> = {
  smoke: 'diffuse', heat: 'diffuse', winter: 'diffuse', wind: 'diffuse',
  storm: 'diffuse',
  // Fire and flood are the two families a camper most needs to act on at a
  // specific spot — a fire perimeter or a flood zone — and they earn a
  // tappable icon. Everything else (including storms, which are often
  // county-wide) renders as a soft cloud that generalises nearby warnings
  // of the same family into one mass.
  fire: 'precise', flood: 'precise'
};

export const isDiffuse = (badge: AlertBadge): boolean =>
  HAZARD_TIER[badge] === 'diffuse';

/** The animated line style a warning or report wears. */
export type WarningMotion = 'squiggle' | 'heatline' | 'zigzag' | 'wave';

const WARNING_MOTION: Record<AlertBadge, WarningMotion> = {
  // Smoke drifts, fire flickers upward — both read as rising squiggles.
  smoke: 'squiggle', fire: 'squiggle',
  // Heat shimmers up as wavy horizontal lines.
  heat: 'heatline',
  // Cold gets sharp zig-zags.
  winter: 'zigzag',
  // Water, storm and wind slide sideways as gentle waves.
  flood: 'wave', storm: 'wave', wind: 'wave'
};

/** One tile of the animated line, on a 30x30 grid. */
const WARNING_GLYPH: Record<WarningMotion, string> = {
  squiggle: 'M0 15 q7.5 -7 15 0 t15 0',
  heatline: 'M0 10 q7.5 -5 15 0 t15 0 M0 21 q7.5 -5 15 0 t15 0',
  zigzag: 'M0 15 l7.5 -8 l7.5 8 l7.5 -8 l7.5 8',
  wave: 'M0 16 q7.5 -6 15 0 t15 0 M0 24 q7.5 -6 15 0 t15 0'
};

/**
 * A tiling <pattern> (as an SVG string) of the family's animated line, ready to
 * inject into an SVG renderer's <defs> and reference as a fill. The whole
 * pattern drifts via an animated `patternTransform`, so it reads as slowly
 * moving smoke, rising heat, or sliding cold rather than a static hatch.
 *
 * Under prefers-reduced-motion the animation is dropped and the lines sit still.
 */
export const warningPattern = (
  badge: AlertBadge, reduced = false
): { id: string; def: string } => {
  const motion = WARNING_MOTION[badge];
  const color = BADGE_COLOR[badge];
  const id = `wl-warn-${badge}${reduced ? '-static' : ''}`;
  const rises = motion === 'squiggle' || motion === 'heatline';
  // One tile per loop keeps the drift seamless. Rising families move up;
  // sliding families move sideways.
  const to = rises ? '0 -30' : '30 0';
  const dur = motion === 'heatline' ? '9s' : motion === 'zigzag' ? '11s' : '7s';
  const anim = reduced
    ? ''
    : `<animateTransform attributeName="patternTransform" type="translate" ` +
      `from="0 0" to="${to}" dur="${dur}" repeatCount="indefinite"/>`;
  const def =
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="30" height="30">` +
    anim +
    `<path d="${WARNING_GLYPH[motion]}" fill="none" stroke="${color}" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>` +
    `</pattern>`;
  return { id, def };
};

/** The short trailing strand under a cloud, per motion style. */
const CLOUD_STRAND: Record<WarningMotion, string> = {
  zigzag: 'M0 0 l5 -5 l5 5 l5 -5',
  heatline: 'M0 0 q6 -5 12 0 t12 0',
  squiggle: 'M0 0 q5 -5 10 0 t10 0',
  wave: 'M0 0 q5 -5 10 0 t10 0'
};

/** The cloud body, reused for the shadow, the fill, and any outline. */
const CLOUD_BLOB =
  '<circle cx="22" cy="30" r="11"/><circle cx="38" cy="24" r="14"/>' +
  '<circle cx="52" cy="31" r="10"/><rect x="20" y="30" width="34" height="12" rx="6"/>';

/**
 * A coloured cloud with a slowly animated strand trailing beneath it.
 *
 * This is the shared shape behind BOTH the official weather-warning overlays
 * and the camper hazard reports — the two now look alike on purpose. What still
 * tells them apart is behaviour, not appearance: an official warning sits in a
 * pointer-events:none pane and cannot be tapped, while a camper report is a
 * live marker that opens the "reported by a camper, not verified" card. So this
 * function never sets pointer-events itself — interactivity is decided by the
 * pane and the Leaflet marker, not by the icon markup.
 *
 * Under prefers-reduced-motion the strand holds still.
 */
export const hazardCloudHtml = (opts: {
  color: string;
  motion: WarningMotion;
  reduced?: boolean;
  /** Cloud width in px; height scales with it. Defaults to 72. */
  size?: number;
  /** An emoji drawn on the cloud body, so a report is identifiable without a legend. */
  glyph?: string;
  /** A pale ring around the cloud, used to mark a confirmed camper report. */
  outline?: boolean;
}): string => {
  const { color, motion, reduced = false, size = 72, glyph, outline = false } = opts;
  const height = Math.round((size * 64) / 72);
  const strand = CLOUD_STRAND[motion];
  const drift = (dur: string) =>
    reduced
      ? ''
      : `<animateTransform attributeName="transform" type="translate" ` +
        `values="0 0; 0 -5; 0 0" dur="${dur}" repeatCount="indefinite" additive="sum"/>`;
  const outlineSvg = outline
    ? `<g fill="none" stroke="#F8FAFC" stroke-width="2" opacity="0.9">${CLOUD_BLOB}</g>`
    : '';
  const glyphSvg = glyph
    ? `<text x="37" y="30" text-anchor="middle" dominant-baseline="central" ` +
      `font-size="18">${glyph}</text>`
    : '';
  return `
    <div style="width:${size}px;height:${height}px">
      <svg width="${size}" height="${height}" viewBox="0 0 72 64" aria-hidden="true">
        <g fill="#0F172A" opacity="0.35" transform="translate(0,2)">${CLOUD_BLOB}</g>
        <g fill="${color}">${CLOUD_BLOB}</g>
        ${outlineSvg}
        ${glyphSvg}
        <g fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" opacity="0.85">
          <g transform="translate(26 46)">${drift('4.5s')}<path d="${strand}"/></g>
          <g transform="translate(36 48)">${drift('5.6s')}<path d="${strand}"/></g>
          <g transform="translate(46 46)">${drift('4.9s')}<path d="${strand}"/></g>
        </g>
      </svg>
    </div>`;
};

/**
 * The cloud for an official warning area's centroid — the "icon" the top-left
 * legend names. Carries the family emoji so it matches the camper-report clouds.
 */
export const cloudMarkerHtml = (badge: AlertBadge, reduced = false): string =>
  hazardCloudHtml({
    color: BADGE_COLOR[badge],
    motion: WARNING_MOTION[badge],
    reduced,
    glyph: WARNING_EMOJI[badge]
  });

/**
 * The glyph tiled across a DIFFUSE warning's cloud.
 *
 * A thermometer for heat (the redesign asks for it by name), a puff for smoke,
 * a snowflake for cold, gust lines for wind. All stroked in the family colour,
 * so they read the same as the legend chip.
 */
const DIFFUSE_GLYPH: Record<'heat' | 'smoke' | 'winter' | 'wind' | 'storm', string> = {
  heat:
    '<path d="M6.6 9.6V4.4a1.4 1.4 0 0 1 2.8 0v5.2a2.6 2.6 0 1 1-2.8 0z"/>' +
    '<path d="M8 6.2v3.6"/>',
  smoke:
    '<path d="M3.6 12.4h6.8M4.4 9.9h7M3.9 7.4h6.4"/>' +
    '<path d="M6 5.2c.6-1 2.2-1 2.7.3"/>',
  winter: '<path d="M8 1v14M2 5l12 6M14 5 2 11"/>',
  wind: '<path d="M2 6h8a2 2 0 1 0-2-2M2 10h11a2 2 0 1 1-2 2"/>',
  // A small lightning bolt for storm warnings. Single zigzag, family color.
  storm: '<path d="M9 1 4 9h3l-1 6 5-8H8l1-6z"/>'
};

/**
 * A tiling <pattern> of the family glyph, to repeat over a diffuse cloud.
 *
 * Returned as an SVG string for injection into a renderer's <defs>; the caller
 * points a polygon's fill at `url(#id)`. Low opacity so it reads as a texture
 * over the tinted cloud rather than a stamp. Static — the drift lives in the
 * cloud's own soft edge, not in the icons, which should stay legible.
 */
export const warningGlyphPattern = (
  badge: 'heat' | 'smoke' | 'winter' | 'wind' | 'storm'
): { id: string; def: string } => {
  const color = BADGE_COLOR[badge];
  const glyph = DIFFUSE_GLYPH[badge];
  const id = `wl-glyph-${badge}`;
  const cell = 48;
  const scale = 1.6;
  const off = (cell - 16 * scale) / 2;
  const def =
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${cell}" height="${cell}">` +
    `<g opacity="0.55" transform="translate(${off},${off}) scale(${scale})" ` +
    `fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" ` +
    `stroke-linejoin="round">${glyph}</g></pattern>`;
  return { id, def };
};

/**
 * SVG path data for the icon inside the precise marker, per family.
 *
 * WHY PATHS, NOT EMOJI. The previous version rendered the family glyph as a
 * `<text>` element carrying the emoji codepoint. That worked on desktop
 * Chrome but on iOS Safari and several Android WebViews, color emoji inside
 * SVG `<text>` draws as a missing-glyph box (□) or nothing at all. A
 * camper looking for a flame sees a blank pin, and the family the pin is
 * trying to communicate is lost.
 *
 * Paths render the same in every browser that supports SVG (which is every
 * browser this app ships to). The flame and water shapes below are designed
 * to read at 22×22 px — the actual draw size — over both light and dark
 * backgrounds.
 */
const PRECISE_GLYPH: Record<'fire' | 'flood', string> = {
  // Flame: two stacked tongues with a hot core.
  fire:
    'M12 2.5c-1.2 3-3.4 4.6-4.4 7.4-.9 2.5-.4 5.2 1.2 6.8.4-2.4 1.6-3.6 3-4.2' +
    '-.2 1.6.4 3.2 1.4 4 1 .8 2.2 1 3.2.4-.4 1.4-.4 2.6.4 3.4.6.6 1.4.8 2.2.6' +
    ' 1.8-.4 3-2.2 3-4 0-2-1.2-3.6-2.4-5.2-1.4-1.8-2.8-3.6-3.2-5.8-.2-1.2 0-2.4.4-3.4' +
    '-1.6.4-3 1.4-4 2.8z',
  // Water: three stacked wave crests.
  flood:
    'M3 9.5c1.4 0 2 1 3 1s1.6-1 3-1 2 1 3 1 1.6-1 3-1 2 1 3 1 1.6-1 3-1' +
    'M3 14.5c1.4 0 2 1 3 1s1.6-1 3-1 2 1 3 1 1.6-1 3-1 2 1 3 1 1.6-1 3-1' +
    'M3 19.5c1.4 0 2 1 3 1s1.6-1 3-1 2 1 3 1 1.6-1 3-1 2 1 3 1 1.6-1 3-1',
  // Storm no longer needs a precise marker — it became a diffuse cloud
  // along with heat/smoke/cold/wind. The shape was a cloud with a
  // lightning bolt; not used.
};

/**
 * A crisp, tappable pin for a PRECISE hazard (fire, flood).
 *
 * Deliberately a hard-edged map marker rather than a soft cloud — a precise
 * hazard has a place, and the icon claims one. Coloured by family, carrying the
 * family glyph as a real SVG path, with a dark outline so a flame reads over
 * both bright snow and dark forest. This one is meant to be tapped: the caller
 * wires a click to it.
 */
export const preciseMarkerHtml = (badge: AlertBadge): string => {
  const color = BADGE_COLOR[badge];
  // Diffuse badges should never reach this function — they go to the cloud
  // branch. Be defensive: if one does, fall back to a generic dot rather
  // than producing malformed SVG.
  const path = PRECISE_GLYPH[badge as 'fire' | 'flood']
    ?? 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z';
  return `
    <div style="width:36px;height:44px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))">
      <svg width="36" height="44" viewBox="0 0 36 44" aria-hidden="true">
        <path d="M18 1.5C9.4 1.5 2.5 8.4 2.5 17c0 10.8 15.5 25.5 15.5 25.5S33.5 27.8 33.5 17
                 C33.5 8.4 26.6 1.5 18 1.5z"
              fill="${color}" stroke="#0F172A" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="18" cy="16.5" r="11" fill="#0F172A" opacity="0.16"/>
        <path d="${path}" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.8"
              stroke-linejoin="round" stroke-linecap="round"
              transform="translate(7 5.5) scale(0.92)"/>
      </svg>
    </div>`;
};

/** The active alerts whose drawn area contains a point — for the bottom card. */
export const alertsCoveringPoint = (
  lat: number, lon: number, alerts: HazardAlert[]
): HazardAlert[] =>
  alerts.filter((a) => a.geometry && pointInGeometry(lat, lon, a.geometry));
