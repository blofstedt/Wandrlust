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
import { LAND_SOURCES, CANDIDATE_SOURCES, LandSourceSpec } from './landSources.js';

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith('--source='))?.split('=')[1];
const CANDIDATES = args.includes('--candidates');
const TIMEOUT_MS = 25_000;

export interface ProbeResult {
  id: string;
  ok: boolean;
  layerName?: string;
  geometryType?: string;
  serverMaxRecordCount?: number;
  /** What the layer actually calls its attributes. */
  fields?: string[];
  /** How the spec labels the first feature — the guessed name fields, tested. */
  sample?: string;
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

/**
 * The same four questions, asked of an OGC service instead of an ArcGIS one.
 *
 * A WFS has no layer-metadata document to read and no `returnCountOnly`, so
 * this asks it for ONE feature and reads the answer: `numberMatched` says how
 * many the layer holds, the geometry says whether they are areas, and the
 * property names are the thing that matters most — the spec has to guess field
 * names from a distance, and a name field guessed wrong is the silent failure
 * that had all fifteen Manitoba forests labelled "Provincial Forest".
 */
const probeWfsSource = async (spec: LandSourceSpec): Promise<ProbeResult> => {
  const result: ProbeResult = { id: spec.id, ok: false, missingFields: [], problems: [] };

  const url = `${spec.url}${spec.url.includes('?') ? '&' : '?'}count=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let body: string;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/geo+json, application/json' },
      signal: controller.signal
    });
    body = await res.text();
    if (!res.ok) {
      result.problems.push(`HTTP ${res.status}: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
      return result;
    }
  } catch (err) {
    result.problems.push(`unreachable: ${(err as Error).message}`);
    return result;
  } finally {
    clearTimeout(timer);
  }

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    // GeoServer reports a bad feature type as an XML ExceptionReport with a
    // 200, which is exactly the silent-empty shape this file exists to catch.
    result.problems.push(
      `answered with something that is not JSON — probably an OGC exception: ` +
        body.slice(0, 300).replace(/\s+/g, ' ')
    );
    return result;
  }

  if (!Array.isArray(data?.features)) {
    result.problems.push(
      `no feature array in the response (keys: ${Object.keys(data ?? {}).join(', ') || 'none'})`
    );
    return result;
  }

  result.layerName = String(data.name ?? spec.url.match(/typeNames?=([^&]+)/i)?.[1] ?? 'unnamed');
  if (typeof data.numberMatched === 'number') result.total = data.numberMatched;
  result.matched = result.total;

  const sample = data.features[0];
  if (!sample) {
    result.problems.push('the layer answered with zero features — treat it as UNCONFIRMED');
    return result;
  }

  result.geometryType = String(sample?.geometry?.type ?? 'none');
  if (!/^(Multi)?Polygon$/.test(result.geometryType)) {
    result.problems.push(
      `geometry is ${result.geometryType}; this pipeline stores MultiPolygon only`
    );
  }

  result.fields = Object.keys(sample?.properties ?? {});
  if (result.fields.length === 0) result.problems.push('features carry no attributes at all');

  // Does the spec's own naming actually find anything, or does every feature
  // fall through to its bare fallback?
  const named = spec.name(sample.properties ?? {});
  const designation = spec.designation(sample.properties ?? {});
  if (!named) result.problems.push('name() returned nothing for the sample feature');

  // The coordinates say whether the CRS request was honoured. Degrees inside
  // the spec\'s own bbox, or this is answering in a projection.
  let node: any = sample?.geometry?.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
  if (Array.isArray(node) && typeof node[0] === 'number') {
    const [x, y] = node;
    const inBox =
      x >= spec.bbox[0] - 3 && x <= spec.bbox[2] + 3 && y >= spec.bbox[1] - 3 && y <= spec.bbox[3] + 3;
    if (!inBox) {
      result.problems.push(
        `first vertex is ${x}, ${y} — not longitude/latitude inside this source's bbox`
      );
    }
  }

  result.sample = `${named} · ${designation}`;
  result.ok = result.problems.length === 0;
  return result;
};

export const probeSource = async (spec: LandSourceSpec): Promise<ProbeResult> => {
  const result: ProbeResult = { id: spec.id, ok: false, missingFields: [], problems: [] };

  /*
   * A file source has no layer metadata to interrogate. When it is a WFS —
   * which is how British Columbia publishes — the service can still answer all
   * four questions from a single feature; when it is a plain download or a
   * path on disk, there is nothing to ask and the seed run itself is the check.
   */
  if (spec.kind === 'geojson') {
    if (/service=wfs/i.test(spec.url)) return probeWfsSource(spec);
    result.problems.push('file source — not probed here; run the seeder with --dry-run instead');
    return result;
  }

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
  if (r.sample) bits.push(`first feature reads "${r.sample}"`);
  if (r.fields?.length) bits.push(`fields ${r.fields.join(', ')}`);

  const detail = bits.length ? `\n        ${bits.join(' · ')}` : '';
  const problems = r.problems.map((p) => `\n        ! ${p}`).join('');
  return head + detail + problems;
};

/**
 * Report on the researched leads that are not wired into the seeder.
 *
 * Only asks each service what it is — layer name, geometry, feature count —
 * because the question they actually fail on is semantic, not technical:
 * a lease layer answers perfectly and is still the wrong data.
 */
const reportCandidates = async (): Promise<void> => {
  console.log(`${CANDIDATE_SOURCES.length} researched leads, none wired into the seeder\n`);

  for (const c of CANDIDATE_SOURCES) {
    console.log(`${c.jurisdiction}  ${c.region}`);
    console.log(`        ${c.url}`);
    console.log(`        appears to be : ${c.appearsToBe}`);
    console.log(`        must confirm  : ${c.mustConfirm}`);

    if (/\/(MapServer|FeatureServer)(\/\d+)?\/?$/.test(c.url)) {
      const meta = await getJson(`${c.url}?f=json`);
      if (meta.__networkError) console.log(`        live check    : unreachable (${meta.__networkError})`);
      else if (meta.__httpError) console.log(`        live check    : HTTP ${meta.__httpError}`);
      else if (meta.error) console.log(`        live check    : ${meta.error?.message}`);
      else {
        const layers = Array.isArray(meta.layers)
          ? meta.layers.map((l: any) => `${l.id}:${l.name}`).join(', ')
          : null;
        console.log(
          `        live check    : "${meta.name ?? meta.mapName ?? 'unnamed'}"` +
            (meta.geometryType ? ` · ${meta.geometryType}` : '') +
            (layers ? `\n        layers        : ${layers}` : '')
        );
      }
    } else {
      console.log('        live check    : not a REST service URL — open it by hand');
    }
    console.log('');
  }

  console.log(
    'A lead that answers cleanly is still not usable until someone confirms it is\n' +
      'LAND rather than what has been done to it. A grazing lease is Crown-owned and\n' +
      'is not somewhere anyone may camp.'
  );
};

const main = async (): Promise<void> => {
  if (CANDIDATES) return reportCandidates();

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
