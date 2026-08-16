/**
 * Complete ArcGIS FeatureServer extraction via recursive quadtree tiling.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every ArcGIS service caps results at `maxRecordCount` (commonly 1000-2000).
 * A naive loop over `resultOffset` looks like it paginates, but not all
 * services honour it, those that do often cap pagination depth, and the worst
 * case is a SILENTLY truncated set with no error — you conclude BLM manages
 * 5,000 polygons nationally.
 *
 * THE FIX
 *
 * Split the extent into tiles. Query each. If a tile returns exactly
 * maxRecordCount features we cannot know whether more exist, so we subdivide
 * into four and recurse. Repeat until every tile returns strictly fewer
 * features than the cap. That gives a completeness guarantee.
 */

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface TiledFetchOptions {
  url: string;
  where: string;
  outFields: string;
  bbox: Bbox;
  maxRecordCount: number;
  /** Guard against runaway recursion on pathological extents. */
  maxDepth?: number;
  geometryPrecision?: number;
  maxAllowableOffset?: number;
  /** Parallel tile requests. Keep low — these are public services. */
  concurrency?: number;
  onProgress?: (stats: FetchStats) => void;
}

export interface FetchStats {
  tilesQueried: number;
  tilesSubdivided: number;
  featuresFetched: number;
  uniqueFeatures: number;
  errors: number;
  truncationSuspected: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const quarter = (b: Bbox): Bbox[] => {
  const midLon = (b.minLon + b.maxLon) / 2;
  const midLat = (b.minLat + b.maxLat) / 2;
  return [
    { minLon: b.minLon, minLat: b.minLat, maxLon: midLon, maxLat: midLat },
    { minLon: midLon, minLat: b.minLat, maxLon: b.maxLon, maxLat: midLat },
    { minLon: b.minLon, minLat: midLat, maxLon: midLon, maxLat: b.maxLat },
    { minLon: midLon, minLat: midLat, maxLon: b.maxLon, maxLat: b.maxLat }
  ];
};

/** Split an extent into a starting grid so we don't begin with one huge query. */
const seedGrid = (b: Bbox, cols: number, rows: number): Bbox[] => {
  const tiles: Bbox[] = [];
  const dLon = (b.maxLon - b.minLon) / cols;
  const dLat = (b.maxLat - b.minLat) / rows;
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      tiles.push({
        minLon: b.minLon + i * dLon,
        minLat: b.minLat + j * dLat,
        maxLon: b.minLon + (i + 1) * dLon,
        maxLat: b.minLat + (j + 1) * dLat
      });
    }
  }
  return tiles;
};

interface TileResult {
  features: any[];
  /** True when the server may have withheld features. */
  truncated: boolean;
  failed: boolean;
}

const fetchTile = async (opts: TiledFetchOptions, tile: Bbox, attempt = 0): Promise<TileResult> => {
  const params = new URLSearchParams({
    where: opts.where,
    geometry: `${tile.minLon},${tile.minLat},${tile.maxLon},${tile.maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: String(opts.geometryPrecision ?? 5),
    // Ask the server to fail loudly rather than quietly truncate.
    returnExceededLimitFeatures: 'false',
    f: 'geojson'
  });

  if (opts.maxAllowableOffset && opts.maxAllowableOffset > 0) {
    params.set('maxAllowableOffset', String(opts.maxAllowableOffset));
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    const res = await fetch(`${opts.url}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Wandrlust/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await sleep(1000 * Math.pow(2, attempt));
        return fetchTile(opts, tile, attempt + 1);
      }
      return { features: [], truncated: false, failed: true };
    }

    if (!res.ok) return { features: [], truncated: false, failed: true };

    const data: any = await res.json();

    // ArcGIS reports errors inside a 200 response.
    if (data?.error) {
      if (attempt < 2) {
        await sleep(800);
        return fetchTile(opts, tile, attempt + 1);
      }
      return { features: [], truncated: false, failed: true };
    }

    const features = Array.isArray(data?.features) ? data.features : [];

    // Two truncation signals: the explicit flag, and hitting the cap exactly.
    const truncated =
      data?.exceededTransferLimit === true ||
      data?.properties?.exceededTransferLimit === true ||
      features.length >= opts.maxRecordCount;

    return { features, truncated, failed: false };
  } catch {
    if (attempt < 3) {
      await sleep(1000 * Math.pow(2, attempt));
      return fetchTile(opts, tile, attempt + 1);
    }
    return { features: [], truncated: false, failed: true };
  }
};

/**
 * Fetch every feature in an extent, subdividing until no tile is truncated.
 *
 * @param onFeatures Called per tile so the caller can stream to the DB instead
 *                   of holding a national dataset in memory.
 */
export const fetchAllTiled = async (
  opts: TiledFetchOptions,
  onFeatures: (features: any[]) => Promise<void>
): Promise<FetchStats> => {
  const maxDepth = opts.maxDepth ?? 7;
  const concurrency = opts.concurrency ?? 3;

  const stats: FetchStats = {
    tilesQueried: 0, tilesSubdivided: 0, featuresFetched: 0,
    uniqueFeatures: 0, errors: 0, truncationSuspected: false
  };

  // Start from a coarse grid rather than one continent-sized envelope.
  let queue: { tile: Bbox; depth: number }[] = seedGrid(opts.bbox, 8, 6).map((tile) => ({ tile, depth: 0 }));
  const seenIds = new Set<string>();

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    const results = await Promise.all(
      batch.map(async ({ tile, depth }) => ({ depth, tile, result: await fetchTile(opts, tile) }))
    );

    const nextQueue: { tile: Bbox; depth: number }[] = [];

    for (const { tile, depth, result } of results) {
      stats.tilesQueried += 1;

      if (result.failed) {
        stats.errors += 1;
        // A failed tile might still hold data; retry it split.
        if (depth < maxDepth) {
          nextQueue.push(...quarter(tile).map((t) => ({ tile: t, depth: depth + 1 })));
          stats.tilesSubdivided += 1;
        }
        continue;
      }

      if (result.truncated) {
        if (depth < maxDepth) {
          stats.tilesSubdivided += 1;
          nextQueue.push(...quarter(tile).map((t) => ({ tile: t, depth: depth + 1 })));
          continue;
        }
        // Bottomed out and still truncated: record honestly rather than
        // pretending the extract is complete.
        stats.truncationSuspected = true;
      }

      stats.featuresFetched += result.features.length;

      // Tiles overlap on shared edges, so the same feature can come back more
      // than once. De-duplicate before handing off.
      const fresh = result.features.filter((f: any) => {
        const id =
          f?.id ?? f?.properties?.OBJECTID ?? f?.properties?.objectid ??
          f?.properties?.OGF_ID ?? JSON.stringify(f?.properties ?? {}).slice(0, 200);
        const key = String(id);
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });

      if (fresh.length > 0) {
        stats.uniqueFeatures += fresh.length;
        await onFeatures(fresh);
      }
    }

    queue = nextQueue.concat(queue);
    opts.onProgress?.(stats);

    // Be a good citizen with public infrastructure.
    await sleep(150);
  }

  return stats;
};
/* ------------------------------------------------------------------ */
/* Whole-file sources                                                  */
/* ------------------------------------------------------------------ */
/**
 * Download one GeoJSON file and hand its features over in batches.
 *
 * WHY THIS SITS BESIDE THE TILED FETCHER. Everything above pages an ArcGIS
 * query endpoint, subdividing whenever a tile looks truncated. That is the
 * right shape for a service and the wrong shape for a province that publishes
 * its Crown land as a file and nothing else — which is most of Canada. The
 * tiled fetcher could not reach them at all, so they were absent from the app
 * and recorded as coverage gaps.
 *
 * Deliberately dumb: one request, no paging, no retry ladder. A file source
 * either answers or it does not, and pretending otherwise would invent
 * partial coverage that nobody could distinguish from the real thing.
 *
 * Reports the same `FetchStats` as the tiled path so the seeder's logging and
 * its truncation warnings work identically for both.
 */
export const fetchGeoJsonFile = async (
  /** An http(s) URL, or a path to a file on disk. */
  url: string,
  onFeatures: (features: any[]) => Promise<void>,
  batchSize = 500
): Promise<FetchStats> => {
  const stats: FetchStats = {
    tilesQueried: 1, tilesSubdivided: 0, featuresFetched: 0,
    uniqueFeatures: 0, errors: 0, truncationSuspected: false
  };

  try {
    /**
     * A LOCAL PATH IS AS VALID A SOURCE AS A URL, and for this data it is
     * often the only one.
     *
     * The provinces that publish campable Crown land publish it as a periodic
     * file — a download page, an email, a quarterly refresh — not as a service
     * anybody can query. Insisting on a URL would mean either inventing deep
     * links that rot, or leaving those provinces out entirely, and this app
     * has already recorded them as coverage gaps for exactly that reason.
     *
     * So: drop the province's GeoJSON somewhere, point `url` at the path, run
     * the seeder. Same gate, same geometry check, same audit row as anything
     * fetched over the wire — and the file is the province's own, not a guess.
     */
    let body: any;

    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
      if (!res.ok) {
        stats.errors = 1;
        console.warn(`    download failed: HTTP ${res.status} ${res.statusText}`);
        return stats;
      }
      body = await res.json();
    } else {
      const { readFile } = await import('node:fs/promises');
      body = JSON.parse(await readFile(url, 'utf8'));
    }

    const features: any[] = Array.isArray(body?.features)
      ? body.features
      : Array.isArray(body) ? body : [];

    if (features.length === 0) {
      // Loud, because a silently empty source is indistinguishable from a
      // region with no public land — the exact confusion this app exists to
      // avoid. A seed run that prints this has NOT covered that province.
      stats.errors = 1;
      console.warn('    download returned no features — treat this source as UNCONFIRMED.');
      return stats;
    }

    stats.featuresFetched = features.length;
    stats.uniqueFeatures = features.length;

    for (let i = 0; i < features.length; i += batchSize) {
      await onFeatures(features.slice(i, i + batchSize));
    }
    return stats;
  } catch (err) {
    stats.errors = 1;
    console.warn(`    download failed: ${(err as Error).message}`);
    return stats;
  }
};
