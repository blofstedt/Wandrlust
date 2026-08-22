/**
 * How a backroad is drawn, and what the drawing claims.
 *
 * Four classes, and the difference between them is the difference between
 * three DIFFERENT facts — not three degrees of the same one:
 *
 *   solid  — OpenStreetMap says the surface is unpaved.
 *   dashed — OpenStreetMap calls it a track: a road built for forestry,
 *            agriculture or resource access. Nearly always unpaved, but the
 *            claim being made is about what the road is FOR.
 *   dotted — nobody has recorded the surface. This is the most common case
 *            in the backcountry and it is the whole reason the layer has a
 *            third style: rendering an unknown surface as though it were
 *            known is exactly the overstatement this app does not do.
 *   faint   — OSM records the road as private, or as needing a permit.
 *
 * The colours are chosen to sit on satellite imagery, which is the default
 * basemap and the one with no roads of its own. Amber reads against green
 * forest, grey rock and red desert; a cool grey does not.
 */
import type { BackroadWay } from '../types';

export type BackroadClass = 'unpaved' | 'track' | 'unrecorded' | 'restricted';

export interface BackroadStyle {
  color: string;
  weight: number;
  /** Leaflet dashArray. `undefined` is a solid line. */
  dash?: string;
  opacity: number;
  /** The words in the legend. */
  label: string;
  /** What the line actually claims, said in one short sentence. */
  meaning: string;
}

export const BACKROAD_STYLES: Record<BackroadClass, BackroadStyle> = {
  unpaved: {
    color: '#F59E0B',
    weight: 2.6,
    opacity: 0.95,
    label: 'Gravel or dirt',
    meaning: 'OSM records the surface as unpaved.'
  },
  track: {
    color: '#FBBF24',
    weight: 2.2,
    dash: '7 5',
    opacity: 0.95,
    label: 'Two-track / forest road',
    meaning: 'Built for forestry, farming or resource access.'
  },
  unrecorded: {
    color: '#E2E8F0',
    weight: 1.8,
    dash: '1 5',
    opacity: 0.8,
    label: 'Surface not recorded',
    meaning: 'A minor road nobody has written a surface down for.'
  },
  restricted: {
    color: '#FCA5A5',
    weight: 1.6,
    dash: '2 6',
    opacity: 0.65,
    label: 'Private or permit',
    meaning: 'OSM says this one is not open to drive.'
  }
};

/**
 * The order the legend lists them in, loudest claim first.
 */
export const BACKROAD_CLASS_ORDER: BackroadClass[] = [
  'unpaved', 'track', 'unrecorded', 'restricted'
];

/**
 * Access beats surface.
 *
 * A gravel road you may not drive is drawn as a road you may not drive. Told
 * the other way round — amber, like every other way in — the map would be
 * inviting a camper down somebody's driveway.
 */
export const backroadClassOf = (road: BackroadWay): BackroadClass => {
  if (road.access !== 'open') return 'restricted';
  if (road.surface === 'unpaved') return 'unpaved';
  if (road.kind === 'track') return 'track';
  return 'unrecorded';
};

/** The casing drawn under every line so it reads over bright imagery. */
export const BACKROAD_CASING = { color: '#0F172A', opacity: 0.5, extraWeight: 2.6 };
