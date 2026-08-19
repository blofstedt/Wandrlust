import { GeocodedLocation } from '../types';

/**
 * Geocoding via OpenStreetMap Nominatim.
 *
 * Nominatim's usage policy caps requests at 1/sec and requires an identifying
 * User-Agent or Referer. Browsers set Referer automatically; we additionally
 * debounce in the UI and cache results here to stay well inside the limit.
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
    limit: String(limit)
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

    const results: GeocodedLocation[] = raw.map((item) => {
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
    });

    remember(cacheKey, results);
    return results;
  } catch {
    // Network failure, abort, or offline: fail soft with no suggestions.
    return [];
  }
};

export const reverseGeocode = async (
  latitude: number,
  longitude: number
): Promise<string | null> => {
  const params = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    format: 'jsonv2',
    zoom: '10'
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!response.ok) return null;

    const data = await response.json();
    const addr = data?.address ?? {};
    const city = addr.city || addr.town || addr.village || addr.county;
    const region = addr.state || addr.province;
    if (city && region) return `${city}, ${region}`;
    return data?.display_name ?? null;
  } catch {
    return null;
  }
};
