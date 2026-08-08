/**
 * Cell coverage.
 *
 *   GET /api/cell-coverage?lat=&lon=          what signal to expect at a point
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * Where the numbers come from, and what they are not, is documented once in
 * `server/cellSources.ts`. The short version, because it governs everything
 * below: this is built from where transmitters ARE, not from a coverage map.
 * It ignores terrain, and terrain is what decides signal in the mountains.
 *
 * THE CHANGE THAT MATTERS HERE: this used to answer "not configured" and
 * nothing else unless a deployment held an OpenCellID key, which almost none
 * do. The panel was therefore blank for every real user. OpenStreetMap's mast
 * register needs no key, so the keyless path now returns real transmitters
 * rather than an apology, and OpenCellID — when a key IS set — adds the two
 * things OSM cannot reliably give: which carrier owns a tower, and whether it
 * is 5G or LTE.
 *
 * What is still true: a carrier nobody has data for is reported MISSING, never
 * as zero bars. Absent data is not a measurement of nothing.
 *
 * CACHING: positions are essentially static (OSM masts do not move, OpenCellID
 * masts are remounted in place when replaced), and the technology field is
 * months-scale to change for a given site. The cache is keyed to two decimal
 * places of lat/lon — about a kilometre, which is far finer than the answer
 * deserves — and held for 30 days. A returning user reads the same answer
 * they got the previous weekend without spending a round trip; the rare
 * upgrade is at most a month late.
 */
import type { Express, Request, Response } from 'express';
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import {
  CARRIERS, distanceKm, barsForKm, strengthForBars, bestTechnology,
  fetchOsmMastsNear, fetchOpenCellIdFor,
  type CellTower, type CellTechnology, type SignalStrength
} from './cellSources.js';
import { looksUS } from './alertSources.js';

/**
 * How far out to look, in km.
 *
 * Past this the answer is "nothing near you" regardless of the exact number,
 * and it keeps a single Overpass query cheap enough to run on every tap.
 */
const SEARCH_RADIUS_KM = 45;

/** OpenCellID caps the area one request may cover; half a degree is ~55 km. */
const OPENCELLID_SPAN_DEG = 0.5;

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

interface CacheEntry { at: number; body: unknown; }
const cache = new Map<string, CacheEntry>();
// Positions are static and 4G/5G changes are months-scale, so a 30-day
// cache is well within what the answer can support. See the file header.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 600;

const cached = (key: string): unknown | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.body;
};

const store = (key: string, body: unknown): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body });
};

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Collapse sectors down to sites.
 *
 * OpenCellID lists one row per CELL — a three-sector mast is three rows, a
 * mast running LTE and 5G on each sector is six. Counting those as six towers
 * would tell a camper an empty ridge is a dense network. Rounding to four
 * decimal places (about 11 m) merges everything mounted on one structure, and
 * the merged record keeps the newest generation any of its sectors reported.
 */
const dedupe = (towers: CellTower[]): CellTower[] => {
  const bySite = new Map<string, CellTower>();

  for (const tower of towers) {
    const key =
      `${tower.latitude.toFixed(4)},${tower.longitude.toFixed(4)},${tower.carrier ?? '?'}`;
    const existing = bySite.get(key);

    if (!existing) {
      bySite.set(key, { ...tower });
      continue;
    }
    existing.technology = bestTechnology(existing.technology, tower.technology);
    existing.operator = existing.operator ?? tower.operator;
  }

  return [...bySite.values()];
};

interface Verdict {
  bars: number;
  strength: SignalStrength;
  nearestTowerKm: number;
  towerCount: number;
  technology?: CellTechnology;
}

/**
 * What to expect from a set of towers, seen from one point.
 *
 * THE GENERATION IS THE CAREFUL PART. It may only be quoted from a tower that
 * would itself earn the strength being reported. Walking outward to the first
 * mast that happens to carry a `5g` tag produces sentences like "strong signal
 * likely · 5G" where the strong signal is a mast 2 km away that nobody has
 * tagged and the 5G is a different mast 7 km further on — two true facts
 * assembled into a claim neither of them supports. A camper reads that as "5G
 * at full strength here".
 *
 * So the candidates are narrowed to towers in the same strength bracket as the
 * nearest one, and the best generation among those is reported. When none of
 * them says, nothing is said. A strength with no generation beside it is a
 * perfectly good answer; a generation borrowed from a tower you cannot reach
 * is not.
 */
const verdictFrom = (towers: CellTower[], lat: number, lon: number): Verdict | null => {
  if (towers.length === 0) return null;

  const ranked = towers
    .map((tower) => ({
      tower,
      km: distanceKm(lat, lon, tower.latitude, tower.longitude)
    }))
    .sort((a, b) => a.km - b.km);

  const nearest = ranked[0];
  const bars = barsForKm(nearest.km);
  const strength = strengthForBars(bars);

  const technology = ranked
    .filter((entry) => strengthForBars(barsForKm(entry.km)) === strength)
    .reduce<CellTechnology | undefined>(
      (best, entry) => bestTechnology(best, entry.tower.technology),
      undefined
    );

  return {
    bars,
    strength,
    nearestTowerKm: Number(nearest.km.toFixed(1)),
    towerCount: ranked.length,
    technology
  };
};

/** Towers as the client wants them: positioned, named, and with a distance. */
const shapeTowers = (towers: CellTower[], lat: number, lon: number) =>
  towers
    .map((tower) => ({
      latitude: Number(tower.latitude.toFixed(5)),
      longitude: Number(tower.longitude.toFixed(5)),
      carrier: tower.carrier,
      operator: tower.operator,
      technology: tower.technology,
      source: tower.source,
      distanceKm: Number(distanceKm(lat, lon, tower.latitude, tower.longitude).toFixed(1))
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

const readCoords = (req: Request, keys: string[]): number[] | null => {
  const values = keys.map((k) => parseFloat(req.query[k] as string));
  return values.some((n) => Number.isNaN(n)) ? null : values;
};

/* ------------------------------------------------------------------ */

export const registerCellRoutes = (app: Express): void => {
  app.get('/api/cell-coverage', async (req: Request, res: Response) => {
    const coords = readCoords(req, ['lat', 'lon']);
    if (!coords) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }
    const [lat, lon] = coords;

    // Two decimal places is about a kilometre — far finer than this estimate
    // deserves, and it means a whole valley shares one cached answer.
    const cacheKey = `cell:${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = cached(cacheKey);
    if (hit) return res.json(hit);

    const key = process.env.OPENCELLID_API_KEY;

    // Only ask about carriers that operate on this side of the border. A
    // Rogers tower search over Utah is a wasted round trip.
    const country = looksUS(lat, lon) ? 'us' : 'ca';
    const relevant = CARRIERS.filter((c) => c.country === country);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    let masts: CellTower[] | null = null;
    let perCarrier: { carrier: typeof CARRIERS[number]; towers: CellTower[] | null }[] = [];

    try {
      /**
       * Both registers at once. OSM answers for everyone without a key; the
       * OpenCellID leg simply does not run when there is no key, and its
       * absence costs carrier attribution and the 4G/5G label, not the whole
       * answer.
       */
      [masts, perCarrier] = await Promise.all([
        fetchOsmMastsNear(lat, lon, SEARCH_RADIUS_KM),
        key
          ? Promise.all(
              relevant.map(async (carrier) => ({
                carrier,
                towers: await fetchOpenCellIdFor(
                  carrier, lat, lon, OPENCELLID_SPAN_DEG, key, controller.signal
                )
              }))
            )
          : Promise.resolve([])
      ]);
    } catch {
      // Both legs already swallow their own failures; this is belt and braces.
    } finally {
      clearTimeout(timeout);
    }

    const osmTowers = dedupe(masts ?? []).filter(
      (tower) => distanceKm(lat, lon, tower.latitude, tower.longitude) <= SEARCH_RADIUS_KM
    );

    /**
     * A carrier's row is built from that carrier's towers, from BOTH
     * registers — OpenCellID's cells filed under its network codes, plus any
     * OSM mast whose operator tag names it. An unattributed mast never lands
     * in a named carrier's row, however close it is.
     */
    const carriers = relevant.map((carrier) => {
      const fromOpenCellId = perCarrier.find((row) => row.carrier.id === carrier.id);
      const fromOsm = osmTowers.filter((tower) => tower.carrier === carrier.id);

      const known = dedupe([...(fromOpenCellId?.towers ?? []), ...fromOsm]);
      const verdict = verdictFrom(known, lat, lon);

      // Nothing known about this carrier here. Send no number at all rather
      // than a zero, which would read as a measurement.
      if (!verdict) return { carrier: carrier.id, label: carrier.label };

      return {
        carrier: carrier.id,
        label: carrier.label,
        bars: verdict.bars,
        strength: verdict.strength,
        technology: verdict.technology,
        nearestTowerKm: verdict.nearestTowerKm,
        towerCount: verdict.towerCount
      };
    });

    /**
     * The answer for a camper who does not care whose tower it is.
     *
     * Built from EVERY transmitter found, attributed or not, because the
     * question "is there any signal at all up here" is the one that decides
     * whether you can call for help — and most OSM masts name no operator.
     */
    const allTowers = dedupe([
      ...osmTowers,
      ...perCarrier.flatMap((row) => row.towers ?? [])
    ]);
    const overall = verdictFrom(allTowers, lat, lon);

    const anyCarrierData = carriers.some((c) => 'bars' in c);
    const askedSuccessfully = masts !== null || perCarrier.some((row) => row.towers !== null);

    const sources = [
      masts !== null ? 'OpenStreetMap mast register' : null,
      key && perCarrier.some((row) => row.towers !== null)
        ? 'OpenCellID (crowd-sourced cell register)'
        : null
    ].filter(Boolean);

    const body = {
      ok: Boolean(overall),
      source: sources.length > 0 ? sources.join(' + ') : 'none',
      basis:
        'Worked out from the straight-line distance to the nearest recorded ' +
        'transmitter. It does not account for terrain, and in mountains terrain ' +
        'decides everything — treat this as a hint, not a measurement.',
      carriers,
      overall: overall
        ? {
            strength: overall.strength,
            bars: overall.bars,
            technology: overall.technology,
            nearestTowerKm: overall.nearestTowerKm,
            towerCount: overall.towerCount
          }
        : undefined,
      // Enough for the sheet to list and the map to draw, without shipping a
      // whole county down a one-bar connection.
      towers: shapeTowers(allTowers, lat, lon).slice(0, 60),
      note: !askedSuccessfully
        ? 'Could not reach the tower registers just now, so nothing is known ' +
          'about this spot. Plan for no signal.'
        : !overall
        ? `No transmitter is recorded within ${SEARCH_RADIUS_KM} km. That may mean ` +
          'no coverage, or simply that nobody has mapped this area.'
        : !anyCarrierData
        ? 'Nobody has recorded which carrier owns the masts near here, so the ' +
          'estimate above is for any network rather than a particular one.'
        : !key
        ? 'Carrier names and 4G/5G come from what surveyors tagged on each mast, ' +
          'so they are patchy. Set an OpenCellID key for a fuller picture.'
        : undefined
    };

    store(cacheKey, body);
    return res.json(body);
  });
};
