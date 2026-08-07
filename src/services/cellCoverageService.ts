/**
 * Approximate cell coverage for a point, broken down by carrier.
 *
 * The estimate itself is built server-side — see `server/cellRoutes.ts` for
 * where the numbers come from and, more importantly, what they are not. The
 * short version, because it governs how this must be rendered:
 *
 *   It is derived from how far away the nearest recorded tower is. It is not
 *   a measurement, it ignores terrain, and a carrier with no data is reported
 *   as UNKNOWN, never as zero bars.
 *
 * `CellCoverage.basis` carries that caveat as text and travels with the data
 * on purpose, so a component cannot draw the bars without also having the
 * sentence that qualifies them to hand.
 *
 * Never throws. With no server, no key, or no signal of our own, this returns
 * `ok: false` and a note explaining which.
 */
import type { CellCoverage } from '../types';

export const UNKNOWN_COVERAGE: CellCoverage = {
  ok: false,
  source: 'none',
  basis: '',
  carriers: [],
  note: 'Coverage unknown here. Plan for no signal.'
};

/**
 * Cached by rough position, because this answer is rough by construction.
 *
 * Two decimal places is about a kilometre — far finer than the estimate
 * deserves, and enough that panning around a valley does not re-query.
 */
const cache = new Map<string, { at: number; data: CellCoverage }>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 60;

export const fetchCellCoverage = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<CellCoverage> => {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  try {
    const res = await fetch(
      `/api/cell-coverage?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
      { signal }
    );
    if (!res.ok) {
      return { ...UNKNOWN_COVERAGE, note: `Coverage lookup unavailable (${res.status}).` };
    }

    const data = (await res.json()) as CellCoverage;

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return { ...UNKNOWN_COVERAGE, note: 'Coverage lookup unavailable offline.' };
  }
};

/**
 * The best carrier we have a number for, or null when we have none.
 *
 * Returns null rather than zero when nothing is known — the caller has to
 * decide what to say about an absence, and cannot be handed a number that
 * looks like a measurement of nothing.
 */
export const bestCarrier = (coverage: CellCoverage) => {
  const known = coverage.carriers.filter((c) => typeof c.bars === 'number');
  if (known.length === 0) return null;
  return known.reduce((best, c) => ((c.bars ?? 0) > (best.bars ?? 0) ? c : best));
};
