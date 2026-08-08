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
import localforage from 'localforage';
import type { CellCoverage } from '../types';

export const UNKNOWN_COVERAGE: CellCoverage = {
  ok: false,
  source: 'none',
  basis: '',
  carriers: [],
  note: 'Coverage unknown here. Plan for no signal.'
};

/**
 * Two-layer cache for cell coverage.
 *
 *   1. In-memory `Map` — 24 hours. Panning back across a recently-tapped
 *      spot in the same session is instant.
 *   2. localforage `wandrlust_coverage` — 7 days. Survives reloads and
 *      cold starts, so a returning user reads the same answer they got a
 *      week ago without spending a round trip.
 *
 * Towers do not move and 4G/5G upgrades are months-scale events, so 7 days
 * of staleness is well within what the answer can support. The server-side
 * cache (in `server/cellRoutes.ts`) is the longer one — 30 days — and is
 * what the in-memory and disk caches both fall through to.
 */
const coverageStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_coverage',
  description: 'Cached cell coverage lookups by rounded point'
});

const memCache = new Map<string, { at: number; data: CellCoverage }>();
const MEM_TTL_MS = 24 * 60 * 60 * 1000;
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEM_MAX_ENTRIES = 80;

interface DiskEntry { at: number; data: CellCoverage }

const memGet = (key: string): CellCoverage | null => {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEM_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return hit.data;
};

const memPut = (key: string, data: CellCoverage): void => {
  if (memCache.size >= MEM_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, { at: Date.now(), data });
};

const diskGet = async (key: string): Promise<CellCoverage | null> => {
  try {
    const hit = await coverageStore.getItem<DiskEntry>(key);
    if (!hit) return null;
    if (Date.now() - hit.at > DISK_TTL_MS) {
      coverageStore.removeItem(key).catch(() => { /* noop */ });
      return null;
    }
    return hit.data;
  } catch {
    return null;
  }
};

const diskPut = async (key: string, data: CellCoverage): Promise<void> => {
  try {
    await coverageStore.setItem<DiskEntry>(key, { at: Date.now(), data });
  } catch {
    // localforage failures are never fatal. The in-memory layer is still
    // warm for this session.
  }
};

export const fetchCellCoverage = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<CellCoverage> => {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;

  const fromMem = memGet(key);
  if (fromMem) return fromMem;

  const fromDisk = await diskGet(key);
  if (fromDisk) {
    memPut(key, fromDisk);
    return fromDisk;
  }

  try {
    const res = await fetch(
      `/api/cell-coverage?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
      { signal }
    );
    if (!res.ok) {
      return { ...UNKNOWN_COVERAGE, note: `Coverage lookup unavailable (${res.status}).` };
    }

    const data = (await res.json()) as CellCoverage;
    memPut(key, data);
    // Fire-and-forget. We do not block the caller on IndexedDB — the
    // in-memory layer is already warm, and the disk write is purely a
    // session bonus for the next reload.
    void diskPut(key, data);
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
