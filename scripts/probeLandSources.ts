/**
 * Check every configured land source against the live service, before trusting it.
 *
 *   npm run probe                      # every source
 *   npm run probe -- --source=alberta_green_area
 *
 * WHY THIS EXISTS
 *
 * `boundaryRoutes.ts` opens with a warning learned the hard way: a wrong field
 * name or a filter that matches nothing does not error. ArcGIS returns HTTP 200
 * with an empty feature array, the seeder stores zero rows, and the map shows a
 * region with no public land in it. That is indistinguishable from "there is no
 * public land here", which for this app is the worst thing it can say.
 *
 * So rather than trusting a URL because it looked right, this asks the service
 * four questions per source:
 *
 *   1. Does the layer exist, and what is it actually called?
 *   2. Does every field named in `outFields` exist on it? (the silent killer)
 *   3. Does the `where` filter match anything at all?
 *   4. How much of the layer does the filter select? A filter matching 100% of
 *      rows usually means it was ignored; one matching 0% is broken.
 *
 * Anything that fails here would have failed silently during a seed run.
 */
import { LAND_SOURCES, LandSourceSpec } from './landSources.js';

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith('--source='))?.split('=')[1];
const TIMEOUT_MS = 25_000;

export interface ProbeResult {
  id: string;
  ok: boolean;
  layerName?: string;
  geometryType?: string;
  serverMaxRecordCount?: number;
  missingFields: string[];
  matched?: number;
  total?: number;
  problems: string[];
}

const getJson = async (url: string): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Wandrlust-probe/1.0' },
      signal: controller.signal
    });
    if (!res.ok) return { __httpError: res.status };
    return await res.json();
  } catch (err) {
    return { __networkError: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

/** `.../FeatureServer/0/query` -> `.../FeatureServer/0` */
const layerUrl = (queryUrl: string): string => queryUrl.replace(/\/query\/?$/, '');

const countUrl = (spec: LandSourceSpec, where: string): string => {
  const params = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  return `${spec.url}?${params.toString()}`;
};

export const probeSource = async (spec: LandSourceSpec): Promise<ProbeResult> => {
  const result: ProbeResult = { id: spec.id, ok: false, missingFields: [], problems: [] };

  // 1. The layer itself.
  const meta = await getJson(`${layerUrl(spec.url)}?f=json`);
  if (meta.__networkError) {
    result.problems.push(`unreachable: ${meta.__networkError}`);
    return result;
  }
  if (meta.__httpError) {
    result.problems.push(`layer metadata returned HTTP ${meta.__httpError}`);
    return result;
  }
  if (meta.error) {
    result.problems.push(`service error: ${meta.error?.message ?? 'unknown'}`);
    return result;
  }

  result.layerName = meta.name;
  result.geometryType = meta.geometryType;
  result.serverMaxRecordCount = meta.maxRecordCount;

  if (meta.geometryType && !/Polygon/i.test(meta.geometryType)) {
    result.problems.push(
      `geometry is ${meta.geometryType}; this pipeline stores MultiPolygon only`
    );
  }

  // A layer whose real cap is lower than we assume means the tiler's
  // completeness check is calibrated wrong and may under-subdivide.
  if (
    typeof meta.maxRecordCount === 'number' &&
    meta.maxRecordCount < spec.maxRecordCount
  ) {
    result.problems.push(
      `spec assumes maxRecordCount ${spec.maxRecordCount}, service caps at ${meta.maxRecordCount}`
    );
  }

  // 2. Field names. This is the one that fails silently.
  const fields: string[] = Array.isArray(meta.fields)
    ? meta.fields.map((f: any) => String(f.name))
    : [];
  const lowered = new Set(fields.map((f) => f.toLowerCase()));

  if (spec.outFields !== '*' && fields.length > 0) {
    for (const wanted of spec.outFields.split(',').map((f) => f.trim()).filter(Boolean)) {
      if (!lowered.has(wanted.toLowerCase())) result.missingFields.push(wanted);
    }
    if (result.missingFields.length > 0) {
      result.problems.push(`outFields not on the layer: ${result.missingFields.join(', ')}`);
    }
  }

  // 3 & 4. Does the filter select a sane share of the layer?
  const [filtered, all] = await Promise.all([
    getJson(countUrl(spec, spec.where)),
    getJson(countUrl(spec, '1=1'))
  ]);

  if (typeof filtered?.count === 'number') result.matched = filtered.count;
  if (typeof all?.count === 'number') result.total = all.count;

  if (filtered?.error) {
    result.problems.push(`where clause rejected: ${filtered.error?.message ?? 'unknown'}`);
  } else if (result.matched === 0) {
    result.problems.push('where clause matched 0 features — the filter or a field name is wrong');
  } else if (
    result.matched !== undefined &&
    result.total !== undefined &&
    spec.where !== '1=1' &&
    result.matched === result.total &&
    result.total > 0
  ) {
    result.problems.push(
      'where clause matched every feature — it may have been ignored by the service'
    );
  }

  result.ok = result.problems.length === 0;
  return result;
};

const format = (r: ProbeResult): string => {
  const head = `${r.ok ? 'OK  ' : 'FAIL'}  ${r.id}`;
  const bits: string[] = [];
  if (r.layerName) bits.push(`layer "${r.layerName}"`);
  if (r.geometryType) bits.push(r.geometryType);
  if (r.matched !== undefined) {
    bits.push(
      r.total !== undefined
        ? `${r.matched.toLocaleString()} of ${r.total.toLocaleString()} features match`
        : `${r.matched.toLocaleString()} features match`
    );
  }
  if (r.serverMaxRecordCount) bits.push(`cap ${r.serverMaxRecordCount}`);

  const detail = bits.length ? `\n        ${bits.join(' · ')}` : '';
  const problems = r.problems.map((p) => `\n        ! ${p}`).join('');
  return head + detail + problems;
};

const main = async (): Promise<void> => {
  const sources = LAND_SOURCES.filter((s) => !ONLY || s.id === ONLY);
  if (sources.length === 0) {
    console.error(`No source matches --source=${ONLY}`);
    process.exit(1);
  }

  console.log(`Probing ${sources.length} land source${sources.length === 1 ? '' : 's'}\n`);

  const results: ProbeResult[] = [];
  // Sequential on purpose: these are public government services.
  for (const spec of sources) {
    const result = await probeSource(spec);
    results.push(result);
    console.log(format(result));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} usable`);

  if (failed.length > 0) {
    console.log(
      '\nA failing source must be fixed before seeding. It will not error during a\n' +
        'seed run — it will quietly store nothing, and the map will show that region\n' +
        'as having no public land.'
    );
    process.exit(1);
  }
};

// Only run when invoked directly, so the probe can be imported and tested.
if (process.argv[1] && process.argv[1].includes('probeLandSources')) {
  main().catch((err) => {
    console.error('Probe failed:', err);
    process.exit(1);
  });
}
