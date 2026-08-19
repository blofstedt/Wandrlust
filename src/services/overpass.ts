import { Campsite, LandType, RoadAccess } from '../types';
import { TtlCache } from '../utils/ttlCache';

/**
 * Live campsite discovery via the OpenStreetMap Overpass API.
 *
 * We query for camp_site / caravan_site nodes and ways around a coordinate and
 * normalise them into the app's `Campsite` shape. Overpass mirrors go down
 * regularly, so we try several in order and fail soft with an empty array.
 */

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

const MILES_TO_METRES = 1609.34;

interface OverpassElement {
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

const toCampsite = (element: OverpassElement): Campsite | null => {
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

/**
 * Answers from this session, so searching the same place twice — or going
 * back to a place already searched — does not spend another Overpass query.
 * Ten minutes: campsites in OSM do not change on a shorter timescale than
 * that, and it is well within one trip-planning sitting.
 */
const campsiteCache = new TtlCache<Campsite[]>(10 * 60 * 1000, 40);

export const fetchOverpassCampsites = async (
  latitude: number,
  longitude: number,
  radiusMiles = 50,
  maxResults = 60
): Promise<Campsite[]> => {
  // Overpass struggles with very large radii; clamp to something sane.
  const radiusMetres = Math.min(Math.round(radiusMiles * MILES_TO_METRES), 80000);

  // Rounded to about a hundred metres — finer than the search radius cares
  // about, and coarse enough that nudging the map reuses the answer.
  const cacheKey =
    `${latitude.toFixed(3)},${longitude.toFixed(3)},${radiusMetres},${maxResults}`;
  const cached = campsiteCache.get(cacheKey);
  if (cached) return cached;

  const query = `[out:json][timeout:20];
(
  node["tourism"="camp_site"](around:${radiusMetres},${latitude},${longitude});
  way["tourism"="camp_site"](around:${radiusMetres},${latitude},${longitude});
  node["tourism"="caravan_site"](around:${radiusMetres},${latitude},${longitude});
);
out center ${maxResults};`;

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) continue;

      const data = await response.json();
      if (!Array.isArray(data?.elements)) continue;

      const sites = (data.elements as OverpassElement[])
        .map(toCampsite)
        .filter((site): site is Campsite => site !== null);

      // De-duplicate by rounded coordinate: OSM often has a node and a way
      // describing the same physical site.
      const seen = new Set<string>();
      const unique = sites.filter((site) => {
        const key = `${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Only a real answer is remembered. An empty array here is
      // indistinguishable from every mirror failing, and caching that would
      // keep an outage on screen after it ended.
      if (unique.length > 0) campsiteCache.set(cacheKey, unique);
      return unique;
    } catch {
      // Try the next mirror.
    }
  }

  return [];
};
