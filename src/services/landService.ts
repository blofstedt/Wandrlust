/**
 * Land-vs-water hit test (client wrapper).
 *
 * One endpoint, one method, in-memory cache. The check is on the
 * critical path of every pin drop, so the round trip is
 * debounce-and-cached rather than fetch-every-time.
 *
 *   - Cache key: 4-decimal lat/lon (~11 m precision). A user
 *     tapping 5 m away is asking the same question.
 *   - Cache TTL: 1 hour. The dataset (Natural Earth 110m) is
 *     a 5-year-stale snapshot of coastlines; 1 hour on top of
 *     that is rounding error.
 *   - Returns null on failure. The caller decides what to do
 *     with the uncertainty; today the right answer is "let
 *     the pin drop" — a check that fails open is better than
 *     a check that fails closed, because the failure mode
 *     (false negative — pin in water allowed) is recoverable
 *     (user can drag) and the cost is one wrong pin, while
 *     a false positive (pin on land refused) leaves the user
 *     with no recourse.
 */
const memCache = new Map<string, { at: number; onLand: boolean }>();
const MEM_TTL_MS = 60 * 60 * 1000;
const MEM_MAX_ENTRIES = 200;

const cacheKey = (lat: number, lon: number): string =>
  `${lat.toFixed(4)},${lon.toFixed(4)}`;

/**
 * Is the point on land?
 *
 *   - 200-entry in-memory cache keyed at 4-decimal precision.
 *   - Never throws. Returns null on a failed lookup so the
 *     caller can decide the policy (today: fail open).
 */
export const isOnLand = async (
  lat: number, lon: number, signal?: AbortSignal
): Promise<boolean | null> => {
  const key = cacheKey(lat, lon);
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.onLand;

  const params = new URLSearchParams({
    lat: lat.toFixed(5), lon: lon.toFixed(5)
  });
  try {
    const res = await fetch(`/api/land/at?${params.toString()}`, { signal });
    if (!res.ok) return null;
    const data = await res.json() as { onLand: boolean };
    if (typeof data?.onLand !== 'boolean') return null;
    if (memCache.size >= MEM_MAX_ENTRIES) {
      const oldest = memCache.keys().next().value;
      if (oldest) memCache.delete(oldest);
    }
    memCache.set(key, { at: Date.now(), onLand: data.onLand });
    return data.onLand;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return null;
    return null;
  }
};
