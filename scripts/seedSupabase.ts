/**
 * Seed Supabase with campsites and public-land boundaries.
 *
 *   npm run seed                    # campsites + all boundary sources
 *   npm run seed -- --sites         # campsites only
 *   npm run seed -- --lands         # boundaries only
 *   npm run seed -- --source=blm_sma_national
 *   npm run seed -- --lands --dry   # report counts, write nothing
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (the anon key cannot write — by design).
 *
 * Boundary extraction uses recursive quadtree tiling, so a national pull is
 * provably complete rather than silently capped at the server's record limit.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { CURATED_CAMPSITES } from '../src/data/curatedCampsites';
import type { Campsite } from '../src/types';
import { LAND_SOURCES, COVERAGE_GAPS, LandSourceSpec } from './landSources';
import { fetchAllTiled, fetchGeoJsonFile, FetchStats } from './arcgisTiledFetch';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Service role key: Supabase Dashboard > Project Settings > API.\n' +
      'Never commit it or ship it to the browser.'
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');
const ONLY_SOURCE = args.find((a) => a.startsWith('--source='))?.split('=')[1];

/**
 * A campsite as a database row.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION USED TO CRASH ON THE FIRST ROW
 * ---------------------------------------------------------------------------
 *
 * It read `site.amenities.cellSignal.verizon`. Every field on
 * `CampsiteAmenities` is optional and NOT ONE of the curated sites records a
 * cell signal, so `cellSignal` was always undefined and reading `.verizon` off
 * it threw a TypeError before a single row was built. `npm run seed -- --sites`
 * has therefore never worked, which means the curated campsites were never in
 * `public.campsites` at all — and every table that references a campsite by id
 * had nothing to point at.
 *
 * ---------------------------------------------------------------------------
 * WHY UNDEFINED FIELDS ARE OMITTED RATHER THAN DEFAULTED
 * ---------------------------------------------------------------------------
 *
 * The old code also wrote `max_rv_length_feet: … ?? 0`. Zero does not mean
 * "unknown", it means "no RV of any length fits", and a camper filtering for a
 * 30-foot rig would have had the site hidden from them by a number nobody
 * measured. The same trap applies to every amenity here.
 *
 * So a field the curated data does not record is left OUT of the row entirely
 * and the column default applies. Those defaults are themselves not
 * observations, which is exactly why `dataService` does not read the amenity
 * columns back — see the note there. Making the columns nullable so absence
 * can be stored honestly is the real fix and is a migration of its own.
 */
const toCampsiteRow = (site: Campsite) => {
  const a = site.amenities ?? {};

  // Only keys with a real value survive; `undefined` is dropped so Postgres
  // applies the column default rather than us inventing one.
  const defined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(obj).filter(([, value]) => value !== undefined)
    ) as Partial<T>;

  return {
    id: site.id,
    name: site.name,
    land_type: site.landType,
    land_manager: site.landManager ?? '',
    latitude: site.latitude,
    longitude: site.longitude,
    elevation_ft: site.elevationFt ?? null,
    nearest_city: site.address?.nearestCity ?? '',
    state_province: site.address?.stateProvince ?? '',
    country: site.address?.country ?? '',
    address_description: site.address?.description ?? null,
    description: site.description ?? '',
    images: site.images ?? [],
    source: site.source,
    is_published: true,
    ...defined({
      water: a.water,
      toilet: a.toilet,
      road_access: a.roadAccess,
      cell_verizon: a.cellSignal?.verizon,
      cell_att: a.cellSignal?.att,
      cell_tmobile: a.cellSignal?.tmobile,
      max_rv_length_feet: a.maxRvLengthFeet,
      fire_ring: a.fireRing,
      pet_friendly: a.petFriendly,
      trash_service: a.trashService,
      shade: a.shade,
      stay_limit_days: a.stayLimitDays,
      is_free: a.isFree,
      permit_required: a.permitRequired
    })
  };
};

const seedCampsites = async () => {
  const rows = CURATED_CAMPSITES.map(toCampsiteRow);
  if (DRY_RUN) {
    console.log(`  campsites: ${rows.length} would be upserted (dry run)`);
    return;
  }
  const { error } = await supabase.from('campsites').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`campsites upsert failed: ${error.message}`);
  console.log(`  campsites: ${rows.length} upserted`);
};

const syncSourceRegistry = async () => {
  const rows = LAND_SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    attribution: s.attribution,
    service_url: s.url.replace(/\/query$/, ''),
    confidence: s.confidence,
    jurisdiction: s.jurisdiction,
    licence: s.licence,
    edge_accuracy: s.edgeAccuracy,
    camping_basis_kind: s.campingBasisKind,
    is_comprehensive: !/PLUZ|subdivision/i.test(s.notes),
    known_limitations: s.notes,
    notes: s.notes
  }));

  if (DRY_RUN) {
    console.log(`  land_sources: ${rows.length} would be synced (dry run)`);
    return;
  }

  const { error } = await supabase.from('land_sources').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`land_sources upsert failed: ${error.message}`);
  console.log(`  land_sources: ${rows.length} synced`);

  const gapRows = COVERAGE_GAPS.map((g) => ({
    jurisdiction: g.jurisdiction, region: g.region, reason: g.reason
  }));
  const { error: gapErr } = await supabase
    .from('coverage_gaps')
    .upsert(gapRows, { onConflict: 'jurisdiction,region' });
  if (gapErr) console.warn(`  coverage_gaps: ${gapErr.message}`);
  else console.log(`  coverage_gaps: ${gapRows.length} recorded`);
};

/** GeoJSON Polygon -> MultiPolygon so the column type stays uniform. */
const asMultiPolygon = (geom: any): any | null => {
  if (!geom) return null;
  if (geom.type === 'MultiPolygon') return geom;
  if (geom.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [geom.coordinates] };
  return null;
};

const seedSource = async (spec: LandSourceSpec) => {
  console.log(`\n  ${spec.label}`);
  console.log(`    jurisdiction : ${spec.jurisdiction}`);
  console.log(`    edge accuracy: ${spec.edgeAccuracy}`);
  console.log(`    camping basis: ${spec.campingBasisKind}`);

  let runId: string | null = null;
  if (!DRY_RUN) {
    const { data, error } = await supabase
      .from('extraction_runs')
      .insert({ source_id: spec.id })
      .select('id')
      .single();
    if (error) console.warn(`    could not open audit run: ${error.message}`);
    else runId = data.id;
  }

  let stored = 0;
  let rejected = 0;
  let campable = 0;
  const seenExternal = new Set<string>();
  // Bounding box of every campable feature actually stored this run. The
  // coverage claim must reflect where the data REALLY is — a nominal spec
  // bbox can include ocean or unmapped fringe, and the server treats a
  // covered viewport as "this source is answered from storage, do not
  // consult the live service at all".
  const extent = {
    minLat: Infinity,
    minLon: Infinity,
    maxLat: -Infinity,
    maxLon: -Infinity
  };
  const extendExtent = (geom: any) => {
    if (!geom || !Array.isArray(geom?.coordinates)) return;
    const polys =
      geom.type === 'Polygon'
        ? [geom.coordinates]
        : geom.type === 'MultiPolygon'
          ? geom.coordinates
          : [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < extent.minLon) extent.minLon = lon;
          if (lon > extent.maxLon) extent.maxLon = lon;
          if (lat < extent.minLat) extent.minLat = lat;
          if (lat > extent.maxLat) extent.maxLat = lat;
        }
      }
    }
  };

  const handleFeatures = async (features: any[]) => {
    const rows = features
      .map((f) => {
        const props = f.properties ?? {};

        // Camping-eligibility gate. Null => never reaches the database.
        const basis = spec.campingBasis(props);
        if (!basis) { rejected += 1; return null; }

        const geom = asMultiPolygon(f.geometry);
        if (!geom) { rejected += 1; return null; }

        const externalId = spec.externalId(props);
        if (seenExternal.has(externalId)) return null;
        seenExternal.add(externalId);

        // Gate passed and this feature is new: it counts toward the coverage
        // claim, and its geometry bounds the claim.
        campable += 1;
        extendExtent(f.geometry);

        const permit = spec.permit(props);
        return {
          source_id: spec.id,
          external_id: externalId,
          name: spec.name(props),
          designation: spec.designation(props),
          confidence: spec.confidence,
          edge_accuracy: spec.edgeAccuracy,
          camping_basis_kind: spec.campingBasisKind,
          jurisdiction: spec.jurisdiction,
          camping_allowed: true,
          general_use_basis: basis,
          stay_limit_days: spec.stayLimitDays(props),
          permit_required: permit.required,
          permit_name: permit.name,
          extraction_run_id: runId,
          geom
        };
      })
      .filter(Boolean) as any[];

    if (rows.length === 0) return;
    if (DRY_RUN) { stored += rows.length; return; }

    // Small batches: polygon geometry payloads get large fast.
    for (let i = 0; i < rows.length; i += 25) {
      const chunk = rows.slice(i, i + 25);
      const { error } = await supabase
        .from('public_lands')
        .upsert(chunk, { onConflict: 'source_id,external_id' });
      if (error) console.warn(`    upsert warning: ${error.message}`);
      else stored += chunk.length;
    }
  };

  let lastLog = Date.now();

  /*
   * A file source is one download, not a tile walk. Everything downstream —
   * the camping gate, the geometry check, the upsert, the audit row — is
   * identical, so the two paths only differ in how the features arrive.
   */
  const stats: FetchStats = spec.kind === 'geojson'
    ? await fetchGeoJsonFile(spec.url, handleFeatures)
    : await fetchAllTiled(
    {
      url: spec.url,
      where: spec.where,
      outFields: spec.outFields,
      bbox: { minLon: spec.bbox[0], minLat: spec.bbox[1], maxLon: spec.bbox[2], maxLat: spec.bbox[3] },
      maxRecordCount: spec.maxRecordCount,
      // ~50 m simplification: keeps national geometry a sane size while
      // staying well inside this data's real accuracy anyway.
      maxAllowableOffset: 0.0005,
      concurrency: 3,
      onProgress: (s) => {
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          process.stdout.write(
            `\r    tiles ${s.tilesQueried} (${s.tilesSubdivided} split) · features ${s.uniqueFeatures} · stored ${stored} · rejected ${rejected}   `
          );
        }
      }
    },
    handleFeatures
      );

  process.stdout.write('\r' + ' '.repeat(100) + '\r');

  const complete = !stats.truncationSuspected && stats.errors === 0;

  console.log(`    tiles queried    : ${stats.tilesQueried} (${stats.tilesSubdivided} subdivided)`);
  console.log(`    features seen    : ${stats.uniqueFeatures}`);
  console.log(`    stored (campable): ${stored}`);
  console.log(`    rejected         : ${rejected}`);
  console.log(`    errors           : ${stats.errors}`);
  console.log(`    completeness     : ${complete ? 'VERIFIED — no tile hit the record cap' : 'NOT VERIFIED — extract may be partial'}`);

  if (!DRY_RUN && runId) {
    await supabase.from('extraction_runs').update({
      finished_at: new Date().toISOString(),
      tiles_queried: stats.tilesQueried,
      tiles_subdivided: stats.tilesSubdivided,
      features_fetched: stats.featuresFetched,
      unique_features: stats.uniqueFeatures,
      features_stored: stored,
      features_rejected: rejected,
      errors: stats.errors,
      completeness_verified: complete,
      notes: stats.truncationSuspected
        ? 'A tile still exceeded the record cap at maximum recursion depth; extract may be partial.'
        : null
    }).eq('id', runId);

    await supabase.from('land_sources')
      .update({ last_synced: new Date().toISOString() })
      .eq('id', spec.id);
  }

  /*
   * THE COVERAGE CLAIM — the part that makes the stored path real for users.
   *
   * The server only answers a viewport from `public_lands` when
   * `land_sources_covering` says this source's stored coverage CONTAINS the
   * whole viewport. Without a claim, every request still goes live to the
   * government service — which is exactly the slowness this seeding exists
   * to kill. So after a verified-complete run, claim the full extent of the
   * campable data actually stored this run. Three gates, mirroring the
   * server's own `storeSourceParcels` rule (never claim coverage over land
   * that was dropped or not verified):
   *
   *   1. complete          — no tile hit the record cap, no fetch errors
   *   2. stored === campable — every gate-passing feature was upserted
   *      without error (upsert warnings skip the chunk, so a mismatch here
   *      means data was silently dropped)
   *   3. campable > 0      — a claim over an empty extent would be nonsense
   */
  if (!DRY_RUN && complete && stored === campable && campable > 0) {
    const { error } = await supabase.rpc('record_land_coverage', {
      in_source_id: spec.id,
      in_min_lat: extent.minLat,
      in_min_lon: extent.minLon,
      in_max_lat: extent.maxLat,
      in_max_lon: extent.maxLon
    });
    if (error) {
      console.warn(`    coverage NOT recorded: ${error.message}`);
    } else {
      console.log(
        `    coverage recorded   : ${spec.id} ` +
          `(${extent.minLon.toFixed(2)}, ${extent.minLat.toFixed(2)}) → ` +
          `(${extent.maxLon.toFixed(2)}, ${extent.maxLat.toFixed(2)})`
      );
    }
  } else if (!DRY_RUN) {
    const why = !complete
      ? 'extract not verified complete'
      : stored !== campable
        ? `stored ${stored} ≠ campable ${campable} — some parcels were dropped`
        : 'no campable features — nothing to claim';
    console.warn(`    coverage SKIPPED     : ${why}`);
  }
};

const seedLands = async () => {
  const targets = ONLY_SOURCE ? LAND_SOURCES.filter((s) => s.id === ONLY_SOURCE) : LAND_SOURCES;

  if (targets.length === 0) {
    console.error(`No source matching "${ONLY_SOURCE}". Available:`);
    LAND_SOURCES.forEach((s) => console.error(`  ${s.id}`));
    process.exit(1);
  }

  for (const spec of targets) {
    try {
      await seedSource(spec);
    } catch (err: any) {
      console.error(`\n    FAILED: ${err.message}`);
    }
  }
};

const main = async () => {
  const only = args.find((a) => a === '--sites' || a === '--lands');
  console.log('Seeding Wandrlust' + (DRY_RUN ? ' (DRY RUN — no writes)' : '') + '\n');

  await syncSourceRegistry();
  if (only !== '--lands') await seedCampsites();
  if (only !== '--sites') await seedLands();

  if (!only && !DRY_RUN) {
    const { error } = await supabase.rpc('reverify_campsites');
    if (error) console.warn(`\n  reverify skipped: ${error.message}`);
    else console.log('\n  campsite land verification refreshed');
  }

  console.log('\nDone.');
  console.log('Check data quality with:  select * from public.data_quality_report();');
};

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
