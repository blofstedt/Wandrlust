/**
 * Cell coverage approximation.
 *
 *   GET /api/cell-coverage?lat=&lon=
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * THIS IS NOT A COVERAGE MAP. It is a distance-to-nearest-tower estimate, and
 * the difference matters enough that it is repeated in the response body, in
 * the client service, and on screen under every set of bars we draw.
 *
 * The carriers' own coverage maps are marketing material and are not published
 * as queryable data. The FCC's National Broadband Map holds carrier-filed
 * coverage polygons but serves them through a licensed, tokened API that this
 * project does not have access to. What IS openly available is OpenCellID: a
 * crowd-sourced register of cell tower positions, keyed by MCC/MNC so towers
 * can be attributed to a carrier.
 *
 * From tower positions you can derive roughly how far the nearest transmitter
 * is. That is genuinely useful in the backcountry — "the nearest Verizon tower
 * is 38 km away" tells a camper something real — and it is emphatically not a
 * signal measurement:
 *
 *   - It ignores terrain. A tower 4 km away behind a ridge gives you nothing;
 *     one 30 km away across a flat valley may give you three bars. In the
 *     mountains, which is where this app is used, terrain dominates.
 *   - It ignores the tower's power, band, sector orientation and backhaul.
 *   - OpenCellID's density varies enormously. Somewhere nobody has driven
 *     through with a scanning app looks identical to somewhere with no towers.
 *
 * So: a missing carrier is reported as MISSING, never as zero bars. Zero bars
 * is a claim; absent data is not. Anyone rendering this must keep that split.
 *
 * With no OPENCELLID_API_KEY set, this returns ok:false and a note saying so.
 * That is the correct behaviour — the app must work with no keys at all, and a
 * fabricated estimate would be worse than an honest blank.
 */
import type { Express, Request, Response } from 'express';

/* ------------------------------------------------------------------ */
/* Carriers                                                            */
/* ------------------------------------------------------------------ */

interface CarrierNetwork {
  id: string;
  label: string;
  mcc: number;
  /** A carrier may run several network codes after its mergers. */
  mncs: number[];
  country: 'us' | 'ca';
}

/**
 * MCC/MNC per carrier.
 *
 * US codes are the primary post-merger networks; T-Mobile carries Sprint's
 * 310/120 because the Sprint network was folded into it and OpenCellID still
 * holds towers filed under the old code.
 */
const CARRIERS: CarrierNetwork[] = [
  { id: 'verizon', label: 'Verizon', mcc: 311, mncs: [480, 280], country: 'us' },
  { id: 'att', label: 'AT&T', mcc: 310, mncs: [410, 150], country: 'us' },
  { id: 'tmobile', label: 'T-Mobile', mcc: 310, mncs: [260, 120], country: 'us' },
  { id: 'rogers', label: 'Rogers', mcc: 302, mncs: [720], country: 'ca' },
  { id: 'telus', label: 'Telus', mcc: 302, mncs: [220], country: 'ca' },
  { id: 'bell', label: 'Bell', mcc: 302, mncs: [610], country: 'ca' }
];

/**
 * How far out to look for towers, in degrees of latitude.
 *
 * About 55 km at these latitudes. Past that the answer is "nothing near you"
 * regardless of the exact number, and OpenCellID caps the area a single
 * request may cover.
 */
const SEARCH_SPAN_DEG = 0.5;

/**
 * Distance to the nearest tower, turned into bars.
 *
 * These thresholds are deliberately pessimistic. A camper who expects one bar
 * and gets three has a nice surprise; one who expects three and gets none may
 * have no way to call for help. The whole ladder is a guess about flat, open
 * ground — which most dispersed sites are not.
 */
const barsForKm = (km: number): number => {
  if (km <= 2) return 5;
  if (km <= 5) return 4;
  if (km <= 10) return 3;
  if (km <= 20) return 2;
  if (km <= 35) return 1;
  return 0;
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

interface CacheEntry { at: number; body: unknown; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // Towers do not move.
const CACHE_MAX_ENTRIES = 400;

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

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

interface TowerResult { nearestKm: number; count: number; }

/**
 * Towers for one carrier around a point, or null when the lookup failed.
 *
 * NULL AND EMPTY ARE DIFFERENT and both are preserved all the way to the UI:
 * null is "we could not ask", an empty result is "we asked and OpenCellID has
 * nothing filed here". Neither is "no signal", but only the second one is even
 * evidence about the ground.
 */
const towersFor = async (
  carrier: CarrierNetwork,
  lat: number,
  lon: number,
  key: string,
  signal: AbortSignal
): Promise<TowerResult | null> => {
  const bbox = [
    lon - SEARCH_SPAN_DEG, lat - SEARCH_SPAN_DEG,
    lon + SEARCH_SPAN_DEG, lat + SEARCH_SPAN_DEG
  ].map((n) => n.toFixed(4)).join(',');

  let nearestKm = Infinity;
  let count = 0;
  let anyResponse = false;

  for (const mnc of carrier.mncs) {
    try {
      const url =
        `https://opencellid.org/cell/getInArea?key=${encodeURIComponent(key)}` +
        `&BBOX=${bbox}&mcc=${carrier.mcc}&mnc=${mnc}&format=json&limit=200`;

      const res = await fetch(url, { signal });
      if (!res.ok) continue;

      const data = (await res.json()) as { cells?: { lat?: number; lon?: number }[] };
      if (!Array.isArray(data?.cells)) continue;
      anyResponse = true;

      for (const cell of data.cells) {
        if (typeof cell.lat !== 'number' || typeof cell.lon !== 'number') continue;
        count += 1;
        const d = distanceKm(lat, lon, cell.lat, cell.lon);
        if (d < nearestKm) nearestKm = d;
      }
    } catch {
      // One network code failing does not invalidate the other.
    }
  }

  if (!anyResponse) return null;
  return { nearestKm, count };
};

/* ------------------------------------------------------------------ */

export const registerCellRoutes = (app: Express): void => {
  app.get('/api/cell-coverage', async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numeric query params.' });
    }

    const key = process.env.OPENCELLID_API_KEY;
    if (!key) {
      // Not an error. Most deployments will not have a key, and the app is
      // required to work without one — it just cannot answer this question.
      return res.json({
        ok: false,
        source: 'none',
        basis: '',
        carriers: [],
        note:
          'No cell coverage data is configured for this deployment. Plan for no ' +
          'signal here and tell someone your route before you leave.'
      });
    }

    // Half a degree is well inside the resolution this estimate deserves, and
    // it means a whole valley shares one cached answer.
    const cacheKey = `cell:${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = cached(cacheKey);
    if (hit) return res.json(hit);

    // Only ask about carriers that operate on this side of the border. A
    // Rogers tower search over Utah is a wasted round trip.
    const country = lon < -52 && lat > 48.5 ? 'ca' : 'us';
    const relevant = CARRIERS.filter((c) => c.country === country);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const results = await Promise.all(
        relevant.map(async (carrier) => ({
          carrier,
          towers: await towersFor(carrier, lat, lon, key, controller.signal)
        }))
      );
      clearTimeout(timeout);

      const carriers = results.map(({ carrier, towers }) => {
        // Lookup failed, or the register is empty here. Either way we have no
        // basis for a number, so we send none rather than sending a zero.
        if (!towers || towers.count === 0) {
          return { carrier: carrier.id, label: carrier.label };
        }
        return {
          carrier: carrier.id,
          label: carrier.label,
          bars: barsForKm(towers.nearestKm),
          nearestTowerKm: Number(towers.nearestKm.toFixed(1)),
          towerCount: towers.count
        };
      });

      const anyData = carriers.some((c) => 'bars' in c);

      const body = {
        ok: anyData,
        source: 'OpenCellID (crowd-sourced tower register)',
        basis:
          'Estimated from the straight-line distance to the nearest recorded ' +
          'tower. It does not account for terrain, and in mountains terrain ' +
          'decides everything — treat this as a hint, not a measurement.',
        carriers,
        note: anyData
          ? undefined
          : 'No towers are recorded within about 55 km for any carrier. That may ' +
            'mean no coverage, or simply that nobody has mapped this area.'
      };

      store(cacheKey, body);
      return res.json(body);
    } catch {
      clearTimeout(timeout);
      return res.json({
        ok: false,
        source: 'OpenCellID (crowd-sourced tower register)',
        basis: '',
        carriers: [],
        note: 'Coverage lookup failed. Assume no signal until you can check it yourself.'
      });
    }
  });
};
