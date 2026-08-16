/**
 * Builds the two map data files that ship with the app.
 *
 *   npm run map:assets
 *
 * Outputs, both committed to the repo:
 *
 *   public/map/admin1-us-ca.json   state / province outlines
 *   public/map/land-mask.bin       land-vs-water bitmask
 *
 * WHY THESE ARE BUILT AHEAD OF TIME AND COMMITTED
 *
 * The obvious way to get this data is to have the server fetch it from
 * Natural Earth on the first request and cache it. That was tried and it
 * cannot work here, for three separate reasons:
 *
 *   1. The API runs as a Vercel serverless function. The filesystem is
 *      read-only apart from /tmp, so the "cache it on disk" step silently
 *      fails and every cold start pays the download again.
 *   2. The admin-1 source is 63 MB. Against a 30-second function budget
 *      that is not a slow first request, it is a failed one — which is
 *      exactly why the state/province layer drew nothing.
 *   3. A pin drop had to wait on a network round trip before the map
 *      would accept the tap, on the one feature most likely to be used
 *      in a canyon with one bar of signal.
 *
 * Doing the work here instead means the app ships with the answer: no
 * key, no round trip, no cold start, and both features keep working with
 * the network switched off. The cost is that this script must be re-run
 * when the upstream data changes, which for national borders and
 * coastlines is a once-a-decade event.
 *
 * Source: Natural Earth via the martynafford GeoJSON mirror. Public
 * domain, no attribution required (we credit it anyway in the layer UI).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_VIEW_BBOX } from '../src/config/coverage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'map');
/** Downloads land here so re-runs don't re-fetch 25 MB. Gitignored. */
const CACHE_DIR = path.join(ROOT, '.cache', 'naturalearth');

const MIRROR = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master';

/* ------------------------------------------------------------------ */
/* Download, with an on-disk cache                                     */
/* ------------------------------------------------------------------ */

const fetchDataset = async (relPath: string): Promise<GeoJSON.FeatureCollection> => {
  const cacheFile = path.join(CACHE_DIR, path.basename(relPath));
  try {
    const raw = await fs.readFile(cacheFile, 'utf-8');
    process.stdout.write(`  cached  ${path.basename(relPath)}\n`);
    return JSON.parse(raw) as GeoJSON.FeatureCollection;
  } catch {
    /* not cached yet */
  }

  process.stdout.write(`  fetch   ${relPath} …\n`);
  const res = await fetch(`${MIRROR}/${relPath}`, {
    headers: { 'User-Agent': 'Wandrlust map asset build' }
  });
  if (!res.ok) throw new Error(`${relPath}: HTTP ${res.status}`);
  const raw = await res.text();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile, raw, 'utf-8');
  return JSON.parse(raw) as GeoJSON.FeatureCollection;
};

/* ------------------------------------------------------------------ */
/* Geometry plumbing                                                   */
/* ------------------------------------------------------------------ */

type Ring = number[][];

const ringsOf = (geometry: GeoJSON.Geometry | null | undefined): Ring[] => {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[];
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as Ring[][]).flat();
  }
  return [];
};

const ringBounds = (ring: Ring): [number, number, number, number] => {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
};

/* ------------------------------------------------------------------ */
/* Asset 1 — state and province outlines                               */
/* ------------------------------------------------------------------ */

/**
 * The 1:50m admin-1 set, trimmed to the US and Canada.
 *
 * 1:50m rather than 1:10m because this layer draws thin grey reference
 * lines under everything else. At the zoom levels a camper actually
 * uses, the extra fidelity of the 10m set is invisible — and it costs
 * 63 MB against 1.6 MB. The trimmed, thinned result is a few hundred
 * kilobytes, which is small enough to ship to the browser once and
 * then answer "which state is this pin in?" locally, with no server.
 */
const buildAdmin1 = async (): Promise<void> => {
  const source = await fetchDataset('50m/cultural/ne_50m_admin_1_states_provinces.json');

  /**
   * Coordinates rounded to three decimals — about 110 m, which is finer
   * than a one-pixel line can express at any zoom this layer draws at.
   * Rounding first and then dropping points that collapse onto their
   * neighbour is what does most of the size reduction, and unlike a real
   * simplification pass it cannot move a border across a town.
   */
  const thin = (ring: Ring): Ring => {
    const out: Ring = [];
    let lastLon = NaN;
    let lastLat = NaN;
    for (const [lon, lat] of ring) {
      const rLon = Math.round(lon * 1000) / 1000;
      const rLat = Math.round(lat * 1000) / 1000;
      if (rLon === lastLon && rLat === lastLat) continue;
      out.push([rLon, rLat]);
      lastLon = rLon;
      lastLat = rLat;
    }
    // A ring that collapsed below a triangle is not a shape any more.
    if (out.length < 4) return [];
    // Rounding can unglue the first and last point; close it back up.
    const [fLon, fLat] = out[0];
    const [lLon, lLat] = out[out.length - 1];
    if (fLon !== lLon || fLat !== lLat) out.push([fLon, fLat]);
    return out;
  };

  const thinGeometry = (geometry: GeoJSON.Geometry): GeoJSON.Geometry | null => {
    if (geometry.type === 'Polygon') {
      const rings = (geometry.coordinates as Ring[]).map(thin).filter((r) => r.length);
      return rings.length ? { type: 'Polygon', coordinates: rings } : null;
    }
    if (geometry.type === 'MultiPolygon') {
      const polys = (geometry.coordinates as Ring[][])
        .map((poly) => poly.map(thin).filter((r) => r.length))
        .filter((poly) => poly.length);
      return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
    }
    return null;
  };

  const features: GeoJSON.Feature[] = [];
  for (const feature of source.features ?? []) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const iso = props.iso_a2 as string | undefined;
    if (iso !== 'US' && iso !== 'CA') continue;

    const name = (props.name as string | undefined) ?? '';
    const isoCode = (props.iso_3166_2 as string | undefined) ?? '';
    if (!name) continue;

    const geometry = thinGeometry(feature.geometry as GeoJSON.Geometry);
    if (!geometry) continue;

    features.push({
      type: 'Feature',
      geometry,
      properties: {
        name,
        isoCode,
        abbrev: (props.abbrev as string | undefined) ?? '',
        country: iso === 'US' ? 'United States' : 'Canada',
        countryCode: iso,
        type: (props.type_en as string | undefined) ?? (iso === 'US' ? 'State' : 'Province')
      }
    });
  }

  const collection = { type: 'FeatureCollection' as const, features };
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'admin1-us-ca.json');
  await fs.writeFile(file, JSON.stringify(collection), 'utf-8');

  const bytes = (await fs.stat(file)).size;
  process.stdout.write(
    `  wrote   public/map/admin1-us-ca.json — ${features.length} states/provinces, ` +
    `${(bytes / 1024).toFixed(0)} KB\n`
  );
};

/* ------------------------------------------------------------------ */
/* Asset 2 — the land/water mask                                       */
/* ------------------------------------------------------------------ */

/**
 * Grid resolution in degrees. 0.02° is roughly 2.2 km north-to-south,
 * and between 1.0 and 2.0 km east-to-west across the covered latitudes.
 *
 * Finer would be a false economy. The mask exists to answer one
 * question — "is this tap obviously out at sea or in the middle of a
 * lake?" — and the source coastline is itself only accurate to about a
 * kilometre. Quadrupling the grid would quadruple the download to
 * sharpen a line the source data cannot place any better.
 */
const CELL_DEG = 0.02;

/**
 * Paint every cell whose centre falls inside the rings, even-odd.
 *
 * Even-odd is what makes holes work for free: an island in a lake is an
 * inner ring, gets crossed twice, and comes out unpainted. Rings from
 * different features are safe to pool into one pass because neither
 * source overlaps itself — no two Natural Earth land polygons cover the
 * same ground, and neither do two lakes.
 *
 * Edges are bucketed by the grid rows they span, so each row only looks
 * at edges that actually cross it. Without that this is a few hundred
 * thousand edges times two thousand rows and the script never finishes.
 */
const rasterize = (rings: Ring[], width: number, height: number,
                   minLon: number, minLat: number): Uint8Array => {
  const mask = new Uint8Array(width * height);

  // rowBuckets[row] = flat list of edge endpoints crossing that row.
  const rowBuckets: number[][] = Array.from({ length: height }, () => []);
  const rowLat = (row: number) => minLat + (row + 0.5) * CELL_DEG;

  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if (y1 === y2) continue;

      const loLat = Math.min(y1, y2);
      const hiLat = Math.max(y1, y2);
      let firstRow = Math.ceil((loLat - minLat) / CELL_DEG - 0.5);
      let lastRow = Math.floor((hiLat - minLat) / CELL_DEG - 0.5);
      if (firstRow < 0) firstRow = 0;
      if (lastRow > height - 1) lastRow = height - 1;

      for (let row = firstRow; row <= lastRow; row += 1) {
        const lat = rowLat(row);
        // Half-open in latitude, so a vertex landing exactly on a row
        // is counted once rather than zero or twice.
        if (lat < loLat || lat >= hiLat) continue;
        rowBuckets[row].push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
  }

  for (let row = 0; row < height; row += 1) {
    const crossings = rowBuckets[row];
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    const rowStart = row * width;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      let from = Math.ceil((crossings[k] - minLon) / CELL_DEG - 0.5);
      let to = Math.floor((crossings[k + 1] - minLon) / CELL_DEG - 0.5);
      if (to < 0 || from > width - 1) continue;
      if (from < 0) from = 0;
      if (to > width - 1) to = width - 1;
      mask.fill(1, rowStart + from, rowStart + to + 1);
    }
  }

  return mask;
};

/**
 * Grow the land by one cell in all eight directions.
 *
 * This is the whole safety margin of the feature, and it is deliberately
 * one-sided. Refusing a pin the user is entitled to drop is a far worse
 * failure than accepting one a few kilometres offshore: the first blocks
 * a real campsite on a coast or a lake shore and leaves no way around
 * it, the second drops a pin the user can simply move. Dilating means
 * the app only ever says "that's water" when the tap is more than a cell
 * clear of anything the source data calls land.
 */
const dilate = (mask: Uint8Array, width: number, height: number): Uint8Array => {
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col;
      if (mask[index]) { out[index] = 1; continue; }
      let hit = 0;
      for (let dr = -1; dr <= 1 && !hit; dr += 1) {
        const r = row + dr;
        if (r < 0 || r >= height) continue;
        for (let dc = -1; dc <= 1; dc += 1) {
          const c = col + dc;
          if (c < 0 || c >= width) continue;
          if (mask[r * width + c]) { hit = 1; break; }
        }
      }
      out[index] = hit;
    }
  }
  return out;
};

const buildLandMask = async (): Promise<void> => {
  const [land, lakes] = await Promise.all([
    fetchDataset('10m/physical/ne_10m_land.json'),
    fetchDataset('10m/physical/ne_10m_lakes.json')
  ]);

  const { minLon, minLat, maxLon, maxLat } = MAP_VIEW_BBOX;
  const width = Math.ceil((maxLon - minLon) / CELL_DEG);
  const height = Math.ceil((maxLat - minLat) / CELL_DEG);

  // Only rings that reach the frame matter — this is what keeps Eurasia
  // and Antarctica out of the scanline pass.
  const relevant = (collection: GeoJSON.FeatureCollection): Ring[] => {
    const out: Ring[] = [];
    for (const feature of collection.features ?? []) {
      for (const ring of ringsOf(feature.geometry as GeoJSON.Geometry)) {
        if (ring.length < 4) continue;
        const [rMinLon, rMinLat, rMaxLon, rMaxLat] = ringBounds(ring);
        if (rMaxLon < minLon || rMinLon > maxLon) continue;
        if (rMaxLat < minLat || rMinLat > maxLat) continue;
        out.push(ring);
      }
    }
    return out;
  };

  const landRings = relevant(land);
  const lakeRings = relevant(lakes);
  process.stdout.write(
    `  raster  ${width}×${height} cells from ${landRings.length} land rings ` +
    `and ${lakeRings.length} lake rings\n`
  );

  const landMask = rasterize(landRings, width, height, minLon, minLat);
  const lakeMask = rasterize(lakeRings, width, height, minLon, minLat);

  // Land that is not lake. The Great Lakes sit inside the continental
  // land polygon in the source data, so without this subtraction the
  // middle of Lake Superior reads as solid ground.
  for (let i = 0; i < landMask.length; i += 1) {
    if (lakeMask[i]) landMask[i] = 0;
  }

  const grown = dilate(landMask, width, height);

  // Pack to one bit per cell, row-major, low bit first.
  const packed = new Uint8Array(Math.ceil(grown.length / 8));
  let landCells = 0;
  for (let i = 0; i < grown.length; i += 1) {
    if (!grown[i]) continue;
    landCells += 1;
    packed[i >> 3] |= 1 << (i & 7);
  }

  /**
   * Self-describing header, so the grid's origin and resolution travel
   * with the bits instead of being duplicated as constants in the
   * client — where they would eventually drift out of sync with
   * whatever this script last wrote.
   *
   *   magic "WLMASK01"  8 bytes
   *   minLon, minLat, cellDeg   3 × float64
   *   width, height             2 × uint32
   */
  const header = new ArrayBuffer(8 + 24 + 8);
  const bytes = new Uint8Array(header);
  const view = new DataView(header);
  for (let i = 0; i < 8; i += 1) bytes[i] = 'WLMASK01'.charCodeAt(i);
  view.setFloat64(8, minLon, true);
  view.setFloat64(16, minLat, true);
  view.setFloat64(24, CELL_DEG, true);
  view.setUint32(32, width, true);
  view.setUint32(36, height, true);

  const out = new Uint8Array(header.byteLength + packed.length);
  out.set(bytes, 0);
  out.set(packed, header.byteLength);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'land-mask.bin');
  await fs.writeFile(file, out);

  process.stdout.write(
    `  wrote   public/map/land-mask.bin — ${(out.length / 1024).toFixed(0)} KB, ` +
    `${((landCells / grown.length) * 100).toFixed(1)}% land\n`
  );
};

/* ------------------------------------------------------------------ */
/* Asset 3 — the big lakes, as shapes                                  */
/* ------------------------------------------------------------------ */

/**
 * THE MAP WAS TELLING PEOPLE THEY COULD CAMP ON A LAKE.
 *
 * Crown land and BLM polygons include the water inside them, and legally they
 * are right to: the province owns the lakebed the same way it owns the shore.
 * Painted as a green "you can sleep here" wash, that is a lie a camper can act
 * on — a bay of Lake Nipigon came out the same colour as the pine forest
 * around it.
 *
 * The land mask already knows where the water is, and the pin drop already
 * refuses it. What was missing was the same knowledge in a form the FILL could
 * use, because a bitmask cannot punch a hole in a polygon. So the same lake
 * data that goes into the mask is also written out as shapes, and the boundary
 * fill subtracts them — see `punchLakes` in MapComponent.
 *
 * WHAT THIS DOES NOT COVER, AND THE APP SAYS SO. Natural Earth's 1:10m lakes
 * are the big ones — roughly the named ones on a wall map. The Canadian Shield
 * has a quarter of a million lakes smaller than that, and none of them are
 * here. This cuts out the water you can see from space, not every pond, and
 * the boundary caveat about approximate edges continues to do the rest.
 */
/** Smallest lake worth shipping, as a bbox in square degrees (~40 km²). */
const MIN_LAKE_DEG2 = 0.004;

const buildLakes = async (): Promise<void> => {
  const lakes = await fetchDataset('10m/physical/ne_10m_lakes.json');
  const { minLon, minLat, maxLon, maxLat } = MAP_VIEW_BBOX;

  /*
   * Three decimals — about 110 m — and vertices closer together than 330 m
   * thrown away.
   *
   * That sounds crude for a coastline and is exactly right for this one. The
   * shape is a HOLE in a boundary whose own edge this app describes, out loud,
   * as accurate to hundreds of metres; drawing the lake to eleven metres
   * inside it would be precision theatre costing 800 KB. At full precision the
   * file was 869 KB, which is not a thing to make a camper download on one bar
   * of signal.
   */
  const round = (v: number): number => Math.round(v * 1e3) / 1e3;
  const THIN_DEG = 0.003;

  const kept: number[][][] = [];
  for (const feature of lakes.features ?? []) {
    for (const ring of ringsOf(feature.geometry as GeoJSON.Geometry)) {
      if (ring.length < 4) continue;
      const [rMinLon, rMinLat, rMaxLon, rMaxLat] = ringBounds(ring);
      if (rMaxLon < minLon || rMinLon > maxLon) continue;
      if (rMaxLat < minLat || rMinLat > maxLat) continue;
      if ((rMaxLon - rMinLon) * (rMaxLat - rMinLat) < MIN_LAKE_DEG2) continue;

      // Radial thinning: keep a vertex only once we have moved far enough
      // from the last one we kept. Cheap, order-preserving, and on a 1:10m
      // shoreline it removes most of the points without moving the shape.
      const simplified: number[][] = [];
      for (const [lon, lat] of ring) {
        const point = [round(lon), round(lat)];
        const last = simplified[simplified.length - 1];
        if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < THIN_DEG) continue;
        simplified.push(point);
      }
      if (simplified.length < 4) continue;
      // Close it, since rounding may have moved the last point off the first.
      const first = simplified[0];
      const final = simplified[simplified.length - 1];
      if (first[0] !== final[0] || first[1] !== final[1]) simplified.push([...first]);
      kept.push(simplified);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'lakes-us-ca.json');
  /*
   * Bare rings with a precomputed bbox each, not a FeatureCollection. The
   * client does one thing with this — ask "does this lake sit inside that
   * parcel?" thousands of times per pan — and every GeoJSON wrapper around
   * the answer is a property it never reads.
   */
  const payload = {
    format: 'wl-lakes-1',
    note: 'Natural Earth 1:10m lakes, trimmed to the coverage area. Big lakes only.',
    lakes: kept.map((ring) => {
      const [a, b, c, d] = ringBounds(ring);
      return { bbox: [a, b, c, d], ring };
    })
  };
  const json = JSON.stringify(payload);
  await fs.writeFile(file, json, 'utf-8');

  process.stdout.write(
    `  wrote   public/map/lakes-us-ca.json — ${(json.length / 1024).toFixed(0)} KB, ` +
    `${kept.length} lakes\n`
  );
};

/* ------------------------------------------------------------------ */

const main = async (): Promise<void> => {
  process.stdout.write('Building map assets\n');
  await buildAdmin1();
  await buildLandMask();
  await buildLakes();
  process.stdout.write('Done. Commit public/map/ with your change.\n');
};

main().catch((error: unknown) => {
  process.stderr.write(`Failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
