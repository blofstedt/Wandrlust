import { Campsite } from '../types';
import { TtlCache } from '../utils/ttlCache';

/**
 * Campsites OpenStreetMap knows about, via OUR server rather than Overpass.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NO LONGER TALKS TO OVERPASS ITSELF
 * ---------------------------------------------------------------------------
 *
 * It used to. Every camper's browser queried a public Overpass mirror
 * directly, on every meaningful pan of the map, and waited several seconds for
 * it. A thousand campers looking at the same valley meant a thousand identical
 * queries against a volunteer-funded service for an answer that is the same
 * every time — and the only thing between them and that was a ten-minute cache
 * inside the tab, which died with the tab and helped nobody else.
 *
 * `/api/osm-campsites` sweeps a piece of ground once and remembers it for
 * ninety days, so the second camper to look pays nothing and waits for
 * nothing. The shaping of a node into a campsite is unchanged and now lives in
 * `shared/osmCampsite.ts` — the server builds exactly what this file used to
 * build for itself.
 *
 * The in-tab cache is kept anyway. It is now about avoiding a round trip to
 * our own server while somebody nudges the map about; protecting Overpass is
 * the server's job.
 */
const campsiteCache = new TtlCache<Campsite[]>(10 * 60 * 1000, 40);

/**
 * NEVER THROWS, and returns an empty array when it cannot say.
 *
 * The house rule for everything in `src/services` — the app has to keep
 * working with no server, no keys and no signal. An empty list means "nothing
 * to add", and the campsites already held on the device are left alone.
 */
export const fetchOverpassCampsites = async (
  latitude: number,
  longitude: number,
  radiusMiles = 50
): Promise<Campsite[]> => {
  // Rounded to about a hundred metres — finer than the search radius cares
  // about, and coarse enough that nudging the map reuses the answer.
  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)},${Math.round(radiusMiles)}`;
  const cached = campsiteCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `/api/osm-campsites?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}` +
      `&radiusMiles=${Math.round(radiusMiles)}`
    );
    if (!res.ok) return [];

    const data = (await res.json().catch(() => null)) as { sites?: Campsite[] } | null;
    const sites = Array.isArray(data?.sites) ? (data.sites as Campsite[]) : [];

    /*
     * Only a real answer is remembered. The server distinguishes "swept and
     * found nothing" from "could not reach OpenStreetMap", and holding the
     * second here would keep an outage on screen for ten minutes after it had
     * passed.
     */
    if (sites.length > 0) campsiteCache.set(cacheKey, sites);
    return sites;
  } catch {
    return [];
  }
};
