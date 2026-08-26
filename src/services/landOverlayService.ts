import localforage from 'localforage';
import { BoundingBox } from '../config/coverage';
/**
 * The map renders `BoundaryCollection` and nothing else. Rather than teach it a
 * second shape, both local sources are dressed as one — so the instant first
 * paint, the downloaded pack and the live government response all travel the
 * same code path and get the same styling, labelling and disclaimers.
 */
import type { BoundaryCollection, BoundaryFeature } from './boundaryService';

/**
 * The bundled public-land overview, and the optional full-detail pack.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS IN THIS FILE, AND WHY THEY ARE DIFFERENT
 * ---------------------------------------------------------------------------
 *
 * QUICK — `public/map/public-land-overview.json`, built by CI and committed.
 * It ships with the app, so it is on the device before anyone opens it. One
 * fetch off the local origin, no government servers, no Supabase, no waiting.
 * It is generalised to about a kilometre and drops small parcels, so it
 * answers "there is public land over there" and nothing finer.
 *
 * FULL — real polygons pulled cell by cell from `/api/land-pack`. Large, slow,
 * and the only one of the two that should ever be used to decide where to
 * sleep with no signal.
 *
 * A camper picks one on first run and can change it later. The choice is
 * recorded here; what it MEANS is enforced by the map and stated in the UI.
 *
 * ---------------------------------------------------------------------------
 * HOUSE RULE: NOTHING HERE THROWS
 * ---------------------------------------------------------------------------
 *
 * Every function returns an empty value or `{ ok: false }`. A missing overlay
 * file, a dead pack endpoint and a full disk all degrade to "the map works the
 * way it did before", never to a broken render.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which map data a camper ASKED FOR. `null` means they have not chosen yet.
 *
 * This is an intent and nothing more. It records that the question was put to
 * them and answered, which is what stops the first-run gate reappearing; it
 * never means the device holds the data. `getPackStatus` is the only thing
 * that knows that, and every screen describing what is on the phone reads it
 * rather than this — a camper who chose "full" on a train and lost signal
 * halfway through has chosen full and holds part of a pack, and the app has
 * to be able to say both.
 */
export type MapDataChoice = 'quick' | 'full' | null;

export type OverlayGroup = 'campable' | 'access_only';

/** One parcel as stored in the bundled file. Keys are short — there are many. */
interface RawOverlayFeature {
  g: 'c' | 'a';
  s: string;
  n?: string;
  p: [number, number][][][];
}

export interface OverlayParcel {
  group: OverlayGroup;
  sourceId: string;
  name?: string;
  /** MultiPolygon rings, [lon, lat] — GeoJSON order. */
  polygons: [number, number][][][];
  /** Precomputed extent, so viewport filtering never walks the rings. */
  bounds: BoundingBox;
}

export interface OverlaySourceReport {
  id: string;
  label: string;
  attribution: string;
  ok: boolean;
  truncated: boolean;
}

export interface LandOverlay {
  builtAt: string;
  simplifyDegrees: number;
  minAreaSqKm: number;
  disclaimer: string;
  sources: OverlaySourceReport[];
  parcels: OverlayParcel[];
}

export interface PackManifest {
  available: boolean;
  reason?: string;
  message?: string;
  parcelCount: number;
  cells: { id: string; minLat: number; minLon: number; maxLat: number; maxLon: number }[];
}

export interface PackStatus {
  /** Cells stored on this device. */
  cellsStored: number;
  /** Cells the manifest says exist. 0 when we have never seen a manifest. */
  cellsTotal: number;
  parcelCount: number;
  sizeMb: number;
  downloadedAt: string | null;
  /** A source withheld parcels somewhere in the pack. */
  truncated: boolean;
  /**
   * Every cell in the grid came back. Recorded rather than inferred, because
   * the two counts above can agree for the wrong reason — a run that never
   * saw a manifest has 0 of 0 — and the difference decides whether the app
   * tells a camper they are carrying the whole continent.
   */
  complete: boolean;
}

/**
 * Is there ground the pack was supposed to cover and does not?
 *
 * Kept as one function so every screen answers it the same way. A partial
 * pack is not broken — the cells it holds are exact, and the map falls back
 * to the quick outline and the network everywhere else — but it must never
 * be described as full detail for the whole region.
 */
export const packIsPartial = (status: PackStatus | null): boolean =>
  status !== null && status.downloadedAt !== null && !status.complete;

/** Cells the pack is still missing, or 0 when it is whole or unknown. */
export const packCellsMissing = (status: PackStatus | null): number =>
  status && status.cellsTotal > 0 ? Math.max(status.cellsTotal - status.cellsStored, 0) : 0;

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

const packStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_land_pack',
  description: 'Full-detail public land boundaries, downloaded by cell'
});

const metaStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_land_meta',
  description: 'Map data choice and land pack bookkeeping'
});

const CHOICE_KEY = 'map_data_choice';
const PACK_STATUS_KEY = 'land_pack_status';
/**
 * Which cells the pack holds, and the ground each covers.
 *
 * Kept as one small record so a viewport lookup can decide WHICH cells it
 * needs before reading any of them. Without it the only way to find the cells
 * touching a viewport is to iterate the whole store — every cell, every parcel,
 * deserialised — on every pan, which would make the full-detail pack slower
 * than the network it replaced.
 */
const PACK_INDEX_KEY = 'land_pack_index';
/**
 * The bundled overlay, cached after its first read.
 *
 * The file is a static asset on our own origin, so the browser will usually
 * serve it from HTTP cache — but "usually" is not "in a canyon with no signal
 * after the cache was evicted", and this is the layer that is supposed to be
 * there when nothing else is. So it goes to IndexedDB the first time it is
 * read and is served from there afterwards.
 */
const OVERLAY_KEY = 'bundled_overlay_v1';

const OVERLAY_URL = '/map/public-land-overview.json';
/** Must match `version` in scripts/buildLandOverlay.ts. */
const OVERLAY_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The choice                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The choice is written TWICE, to two different stores.
 *
 * IndexedDB is where it belongs — it sits beside the pack it describes. But
 * IndexedDB is also the store that fails: it is unavailable in a private
 * window, it throws under a full disk, and Safari drops it wholesale. Every
 * one of those turns into the blocking first-run screen appearing again for
 * somebody who answered it weeks ago and is standing in a car park watching
 * a continent download for the second time.
 *
 * `localStorage` is a worse store in every way except the one that matters
 * here: it is two dozen bytes, it is synchronous, and it survives cases
 * IndexedDB does not. So the answer goes in both and either one is enough to
 * remember it. Neither is ever used to claim the camper HAS data — that is
 * `getPackStatus`, and it is read from the pack itself.
 */
const readLocalChoice = (): MapDataChoice => {
  try {
    const value = window.localStorage.getItem(CHOICE_KEY);
    return value === 'quick' || value === 'full' ? value : null;
  } catch {
    return null;
  }
};

const writeLocalChoice = (choice: Exclude<MapDataChoice, null>): void => {
  try {
    window.localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // Disabled or full. The IndexedDB copy still answers.
  }
};

export const getMapDataChoice = async (): Promise<MapDataChoice> => {
  const local = readLocalChoice();

  try {
    const value = await metaStore.getItem<MapDataChoice>(CHOICE_KEY);
    if (value === 'quick' || value === 'full') {
      // Heal the cheap copy if it was cleared or never written.
      if (local !== value) writeLocalChoice(value);
      return value;
    }
  } catch {
    // Fall through to whatever localStorage remembered.
  }

  /*
   * No storage means we cannot remember a choice, so we must not claim one.
   * Returning null shows the picker again, which is mildly annoying and
   * strictly honest — the alternative silently assumes "quick" and lets a
   * camper believe they are carrying detailed maps they never downloaded.
   */
  return local;
};

/**
 * Should the first-run chooser be shown at all?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT SIMPLY "HAVE THEY CHOSEN YET"
 * ---------------------------------------------------------------------------
 *
 * The chooser is a blocking screen, and blocking somebody on a decision that
 * has no consequences is worse than not asking. Two of its three states are
 * exactly that:
 *
 *   - the bundled overview has not been built yet (CI has never run
 *     `map:land`, so `public/map/public-land-overview.json` 404s), and
 *   - `public_lands` is unseeded, so the full pack reports unavailable.
 *
 * With both true there is nothing to pick between: the map fetches live
 * boundaries the way it always has, and a screen demanding a choice about
 * offline data would be a decision point over an empty set — the app looking
 * like it has a feature it does not.
 *
 * So the gate opens when at least one real option exists. The moment CI
 * commits the overview, every camper who has not chosen gets asked.
 */
export const shouldAskMapDataChoice = async (): Promise<boolean> => {
  if ((await getMapDataChoice()) !== null) return false;

  /*
   * ASKED ONCE MEANS ASKED ONCE.
   *
   * A device holding downloaded cells has unambiguously been through this
   * screen — nothing else puts them there. If the recorded answer is missing
   * anyway (both stores wiped, a write that failed at the time), the pack on
   * disk is the better evidence and it wins. Blocking somebody in front of a
   * "download the map" screen while the map is already on their phone is the
   * worst version of this screen there is.
   *
   * Whatever the pack turns out to hold, the answer is repaired here so the
   * question is not re-derived on every launch.
   */
  if (await hasLandPack()) {
    await setMapDataChoice('full');
    return false;
  }

  // The cheap local check first — it settles the common case with no network.
  if (await loadLandOverlay()) return true;

  return (await fetchPackManifest()).available;
};

export const setMapDataChoice = async (choice: Exclude<MapDataChoice, null>): Promise<void> => {
  writeLocalChoice(choice);
  try {
    await metaStore.setItem(CHOICE_KEY, choice);
  } catch {
    // Non-fatal: localStorage has it, and the session continues regardless.
  }
};

/* -------------------------------------------------------------------------- */
/* The bundled overview                                                        */
/* -------------------------------------------------------------------------- */

const boundsOf = (polygons: [number, number][][][]): BoundingBox => {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;

  for (const rings of polygons) {
    // Outer ring only — holes are inside it by definition.
    for (const [lon, lat] of rings[0] ?? []) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }

  return { minLat, minLon, maxLat, maxLon };
};

const parseOverlay = (payload: any): LandOverlay | null => {
  if (!payload || payload.version !== OVERLAY_VERSION) return null;
  if (!Array.isArray(payload.features)) return null;

  const parcels: OverlayParcel[] = [];

  for (const raw of payload.features as RawOverlayFeature[]) {
    if (!Array.isArray(raw?.p) || raw.p.length === 0) continue;
    const bounds = boundsOf(raw.p);
    if (!Number.isFinite(bounds.minLat)) continue;

    parcels.push({
      group: raw.g === 'a' ? 'access_only' : 'campable',
      sourceId: String(raw.s ?? 'unknown'),
      name: raw.n,
      polygons: raw.p,
      bounds
    });
  }

  return {
    builtAt: String(payload.builtAt ?? ''),
    simplifyDegrees: Number(payload.simplifyDegrees ?? 0.01),
    minAreaSqKm: Number(payload.minAreaSqKm ?? 0),
    disclaimer: String(payload.disclaimer ?? ''),
    sources: Array.isArray(payload.sources)
      ? payload.sources.map((s: any) => ({
          id: String(s.id ?? ''),
          label: String(s.label ?? ''),
          attribution: String(s.attribution ?? ''),
          ok: s.ok === true,
          truncated: s.truncated === true
        }))
      : [],
    parcels
  };
};

/** Parsed once per session — it is a few megabytes and thousands of parcels. */
let overlayPromise: Promise<LandOverlay | null> | null = null;

const loadOverlayOnce = async (): Promise<LandOverlay | null> => {
  // Disk first: it is the copy that survives having no signal.
  try {
    const stored = await metaStore.getItem<any>(OVERLAY_KEY);
    const parsed = parseOverlay(stored);
    if (parsed) return parsed;
  } catch {
    // Fall through to the network copy.
  }

  try {
    const response = await fetch(OVERLAY_URL);
    if (!response.ok) return null;

    const payload = await response.json();
    const parsed = parseOverlay(payload);
    if (!parsed) return null;

    // Fire and forget — the parsed copy is already in hand.
    metaStore.setItem(OVERLAY_KEY, payload).catch(() => undefined);
    return parsed;
  } catch {
    /*
     * No overlay. The map falls back to fetching boundaries the way it always
     * did, which is slower but correct. It must NOT draw an empty continent.
     */
    return null;
  }
};

export const loadLandOverlay = (): Promise<LandOverlay | null> => {
  if (!overlayPromise) overlayPromise = loadOverlayOnce();
  return overlayPromise;
};

/** True when `a` and `b` overlap at all. */
const intersects = (a: BoundingBox, b: BoundingBox): boolean =>
  a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLon <= b.maxLon && a.maxLon >= b.minLon;

/**
 * Parcels touching a viewport.
 *
 * A linear scan over a few thousand precomputed boxes, which measures in the
 * low single-digit milliseconds — cheap enough that an index would be more
 * code to maintain than it saves.
 */
export const overlayParcelsIn = (
  overlay: LandOverlay | null,
  box: BoundingBox,
  /**
   * Smallest bounding-box side, in degrees, worth returning — see
   * `overviewMinSpanDegrees`. Zero keeps everything.
   *
   * The file holds ten thousand parcels covering a continent. Handing all of
   * them to the map at zoom 3 means dissolving and drawing several hundred
   * thousand vertices to produce shapes a pixel across, which is a stalled
   * phone in exchange for nothing anybody can see.
   */
  minSpanDeg = 0,
  limit = 6000
): OverlayParcel[] => {
  if (!overlay) return [];

  const inBox: OverlayParcel[] = [];
  for (const parcel of overlay.parcels) {
    if (intersects(parcel.bounds, box)) inBox.push(parcel);
  }

  if (minSpanDeg <= 0) return inBox.slice(0, limit);

  /**
   * The LONGER side, not the shorter one. A parcel following a river or a
   * forest edge can be a hundred kilometres of visible land and only a few
   * wide, and testing its narrow side would erase it from the map.
   */
  const span = (p: OverlayParcel): number =>
    Math.max(p.bounds.maxLat - p.bounds.minLat, p.bounds.maxLon - p.bounds.minLon);

  const kept = inBox.filter((p) => span(p) >= minSpanDeg);

  /**
   * A SOURCE MUST NEVER VANISH FROM THE MAP JUST FOR BEING SMALL-GRAINED.
   *
   * The threshold is an absolute size, and public land does not arrive in
   * uniform sizes. Alberta's Green Area is one enormous shape and survives any
   * zoom; Manitoba's provincial forests average a fifteenth of that and, at
   * the zoom where somebody is looking at the whole country, every one of them
   * falls under the line — while both its neighbours stay painted. The result
   * on screen is a Manitoba-shaped hole between two provinces full of colour,
   * which reads as "no public land here" when the truth is "these parcels are
   * smaller than the ones next door".
   *
   * So a source that has anything in view keeps its largest few regardless.
   * They may be a couple of pixels; that is a far better failure than a
   * confident blank. The server learned this the same way — see
   * OVERVIEW_MIN_PER_SOURCE in server/boundaryRoutes.ts.
   */
  const keptSources = new Set(kept.map((p) => p.sourceId));
  const perSource = new Map<string, number>();
  const rescued = inBox
    .filter((p) => !keptSources.has(p.sourceId))
    .sort((a, b) => span(b) - span(a))
    .filter((p) => {
      const n = perSource.get(p.sourceId) ?? 0;
      if (n >= MIN_PER_SOURCE) return false;
      perSource.set(p.sourceId, n + 1);
      return true;
    });

  // Rescued first, so the guarantee survives the limit rather than being
  // quietly undone by it.
  return [...rescued, ...kept].slice(0, limit);
};

/** How many parcels a source keeps even when all of them are below the line. */
const MIN_PER_SOURCE = 3;

/* -------------------------------------------------------------------------- */
/* The full-detail pack                                                        */
/* -------------------------------------------------------------------------- */

export const fetchPackManifest = async (): Promise<PackManifest> => {
  try {
    const response = await fetch('/api/land-pack/manifest');
    if (!response.ok) {
      return { available: false, reason: 'unavailable', parcelCount: 0, cells: [] };
    }
    const data = await response.json();
    return {
      available: data?.available === true,
      reason: data?.reason,
      message: data?.message,
      parcelCount: Number(data?.parcelCount ?? 0),
      cells: Array.isArray(data?.cells) ? data.cells : []
    };
  } catch {
    return { available: false, reason: 'unavailable', parcelCount: 0, cells: [] };
  }
};

const emptyStatus: PackStatus = {
  cellsStored: 0,
  cellsTotal: 0,
  parcelCount: 0,
  sizeMb: 0,
  downloadedAt: null,
  truncated: false,
  complete: false
};

export const getPackStatus = async (): Promise<PackStatus> => {
  try {
    const stored = await metaStore.getItem<PackStatus>(PACK_STATUS_KEY);
    if (!stored || typeof stored !== 'object') return emptyStatus;

    const status = { ...emptyStatus, ...stored };

    /*
     * Statuses written before `complete` existed get it derived from the two
     * counts, which is precisely what the old code compared. Defaulting them
     * to false instead would tell every camper who already holds the whole
     * continent that their pack is short, and offer to download it again.
     */
    if (typeof (stored as any).complete !== 'boolean') {
      status.complete = status.cellsTotal > 0 && status.cellsStored >= status.cellsTotal;
    }

    return status;
  } catch {
    return emptyStatus;
  }
};

/** One downloaded grid cell: the ground it covers, and what is on it. */
interface StoredCell {
  bounds: BoundingBox;
  features: any[];
}

/**
 * What this device knows about one cell of the grid.
 *
 * It carries the ground covered AND what came back, because a resumed
 * download has to answer two questions per cell without opening it: have we
 * already asked about this ground, and how much did it contribute to the
 * totals we report. Without the second, finishing a half-done pack would
 * report only the parcels of the half it just fetched.
 *
 * `empty` is a real answer, not a gap. Most of a continental grid is ocean or
 * private land, and a cell that genuinely holds nothing must be remembered as
 * asked — otherwise every resume re-downloads the sea.
 */
interface PackCellMeta {
  bounds: BoundingBox;
  parcels: number;
  bytes: number;
  empty?: boolean;
}

/** `{ cellId: meta }` for every cell this device has an answer for. */
type PackIndex = Record<string, PackCellMeta>;

/**
 * Indexes written before cells carried counts hold a bare `BoundingBox`.
 * Those are still perfectly good for deciding what to READ — the bounds are
 * right there — so they are kept and simply reported as unknown, which makes
 * a resume re-fetch them rather than quietly totalling them as zero.
 */
const asCellMeta = (value: any): PackCellMeta | null => {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.parcels === 'number' && value.bounds) return value as PackCellMeta;
  if (typeof value.minLat === 'number') {
    return { bounds: value as BoundingBox, parcels: -1, bytes: 0 };
  }
  if (value.bounds && typeof value.bounds.minLat === 'number') {
    return { bounds: value.bounds, parcels: -1, bytes: 0 };
  }
  return null;
};

/** True once a cell's contribution to the totals is known. */
const cellCounted = (meta: PackCellMeta): boolean => meta.parcels >= 0;

/** Read once per session; rewritten by a download or a delete. */
let packIndexCache: PackIndex | null = null;

const readPackIndex = async (): Promise<PackIndex> => {
  if (packIndexCache) return packIndexCache;

  const index: PackIndex = {};
  try {
    const stored = await metaStore.getItem<Record<string, any>>(PACK_INDEX_KEY);
    if (stored && typeof stored === 'object') {
      for (const [id, value] of Object.entries(stored)) {
        const meta = asCellMeta(value);
        if (meta) index[id] = meta;
      }
    }
  } catch {
    // An unreadable index is an empty one — the pack is best-effort storage.
  }

  packIndexCache = index;
  return packIndexCache;
};

/**
 * Does this device hold a downloaded pack at all?
 *
 * Deliberately "has this ground been asked about", not "does it hold
 * parcels": an index of nothing but empty cells still proves a download ran,
 * and that is what the first-run gate needs to know.
 */
export const hasLandPack = async (): Promise<boolean> =>
  Object.keys(await readPackIndex()).length > 0;

const writePackIndex = async (index: PackIndex): Promise<void> => {
  packIndexCache = index;
  try {
    await metaStore.setItem(PACK_INDEX_KEY, index);
  } catch {
    // In-memory copy still serves this session.
  }
};

export interface PackProgress {
  cellsDone: number;
  cellsTotal: number;
  parcels: number;
  sizeMb: number;
}

export interface PackResult {
  ok: boolean;
  message: string;
  status: PackStatus;
}

/**
 * Download the full-detail pack, cell by cell.
 *
 * Sequential and unhurried on purpose: this is hundreds of requests against
 * one serverless function, and firing them in parallel trades a download that
 * finishes for a download that gets rate-limited halfway and leaves the device
 * holding half a continent it believes is whole.
 *
 * Partial progress is kept. A cancelled or failed run leaves every cell it did
 * manage on disk and reports honestly how many that was, because a camper who
 * downloaded three quarters of the pack in a car park should not lose it to a
 * dropped connection at the end.
 */
export interface PackDownloadOptions {
  /**
   * Keep the cells this device already has an answer for and ask only for
   * the rest.
   *
   * This is what "finish the download" means, and it is the difference
   * between a resume that takes a minute and one that re-downloads a
   * continent to fill in the last twenty cells. Off by default, because
   * "Refresh" means exactly the opposite: go and get today's copy.
   *
   * Cells whose stored record predates per-cell counts are re-fetched even
   * here — see `cellCounted`. Skipping them would leave their parcels out of
   * the totals, and a pack that under-reports itself is a pack that looks
   * short forever.
   */
  resume?: boolean;
}

export const downloadLandPack = async (
  onProgress?: (progress: PackProgress) => void,
  signal?: AbortSignal,
  options: PackDownloadOptions = {}
): Promise<PackResult> => {
  const manifest = await fetchPackManifest();

  if (!manifest.available) {
    return {
      ok: false,
      message:
        manifest.message ??
        'Full-detail maps are not available right now. The quick map still works.',
      status: await getPackStatus()
    };
  }

  let parcels = 0;
  let bytes = 0;
  let done = 0;
  let truncated = false;
  let failures = 0;

  // Start from what is already held, so a resumed download keeps the cells an
  // earlier run managed rather than orphaning them.
  const index: PackIndex = { ...(await readPackIndex()) };

  for (const cell of manifest.cells) {
    if (signal?.aborted) break;

    /*
     * Already answered, and we know what it contributed. Count it and move
     * on — this is the whole point of resuming.
     */
    const held = index[cell.id];
    if (options.resume && held && cellCounted(held)) {
      parcels += held.parcels;
      bytes += held.bytes;
      done += 1;
      onProgress?.({
        cellsDone: done,
        cellsTotal: manifest.cells.length,
        parcels,
        sizeMb: Number((bytes / (1024 * 1024)).toFixed(1))
      });
      continue;
    }

    try {
      const params = new URLSearchParams({
        minLat: String(cell.minLat),
        minLon: String(cell.minLon),
        maxLat: String(cell.maxLat),
        maxLon: String(cell.maxLon)
      });

      const response = await fetch(`/api/land-pack/cell?${params.toString()}`, { signal });

      if (response.ok) {
        const text = await response.text();
        bytes += text.length;

        const data = JSON.parse(text);
        const features = Array.isArray(data?.features) ? data.features : [];
        if (data?.truncated === true) truncated = true;

        if (features.length > 0) {
          parcels += features.length;
          /*
           * The cell's own box is stored with it rather than parsed back out
           * of the key. The key encodes only the cell's origin, so recovering
           * its extent means knowing the grid size the SERVER used — and a
           * client that assumes a grid size is a client that silently reads
           * the wrong ground the day that constant changes.
           */
          const bounds: BoundingBox = {
            minLat: cell.minLat,
            minLon: cell.minLon,
            maxLat: cell.maxLat,
            maxLon: cell.maxLon
          };
          await packStore.setItem<StoredCell>(cell.id, { bounds, features });
          index[cell.id] = { bounds, parcels: features.length, bytes: text.length };
        } else {
          /*
           * An empty cell is a real answer — most of the grid is ocean or
           * private land. Clear any stale copy so a re-download shrinks, but
           * KEEP the index entry, marked empty: it is the record that this
           * ground has been asked about, and without it every resume goes
           * back and re-downloads the sea.
           */
          await packStore.removeItem(cell.id).catch(() => undefined);
          index[cell.id] = {
            bounds: {
              minLat: cell.minLat,
              minLon: cell.minLon,
              maxLat: cell.maxLat,
              maxLon: cell.maxLon
            },
            parcels: 0,
            bytes: text.length,
            empty: true
          };
        }
      } else {
        failures += 1;
      }
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === 'AbortError') break;
      failures += 1;
    }

    done += 1;
    onProgress?.({
      cellsDone: done,
      cellsTotal: manifest.cells.length,
      parcels,
      sizeMb: Number((bytes / (1024 * 1024)).toFixed(1))
    });
  }

  const complete = done === manifest.cells.length && failures === 0;

  const status: PackStatus = {
    cellsStored: done - failures,
    cellsTotal: manifest.cells.length,
    parcelCount: parcels,
    sizeMb: Number((bytes / (1024 * 1024)).toFixed(1)),
    downloadedAt: new Date().toISOString(),
    truncated,
    complete
  };

  await writePackIndex(index);

  try {
    await metaStore.setItem(PACK_STATUS_KEY, status);
  } catch {
    // The pack is on disk even if the bookkeeping is not.
  }

  return {
    ok: complete,
    message: complete
      ? `Full-detail maps ready — ${parcels.toLocaleString()} areas, ${status.sizeMb} MB.`
      : signal?.aborted
        ? `Stopped. ${status.cellsStored} of ${manifest.cells.length} sections saved — you can pick up where you left off.`
        : `Saved ${status.cellsStored} of ${manifest.cells.length} sections. ${failures} could not be downloaded; run it again to fill the gaps.`,
    status
  };
};

/**
 * Parcels from the downloaded pack that touch a viewport.
 *
 * The index decides which cells matter before anything is deserialised, so a
 * pan reads the two or three cells under the screen rather than the whole
 * continent. Returns an empty array when no pack is held, which is the signal
 * the map uses to fall back to the bundled overview and the network.
 */
export const packParcelsIn = async (box: BoundingBox): Promise<any[]> => {
  const index = await readPackIndex();

  const needed = Object.entries(index)
    // Empty cells are answers, not records — there is nothing to open.
    .filter(([, meta]) => !meta.empty && intersects(meta.bounds, box))
    .map(([id]) => id);

  if (needed.length === 0) return [];

  const features: any[] = [];

  for (const id of needed) {
    try {
      const cell = await packStore.getItem<StoredCell>(id);
      if (Array.isArray(cell?.features)) features.push(...cell.features);
    } catch {
      // One unreadable cell must not lose the rest of the viewport.
    }
  }

  return features;
};

/* -------------------------------------------------------------------------- */
/* Turning local data into something the map can already draw                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a drawable collection from the bundled overview.
 *
 * `_edgeAccuracy` is forced to `generalised` regardless of what the underlying
 * source claims about itself. The source may well publish administrative-grade
 * edges; this file does not contain them. It contains those edges pushed
 * through a kilometre of simplification, and the parcel sheet must say the
 * weaker thing, because that is what is on the screen.
 */
export const overviewCollection = (
  overlay: LandOverlay | null,
  box: BoundingBox,
  /** See `overviewMinSpanDegrees` — how much detail this zoom can show. */
  minSpanDeg = 0
): BoundaryCollection | null => {
  if (!overlay) return null;

  const parcels = overlayParcelsIn(overlay, box, minSpanDeg);
  if (parcels.length === 0) return null;

  const labelOf = new Map(overlay.sources.map((s) => [s.id, s]));

  const features: BoundaryFeature[] = parcels.map((parcel) => {
    const source = labelOf.get(parcel.sourceId);
    return {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: parcel.polygons },
      properties: {
        _source: parcel.sourceId,
        _sourceName: source?.label ?? parcel.sourceId,
        _attribution: source?.attribution ?? '',
        _confidence: 'managing_agency',
        _name: parcel.name ?? source?.label ?? 'Public land',
        _designation: source?.label ?? 'Public land',
        _edgeAccuracy: 'generalised',
        _campingBasisKind:
          parcel.group === 'access_only' ? 'open_access_flag' : 'agency_policy_inference'
      }
    };
  });

  return {
    type: 'FeatureCollection',
    features,
    meta: {
      sources: overlay.sources.map((s) => ({
        id: s.id,
        label: s.label,
        attribution: s.attribution,
        confidence: 'managing_agency' as const,
        available: s.ok,
        featureCount: 0
      })),
      disclaimer: overlay.disclaimer,
      detail: 'overview',
      /**
       * A ZOOM THAT SHOWS ONLY THE BIG AREAS HAS TO SAY SO.
       *
       * `minSpanDeg` above the line means this view is deliberately drawing
       * the larger parcels and holding the rest back until you come in. That
       * is a sample, and a sample the camper is not told about is the one
       * sentence this app refuses to say — a thinly-painted province reads as
       * an empty one. It is only ever true that MORE exists than is drawn, so
       * the map says which way it is wrong.
       *
       * At zoom 6 the band is zero, nothing is held back, and this is false.
       */
      truncated: minSpanDeg > 0,
      /*
       * The map merges abutting parcels by cancelling their shared edge, and
       * it can only recognise a shared edge if it knows how far generalisation
       * may have pushed the two sides apart. Passing the overlay's real
       * tolerance is what stops a province of Crown land drawing as a mesh of
       * thousands of separate outlines.
       */
      simplifyDegrees: overlay.simplifyDegrees
    }
  };
};

/** Build a drawable collection from the downloaded full-detail pack. */
export const packCollection = async (
  box: BoundingBox
): Promise<BoundaryCollection | null> => {
  const features = await packParcelsIn(box);
  if (features.length === 0) return null;

  const sources = new Map<string, { label: string; attribution: string; n: number }>();
  for (const feature of features) {
    const properties = feature?.properties ?? {};
    const id = String(properties._source ?? 'unknown');
    const existing = sources.get(id);
    if (existing) existing.n += 1;
    else {
      sources.set(id, {
        label: String(properties._sourceName ?? id),
        attribution: String(properties._attribution ?? ''),
        n: 1
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    meta: {
      sources: [...sources.entries()].map(([id, s]) => ({
        id,
        label: s.label,
        attribution: s.attribution,
        confidence: 'managing_agency' as const,
        available: true,
        featureCount: s.n
      })),
      detail: 'full',
      // Stored at the same tolerance the pack route asked the database for.
      simplifyDegrees: 0.0005
    }
  };
};

export const deleteLandPack = async (): Promise<void> => {
  // Clear the index first, and in memory too. A stale index pointing at cells
  // that no longer exist would have every viewport lookup ask for missing
  // records and quietly return nothing, which looks exactly like empty land.
  packIndexCache = {};

  try {
    await metaStore.removeItem(PACK_INDEX_KEY);
    await packStore.clear();
    await metaStore.removeItem(PACK_STATUS_KEY);
  } catch {
    // Nothing to do — the pack is best-effort storage in both directions.
  }
};
