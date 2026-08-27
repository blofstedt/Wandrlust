import localforage from 'localforage';
import { Campsite, OfflineRegion } from '../types';

/**
 * Offline persistence layer.
 *
 * Two localforage stores:
 *   - `wandrlust_data`   saved + user-submitted campsites, region metadata
 *   - `wandrlust_tiles`  raw map tile blobs keyed by `z/x/y`
 *
 * Everything fails soft: if IndexedDB is unavailable the app still runs, it
 * just won't remember anything between sessions.
 */

const dataStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_data',
  description: 'Saved campsites, custom submissions and offline region metadata'
});

const tileStore = localforage.createInstance({
  name: 'wandrlust',
  storeName: 'wandrlust_tiles',
  description: 'Cached raster map tiles for offline use'
});

const SAVED_KEY = 'saved_campsites';
const CUSTOM_KEY = 'custom_campsites';
const REGIONS_KEY = 'offline_regions';
/**
 * Spots that came down with a map pack, kept apart from the bookmarks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `SAVED_KEY`, WHICH IS WHERE IT USED TO GO
 * ---------------------------------------------------------------------------
 *
 * Downloading a region caches every campsite inside it so the area works with
 * no signal. Those spots were being appended to the SAVED list, which is the
 * camper's bookmarks — so one download turned "Saved (0)" into "Saved (47)",
 * every one of them a place they had never chosen to keep.
 *
 * It did not stop at the display, either. The saved list is synced UP to the
 * account on sign-in, so all forty-seven were then written to the server as
 * that camper's own bookmarks, and the merge that follows only ever adds. A
 * cache of somebody else's spots became permanent account data.
 *
 * Two lists, two meanings: SAVED is what a camper bookmarked, this is what a
 * map pack brought with it. Only the first is theirs, only the first syncs, and
 * this one is disposable — it goes when the region it came with goes.
 */
const OFFLINE_SITES_KEY = 'offline_campsites';

const readList = async <T>(key: string): Promise<T[]> => {
  try {
    const value = await dataStore.getItem<T[]>(key);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

/**
 * Returns whether the write actually landed.
 *
 * Still never throws — a failure here must not break a render. But it no
 * longer fails *silently*: a full disk used to make `downloadOfflineRegion`
 * look like a button that did nothing, because the region record was dropped
 * on the floor with no way for the caller to know. Callers that are telling a
 * camper what happened need the answer; the ones that aren't can ignore it.
 */
const writeList = async <T>(key: string, value: T[]): Promise<boolean> => {
  try {
    await dataStore.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/* Saved campsites                                                     */
/* ------------------------------------------------------------------ */

export const getSavedCampsites = (): Promise<Campsite[]> => readList<Campsite>(SAVED_KEY);

/** @returns `true` if the site is saved after the call, `false` if removed. */
export const toggleSaveCampsite = async (campsite: Campsite): Promise<boolean> => {
  const saved = await getSavedCampsites();
  const exists = saved.some((site) => site.id === campsite.id);

  if (exists) {
    await writeList(SAVED_KEY, saved.filter((site) => site.id !== campsite.id));
    return false;
  }

  await writeList(SAVED_KEY, [{ ...campsite, savedOffline: true }, ...saved]);
  return true;
};

/**
 * Fold the account's saved list into this device's.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONLY EVER ADDS
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation — take the server's list as the truth and
 * overwrite — deletes saved spots, and it does it in exactly the situation
 * where the camper can least afford it. `campsites_saved` legitimately returns
 * fewer rows than the camper has saved: a site that has since been hidden, or
 * one above their trust tier, drops out server-side while the row stays. A
 * spot bookmarked while signed out is on the device and nowhere else. Treating
 * either as "unsaved" throws away the only copy.
 *
 * So a union, keyed on id. Removing a bookmark is an explicit act on both
 * sides — `toggleSaveCampsite` and `unsaveCampsiteRemote` — never a side
 * effect of a sync.
 *
 * The DEVICE copy wins a collision. It is the richer record: it carries the
 * amenities the camper filled in, and the server deliberately returns none
 * (they are `not null default` columns, so reading them back would invent
 * observations nobody made). Position is the one thing worth taking from the
 * server, since a stealth site's coordinates may have sharpened or fuzzed
 * since the device last looked.
 *
 * @returns the merged list, already persisted.
 */
export const mergeSavedCampsites = async (remote: Campsite[]): Promise<Campsite[]> => {
  const local = await getSavedCampsites();
  const byId = new Map<string, Campsite>();

  for (const site of remote) byId.set(site.id, { ...site, savedOffline: true });

  for (const site of local) {
    const server = byId.get(site.id);
    byId.set(site.id, server
      ? {
          ...site,
          latitude: server.latitude,
          longitude: server.longitude,
          isApproximate: server.isApproximate,
          isStealth: server.isStealth,
          submissionState: server.submissionState,
          savedOffline: true
        }
      : { ...site, savedOffline: true });
  }

  const merged = [...byId.values()];
  await writeList(SAVED_KEY, merged);
  return merged;
};

/* ------------------------------------------------------------------ */
/* User-submitted campsites                                            */
/* ------------------------------------------------------------------ */

export const getCustomCampsites = (): Promise<Campsite[]> => readList<Campsite>(CUSTOM_KEY);

export const addCustomCampsite = async (campsite: Campsite): Promise<void> => {
  const custom = await getCustomCampsites();
  if (custom.some((site) => site.id === campsite.id)) return;
  await writeList(CUSTOM_KEY, [campsite, ...custom]);
};

export const deleteCustomCampsite = async (id: string): Promise<void> => {
  const custom = await getCustomCampsites();
  await writeList(CUSTOM_KEY, custom.filter((site) => site.id !== id));
};

/* ------------------------------------------------------------------ */
/* Map tile caching                                                    */
/* ------------------------------------------------------------------ */

const TILE_URL_TEMPLATE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** Slippy-map tile maths (Web Mercator). */
const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));

const latToTileY = (lat: number, zoom: number): number => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
};

export const tileCacheKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

/** Look up a cached tile. Returns an object URL, or null on a miss. */
export const getCachedTile = async (z: number, x: number, y: number): Promise<string | null> => {
  try {
    const blob = await tileStore.getItem<Blob>(tileCacheKey(z, x, y));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
};

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

const enumerateTiles = (
  bounds: OfflineRegion['bounds'],
  zoomMin: number,
  zoomMax: number,
  cap: number
): TileCoord[] => {
  const tiles: TileCoord[] = [];

  for (let z = zoomMin; z <= zoomMax; z += 1) {
    const xStart = lonToTileX(bounds.west, z);
    const xEnd = lonToTileX(bounds.east, z);
    // Tile Y is inverted relative to latitude.
    const yStart = latToTileY(bounds.north, z);
    const yEnd = latToTileY(bounds.south, z);

    for (let x = Math.min(xStart, xEnd); x <= Math.max(xStart, xEnd); x += 1) {
      for (let y = Math.min(yStart, yEnd); y <= Math.max(yStart, yEnd); y += 1) {
        tiles.push({ z, x, y });
        if (tiles.length >= cap) return tiles;
      }
    }
  }
  return tiles;
};

/* ------------------------------------------------------------------ */
/* Offline regions                                                     */
/* ------------------------------------------------------------------ */

export const getDownloadedRegions = (): Promise<OfflineRegion[]> =>
  readList<OfflineRegion>(REGIONS_KEY);

/**
 * The spots that came down with the map packs.
 *
 * These are the ONLY campsites this device holds that the camper neither
 * submitted nor bookmarked, and they exist because they were asked for: a pack
 * with no spots in it is a picture of a valley. Everything else on the map
 * comes from the server while there is a connection to reach it.
 */
export const getOfflineCampsites = (): Promise<Campsite[]> =>
  readList<Campsite>(OFFLINE_SITES_KEY);

/** Inside a region's box, with no tolerance — the box is what was downloaded. */
const withinBounds = (site: Campsite, bounds: OfflineRegion['bounds']): boolean =>
  site.latitude >= bounds.south && site.latitude <= bounds.north &&
  site.longitude >= bounds.west && site.longitude <= bounds.east;

/**
 * Is this the browser saying "no room left", rather than one tile going wrong?
 *
 * The distinction decides whether to carry on. A 404 on one tile costs that
 * tile; a full disk means every remaining `setItem` will fail too, so pressing
 * on just spends a camper's mobile data downloading imagery that is thrown
 * away on arrival.
 *
 * Named rather than sniffed by message: Chrome and Firefox raise a DOMException
 * called QuotaExceededError, Safari has historically used its own name and
 * legacy code 22, and localforage may hand back either the DOMException or an
 * Error wrapping its text.
 */
const isStorageFull = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; message?: string };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    /quota|storage.*full|exceeded the quota/i.test(e.message ?? '')
  );
};

/** What a download actually managed, as opposed to what it attempted. */
export interface OfflineDownloadResult {
  /** Null only when the region record itself could not be written. */
  region: OfflineRegion | null;
  /** True only when every requested tile is on the device. */
  ok: boolean;
  /** The device ran out of room. The pack is short and will stay short. */
  storageFull: boolean;
  tilesStored: number;
  tilesRequested: number;
  /** Plain-English outcome, safe to show a camper as-is. */
  message: string;
}

/**
 * Download and cache map tiles for a bounding box, plus the campsites inside
 * it, so the area is usable with no connectivity.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COUNTS WHAT IT STORED AND NOT WHAT IT ASKED FOR
 * ---------------------------------------------------------------------------
 * This used to swallow every per-tile failure alike, march the progress bar to
 * 100%, and record the region with the full tile count — so a phone with no
 * room left showed "Downloaded ✓" and a green tick, and the blank map was
 * discovered later, in the place with no signal, which is the one moment the
 * feature exists for. Storage failures now stop the run and are reported.
 *
 * A short pack is still worth keeping — some imagery beats none — so it is
 * saved either way. It is just never described as whole when it isn't.
 */
export const downloadOfflineRegion = async (
  name: string,
  center: [number, number],
  bounds: OfflineRegion['bounds'],
  campsites: Campsite[],
  onProgress?: (percent: number) => void,
  options: { zoomMin?: number; zoomMax?: number; maxTiles?: number } = {}
): Promise<OfflineDownloadResult> => {
  const zoomMin = options.zoomMin ?? 8;
  const zoomMax = options.zoomMax ?? 12;
  const maxTiles = options.maxTiles ?? 400;

  const tiles = enumerateTiles(bounds, zoomMin, zoomMax, maxTiles);

  let bytes = 0;
  let completed = 0;
  let stored = 0;
  let storageFull = false;
  const CONCURRENCY = 6;

  const fetchTile = async ({ z, x, y }: TileCoord): Promise<void> => {
    const key = tileCacheKey(z, x, y);
    try {
      const existing = await tileStore.getItem<Blob>(key);
      if (existing) {
        bytes += existing.size;
        stored += 1;
        return;
      }

      const url = TILE_URL_TEMPLATE.replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));

      const response = await fetch(url);
      if (!response.ok) return;

      const blob = await response.blob();
      await tileStore.setItem(key, blob);
      bytes += blob.size;
      stored += 1;
    } catch (err) {
      // One tile going wrong costs that tile. A full disk costs all the rest,
      // so record it and let the loop below stop.
      if (isStorageFull(err)) storageFull = true;
    } finally {
      completed += 1;
      onProgress?.(Math.round((completed / tiles.length) * 100));
    }
  };

  for (let i = 0; i < tiles.length; i += CONCURRENCY) {
    await Promise.all(tiles.slice(i, i + CONCURRENCY).map(fetchTile));
    if (storageFull) break;
  }

  /**
   * Persist the campsites themselves so the area works with no signal.
   *
   * Into the pack's own list, NOT the bookmarks — see OFFLINE_SITES_KEY. A
   * camper who downloads the Rockies has not bookmarked the Rockies.
   */
  let sitesStored = 0;
  if (!storageFull) {
    const cached = await getOfflineCampsites();
    const cachedIds = new Set(cached.map((site) => site.id));
    const additions = campsites.filter((site) => !cachedIds.has(site.id));
    const wanted = [...cached, ...additions];
    if (additions.length > 0) {
      if (await writeList(OFFLINE_SITES_KEY, wanted)) {
        sitesStored = campsites.length;
      } else {
        storageFull = true;
      }
    } else {
      // Every one of them was already here from an overlapping pack.
      sitesStored = campsites.length;
    }
  }

  const complete = stored === tiles.length && sitesStored === campsites.length;

  const region: OfflineRegion = {
    id: `region-${Date.now()}`,
    name,
    bounds,
    center,
    zoomMin,
    zoomMax,
    tileCount: stored,
    tilesRequested: tiles.length,
    complete,
    sizeMb: Number((bytes / (1024 * 1024)).toFixed(1)),
    downloadedAt: new Date().toISOString().split('T')[0],
    campsiteCount: sitesStored
  };

  const regions = await getDownloadedRegions();
  const recorded = await writeList(REGIONS_KEY, [region, ...regions]);

  onProgress?.(100);

  if (!recorded) {
    return {
      region: null,
      ok: false,
      storageFull: true,
      tilesStored: stored,
      tilesRequested: tiles.length,
      message:
        'There is no room left on this device, so nothing could be saved. ' +
        'Delete a stored region and try again.'
    };
  }

  if (storageFull) {
    return {
      region,
      ok: false,
      storageFull: true,
      tilesStored: stored,
      tilesRequested: tiles.length,
      message:
        `This device ran out of room. ${stored} of ${tiles.length} map tiles were ` +
        'saved, so parts of this area will be blank with no signal. Delete a ' +
        'stored region to make space.'
    };
  }

  if (!complete) {
    return {
      region,
      ok: false,
      storageFull: false,
      tilesStored: stored,
      tilesRequested: tiles.length,
      message:
        `${stored} of ${tiles.length} map tiles were saved — the rest could not be ` +
        'downloaded. Parts of this area will be blank with no signal. Try again ' +
        'on a better connection.'
    };
  }

  return {
    region,
    ok: true,
    storageFull: false,
    tilesStored: stored,
    tilesRequested: tiles.length,
    message: `${name} is saved and will work with no signal.`
  };
};

export const deleteOfflineRegion = async (id: string): Promise<void> => {
  const regions = await getDownloadedRegions();
  const target = regions.find((region) => region.id === id);

  await writeList(REGIONS_KEY, regions.filter((region) => region.id !== id));
  if (!target) return;

  // Drop this region's tiles unless another stored region also covers them.
  const remaining = regions.filter((region) => region.id !== id);

  /**
   * The pack's spots go with its tiles.
   *
   * Kept only where another pack still covers the ground they sit on, which is
   * the same rule the tiles follow one block down. A camper's own submissions
   * and their bookmarks live in different lists entirely and are untouched by
   * this — deleting a map pack must never delete somebody's spot.
   */
  const cached = await getOfflineCampsites();
  if (cached.length > 0) {
    await writeList(
      OFFLINE_SITES_KEY,
      cached.filter((site) => remaining.some((region) => withinBounds(site, region.bounds)))
    );
  }
  const stillNeeded = new Set<string>();
  remaining.forEach((region) => {
    enumerateTiles(region.bounds, region.zoomMin, region.zoomMax, region.tileCount).forEach(
      ({ z, x, y }) => stillNeeded.add(tileCacheKey(z, x, y))
    );
  });

  const doomed = enumerateTiles(target.bounds, target.zoomMin, target.zoomMax, target.tileCount);
  await Promise.all(
    doomed
      .map(({ z, x, y }) => tileCacheKey(z, x, y))
      .filter((key) => !stillNeeded.has(key))
      .map((key) => tileStore.removeItem(key).catch(() => undefined))
  );
};
