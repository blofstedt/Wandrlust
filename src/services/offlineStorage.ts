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

const writeList = async <T>(key: string, value: T[]): Promise<void> => {
  try {
    await dataStore.setItem(key, value);
  } catch {
    // Storage full or unavailable; drop silently rather than breaking the UI.
  }
};

/* ------------------------------------------------------------------ */
/* Saved campsites                                                     */
/* ------------------------------------------------------------------ */

export const getSavedCampsites = (): Promise<Campsite[]> => readList<Campsite>(SAVED_KEY);

export const isCampsiteSaved = async (id: string): Promise<boolean> => {
  const saved = await getSavedCampsites();
  return saved.some((site) => site.id === id);
};

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

export const clearSavedCampsites = (): Promise<void> => writeList(SAVED_KEY, []);

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
 * Download and cache map tiles for a bounding box, plus the campsites inside
 * it, so the area is usable with no connectivity.
 */
export const downloadOfflineRegion = async (
  name: string,
  center: [number, number],
  bounds: OfflineRegion['bounds'],
  campsites: Campsite[],
  onProgress?: (percent: number) => void,
  options: { zoomMin?: number; zoomMax?: number; maxTiles?: number } = {}
): Promise<OfflineRegion> => {
  const zoomMin = options.zoomMin ?? 8;
  const zoomMax = options.zoomMax ?? 12;
  const maxTiles = options.maxTiles ?? 400;

  const tiles = enumerateTiles(bounds, zoomMin, zoomMax, maxTiles);

  let bytes = 0;
  let completed = 0;
  const CONCURRENCY = 6;

  const fetchTile = async ({ z, x, y }: TileCoord): Promise<void> => {
    const key = tileCacheKey(z, x, y);
    try {
      const existing = await tileStore.getItem<Blob>(key);
      if (existing) {
        bytes += existing.size;
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
    } catch {
      // Skip individual tile failures — a partial cache is still useful.
    } finally {
      completed += 1;
      onProgress?.(Math.round((completed / tiles.length) * 100));
    }
  };

  for (let i = 0; i < tiles.length; i += CONCURRENCY) {
    await Promise.all(tiles.slice(i, i + CONCURRENCY).map(fetchTile));
  }

  /**
   * Persist the campsites themselves so the area works with no signal.
   *
   * Into the pack's own list, NOT the bookmarks — see OFFLINE_SITES_KEY. A
   * camper who downloads the Rockies has not bookmarked the Rockies.
   */
  const cached = await getOfflineCampsites();
  const cachedIds = new Set(cached.map((site) => site.id));
  const additions = campsites.filter((site) => !cachedIds.has(site.id));
  if (additions.length > 0) {
    await writeList(OFFLINE_SITES_KEY, [...cached, ...additions]);
  }

  const region: OfflineRegion = {
    id: `region-${Date.now()}`,
    name,
    bounds,
    center,
    zoomMin,
    zoomMax,
    tileCount: tiles.length,
    sizeMb: Math.max(0.1, Number((bytes / (1024 * 1024)).toFixed(1))),
    downloadedAt: new Date().toISOString().split('T')[0],
    campsiteCount: campsites.length
  };

  const regions = await getDownloadedRegions();
  await writeList(REGIONS_KEY, [region, ...regions]);

  onProgress?.(100);
  return region;
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

export const getTileCacheSizeMb = async (): Promise<number> => {
  let bytes = 0;
  try {
    await tileStore.iterate<Blob, void>((blob) => {
      if (blob) bytes += blob.size;
    });
  } catch {
    return 0;
  }
  return Number((bytes / (1024 * 1024)).toFixed(1));
};