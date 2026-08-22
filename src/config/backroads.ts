/**
 * How a backroad is drawn, and what the drawing claims.
 *
 * Five classes, and the differences between them are differences between
 * DIFFERENT FACTS, not degrees of one:
 *
 *   amber solid  — OpenStreetMap says the surface is unpaved.
 *   amber dashed — OSM calls it a track: a road built for forestry,
 *                  agriculture or resource access. Nearly always unpaved,
 *                  but the claim being made is about what the road is FOR.
 *   dotted       — nobody has recorded the surface. The commonest case in
 *                  the backcountry, and the whole reason the layer has this
 *                  style at all: drawing an unknown surface as though it
 *                  were known is exactly the overstatement this app does not
 *                  make.
 *   grey solid   — OSM says it is paved. Drawn thin and quiet because it is
 *                  context, not the point: it is how you reach the gravel.
 *                  Without it the network draws as disconnected fragments
 *                  over satellite imagery, which has no roads of its own.
 *   faint        — OSM records the road as private, or as needing a permit.
 *
 * The colours are chosen to sit on satellite imagery, which is the default
 * basemap. Amber reads against green forest, grey rock and red desert.
 */
import type { BackroadWay } from '../types';

export type BackroadClass =
  'unpaved' | 'track' | 'unrecorded' | 'paved' | 'restricted';

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
  paved: {
    color: '#94A3B8',
    weight: 1.5,
    opacity: 0.7,
    label: 'Paved',
    meaning: 'OSM records this one as sealed. Shown for context.'
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
  'unpaved', 'track', 'unrecorded', 'paved', 'restricted'
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
  /**
   * PAVED IS CHECKED AFTER `track`, AND BEFORE `unrecorded`.
   *
   * After track, because a track OSM has tagged paved is still a track and
   * that is the more useful thing to say about it. Before unrecorded,
   * because the first version of this had no paved case at all — so every
   * asphalt street in town came through as "surface not recorded", which is
   * the map inventing an absence out of a tag that is plainly there.
   */
  if (road.surface === 'paved') return 'paved';
  return 'unrecorded';
};

/** The casing drawn under every line so it reads over bright imagery. */
export const BACKROAD_CASING = { color: '#0F172A', opacity: 0.5, extraWeight: 2.6 };
