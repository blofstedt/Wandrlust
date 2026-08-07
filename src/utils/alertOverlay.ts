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
  features: { geometry: Geometry }[]
): [number, number][][] => {
  const counts = new Map<string, { seg: [number, number][]; n: number }>();
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
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
