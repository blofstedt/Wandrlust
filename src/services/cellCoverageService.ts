/**
 * Approximate cell coverage for a point, broken down by carrier.
 *
 * The estimate itself is built server-side — see `server/cellSources.ts` for
 * where the numbers come from and, more importantly, what they are not. The
 * short version, because it governs how this must be rendered:
 *
 *   It is derived from how far away the nearest recorded transmitter is. It is
 *   not a measurement, it ignores terrain, and a carrier with no data is
 *   reported as UNKNOWN, never as zero bars.
 *
 * `CellCoverage.basis` carries that caveat as text and travels with the data
 * on purpose, so a component cannot draw the bars without also having the
 * sentence that qualifies them to hand.
 *
 * Never throws. With no server, no key, or no signal of our own, this returns
 * `ok: false` and a note explaining which.
 */
import type { CellCoverage, CellTower } from '../types';

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

/* ------------------------------------------------------------------ *
 * Towers for the map layer
 * ------------------------------------------------------------------ */

export interface CellTowerResult {
  ok: boolean;
  towers: CellTower[];
  note?: string;
}

const EMPTY_TOWERS: CellTowerResult = { ok: false, towers: [] };

/**
 * Every surveyed transmitter in a viewport.
 *
 * Cached per rounded bounding box: masts do not move, and an ordinary pan
 * should not cost an Overpass query. Returns an empty list rather than
 * throwing, so a mirror being down costs the layer and nothing else.
 */
const towerCache = new Map<string, { at: number; data: CellTowerResult }>();
const TOWER_TTL_MS = 60 * 60 * 1000;
const TOWER_MAX_ENTRIES = 40;

export const fetchCellTowers = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  signal?: AbortSignal
): Promise<CellTowerResult> => {
  const params = new URLSearchParams({
    minLat: bbox.minLat.toFixed(3),
    minLon: bbox.minLon.toFixed(3),
    maxLat: bbox.maxLat.toFixed(3),
    maxLon: bbox.maxLon.toFixed(3)
  });

  const key = params.toString();
  const hit = towerCache.get(key);
  if (hit && Date.now() - hit.at < TOWER_TTL_MS) return hit.data;

  try {
    const res = await fetch(`/api/cell-towers?${params}`, { signal });
    if (!res.ok) return EMPTY_TOWERS;

    const data = (await res.json()) as CellTowerResult;
    const result: CellTowerResult = {
      ok: Boolean(data?.ok),
      towers: Array.isArray(data?.towers) ? data.towers : [],
      note: data?.note
    };

    if (towerCache.size >= TOWER_MAX_ENTRIES) {
      const oldest = towerCache.keys().next().value;
      if (oldest) towerCache.delete(oldest);
    }
    towerCache.set(key, { at: Date.now(), data: result });
    return result;
  } catch {
    return EMPTY_TOWERS;
  }
};

/**
 * How far a mast plausibly reaches, in metres, for the ring drawn around it.
 *
 * A single number standing in for transmit power, band, antenna height, sector
 * orientation and the shape of the ground — none of which we know. It is drawn
 * soft-edged and unlabelled for that reason: it is the rough area a mast might
 * serve on open ground, and the legend says so. A rural macrocell commonly
 * reaches somewhere in this range; a ridge between you and it reaches nothing.
 */
export const TOWER_REACH_M: Record<'strong' | 'usable', number> = {
  strong: 5_000,
  usable: 20_000
};