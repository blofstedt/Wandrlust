/**
 * Turning an OpenStreetMap campsite node into one of ours.
 *
 * Lifted out of `src/services/overpass.ts` unchanged so the SERVER can shape a
 * campsite too. The browser used to be the only thing that ever called
 * Overpass for campsites; now the server sweeps ground once and caches it for
 * everybody, and both halves have to agree exactly about what a node means —
 * the same reason `shared/hazards.ts` exists for the alert classifier.
 *
 * THE RULE THAT MATTERS IS THE ONE ABOUT ABSENT TAGS. An absent tag means
 * nobody has said, and every mapping here returns `undefined` for it rather
 * than a plausible default. An untagged node used to arrive carrying "no
 * water, no toilet, gravel road, partial shade, 14-day limit, zero bars on
 * every carrier" — none of it surveyed, none of it distinguishable from a real
 * observation.
 */
import type { Campsite, LandType, RoadAccess } from '../src/types.js';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Map OSM operator/ownership tags onto the app's land-type taxonomy. */
const inferLandType = (tags: Record<string, string>): LandType => {
  const haystack = [
    tags.operator,
    tags.owner,
    tags.name,
    tags['protected_area'],
    tags.ownership
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (haystack.includes('bureau of land management') || haystack.includes('blm')) return 'blm';
  if (
    haystack.includes('forest service') ||
    haystack.includes('national forest') ||
    haystack.includes('usfs')
  )
    return 'usfs';
  if (haystack.includes('crown') || haystack.includes('alberta') || haystack.includes('ontario'))
    return 'crown_land';
  if (haystack.includes('state')) return 'state_forest';
  return 'dispersed';
};

/**
 * Road access, ONLY where OpenStreetMap actually says something.
 *
 * This used to fall through to 'gravel' whenever a site had no surface or
 * smoothness tag — which is most of them. Every unsurveyed track in the
 * dataset was therefore presented to the user as a known gravel road.
 * Returning undefined lets the UI say nothing instead.
 */
const inferRoadAccess = (tags: Record<string, string>): RoadAccess | undefined => {
  const surface = (tags.surface ?? '').toLowerCase();
  const smoothness = (tags.smoothness ?? '').toLowerCase();

  if (smoothness.includes('very_bad') || smoothness.includes('horrible')) return '4x4_only';
  if (smoothness.includes('bad')) return 'high_clearance';
  if (surface.includes('asphalt') || surface.includes('paved') || surface.includes('concrete'))
    return 'paved';
  if (surface.includes('gravel') || surface.includes('dirt') || surface.includes('unpaved'))
    return 'gravel';
  return undefined;
};

const yesish = (value?: string): boolean =>
  value === 'yes' || value === 'designated' || value === 'permissive';

/**
 * A tag that is present and negative means no; a tag that is absent means
 * nobody has said. Collapsing those two into `false` is how "not surveyed"
 * became "no toilet".
 */
const triState = (value?: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (yesish(value)) return true;
  if (value === 'no' || value === 'none') return false;
  return undefined;
};

export const toCampsite = (element: OverpassElement): Campsite | null => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const tags = element.tags ?? {};
  const landType = inferLandType(tags);
  // An absent `fee` tag means nobody recorded whether there is one, not that
  // the site is free.
  const isFree = tags.fee === undefined ? undefined : tags.fee === 'no';

  return {
    id: `osm-${element.type}-${element.id}`,
    name: tags.name || tags.operator || 'Unnamed Dispersed Site',
    landType,
    landManager: tags.operator || 'Unknown / Community reported',
    latitude: lat,
    longitude: lon,
    elevationFt: tags.ele ? Math.round(parseFloat(tags.ele) * 3.28084) : undefined,
    address: {
      nearestCity: tags['addr:city'] || '',
      stateProvince: tags['addr:state'] || tags['addr:province'] || '',
      country: tags['addr:country'] || ''
    },
    description:
      tags.description ||
      tags.note ||
      'Community-reported campsite sourced live from OpenStreetMap. Verify access and regulations before travelling.',
    /**
     * Only what OpenStreetMap was actually tagged with.
     *
     * Everything here used to have a fallback, so an untagged node arrived
     * carrying "no water, no toilet, gravel road, partial shade, 14-day limit,
     * 0 bars on every carrier" — none of it surveyed, all of it indistinguishable
     * from a real observation. Cell signal is gone entirely: OSM does not
     * record carrier coverage, so there was never anything to report.
     */
    amenities: {
      water: triState(tags.drinking_water) ? 'potable' : undefined,
      toilet: triState(tags.toilets) ? 'vault' : undefined,
      roadAccess: inferRoadAccess(tags),
      maxRvLengthFeet: tags.maxlength ? parseInt(tags.maxlength, 10) || undefined : undefined,
      fireRing: triState(tags.openfire) ?? triState(tags.fireplace),
      petFriendly: triState(tags.dog),
      trashService: triState(tags.waste_disposal),
      stayLimitDays: tags.maxstay ? parseInt(tags.maxstay, 10) || undefined : undefined,
      isFree,
      permitRequired:
        tags.permit === 'yes' || tags.access === 'permit' ? true : undefined
    },
    images: [],
    reviews: [],
    rating: 0,
    reviewCount: 0,
    source: 'overpass'
  };
};

