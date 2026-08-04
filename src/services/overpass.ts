import { Campsite, LandType, RoadAccess } from '../types';

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

const inferRoadAccess = (tags: Record<string, string>): RoadAccess => {
  const surface = (tags.surface ?? '').toLowerCase();
  const smoothness = (tags.smoothness ?? '').toLowerCase();

  if (smoothness.includes('very_bad') || smoothness.includes('horrible')) return '4x4_only';
  if (smoothness.includes('bad')) return 'high_clearance';
  if (surface.includes('asphalt') || surface.includes('paved') || surface.includes('concrete'))
    return 'paved';
  return 'gravel';
};

const yesish = (value?: string): boolean =>
  value === 'yes' || value === 'designated' || value === 'permissive';

const toCampsite = (element: OverpassElement): Campsite | null => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const tags = element.tags ?? {};
  const landType = inferLandType(tags);
  const isFree = tags.fee === 'no' || tags.fee === undefined;

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
    amenities: {
      water: yesish(tags.drinking_water) ? 'potable' : 'none',
      toilet: yesish(tags.toilets) ? 'vault' : 'none',
      roadAccess: inferRoadAccess(tags),
      cellSignal: { verizon: 0, att: 0, tmobile: 0 },
      maxRvLengthFeet: tags.caravans === 'yes' ? 30 : 0,
      fireRing: yesish(tags.openfire) || yesish(tags.fireplace),
      petFriendly: tags.dog !== 'no',
      trashService: yesish(tags.waste_disposal),
      shade: 'partial',
      stayLimitDays: tags.maxstay ? parseInt(tags.maxstay, 10) || 14 : 14,
      isFree,
      permitRequired: tags.permit === 'yes' || tags.access === 'permit'
    },
    images: [],
    reviews: [],
    rating: 0,
    reviewCount: 0,
    source: 'overpass'
  };
};

export const fetchOverpassCampsites = async (
  latitude: number,
  longitude: number,
  radiusMiles = 50,
  maxResults = 60
): Promise<Campsite[]> => {
  // Overpass struggles with very large radii; clamp to something sane.
  const radiusMetres = Math.min(Math.round(radiusMiles * MILES_TO_METRES), 80000);

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
      return sites.filter((site) => {
        const key = `${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      // Try the next mirror.
    }
  }

  return [];
};
