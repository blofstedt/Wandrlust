/**
 * Where Beacon's evidence comes from.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * Beacon answers "could I sleep near here?" from two free, keyless-or-nearly
 * sources. Neither of them knows whether you may legally park somewhere. What
 * they know is narrower and worth stating exactly:
 *
 *   OPENSTREETMAP, through Overpass. Who a piece of land appears to belong to
 *   (`boundary=protected_area`, `landuse=military`, `access=private`), what the
 *   roads around it are, and where the compact, point-like features are that a
 *   coordinate can honestly describe — a parking area, a passing place, a rest
 *   area. No key, no registration. This is the source that works on a
 *   deployment with no configuration at all.
 *
 *   MAPILLARY, when MAPILLARY_TOKEN is set. Not imagery — DETECTIONS. Mapillary
 *   runs its own computer vision over every image it holds and publishes the
 *   traffic signs it found as plain point features. So the "check the signage"
 *   step is one JSON request for a bounding box, not a gigabyte of model
 *   weights and a GPU. The token is free and takes no payment details.
 *
 * WHAT NEITHER OF THEM IS: a statement of the law. Camping and overnight
 * parking rules are municipal, seasonal, and frequently posted on a sign that
 * exists in no database at all. Everything this module produces is a lead for a
 * human to check, and the word "lead" is doing real work.
 *
 * THREE RULES THIS FILE FOLLOWS
 *
 *   1. A CANDIDATE'S COORDINATE MUST MEAN SOMETHING. Only compact, point-like
 *      features become candidates. A 4 km winding forest road has a centroid,
 *      and that centroid is very often in a river — so roads inform a candidate
 *      and never become one. Sending somebody to a made-up coordinate is the
 *      exact failure the removed AI-campsite endpoint was removed for.
 *
 *   2. ABSENCE OF A SIGN IS NOT ABSENCE OF A RULE. "Mapillary found no
 *      no-parking sign" only means something where Mapillary has looked. So
 *      imagery density is measured and carried, and a clear reading is only
 *      awarded where there was enough coverage for clear to be informative.
 *
 *   3. NOTHING HERE THROWS. Every fetch resolves to a result object with an
 *      `ok` flag and a plain-English `note`. A source that is down produces a
 *      thinner answer that says it is thinner — never an empty map that looks
 *      confident.
 */
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { USER_AGENT } from './alertSources.js';

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type BeaconGenerator = 'public_land' | 'urban';
export type SignEvidence = 'unknown' | 'clear' | 'restricted';

/**
 * A feature token.
 *
 * These strings are the model's feature names, stored on every spot and
 * tallied in `beacon_signals`. RENAMING ONE THROWS AWAY EVERYTHING THE APP
 * HAS LEARNED ABOUT IT — the old token keeps its counts and the new one starts
 * at zero. Add freely; rename never.
 */
export type Token = string;

export interface Candidate {
  lat: number;
  lon: number;
  generator: BeaconGenerator;
  /** What the place is, in the words a camper would use. */
  label: string;
  /** Why we think you might be allowed to stay. Shown verbatim. */
  landBasis: string;
  tokens: Token[];
  ruleScore: number;
  signEvidence: SignEvidence;
}

export interface SourceNote {
  ok: boolean;
  note?: string;
}

/**
 * The same agent string the weather feeds are given, and for the same reason.
 *
 * OpenStreetMap's Overpass instances and Mapillary both ask callers to
 * identify themselves, and Overpass in particular is quick to refuse traffic
 * it cannot attribute — it is a volunteer-funded service being asked to run
 * arbitrary queries. What this used to send was the placeholder
 * `'wandrlust-app (contact: set NWS_USER_AGENT in .env)'`, because the env var
 * it read has never been set on any deployment. See USER_AGENT in
 * server/alertSources.ts.
 */
const UA = USER_AGENT;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const metresBetween = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

type Ring = { lat: number; lon: number }[];

/**
 * Ray casting, written out here rather than imported from `src/utils/geo.ts`.
 *
 * The server bundle and the client bundle are built separately and this module
 * is meant to be liftable on its own; a twenty-line function is a cheaper price
 * than a cross-bundle import.
 */
const pointInRing = (lat: number, lon: number, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    const straddles = (yi > lat) !== (yj > lat);
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/* ------------------------------------------------------------------ */
/* Overpass                                                            */
/* ------------------------------------------------------------------ */

/**
 * Mirrors, fastest-and-least-rationed FIRST.
 *
 * `overpass-api.de` used to lead this list and it is the reason Beacon
 * returned "could not reach OpenStreetMap" on every scan. It is the main
 * public instance, it rations by client IP, and a serverless deployment shares
 * its address with everybody else on that machine — so this app arrives
 * already near the limit and gets put in a queue. Production logs showed the
 * whole thing plainly:
 *
 *   [beacon] every Overpass mirror refused —
 *     overpass-api.de: timed out | overpass.kumi.systems: no time left
 *
 * The lead mirror sat in a queue until the budget ran out and the two behind
 * it — the ones that exist for exactly this — were never asked. `kumi.systems`
 * is a donated high-capacity instance that answers a 500 m query in about a
 * second, so it goes first now.
 *
 * The order matters much less than it did, because the mirrors are now HEDGED
 * rather than tried one after another. See `fetchOverpassScan`.
 */
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

/**
 * How long a mirror gets to itself before the next one is asked ALONGSIDE it.
 *
 * Not a timeout — the first mirror is not cancelled when this elapses, it just
 * stops being the only hope. A healthy Overpass answers a 500 m query well
 * inside this, so the usual scan still sends exactly one query and the other
 * mirrors are never contacted at all. Only a slow or queued lead mirror costs
 * the commons a second request, which is the case the fallbacks exist for.
 */
const HEDGE_DELAY_MS = 2_500;

/** A pause that gives up the moment the scan is over. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OverpassScan extends SourceNote {
  /** Land polygons, with geometry, for ownership and exclusion tests. */
  areas: OverpassElement[];
  /** Roads, with geometry, used as context for a candidate — never as one. */
  roads: OverpassElement[];
  /** Compact features whose centre is a coordinate worth sending someone to. */
  features: OverpassElement[];
  /**
   * Viewpoints, peaks, water and settlements.
   *
   * Never candidates — you do not sleep on a summit marker. These are what a
   * candidate is scored AGAINST: the first three are why a spot is worth
   * having, the last is why it is risky.
   */
  context: OverpassElement[];
  /**
   * Small open patches — grassland, heath, scrub, meadow, recreation ground.
   *
   * Carried separately from `features` because they arrive WITH geometry and
   * have to be measured before their centre can be used, and separately from
   * `areas` because a meadow is not a statement about who owns the ground.
   */
  clearings: OverpassElement[];
}

const EMPTY_SCAN: OverpassScan = {
  ok: false, areas: [], roads: [], features: [], context: [], clearings: []
};

/**
 * One request, three result sets.
 *
 * Overpass allows several `out` statements with different modes in a single
 * query, so the polygons come back with full geometry (needed for
 * point-in-polygon), the roads come back with geometry (needed for "is there
 * road access within 120 m"), and the compact candidate features come back as
 * centres. Three round trips collapsed into one matters when the whole request
 * has a twelve-second budget.
 */
const buildQuery = (lat: number, lon: number, radiusM: number, timeoutS: number): string => {
  const around = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})`;

  const areas = [
    `way["boundary"="protected_area"]${around};`,
    `relation["boundary"="protected_area"]${around};`,
    `way["landuse"~"^(forest|military|residential|industrial)$"]${around};`,
    `way["leisure"~"^(park|nature_reserve)$"]${around};`,
    `way["access"~"^(private|no)$"]${around};`
  ].join('');

  const roads = [
    `way["highway"~"^(track|unclassified|service|residential|tertiary|secondary)$"]${around};`
  ].join('');

  // Compact features only. See rule 1 in the file header.
  const features = [
    `node["amenity"="parking"]${around};`,
    `way["amenity"="parking"]${around};`,
    `node["amenity"="parking_space"]${around};`,
    `node["highway"="rest_area"]${around};`,
    `way["highway"="rest_area"]${around};`,
    `way["highway"="services"]${around};`,
    `node["highway"="passing_place"]${around};`,
    `node["highway"="turning_circle"]${around};`,
    `node["highway"="turning_loop"]${around};`,
    `node["tourism"="camp_site"]${around};`,
    `way["tourism"="camp_site"]${around};`,
    /* A picnic site on a forest road IS the pull-off — a widening with a table
       on it. One of the commonest shapes a dispersed spot actually takes, and
       it was not being asked for at all. */
    `node["tourism"="picnic_site"]${around};`,
    `way["tourism"="picnic_site"]${around};`
  ].join('');

  /**
   * CLEARINGS, and the one place this file bends its own first rule.
   *
   * Rule 1 in the header says only compact, point-like features become
   * candidates, because the centroid of a sprawling polygon is meaningless
   * and often in a river. That rule was written about 4 km forest roads and
   * it is right about them.
   *
   * A SMALL clearing is the opposite case: a two-hundred-metre patch of
   * grassland off a track has a centre that means exactly what a camper
   * thinks it means, and it is one of the things they are actually looking
   * for. So these are fetched WITH GEOMETRY, measured, and only kept when
   * they are small enough for the centre to be honest — see `MAX_CLEARING_M`.
   * A big one is dropped rather than pinned at its middle.
   */
  const clearings = [
    `way["natural"~"^(grassland|heath|scrub)$"]${around};`,
    `way["landuse"~"^(meadow|recreation_ground)$"]${around};`
  ].join('');

  /**
   * What makes a spot WORTH having, and what makes it RISKY.
   *
   * Neither of these was ever asked for, which is why the scan could only
   * rank places by their paperwork. A free parking area on unmapped ground
   * beside a track scored exactly as well as a pullout on a ridge over a
   * lake, because nothing in the query knew the ridge or the lake were
   * there. So the map filled up with car parks.
   *
   * Viewpoints, peaks and water are the view. Settlements are the risk: the
   * single best predictor of being moved on at 2am is how close you are to
   * people who did not expect you.
   */
  const context = [
    `node["tourism"="viewpoint"]${around};`,
    `node["natural"="peak"]${around};`,
    `way["natural"="water"]${around};`,
    `way["waterway"="riverbank"]${around};`,
    `node["place"~"^(city|town|village|hamlet|suburb)$"]${around};`
  ].join('');

  /*
   * `[timeout:N]` IS A PROMISE IN BOTH DIRECTIONS, AND IT WAS LYING.
   *
   * It was hardcoded to 25 seconds while the caller hung up at eleven. That is
   * the worst of both: Overpass schedules the query against a generous budget
   * and keeps working on it long after we have stopped listening, so we pay
   * for the wait, get nothing, and leave a server that rations its capacity by
   * declared cost running a query for a client that has gone. Telling it what
   * we will actually wait for makes it likelier to be scheduled promptly and
   * lets it give up when we would.
   */
  return (
    `[out:json][timeout:${Math.max(5, Math.round(timeoutS))}];` +
    `(${areas});out geom 150;` +
    `(${roads});out geom 250;` +
    `(${features});out center 150;` +
    `(${context});out center 120;` +
    // Geometry, not centres: a clearing has to be MEASURED before its centre
    // can be trusted, and `out center` throws away the shape that decides it.
    `(${clearings});out geom 80;`
  );
};

/**
 * Sort the flat element list back into the three groups.
 *
 * Overpass concatenates the result sets, so they are told apart by their tags
 * rather than by position — which is also what makes the function robust to a
 * mirror reordering them.
 */
const sortElements = (elements: OverpassElement[]): Omit<OverpassScan, keyof SourceNote> => {
  const areas: OverpassElement[] = [];
  const roads: OverpassElement[] = [];
  const features: OverpassElement[] = [];
  const context: OverpassElement[] = [];
  const clearings: OverpassElement[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    /* Clearings before everything: `natural=grassland` carries no highway,
       amenity or place tag, so without this it lands in `areas` and gets
       tested as an ownership boundary — which it is not. */
    if (
      /^(grassland|heath|scrub)$/.test(tags.natural ?? '') ||
      /^(meadow|recreation_ground)$/.test(tags.landuse ?? '')
    ) {
      clearings.push(el);
    } else if (
      tags.tourism === 'viewpoint' || tags.natural === 'peak' ||
      tags.natural === 'water' || tags.waterway === 'riverbank' || tags.place
    ) {
      context.push(el);
    } else if (tags.highway && !['rest_area', 'services', 'passing_place', 'turning_circle'].includes(tags.highway)) {
      roads.push(el);
    } else if (tags.amenity === 'parking' || tags.amenity === 'parking_space' ||
               tags.tourism === 'camp_site' || tags.highway) {
      features.push(el);
    } else {
      areas.push(el);
    }
  }
  return { areas, roads, features, context, clearings };
};

/**
 * THE MIRRORS ARE HEDGED, NOT QUEUED, AND THAT IS THE WHOLE FIX.
 *
 * `timeoutMs` is the budget for the WHOLE call. It always was — the previous
 * version cut a slice of it for each mirror and worked through them one at a
 * time, which is the arrangement that made Beacon say "could not reach
 * OpenStreetMap" on every single scan. Production said so in as many words:
 *
 *   [beacon] every Overpass mirror refused —
 *     overpass-api.de: timed out | overpass.kumi.systems: no time left
 *
 * Read that twice. The lead mirror was queued and burnt its slice. Coming out
 * of it there was less than one round trip left, so the loop gave up and the
 * two healthy mirrors behind it were NEVER CONTACTED. Every fallback in the
 * list was unaffordable by the time it was reached. A fallback you cannot
 * afford to call is not a fallback — the old comment said exactly that about
 * the bug before it, and the slicing rewrite reintroduced it in a new shape.
 *
 * Serial retry is the wrong structure here. It is right when the fallbacks are
 * WORSE — try the good source, settle for the poor one — but these three are
 * interchangeable: same database, same query, same answer. There is nothing to
 * prefer and therefore nothing to wait for. So the first mirror is asked, and
 * if it has not answered within HEDGE_DELAY_MS the second is asked ALONGSIDE
 * it, then the third. First good answer wins and cancels the rest.
 *
 * WHY THIS IS NOT JUST FIRING THREE QUERIES AT A VOLUNTEER SERVICE. A healthy
 * mirror answers the 500 m rung in about a second, so the ordinary scan sends
 * one query and the hedges never start. A second request goes out only when
 * the first has already gone quiet — the situation the mirror list exists for
 * — and the losers are aborted the moment a winner lands, which Overpass
 * honours by dropping the query.
 *
 * Overpass is told our budget too (see `[timeout:N]` in buildQuery), so a
 * mirror is never left working on a query nobody is waiting for.
 */
export const fetchOverpassScan = async (
  lat: number,
  lon: number,
  radiusM: number,
  timeoutMs = 11_000
): Promise<OverpassScan> => {
  const budget = Math.max(0, Math.round(timeoutMs));

  /**
   * Under three seconds there is no point starting: Overpass has to parse,
   * schedule and run the query before a byte comes back. Said plainly in the
   * log, because "no time left" is a different fault from "the mirror is down"
   * and the fix for it is upstream of this file.
   */
  if (budget < 3_000) {
    console.warn(`[beacon] Overpass not asked — only ${budget} ms of budget left`);
    return {
      ...EMPTY_SCAN,
      note: 'Could not reach OpenStreetMap just now, so nothing was scanned here.'
    };
  }

  /**
   * What each mirror said, for the log.
   *
   * "Could not reach OpenStreetMap" was every failure spelled the same way —
   * a refusal, a rate limit, a timeout and a query the server rejected all
   * looked identical, so a mirror that had been turning this deployment away
   * for its whole life could only be diagnosed by guessing. The camper still
   * reads one plain sentence; this is for whoever has to fix it.
   */
  const tried: string[] = [];

  /**
   * One signal for the lot: the shared deadline, and the winner, both end it.
   *
   * This is also what stops a hedge outliving the answer. A mirror that comes
   * second is aborted mid-flight rather than left to finish into nothing.
   */
  const done = new AbortController();
  const deadline = setTimeout(() => done.abort(), budget);
  const query = buildQuery(lat, lon, radiusM, budget / 1000);

  /**
   * A MIRROR THAT SAYS NO IMMEDIATELY MUST NOT COST THE NEXT ONE ITS STAGGER.
   *
   * The hedge delay is there to avoid bothering a second mirror while the
   * first might still be about to answer. A 429, a 504 or a refused connection
   * settles that question in milliseconds — there is nothing left to wait for,
   * and sitting out the rest of the stagger would burn two and a half seconds
   * of a budget that is already tight. So a failure hands its turn straight to
   * whoever is next in the queue.
   *
   * FIFO, and each waiter takes itself out of the queue whichever way it
   * starts, so handing the turn on never lands on a mirror that is already
   * running and leaves a genuinely waiting one asleep.
   */
  const waiting: { go: () => void }[] = [];
  const handTurnOn = () => waiting.shift()?.go();

  const waitTurn = (index: number): Promise<void> =>
    new Promise((resolve) => {
      if (index === 0 || done.signal.aborted) return resolve();
      const entry = {
        go: () => {
          clearTimeout(timer);
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          resolve();
        }
      };
      const timer = setTimeout(() => entry.go(), Math.min(index * HEDGE_DELAY_MS, budget));
      waiting.push(entry);
      done.signal.addEventListener('abort', () => entry.go(), { once: true });
    });

  const ask = async (mirror: string, index: number): Promise<OverpassScan> => {
    const host = new URL(mirror).host;

    // The hedge. Mirror 0 starts immediately; each one after it waits its turn
    // and then joins in, unless somebody has already won.
    await waitTurn(index);
    if (done.signal.aborted) throw new Error(`${host}: not needed`);

    const startedAt = Date.now();
    const res = await fetch(mirror, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: done.signal
    }).catch((err: any) => {
      const why = done.signal.aborted ? 'timed out' : String(err?.message ?? err).slice(0, 120);
      tried.push(`${host}: ${why} after ${Date.now() - startedAt} ms`);
      handTurnOn();
      throw err;
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      tried.push(
        `${host}: HTTP ${res.status}${body ? ` ${body.slice(0, 120).replace(/\s+/g, ' ').trim()}` : ''}`
      );
      handTurnOn();
      throw new Error(`${host}: HTTP ${res.status}`);
    }

    const data = (await res.json().catch(() => null)) as { elements?: unknown } | null;
    if (!Array.isArray(data?.elements)) {
      tried.push(`${host}: answered without an element list`);
      handTurnOn();
      throw new Error(`${host}: no elements`);
    }

    tried.push(`${host}: ok in ${Date.now() - startedAt} ms`);
    return { ok: true, ...sortElements(data.elements as OverpassElement[]) };
  };

  try {
    /*
     * First one home wins. `Promise.any` rejects only when EVERY mirror has
     * failed, which is the one case that is genuinely an outage — and it
     * collects the individual failures rather than letting them surface as
     * unhandled rejections.
     */
    const scan = await Promise.any(OVERPASS_MIRRORS.map(ask));
    console.info(`[beacon] Overpass answered — ${tried.join(' | ')}`);
    return scan;
  } catch {
    console.warn(`[beacon] every Overpass mirror refused — ${tried.join(' | ')}`);
    return {
      ...EMPTY_SCAN,
      note: 'Could not reach OpenStreetMap just now, so nothing was scanned here.'
    };
  } finally {
    // Stops the losing hedges, and the deadline timer that would otherwise
    // hold the serverless function open after the answer has gone out.
    clearTimeout(deadline);
    done.abort();
  }
};

/* ------------------------------------------------------------------ */
/* Mapillary traffic sign detections                                   */
/* ------------------------------------------------------------------ */

/**
 * Signs that mean "not here".
 *
 * Prefixes, not exact values: Mapillary's taxonomy carries regional variants
 * as suffixes (`regulatory--no-parking--g1`, `--g2`, and so on), and matching
 * the exact string would silently miss most of the world.
 */
const RESTRICTIVE_SIGN_PREFIXES = [
  'regulatory--no-parking',
  'regulatory--no-stopping',
  'regulatory--no-waiting',
  'regulatory--parking-restrictions',
  'regulatory--no-overnight',
  'regulatory--no-motor-vehicles',
  'regulatory--no-entry'
];

/** Signs that mean "yes, here" — weak positive evidence, never a guarantee. */
const PERMISSIVE_SIGN_PREFIXES = [
  'information--parking',
  'information--camping',
  'information--rest-area'
];

export interface SignDetection {
  lat: number;
  lon: number;
  value: string;
  restrictive: boolean;
  permissive: boolean;
}

export interface SignScan extends SourceNote {
  detections: SignDetection[];
  /**
   * How much Mapillary has actually seen around here. This is what licenses
   * reading "no restrictive sign found" as evidence rather than as silence.
   */
  coverage: 'none' | 'sparse' | 'dense';
}

const classify = (value: string) => ({
  restrictive: RESTRICTIVE_SIGN_PREFIXES.some((p) => value.startsWith(p)),
  permissive: PERMISSIVE_SIGN_PREFIXES.some((p) => value.startsWith(p))
});

/**
 * Traffic signs Mapillary's vision pipeline already found near a point.
 *
 * This is the whole of the "OCR the signage" requirement, and it costs one
 * JSON request. Mapillary detects and classifies signs across its entire image
 * corpus and serves the results as point features, so the work of reading a
 * sign has already been done by somebody with a GPU cluster.
 *
 * Without MAPILLARY_TOKEN this returns coverage 'none' and no detections, and
 * every candidate downstream is marked `sign_evidence: 'unknown'`. That is the
 * honest reading — we did not look, so we did not see — and it is deliberately
 * NOT the same as looking and finding nothing.
 */
export const fetchSignsNear = async (
  lat: number,
  lon: number,
  radiusM: number,
  timeoutMs = 8_000
): Promise<SignScan> => {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token) {
    return {
      ok: false, detections: [], coverage: 'none',
      note: 'No Mapillary token is set, so no street-level signage was checked.'
    };
  }

  // Degrees per metre varies with latitude for longitude but not for latitude.
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.15, Math.cos(toRad(lat))));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
    .map((n) => n.toFixed(6)).join(',');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url =
      `https://graph.mapillary.com/map_features?access_token=${encodeURIComponent(token)}` +
      `&fields=object_value,geometry&bbox=${bbox}&layer=trafficsigns&limit=500`;

    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false, detections: [], coverage: 'none',
        note: 'Mapillary did not answer, so no street-level signage was checked.'
      };
    }

    const data = (await res.json()) as {
      data?: { object_value?: string; geometry?: { coordinates?: [number, number] } }[];
    };
    if (!Array.isArray(data?.data)) {
      return {
        ok: false, detections: [], coverage: 'none',
        note: 'Mapillary returned nothing usable, so no signage was checked.'
      };
    }

    const detections: SignDetection[] = [];
    for (const row of data.data) {
      const coords = row.geometry?.coordinates;
      const value = row.object_value;
      if (!value || !Array.isArray(coords) || coords.length < 2) continue;
      const [signLon, signLat] = coords;
      if (typeof signLat !== 'number' || typeof signLon !== 'number') continue;
      detections.push({ lat: signLat, lon: signLon, value, ...classify(value) });
    }

    /**
     * The density judgement. Any signs at all means somebody has driven here
     * with a camera; a good number means the absence of a no-parking sign is
     * worth something. The thresholds are deliberately conservative — being
     * wrong in the "we don't know" direction costs a camper one candidate,
     * being wrong the other way costs them a ticket.
     */
    const coverage: SignScan['coverage'] =
      detections.length === 0 ? 'none' : detections.length < 8 ? 'sparse' : 'dense';

    return {
      ok: true,
      detections,
      coverage,
      note: coverage === 'none'
        ? 'Mapillary has no sign detections around here, so signage is unknown.'
        : undefined
    };
  } catch {
    return {
      ok: false, detections: [], coverage: 'none',
      note: 'Could not reach Mapillary, so no street-level signage was checked.'
    };
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------------------------------------------ */
/* Reading the tags                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tags that take a place off the list outright, whatever else is true of it.
 *
 * These are not scored, they are vetoes. A model that has learned that
 * `access=private` usually works out fine has learned something about the
 * campers who report back, not about the law, and it must not be able to
 * outvote an explicit prohibition.
 */
const isForbidden = (tags: Record<string, string>): string | null => {
  const no = (v?: string) => v === 'no' || v === 'private';

  if (no(tags.access)) return 'Access is tagged private.';
  if (tags.landuse === 'military') return 'Inside a military area.';
  if (no(tags.motor_vehicle) || no(tags.vehicle)) return 'Vehicles are not allowed.';
  if (tags.overnight === 'no') return 'Overnight stays are tagged as not allowed.';
  if (tags.camping === 'no' || tags.tents === 'no') return 'Camping is tagged as not allowed.';
  if (tags.motorhome === 'no' || tags.caravan === 'no') return 'Motorhomes are not allowed.';
  if (tags.maxstay && tags.maxstay !== 'unlimited') return `Posted maximum stay: ${tags.maxstay}.`;

  // `parking:condition:*` and the older `parking:lane:*:condition` both encode
  // kerbside rules. Any restrictive value anywhere in that namespace is fatal.
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith('parking:')) continue;
    if (/no_parking|no_stopping|no_standing|disabled|customers|residents|ticket/.test(value)) {
      return 'Kerbside parking here is restricted.';
    }
  }
  return null;
};

/** Land-ownership token and the plain-English basis that goes with it. */
/**
 * ---------------------------------------------------------------------------
 * THE THREE ANSWERS TO "WHOSE GROUND IS THIS", AND WHY THERE ARE THREE
 * ---------------------------------------------------------------------------
 *
 * There was a boolean here, and a boolean was wrong in both directions.
 *
 * `dispersed` — Crown land, BLM, National Forest, national grassland, state
 * forest and trust land. Land where sleeping in a vehicle away from a
 * developed site is the GENERAL RULE rather than an exception. This is what
 * Beacon is for and it ranks first, always.
 *
 * `public` — everything else the public owns and may enter: municipal and
 * county land, provincial holdings, open-access parcels with no agency named,
 * ordinary public space. Far more of both countries by area than the first
 * category, and a real answer for a camper — a gravel pull-off on county land
 * is a place people sleep. It ranks BELOW the first, and its wording never
 * pretends overnight use is the rule there, because usually it is not.
 *
 * `null` — REJECTED. Private land, land whose owner nobody recorded, and the
 * handful of public designations where overnight stays are prohibited outright
 * rather than merely unmentioned. Unknown ownership is rejected on purpose:
 * "nobody said it was private" is not "it is public", and the one thing this
 * feature must never do is send somebody onto private ground.
 */
export type LandTier = 'dispersed' | 'public';

interface LandReading {
  token: Token;
  basis: string;
  /** Null means reject: private, unknown, or prohibited outright. */
  tier: LandTier | null;
}

/**
 * Public land where overnight stays are banned, not merely unaddressed.
 *
 * These are rejected despite being public, and that is not a contradiction of
 * "public land can be used" — it is the difference between a rule that is
 * silent and a rule that says no. A national park campground has a gate and a
 * reservation system; a wildlife refuge closes at dusk. Sending a camper to
 * either is sending them somewhere they will be moved on from.
 *
 * Mirrors EXCLUDED_DESIGNATIONS in scripts/landSources.ts, which encodes the
 * same judgement for the seeder.
 */
const OVERNIGHT_PROHIBITED =
  /national park|provincial park|state park|wildlife refuge|wildlife management|wilderness|national monument|historic site|battlefield|memorial|military|proving ground|test range|botanical|arboretum|cemetery|golf/i;

/**
 * Land where dispersed camping is the general rule, by name.
 *
 * Deliberately a name test rather than a tag test: the same words appear in
 * an OpenStreetMap `operator`, in a PAD-US `Des_Tp` and in an Alberta layer's
 * designation, so one regex serves every source and they cannot drift apart.
 */
const DISPERSED_LAND =
  /bureau of land management|\bblm\b|forest service|national forest|\busfs\b|national grassland|crown land|crown|state forest|state trust|department of natural resources|public land use zone|general use area/i;

const landFromArea = (tags: Record<string, string>): LandReading | null => {
  const operator = tags.operator ?? '';
  const ownership = tags.ownership ?? '';
  const protectTitle = tags.protect_title ?? '';
  const name = tags.name ?? '';
  const haystack = `${operator} ${ownership} ${protectTitle} ${name}`;

  // Prohibited outright beats everything, including a dispersed-land keyword:
  // "Yellowstone National Park" contains no dispersed word, but "Custer
  // National Forest Wilderness" contains both and the ban is the answer.
  if (OVERNIGHT_PROHIBITED.test(haystack)) {
    return {
      token: 'land=overnight_banned',
      tier: null,
      basis: 'Public, but this designation normally forbids overnight stays.'
    };
  }

  if (DISPERSED_LAND.test(haystack)) {
    if (/bureau of land management|\bblm\b/i.test(haystack)) {
      return { token: 'land=blm', tier: 'dispersed', basis: 'Inside land mapped as Bureau of Land Management, where dispersed camping is often the general rule.' };
    }
    if (/forest service|national forest|\busfs\b/i.test(haystack)) {
      return { token: 'land=usfs', tier: 'dispersed', basis: 'Inside land mapped as National Forest, where dispersed camping is often allowed away from developed sites.' };
    }
    if (/crown/i.test(haystack)) {
      return { token: 'land=crown', tier: 'dispersed', basis: 'Inside land mapped as Crown land, where camping rules vary by province.' };
    }
    if (/national grassland/i.test(haystack)) {
      return { token: 'land=grassland', tier: 'dispersed', basis: 'Inside a mapped National Grassland, where dispersed camping is often allowed.' };
    }
    return { token: 'land=state_forest', tier: 'dispersed', basis: 'Inside land mapped as a state forest or state trust land. Rules vary by state and some require a permit.' };
  }

  /*
   * ---- Public, but not dispersed-camping land. ----
   *
   * These used to be rejected outright, and that threw away most of the
   * publicly-owned ground in both countries. A county gravel lot and a
   * municipal common are places people do sleep, and a camper is better served
   * by a ranked lead carrying a warning than by silence. What they are NOT is
   * land where staying the night is the default, and none of the wording below
   * suggests it is.
   */
  const publicOperator =
    /county|municipal|city of|town of|township|regional district|district of|province|provincial|state of|department|ministry|bureau|authority|conservation authority|parks board|public/i
      .test(haystack);

  if (tags.leisure === 'park' || tags.leisure === 'nature_reserve') {
    return {
      token: 'land=park',
      tier: 'public',
      basis: 'Inside mapped public parkland. Parks very often close overnight or post against sleeping in a vehicle — read the signs before you settle.'
    };
  }
  if (publicOperator) {
    return {
      token: 'land=public_other',
      tier: 'public',
      basis: `Public land, managed by ${operator || protectTitle || 'a public body'}. Public ownership is not permission to stay overnight.`
    };
  }
  if (tags.boundary === 'protected_area') {
    return {
      token: 'land=protected',
      tier: 'public',
      basis: 'Inside a mapped protected area with no managing agency recorded. Public to enter; whether you may stay the night is a separate question nobody has answered here.'
    };
  }

  /*
   * ---- Rejected: nobody said whose this is. ----
   *
   * Unmapped forest and a bare residential polygon are the two commonest
   * shapes here, and neither is public. "Nobody tagged an owner" is not
   * ownership, and timber company land and a farmer's woodlot both look
   * exactly like `landuse=forest`.
   */
  if (tags.landuse === 'forest') {
    return { token: 'land=forest', tier: null, basis: 'Mapped forest with no owner recorded. Timber company land looks exactly like this.' };
  }
  if (tags.landuse === 'residential') {
    return { token: 'land=residential', tier: null, basis: 'Residential ground. Private property.' };
  }
  return null;
};

/** What a candidate feature actually is, and its own tags' contribution. */
const describeFeature = (
  tags: Record<string, string>
): { label: string; tokens: Token[]; score: number } | null => {
  if (tags.amenity === 'parking' || tags.amenity === 'parking_space') {
    const free = tags.fee === 'no' || tags.fee === undefined;
    /*
     * A CAR PARK IS THE WEAKEST THING ON THIS LIST, not the strongest.
     *
     * It used to open at 1.5, half a point under the surfacing bar, so a free
     * parking area beside a track cleared it on road context alone. That is
     * how a scan came back as a list of car parks. On a forest road a
     * `amenity=parking` really is the pullout you want — which is why this is
     * still a candidate at all — but it earns its place from the public land
     * it sits on and the view it has, not from being a car park.
     */
    return {
      label: tags.name ?? 'Parking area',
      tokens: ['feature=parking', free ? 'parking=free' : 'parking=fee'],
      score: free ? 0.25 : -1
    };
  }
  if (tags.highway === 'rest_area' || tags.highway === 'services') {
    return { label: tags.name ?? 'Rest area', tokens: ['feature=rest_area'], score: 2 };
  }
  if (tags.highway === 'passing_place') {
    return { label: 'Pull-off beside the road', tokens: ['feature=passing_place'], score: 1 };
  }
  if (tags.highway === 'turning_circle' || tags.highway === 'turning_loop') {
    return { label: 'Turning circle at a road end', tokens: ['feature=turning_circle'], score: 0.5 };
  }
  /*
   * A picnic site on a forest road is the pull-off, with a table on it. Scored
   * near a rest area because it is the same thing at a smaller scale — but a
   * picnic site in a town park is day-use only, which the land tier and the
   * settlement penalty between them already push down.
   */
  if (tags.tourism === 'picnic_site') {
    return { label: tags.name ?? 'Picnic site', tokens: ['feature=picnic_site'], score: 1.5 };
  }
  if (tags.tourism === 'camp_site') {
    const free = tags.fee === 'no';
    return {
      label: tags.name ?? 'Campsite',
      tokens: ['feature=camp_site', free ? 'camp=free' : 'camp=fee'],
      score: free ? 3 : 0
    };
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Candidate assembly                                                  */
/* ------------------------------------------------------------------ */

const centreOf = (el: OverpassElement): { lat: number; lon: number } | null => {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return el.center;
  return null;
};

/**
 * What a spot LOOKS OUT ON, scored from what the map knows is near it.
 *
 * A viewpoint is somebody having said "the view from here is the point". A
 * peak is terrain. Water is the other thing campers drive for. None of these
 * proves you can see anything — trees, a rise, or the wrong orientation all
 * beat this — so the wording that reaches the camper says "near a mapped
 * viewpoint", never "great view".
 *
 * Distances are deliberately short. A lake four kilometres away is not your
 * view, it is just in the same valley.
 */
const viewScore = (
  lat: number, lon: number, context: OverpassElement[]
): { score: number; tokens: Token[]; note: string | null } => {
  const tokens: Token[] = [];
  let score = 0;
  let note: string | null = null;

  let nearestView = Infinity;
  let nearestWater = Infinity;

  for (const el of context) {
    const tags = el.tags ?? {};
    const centre = el.lat !== undefined && el.lon !== undefined
      ? { lat: el.lat, lon: el.lon }
      : el.center;
    if (!centre) continue;
    const metres = metresBetween(lat, lon, centre.lat, centre.lon);

    if (tags.tourism === 'viewpoint' || tags.natural === 'peak') {
      if (metres < nearestView) nearestView = metres;
    } else if (tags.natural === 'water' || tags.waterway === 'riverbank') {
      if (metres < nearestWater) nearestWater = metres;
    }
  }

  if (nearestView <= 400) {
    score += 2; tokens.push('view=viewpoint_near');
    note = 'Within a few hundred metres of a mapped viewpoint or summit.';
  } else if (nearestView <= 1200) {
    score += 1; tokens.push('view=viewpoint_walk');
    note = 'A mapped viewpoint or summit is within about a kilometre.';
  }

  if (nearestWater <= 300) {
    score += 1.5; tokens.push('view=water_near');
    note = note
      ? `${note} There is mapped water beside it too.`
      : 'Beside mapped water.';
  } else if (nearestWater <= 1000) {
    score += 0.5; tokens.push('view=water_walk');
  }

  if (tokens.length === 0) tokens.push('view=none_mapped');
  return { score, tokens, note };
};

/**
 * How likely somebody is to knock on the window, from how close the people are.
 *
 * This is the only honest proxy available without a law database: the risk of
 * being moved on rises steeply with proximity to a settlement, because that is
 * where bylaws, enforcement and irritated residents all live. It is a
 * PENALTY-ONLY signal — being far from town does not make a place legal, it
 * makes being noticed less likely, and those are different claims.
 */
const riskScore = (
  lat: number, lon: number, context: OverpassElement[]
): { score: number; tokens: Token[]; note: string | null } => {
  let nearestPlace = Infinity;
  let placeKind = '';

  for (const el of context) {
    const tags = el.tags ?? {};
    if (!tags.place) continue;
    const centre = el.lat !== undefined && el.lon !== undefined
      ? { lat: el.lat, lon: el.lon }
      : el.center;
    if (!centre) continue;
    const metres = metresBetween(lat, lon, centre.lat, centre.lon);
    if (metres < nearestPlace) { nearestPlace = metres; placeKind = tags.place; }
  }

  // A city centre and a hamlet are not the same amount of attention.
  const weight = placeKind === 'city' ? 1.5
    : placeKind === 'town' || placeKind === 'suburb' ? 1
    : 0.6;

  if (nearestPlace <= 800) {
    return {
      score: -3 * weight,
      tokens: ['risk=in_settlement'],
      note: 'Inside a settlement, where overnight parking is most likely to be noticed and posted against.'
    };
  }
  if (nearestPlace <= 2500) {
    return {
      score: -1.5 * weight,
      tokens: ['risk=near_settlement'],
      note: 'On the edge of a settlement.'
    };
  }
  if (nearestPlace <= 8000) {
    return { score: -0.25 * weight, tokens: ['risk=settlement_nearby'], note: null };
  }
  return {
    score: 1,
    tokens: ['risk=remote'],
    note: 'Well away from any mapped settlement.'
  };
};

/**
 * How wide a clearing may be before its centre stops meaning anything.
 *
 * 400 m across. Past that the middle of the polygon is a point in a field
 * with no particular claim to be where you would stop — and the pin would be
 * exactly the invented coordinate rule 1 exists to prevent. Under it, "the
 * middle of that clearing" is a place a camper can find and recognise.
 */
const MAX_CLEARING_M = 400;

/**
 * A small open patch, turned into one candidate at its centre.
 *
 * Returns null for anything too big, anything with no geometry, and anything
 * whose ring is degenerate. Measured by the diagonal of the bounding box
 * rather than by area, because a long thin strip beside a road is 400 m of
 * verge and not a clearing anybody camps in the middle of.
 */
const clearingCandidate = (
  el: OverpassElement
): { lat: number; lon: number; label: string; tokens: Token[]; score: number } | null => {
  const ring = el.geometry ?? [];
  if (ring.length < 3) return null;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of ring) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;

  const across = metresBetween(minLat, minLon, maxLat, maxLon);
  if (across > MAX_CLEARING_M || across < 15) return null;

  const tags = el.tags ?? {};
  const kind = tags.natural ?? tags.landuse ?? 'clearing';
  return {
    lat: (minLat + maxLat) / 2,
    lon: (minLon + maxLon) / 2,
    label: tags.name ?? (kind === 'recreation_ground' ? 'Recreation ground' : 'Clearing'),
    tokens: ['feature=clearing', `clearing=${kind}`],
    /*
     * Below a rest area and above a bare parking lot. A clearing is genuinely
     * what a lot of dispersed camping looks like, but nothing about it says
     * anyone has ever driven in — the road-access check below is what decides
     * whether this one is reachable, and it is the reason a clearing with no
     * track near it loses a point.
     */
    score: 1.25
  };
};

/** Nearest point on any mapped road, and that road's tags. */
const nearestRoad = (
  lat: number, lon: number, roads: OverpassElement[]
): { metres: number; tags: Record<string, string> } | null => {
  let best: { metres: number; tags: Record<string, string> } | null = null;

  for (const road of roads) {
    for (const node of road.geometry ?? []) {
      const metres = metresBetween(lat, lon, node.lat, node.lon);
      if (!best || metres < best.metres) best = { metres, tags: road.tags ?? {} };
    }
  }
  return best;
};

/**
 * Turn a raw scan into scored candidates.
 *
 * The order here is the order the checks have to happen in: vetoes first, so
 * nothing forbidden can be rescued by a good score; then ownership; then the
 * road context; then signage; and the learned model is applied later, in the
 * database, on top of the rule score computed here.
 */
/**
 * Government public-land polygons, as `fetchPublicLand` returns them.
 *
 * Kept as a loose shape on purpose: this module is meant to be liftable, and
 * a hard import of the boundary route would drag the whole Express surface in
 * with it.
 */
export interface PublicLandCover {
  ok: boolean;
  features: {
    geometry?: { type?: string; coordinates?: any };
    properties?: Record<string, any>;
  }[];
}

/** Every outer ring of a Polygon or MultiPolygon, as `{lat, lon}` points. */
const ringsOf = (geometry: any): Ring[] => {
  if (!geometry?.coordinates) return [];
  const toRing = (coords: any): Ring =>
    Array.isArray(coords)
      ? coords
          .filter((p: any) => Array.isArray(p) && p.length >= 2)
          .map((p: any) => ({ lat: Number(p[1]), lon: Number(p[0]) }))
      : [];

  if (geometry.type === 'Polygon') return [toRing(geometry.coordinates[0])];
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((poly: any) => toRing(poly?.[0]))
      .filter((r: Ring) => r.length >= 3);
  }
  return [];
};

/**
 * Which named public parcel a point sits inside, from the authoritative data.
 *
 * This replaces reading `operator` strings off OpenStreetMap. The polygons
 * here come from BLM, the Forest Service, PAD-US, Alberta and Ontario — the
 * same ones the map itself draws — so a spot is on public land when the
 * agency that manages it says so, not when a volunteer happened to tag it.
 */
const publicParcelAt = (
  lat: number, lon: number, cover: PublicLandCover
): { name: string; designation: string; source: string; tier: LandTier | null } | null => {
  for (const feature of cover.features) {
    for (const ring of ringsOf(feature.geometry)) {
      if (ring.length >= 3 && pointInRing(lat, lon, ring)) {
        const props = feature.properties ?? {};
        const name = String(props._name ?? 'Public land');
        const designation = String(props._designation ?? '');
        const source = String(props._sourceName ?? props._source ?? 'a public land dataset');

        /*
         * WHICH KIND OF PUBLIC, from the words the agency itself used.
         *
         * PAD-US is the reason this matters. It returns everything from
         * "National Forest" to "Local Park" to "State Park" under one flag
         * that only means the public may ENTER, so without a second reading
         * a city playing field would rank alongside a national forest. The
         * same regexes serve the OpenStreetMap path, so the two sources
         * cannot disagree about what a national park is.
         */
        const haystack = `${name} ${designation} ${source}`;
        const tier: LandTier | null =
          OVERNIGHT_PROHIBITED.test(haystack) ? null
          : DISPERSED_LAND.test(haystack) ? 'dispersed'
          : 'public';

        return { name, designation, source, tier };
      }
    }
  }
  return null;
};

export const buildCandidates = (
  scan: OverpassScan,
  signs: SignScan,
  origin: { lat: number; lon: number },
  /**
   * Government public-land polygons for the scanned box.
   *
   * Optional so the module still works standalone, but when it is absent the
   * only remaining public-land evidence is OpenStreetMap's own tagging, which
   * is thin. The caller says which it had.
   */
  publicLand: PublicLandCover = { ok: false, features: [] }
): Candidate[] => {
  const candidates: Candidate[] = [];

  /**
   * Compact features and small clearings go through ONE pipeline.
   *
   * They differ only in how their coordinate and label are worked out — after
   * that every check that matters (the vetoes, the land tier, road access,
   * signage, view, risk) has to apply identically. Running clearings down a
   * second path would be the obvious way to end up with a clearing that
   * skipped the private-land test.
   */
  const targets: { el: OverpassElement; centre: { lat: number; lon: number };
                   described: { label: string; tokens: Token[]; score: number } }[] = [];

  for (const el of scan.features) {
    const centre = centreOf(el);
    const described = centre ? describeFeature(el.tags ?? {}) : null;
    if (centre && described) targets.push({ el, centre, described });
  }

  for (const el of scan.clearings ?? []) {
    const c = clearingCandidate(el);
    if (!c) continue;
    targets.push({
      el,
      centre: { lat: c.lat, lon: c.lon },
      described: { label: c.label, tokens: c.tokens, score: c.score }
    });
  }

  for (const { el, centre, described } of targets) {
    const tags = el.tags ?? {};

    // ---- Veto: the feature's own tags.
    if (isForbidden(tags)) continue;

    const tokens: Token[] = [...described.tokens];
    let score = described.score;
    let basis = '';
    let generator: BeaconGenerator = 'urban';

    // ---- Ownership. Smallest containing area wins, the same way the map's
    // existing pin-drop picks the tightest boundary parcel.
    let containing: { tags: Record<string, string>; size: number } | null = null;
    for (const area of scan.areas) {
      const ring = area.geometry;
      if (!ring || ring.length < 3) continue;
      if (!pointInRing(centre.lat, centre.lon, ring)) continue;

      const lats = ring.map((p) => p.lat);
      const lons = ring.map((p) => p.lon);
      const size = (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lons) - Math.min(...lons));
      if (!containing || size < containing.size) containing = { tags: area.tags ?? {}, size };
    }

    /**
     * ---- PUBLIC LAND IS A REQUIREMENT, NOT A BONUS.
     *
     * This is the single biggest change to what Beacon returns, and it is the
     * reason scans used to come back as a list of car parks. Public land was
     * worth +3 and everything else was worth nothing — so a free parking area
     * on unmapped ground beside a track cleared the surfacing bar on road
     * context alone, and a supermarket lot scored the same as a forest pullout.
     *
     * Now: if the map does not name an agency that manages this ground for
     * public use, the candidate is dropped. Not marked down — dropped.
     *
     * WHAT THIS COSTS, SAID PLAINLY. Public-land polygons are patchy, and
     * Crown land especially so outside Ontario and Alberta. A scan over ground
     * that IS public but unmapped will now find nothing, and the panel says it
     * found nothing. That is the correct trade: an empty answer is a camper
     * driving on, and a wrong answer is a camper parked in a supermarket lot
     * being told it was a lead.
     */
    // ---- Veto: the OSM land it sits on, when there is any. `access=private`
    // over a parcel the government calls public is still a locked gate.
    if (containing && isForbidden(containing.tags)) continue;

    /**
     * ---- PUBLIC LAND, FROM THE AGENCY THAT MANAGES IT.
     *
     * The government polygons are asked first and they are the answer. Only
     * if the boundary layer had nothing to say here does OpenStreetMap's own
     * tagging get a turn.
     *
     * Either way the ground must be PUBLIC. Which kind of public then decides
     * where the lead ranks: Crown land, BLM and National Forest lead, other
     * public land follows well behind, private and unknown are dropped.
     */
    const parcel = publicParcelAt(centre.lat, centre.lon, publicLand);

    if (parcel) {
      if (parcel.tier === null) continue;

      tokens.push(
        parcel.tier === 'dispersed' ? 'land=official_dispersed' : 'land=official_public',
        `land_src=${parcel.source.toLowerCase().replace(/\s+/g, '_')}`
      );
      /*
       * Name, then designation, then who says so — skipping any of the three
       * that just repeats the one before it. Without this a Forest Service
       * parcel read "Inside Gallatin National Forest — National Forest, from
       * National Forest", which is the same words three times and reads like
       * a template that got away.
       */
      const parts = [parcel.name];
      if (parcel.designation && parcel.designation !== parcel.name) parts.push(parcel.designation);
      const said = parts.join(' — ');
      const from = said.toLowerCase().includes(parcel.source.toLowerCase())
        ? "the managing agency's own boundary data"
        : parcel.source;

      basis = parcel.tier === 'dispersed'
        ? `Inside ${said}, from ${from}. Camping away from developed sites is often the general rule on this kind of land.`
        // The hedge is heavier here on purpose. Public ownership answers "may
        // I be here in the daytime", which is a different question.
        : `Inside ${said}, from ${from}. This is public land, which is not the same as somewhere you may stay the night — check for posted rules.`;

      generator = 'public_land';
      score += parcel.tier === 'dispersed' ? 3 : 1;
    } else {
      const land = containing ? landFromArea(containing.tags) : null;
      if (!land || land.tier === null) continue;

      tokens.push(land.token, 'land_src=openstreetmap');
      // Said out loud: this one rests on a volunteer's tag, not on an agency.
      basis = `${land.basis} This is from OpenStreetMap's tagging rather than from the managing agency's own boundary.`;
      generator = 'public_land';
      // A point below the same tier from official data — the tier decides the
      // ranking, the source decides the confidence, and both cost something.
      score += land.tier === 'dispersed' ? 2 : 0.5;
    }

    // ---- Road context. Somewhere you cannot drive to is not a place to sleep.
    const road = nearestRoad(centre.lat, centre.lon, scan.roads);
    if (!road || road.metres > 150) {
      tokens.push('road=none');
      score -= 1;
    } else {
      // ---- Veto: restrictions on the road it sits beside.
      if (isForbidden(road.tags)) continue;

      const highway = road.tags.highway ?? 'unknown';
      tokens.push(`road=${highway}`);
      tokens.push(`surface=${road.tags.surface ?? 'unknown'}`);

      // An unpaved track is the classic dispersed-camping approach; a
      // residential street is where tickets happen.
      if (highway === 'track' || highway === 'unclassified') score += 1;
      if (highway === 'residential') score -= 0.5;
      if (highway === 'secondary' || highway === 'tertiary') score -= 0.5;
    }

    // ---- Signage.
    let signEvidence: SignEvidence = 'unknown';
    const nearbySigns = signs.detections.filter(
      (s) => metresBetween(centre.lat, centre.lon, s.lat, s.lon) <= 60
    );

    // ---- Veto: a restrictive sign close enough to be about this spot.
    const restrictive = nearbySigns.filter(
      (s) => s.restrictive && metresBetween(centre.lat, centre.lon, s.lat, s.lon) <= 40
    );
    if (restrictive.length > 0) continue;

    if (signs.coverage === 'dense' && nearbySigns.length > 0) {
      // Mapillary has looked hard here and found no prohibition. That is the
      // only case where a clear reading is honest.
      signEvidence = 'clear';
      tokens.push('sign:no_parking=absent', 'imagery=dense');
      score += 1;
    } else if (signs.coverage === 'sparse') {
      tokens.push('sign:no_parking=unknown', 'imagery=sparse');
    } else {
      tokens.push('sign:no_parking=unknown', 'imagery=none');
    }

    if (nearbySigns.some((s) => s.permissive)) {
      tokens.push('sign:parking_allowed=present');
      score += 0.5;
    }

    // ---- Is it worth being there? Views and water, from the map.
    const view = viewScore(centre.lat, centre.lon, scan.context);
    score += view.score;
    tokens.push(...view.tokens);

    // ---- How likely is a knock? Distance from people, and nothing else.
    const risk = riskScore(centre.lat, centre.lon, scan.context);
    score += risk.score;
    tokens.push(...risk.tokens);

    // ---- Distance from where the beacon was dropped. Closer is more useful,
    // and this is the only part of the score that is about convenience rather
    // than legality.
    const away = metresBetween(origin.lat, origin.lon, centre.lat, centre.lon);
    if (away <= 1000) score += 0.5;

    /*
     * The basis the camper reads is the land first, then why this one was
     * ranked where it was. Ordered that way because "may I be here" is the
     * question that matters and "is it nice" is the tie-breaker.
     */
    const reasons = [basis, view.note, risk.note].filter(Boolean) as string[];

    candidates.push({
      lat: centre.lat,
      lon: centre.lon,
      generator,
      label: described.label,
      landBasis: reasons.join(' '),
      tokens,
      ruleScore: Number(score.toFixed(3)),
      signEvidence
    });
  }

  return candidates;
};
