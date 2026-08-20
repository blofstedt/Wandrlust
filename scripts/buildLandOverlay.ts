/**
 * Build the bundled public-land overview — `public/map/public-land-overview.json`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Every boundary the map draws today is fetched, live, from eight government
 * ArcGIS services at the moment somebody looks at a viewport. `public_lands` is
 * empty, so the seeded fast path has never once fired, and the honest summary
 * of the current experience is: open the app, wait on Ottawa and Denver.
 *
 * This script produces the opposite of that — ONE small file, committed to the
 * repo, that says where public land is across the whole of the United States
 * and Canada. It ships with the app, so the first paint needs no network at
 * all, works with no signal, and is the same speed in Saskatchewan as it is on
 * wifi. `public/map/` already works exactly this way for state lines, lakes and
 * the land mask; this is the fourth asset of that kind.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * COARSE, AND IT HAS TO SAY SO. Geometry is generalised by the source servers
 * (`maxAllowableOffset`) and then rounded to three decimal places — about 110
 * metres — and parcels below `--min-area` are dropped entirely. That is what
 * makes a continent fit in a few megabytes, and it means an edge in this file
 * can be a kilometre from the edge on the ground and a small parcel can be
 * missing altogether.
 *
 * So this answers "is there public land around here?" and it must never be
 * presented as answering "may I camp on this exact spot?". The app pairs it
 * with a plain warning and keeps loading real boundaries at close zoom. If you
 * are tempted to raise the tolerance to shrink the file, raise the warning too.
 *
 * A DROPPED PARCEL IS NOT ABSENT LAND. Everything cut here is cut for size, so
 * the meta block below records the thresholds used and the map repeats them.
 *
 * IT DOES NOT MERGE, AND THE LIVE API NOW DOES. Read this before running it.
 * `server/boundaryRoutes.ts` welds abutting parcels from one source into blocks
 * before deciding what is too small to draw — which is what stopped Ontario
 * rendering as a scatter of flecks over a province that is mostly Crown land.
 * This file writes loose parcels, and the client drops the small ones by
 * bounding-box span (`overviewMinSpanDegrees`) when zoomed out, so an overlay
 * built today would bring the old sparse Ontario back with it, on a path that
 * takes priority over the network. Nothing is broken right now — the overlay
 * has never been built and the file has never been committed — but whoever runs
 * this first needs to weld here too, at a few zoom bands, since the browser
 * cannot afford a boolean union on ten thousand parcels. `unionParcels` in
 * server/landGeometry.ts is the piece to reuse.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT RUNS
 * ---------------------------------------------------------------------------
 *
 * Not on a developer's laptop by preference, and not in the agent sandbox at
 * all — outbound access to gis.blm.gov and friends is refused there. It runs in
 * CI, where the network is open, and commits its output:
 * `.github/workflows/build-land-overlay.yml`.
 *
 *   npm run map:land -- --min-area=5 --offset=0.01
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { LAND_SOURCES, LandSourceSpec } from './landSources';
import { fetchAllTiled, fetchGeoJsonFile } from './arcgisTiledFetch';
import { subtractLakes } from '../server/landGeometry';

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = Number(hit.split('=')[1]);
  return Number.isFinite(value) ? value : fallback;
};

const only = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1];

/**
 * Server-side generalisation, in degrees. ~0.01° is roughly 1.1 km, which is
 * invisible at the zooms this file is drawn at and cuts the vertex count by
 * more than an order of magnitude.
 */
const OFFSET = arg('offset', 0.01);
/** Coordinate rounding, in decimal places. 3 ≈ 110 m. */
const PRECISION = Math.round(arg('precision', 3));
/** Parcels smaller than this are dropped. See the header — this loses land. */
const MIN_AREA_SQ_KM = arg('min-area', 5);

const OUT_PATH = resolve(process.cwd(), 'public/map/public-land-overview.json');

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

type Ring = [number, number][];

/**
 * Rough polygon area in km².
 *
 * Equirectangular approximation with a cosine correction at the ring's own
 * latitude. Wrong by a percent or two at continental latitudes, which is far
 * inside the tolerance of a threshold whose whole job is "is this parcel big
 * enough to be worth a pixel".
 */
const ringAreaSqKm = (ring: Ring): number => {
  if (ring.length < 3) return 0;

  const latMean = ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.32 * Math.cos((latMean * Math.PI) / 180);

  let twiceArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    twiceArea += (x1 * kmPerDegLon) * (y2 * kmPerDegLat) - (x2 * kmPerDegLon) * (y1 * kmPerDegLat);
  }
  return Math.abs(twiceArea / 2);
};

/** Round, then drop points the rounding made identical to their neighbour. */
const roundRing = (ring: Ring): Ring => {
  const factor = Math.pow(10, PRECISION);
  const out: Ring = [];

  for (const [lon, lat] of ring) {
    const point: [number, number] = [
      Math.round(lon * factor) / factor,
      Math.round(lat * factor) / factor
    ];
    const previous = out[out.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    out.push(point);
  }

  // Close the ring again if rounding opened it.
  if (out.length > 2) {
    const [fx, fy] = out[0];
    const [lx, ly] = out[out.length - 1];
    if (fx !== lx || fy !== ly) out.push([fx, fy]);
  }
  return out;
};

interface Simplified {
  /** Polygon rings, outer ring first. Holes are kept — an inholding matters. */
  polygons: Ring[][];
  areaSqKm: number;
}

/**
 * Normalise Polygon | MultiPolygon into a list of polygons, rounded, with
 * degenerate rings and sub-threshold parts removed.
 */
const simplifyGeometry = (geometry: any): Simplified | null => {
  if (!geometry) return null;

  const raw: Ring[][] =
    geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
    : [];

  const polygons: Ring[][] = [];
  let areaSqKm = 0;

  for (const rings of raw) {
    if (!Array.isArray(rings) || rings.length === 0) continue;

    const outer = roundRing(rings[0] as Ring);
    if (outer.length < 4) continue;

    const outerArea = ringAreaSqKm(outer);
    // Each PART is measured, not just the feature: a multipolygon of a hundred
    // slivers plus one big block should keep the block and shed the slivers.
    if (outerArea < MIN_AREA_SQ_KM) continue;

    const holes = (rings.slice(1) as Ring[])
      .map(roundRing)
      // A hole below the threshold is smaller than the rounding error anyway.
      .filter((hole) => hole.length >= 4 && ringAreaSqKm(hole) >= MIN_AREA_SQ_KM);

    polygons.push([outer, ...holes]);
    areaSqKm += outerArea;
  }

  return polygons.length > 0 ? { polygons, areaSqKm } : null;
};

/* -------------------------------------------------------------------------- */
/* Output shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The two groups the map paints, and the only distinction it paints. Mirrors
 * `boundaryGroupOf` in src/services/boundaryService.ts: PAD-US "open access"
 * means the public may ENTER, which is not permission to sleep, so it stays in
 * its own quieter group rather than being folded in with BLM.
 */
type Group = 'campable' | 'access_only';

const groupOf = (source: LandSourceSpec): Group =>
  source.campingBasisKind === 'open_access_flag' ? 'access_only' : 'campable';

interface OverlayFeature {
  /** Group — `c` campable, `a` access only. Short key: this file has ~20k of them. */
  g: 'c' | 'a';
  /** Source id, so the app can attribute and explain the parcel. */
  s: string;
  /** Name, where the source gave one worth showing. */
  n?: string;
  /** MultiPolygon coordinates. */
  p: Ring[][];
}

interface SourceReport {
  id: string;
  label: string;
  attribution: string;
  group: Group;
  ok: boolean;
  featuresFetched: number;
  featuresKept: number;
  /** The source withheld features — this source's coverage is a sample. */
  truncated: boolean;
  errors: number;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

const buildSource = async (
  source: LandSourceSpec
): Promise<{ features: OverlayFeature[]; report: SourceReport }> => {
  const group = groupOf(source);
  const features: OverlayFeature[] = [];

  const report: SourceReport = {
    id: source.id,
    label: source.label,
    attribution: source.attribution,
    group,
    ok: false,
    featuresFetched: 0,
    featuresKept: 0,
    truncated: false,
    errors: 0
  };

  const consume = async (batch: any[]): Promise<void> => {
    for (const feature of batch) {
      const properties = feature?.properties ?? {};

      /*
       * The same gate the seeder applies. `campingBasis` returning null means
       * this parcel is a wilderness area, a refuge, a proving ground — land the
       * registry will not call campable — and it is dropped rather than shown
       * in a quieter colour, because there is no colour for "we think you
       * probably cannot sleep here".
       */
      if (group === 'campable' && source.campingBasis(properties) === null) continue;

      /*
       * Water first: the same lake cut the live boundary API applies per
       * request (Natural Earth 1:10m big lakes, see subtractLakes in
       * server/landGeometry.ts). Without it the static overview paints
       * campable green over open water — a province-scale layer like NL's
       * would put a tent on Smallwood Reservoir. File sources that already
       * carry water holes (NL, QC north) pass through unchanged.
       */
      const simplified = simplifyGeometry(subtractLakes(feature?.geometry));
      if (!simplified) continue;

      const name = (() => {
        try {
          const value = source.name(properties);
          return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined;
        } catch {
          return undefined;
        }
      })();

      features.push({
        g: group === 'campable' ? 'c' : 'a',
        s: source.id,
        ...(name ? { n: name } : {}),
        p: simplified.polygons
      });
    }
  };

  console.log(`\n▶ ${source.label} (${source.id})`);

  const stats =
    source.kind === 'geojson'
      ? await fetchGeoJsonFile(source.url, consume)
      : await fetchAllTiled(
          {
            url: source.url,
            where: source.where,
            outFields: source.outFields,
            bbox: {
              minLon: source.bbox[0],
              minLat: source.bbox[1],
              maxLon: source.bbox[2],
              maxLat: source.bbox[3]
            },
            maxRecordCount: source.maxRecordCount,
            // Let the SERVER generalise. It is dramatically cheaper than
            // pulling full-resolution geometry across the wire and thinning it
            // here, and these services are public infrastructure.
            maxAllowableOffset: OFFSET,
            geometryPrecision: PRECISION,
            concurrency: 3,
            maxDepth: 6
          },
          consume
        );

  report.featuresFetched = stats.uniqueFeatures;
  report.featuresKept = features.length;
  report.truncated = stats.truncationSuspected;
  report.errors = stats.errors;
  /*
   * "Worked" means it produced polygons. A source that answers every request
   * with an empty set is NOT ok — an empty province and a broken endpoint look
   * identical on a map, and this app treats guessing between them as the worst
   * thing it can do.
   */
  report.ok = features.length > 0;

  console.log(
    `  fetched ${stats.uniqueFeatures}, kept ${features.length}` +
      `${stats.truncationSuspected ? ', TRUNCATED' : ''}` +
      `${stats.errors ? `, ${stats.errors} errors` : ''}`
  );

  return { features, report };
};

const main = async (): Promise<void> => {
  const sources = LAND_SOURCES.filter((s) => !only || s.id === only);

  console.log(
    `Building public land overview from ${sources.length} source(s)\n` +
      `  simplification  ${OFFSET}°  (~${Math.round(OFFSET * 111)} km)\n` +
      `  precision       ${PRECISION} dp (~${Math.round(111000 / Math.pow(10, PRECISION))} m)\n` +
      `  min parcel area ${MIN_AREA_SQ_KM} km²`
  );

  const allFeatures: OverlayFeature[] = [];
  const reports: SourceReport[] = [];

  // Sequential on purpose. Eight government services hit in parallel from one
  // CI runner is how you get rate-limited by all eight at once.
  for (const source of sources) {
    try {
      const { features, report } = await buildSource(source);
      allFeatures.push(...features);
      reports.push(report);
    } catch (error) {
      console.warn(`  FAILED: ${(error as Error).message}`);
      reports.push({
        id: source.id,
        label: source.label,
        attribution: source.attribution,
        group: groupOf(source),
        ok: false,
        featuresFetched: 0,
        featuresKept: 0,
        truncated: false,
        errors: 1
      });
    }
  }

  const failed = reports.filter((r) => !r.ok);

  const payload = {
    /** Bumped when the shape of this file changes, so the client can refuse an old one. */
    version: 1,
    builtAt: new Date().toISOString(),
    simplifyDegrees: OFFSET,
    precision: PRECISION,
    minAreaSqKm: MIN_AREA_SQ_KM,
    /**
     * The disclaimer travels WITH the data rather than living only in the UI,
     * so anything that reads this file inherits it.
     */
    disclaimer:
      `Generalised overview. Edges are simplified by about ${Math.round(OFFSET * 111)} km and ` +
      `parcels under ${MIN_AREA_SQ_KM} km² are not included. Use it to see where public land is, ` +
      'never to decide whether a particular spot is legal to camp on.',
    sources: reports,
    features: allFeatures
  };

  if (failed.length > 0) {
    console.warn(`\n⚠ these sources produced nothing: ${failed.map((r) => r.id).join(', ')}`);
  }

  /*
   * An overlay with no parcels in it must never reach the disk.
   *
   * This is not a theoretical guard. A typo in `--source=` filters the
   * registry down to nothing, every loop below runs zero times, and the old
   * code cheerfully wrote a well-formed file containing an empty continent and
   * exited 0 — which the app would have loaded, believed, and painted as "no
   * public land anywhere in North America".
   *
   * Nothing fetched is a failed run, and a failed run leaves the committed
   * overlay alone.
   */
  if (sources.length === 0) {
    console.error(
      `\n✖ no sources matched${only ? ` --source=${only}` : ''}. Known ids: ` +
        LAND_SOURCES.map((s) => s.id).join(', ')
    );
    process.exit(1);
  }

  if (allFeatures.length === 0) {
    console.error('\n✖ every source returned nothing — refusing to write an empty overlay.');
    process.exit(1);
  }

  /*
   * Refuse to write a half-continent over a good file — and decide this BEFORE
   * writing, not after.
   *
   * A partial build is the dangerous outcome here, not a failed one: the file
   * still parses, the map still draws, and whole states quietly go from green
   * to empty with nothing anywhere saying why. Bailing out early leaves the
   * previously committed overlay untouched, which is stale but honest.
   */
  if (reports.length > 1 && failed.length > reports.length / 2) {
    console.error(
      `\n✖ ${failed.length} of ${reports.length} sources produced nothing — refusing to ` +
        'overwrite the committed overlay with a partial continent.'
    );
    process.exit(1);
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));

  const { size } = await stat(OUT_PATH);
  const mb = (size / (1024 * 1024)).toFixed(1);

  console.log(`\n✔ ${OUT_PATH}`);
  console.log(`  ${allFeatures.length} parcels, ${mb} MB on disk`);
  console.log(`  sources ok: ${reports.filter((r) => r.ok).length}/${reports.length}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
