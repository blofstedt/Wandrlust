import localforage from 'localforage';
import type { BoundingBox } from '../config/coverage';
import type { ScoutBatch, ScoutPoint, ScoutCalibration } from './scoutMode';

/**
 * The roads this phone has driven, kept on this phone.
 *
 * ---------------------------------------------------------------------------
 * WHY LOCAL FIRST, AND NOT THE DATABASE
 * ---------------------------------------------------------------------------
 *
 * Scout Mode is crowd-sensing, and a crowd-sensing feature is worth nothing
 * until there is a crowd. Waiting for one meant the recorder ran, the battery
 * drained, points were paid, and not one metre was ever drawn for anybody —
 * which is exactly the state this feature sat in.
 *
 * Storing traces here changes what it is. "Roads I have driven, and how rough
 * they were" is useful to ONE person on their first drive, needs no server,
 * no account and no signal, and builds the shared dataset as a side effect
 * rather than as a precondition. Batches still upload for the pooled version
 * later; nothing on the map waits for that to come back.
 *
 * ---------------------------------------------------------------------------
 * HOUSE RULES THAT APPLY HERE
 * ---------------------------------------------------------------------------
 *
 * Nothing in this file throws. A full disk, a private window, a browser with
 * IndexedDB switched off — every one of them degrades to "the map draws what
 * it drew before", never to a broken render or a lost drive.
 *
 * And nothing here merges, averages or counts passes. Each drive is stored as
 * it was recorded and the layer draws all of them; where they overlap the
 * alpha compounds and the road firms up on its own. See `PASS_ALPHA` in
 * config/scoutRoughness.ts for why that is the honest way round.
 */

export interface ScoutTrace {
  id: string;
  recordedAt: string;
  points: ScoutPoint[];
  /** Precomputed extent, so viewport filtering never walks the points. */
  bounds: BoundingBox;
  meanSpeedKph: number;
  distanceM: number;
  /** False when the fallback baseline was used — said out loud on screen. */
  calibrated: boolean;
}

const traceStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_scout_traces',
  description: 'Road roughness recorded by this device'
});

const metaStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_scout_meta',
  description: 'Scout calibration and trace index'
});

const INDEX_KEY = 'scout_trace_index';
const CALIBRATION_KEY = 'scout_calibration';

/**
 * Ceilings, so a season of driving cannot fill a phone.
 *
 * A point is roughly ten to twenty metres of road, so 150k points is a few
 * thousand kilometres — more than anyone will drive between app updates, and
 * small enough to read into memory without a stutter. Oldest goes first.
 */
const MAX_POINTS = 150_000;
const MAX_TRACES = 2_000;

/** `{ id: bounds + size }` so a viewport lookup opens only what it must. */
type TraceIndex = Record<
  string,
  { bounds: BoundingBox; points: number; recordedAt: string }
>;

let indexCache: TraceIndex | null = null;

const readIndex = async (): Promise<TraceIndex> => {
  if (indexCache) return indexCache;
  try {
    const stored = await metaStore.getItem<TraceIndex>(INDEX_KEY);
    indexCache = stored && typeof stored === 'object' ? stored : {};
  } catch {
    indexCache = {};
  }
  return indexCache;
};

const writeIndex = async (index: TraceIndex): Promise<void> => {
  indexCache = index;
  try {
    await metaStore.setItem(INDEX_KEY, index);
  } catch {
    // The in-memory copy still serves this session.
  }
};

const boundsOf = (points: ScoutPoint[]): BoundingBox => {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
};

const intersects = (a: BoundingBox, b: BoundingBox): boolean =>
  a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLon <= b.maxLon && a.maxLon >= b.minLon;

/* -------------------------------------------------------------------------- */
/* Telling the map something changed                                           */
/* -------------------------------------------------------------------------- */

/**
 * The map layer reads this store on pan and zoom, which means a drive
 * recorded while the map sits still would not appear until the camper moved
 * it. A one-line subscription is cheaper than polling and cheaper than
 * threading a callback down through the panel, the app and the map.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export const onTracesChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const announce = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must not stop the others, or the write.
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keep a recorded batch.
 *
 * Only batches that passed the mount, speed and distance gates are stored —
 * a phone rattling in a door pocket is not a road, and drawing it would put
 * a colour on the map that means nothing. Rejected batches still upload, so
 * the thresholds can be retuned later against real refusals.
 */
export const saveTrace = async (batch: ScoutBatch): Promise<ScoutTrace | null> => {
  if (!batch.dashMounted || batch.points.length < 2) return null;

  const trace: ScoutTrace = {
    id: `${Date.parse(batch.recordedAt) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: batch.recordedAt,
    points: batch.points,
    bounds: boundsOf(batch.points),
    meanSpeedKph: batch.meanSpeedKph,
    distanceM: batch.distanceM,
    calibrated: batch.calibrated
  };

  try {
    await traceStore.setItem(trace.id, trace);
  } catch {
    // Out of room, or no storage at all. The drive is lost rather than the
    // app, which is the right way round for a best-effort record.
    return null;
  }

  const index = { ...(await readIndex()) };
  index[trace.id] = {
    bounds: trace.bounds,
    points: trace.points.length,
    recordedAt: trace.recordedAt
  };

  await writeIndex(await prune(index));
  announce();
  return trace;
};

/** Drop the oldest traces until the device is back under both ceilings. */
const prune = async (index: TraceIndex): Promise<TraceIndex> => {
  const entries = Object.entries(index).sort(
    (a, b) => Date.parse(a[1].recordedAt) - Date.parse(b[1].recordedAt)
  );

  let points = entries.reduce((n, [, e]) => n + e.points, 0);
  let count = entries.length;
  const kept: TraceIndex = { ...index };

  for (const [id, entry] of entries) {
    if (points <= MAX_POINTS && count <= MAX_TRACES) break;
    delete kept[id];
    points -= entry.points;
    count -= 1;
    try {
      await traceStore.removeItem(id);
    } catch {
      // Already gone, or unreadable. The index no longer points at it either.
    }
  }

  return kept;
};

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Traces touching a viewport.
 *
 * The index decides which drives matter before anything is deserialised, so
 * panning across a province reads the two or three that are actually on
 * screen rather than every drive ever recorded.
 */
export const tracesIn = async (box: BoundingBox): Promise<ScoutTrace[]> => {
  const index = await readIndex();

  const needed = Object.entries(index)
    .filter(([, entry]) => intersects(entry.bounds, box))
    .map(([id]) => id);

  if (needed.length === 0) return [];

  const traces: ScoutTrace[] = [];
  for (const id of needed) {
    try {
      const trace = await traceStore.getItem<ScoutTrace>(id);
      if (trace && Array.isArray(trace.points) && trace.points.length > 1) traces.push(trace);
    } catch {
      // One unreadable drive must not lose the rest of the viewport.
    }
  }

  return traces;
};

export interface ScoutSummary {
  traces: number;
  points: number;
  distanceKm: number;
  lastRecordedAt: string | null;
}

export const scoutSummary = async (): Promise<ScoutSummary> => {
  try {
    const index = await readIndex();
    const entries = Object.values(index);
    if (entries.length === 0) {
      return { traces: 0, points: 0, distanceKm: 0, lastRecordedAt: null };
    }

    /*
     * Distance is estimated from the point count rather than stored per
     * trace, because the index is what this reads and the index holds sizes,
     * not lengths. It is quoted as "about" wherever it is shown for exactly
     * that reason.
     */
    const points = entries.reduce((n, e) => n + e.points, 0);
    const last = entries
      .map((e) => e.recordedAt)
      .sort()
      .pop() ?? null;

    return {
      traces: entries.length,
      points,
      distanceKm: Math.round((points * 15) / 1000),
      lastRecordedAt: last
    };
  } catch {
    return { traces: 0, points: 0, distanceKm: 0, lastRecordedAt: null };
  }
};

export const clearTraces = async (): Promise<void> => {
  // The index goes first, and in memory too: an index pointing at records
  // that no longer exist would have every viewport ask for missing traces and
  // quietly draw nothing, which looks exactly like never having driven there.
  indexCache = {};
  try {
    await metaStore.removeItem(INDEX_KEY);
    await traceStore.clear();
  } catch {
    // Best-effort in both directions.
  }
  announce();
};

/* -------------------------------------------------------------------------- */
/* Calibration                                                                 */
/* -------------------------------------------------------------------------- */

export const getCalibration = async (): Promise<ScoutCalibration | null> => {
  try {
    const stored = await metaStore.getItem<ScoutCalibration>(CALIBRATION_KEY);
    return stored && typeof stored.baseline === 'number' && stored.baseline > 0 ? stored : null;
  } catch {
    return null;
  }
};

export const setCalibration = async (calibration: ScoutCalibration): Promise<void> => {
  try {
    await metaStore.setItem(CALIBRATION_KEY, calibration);
  } catch {
    // Non-fatal: the session continues on the default baseline, and the
    // screen keeps saying "uncalibrated" because that is still true.
  }
};

export const clearCalibration = async (): Promise<void> => {
  try {
    await metaStore.removeItem(CALIBRATION_KEY);
  } catch {
    // Nothing to do.
  }
};
