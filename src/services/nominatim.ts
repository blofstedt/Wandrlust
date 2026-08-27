import { GeocodedLocation } from '../types';

/**
 * Geocoding via OpenStreetMap Nominatim.
 *
 * Nominatim's usage policy caps requests at 1/sec and requires an identifying
 * User-Agent or Referer. Browsers set Referer automatically; we additionally
 * debounce in the UI and cache results here to stay well inside the limit.
 *
 * Results are filtered to only include Canada and Continental USA (excluding
 * Alaska, Hawaii, and US territories).
 */

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
/**
 * Search results, capped.
 *
 * This used to grow without limit: every distinct query anyone typed stayed
 * in memory for the life of the tab, and this app is a PWA that people leave
 * open for days. A Map iterates in insertion order, so deleting the first
 * key evicts the oldest entry.
 */
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, GeocodedLocation[]>();

const remember = (key: string, value: GeocodedLocation[]): void => {
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
  address?: Record<string, string>;
}

/**
 * Non-continental US states and territories to exclude.
 * This ensures only Continental USA (lower 48) + Canada results are returned.
 */
const NON_CONTINENTAL_US_STATES = new Set([
  'Alaska', 'AK',
  'Hawaii', 'HI',
  'Puerto Rico', 'PR',
  'Guam', 'GU',
  'Virgin Islands', 'VI', 'US Virgin Islands',
  'American Samoa', 'AS',
  'Northern Mariana Islands', 'MP',
  'United States Minor Outlying Islands', 'UM'
]);

/**
 * Check if a location is in Canada or Continental USA.
 */
const isValidLocation = (location: GeocodedLocation): boolean => {
  const country = location.country.toUpperCase();
  
  // Canada - always valid
  if (country === 'CA' || country === 'CANADA') {
    return true;
  }
  
  // United States - need to check state
  if (country === 'US' || country === 'UNITED STATES' || country === 'USA') {
    const state = location.stateProvince.toUpperCase();
    // Check if state is in the exclusion list
    for (const excluded of NON_CONTINENTAL_US_STATES) {
      if (state.includes(excluded.toUpperCase())) {
        return false;
      }
    }
    return true;
  }
  
  // Any other country - exclude
  return false;
};

export const geocodeSearch = async (
  query: string,
  limit = 6
): Promise<GeocodedLocation[]> => {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const cacheKey = `${trimmed.toLowerCase()}::${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(limit),
    countrycodes: 'CA,US' // Restrict to Canada and United States
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return [];

    const raw: NominatimResult[] = await response.json();

    const results: GeocodedLocation[] = raw
      .map((item) => {
        const addr = item.address ?? {};
        const city =
          addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';

        const location: GeocodedLocation = {
          displayName: item.display_name,
          city,
          stateProvince: addr.state || addr.province || '',
          country: addr.country || '',
          lat: parseFloat(item.lat),
          lon: parseFloat(item.lon)
        };

        if (item.boundingbox && item.boundingbox.length === 4) {
          const [south, north, west, east] = item.boundingbox.map(Number);
          location.boundingBox = [south, north, west, east];
        }
        return location;
      })
      .filter(isValidLocation); // Filter to only Canada + Continental USA

    remember(cacheKey, results);
    return results;
  } catch {
    // Network failure, abort, or offline: fail soft with no suggestions.
    return [];
  }
};

