/**
 * Where the cell coverage numbers come from.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE
 * ---------------------------------------------------------------------------
 *
 * There are two open registers of real transmitter positions, and this module
 * reads both:
 *
 *   OPENSTREETMAP, through Overpass. Every mast someone has surveyed and
 *   tagged `tower:type=communication` or `communication:mobile_phone=yes`.
 *   No key, no registration, no rate limit worth worrying about at this
 *   volume. Often carries the operator's name, and increasingly carries which
 *   generations the mast serves (`communication:lte`, `communication:5g`).
 *   This is the source that works on a deployment with no configuration at
 *   all, which is why it is the one the app leans on.
 *
 *   OPENCELLID, when OPENCELLID_API_KEY is set. A crowd-sourced register of
 *   cells keyed by MCC/MNC, so towers can be attributed to a specific carrier,
 *   and carrying the radio type per cell — which is the only honest way this
 *   app can say "4G" or "5G" about anywhere.
 *
 * WHAT NEITHER OF THEM IS: a coverage map. The carriers' own maps are
 * marketing material, and the FCC's carrier-filed coverage polygons are served
 * through a registered, tokened API this project does not hold credentials
 * for. What we have is where the transmitters ARE, and everything downstream
 * is inference from that:
 *
 *   - It ignores terrain. A mast 4 km away behind a ridge gives you nothing;
 *     one 30 km away across a flat valley may give you three bars. In the
 *     mountains, which is where this app is used, terrain dominates.
 *   - It ignores the tower's power, band, sector orientation and backhaul.
 *   - Both registers are surveyed, not exhaustive. Somewhere nobody has driven
 *     through with a scanning app looks identical to somewhere with no masts.
 *
 * So a carrier we know nothing about is reported as MISSING, never as zero.
 * Zero is a claim; absent data is not. Everything that renders this has to
 * keep those two apart.
 *
 * Nothing here throws. A source that is down returns an empty list and the
 * caller says so, because "we could not ask" and "there is nothing there" are
 * also two different facts.
 */
import { USER_AGENT } from './alertSources.js';

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type CarrierId = 'verizon' | 'att' | 'tmobile' | 'rogers' | 'telus' | 'bell';
export type CellTechnology = '5G' | '4G LTE' | '3G' | '2G';
export type SignalStrength = 'strong' | 'good' | 'weak' | 'none';

export interface CarrierNetwork {
  id: CarrierId;
  label: string;
  mcc: number;
  /** A carrier may run several network codes after its mergers. */
  mncs: number[];
  country: 'us' | 'ca';
  /**
   * Lower-cased fragments that identify this carrier in an OSM `operator` tag.
   *
   * Deliberately specific. "Bell" alone would claim every mast operated by a
   * company with Bell in its name, and attributing somebody else's tower to
   * the carrier a camper is about to rely on is the exact failure this file
   * is written to avoid.
   */
  osmNames: string[];
}

export const CARRIERS: CarrierNetwork[] = [
  {
    id: 'verizon', label: 'Verizon', mcc: 311, mncs: [480, 280], country: 'us',
    osmNames: ['verizon']
  },
  {
    id: 'att', label: 'AT&T', mcc: 310, mncs: [410, 150], country: 'us',
    osmNames: ['at&t', 'at and t', 'att mobility', 'cingular', 'new cingular']
  },
  {
    id: 'tmobile', label: 'T-Mobile', mcc: 310, mncs: [260, 120], country: 'us',
    osmNames: ['t-mobile', 't mobile', 'tmobile', 'sprint', 'metropcs']
  },
  {
    id: 'rogers', label: 'Rogers', mcc: 302, mncs: [720], country: 'ca',
    osmNames: ['rogers', 'fido', 'chatr']
  },
  {
    id: 'telus', label: 'Telus', mcc: 302, mncs: [220], country: 'ca',
    osmNames: ['telus', 'koodo', 'public mobile']
  },
  {
    id: 'bell', label: 'Bell', mcc: 302, mncs: [610], country: 'ca',
    osmNames: ['bell mobility', 'bell canada', 'bell mts', 'virgin plus', 'virgin mobile']
  }
];

/**
 * One transmitter we have a position for.
 *
 * `carrier` absent means the register did not say whose it is — which is the
 * common case for an OSM mast. Such a tower still tells a camper something
 * real ("there is a mast 6 km away") and is drawn on the map, but it is never
 * allowed to fill in a named carrier's row.
 */
export interface CellTower {
  latitude: number;
  longitude: number;
  carrier?: CarrierId;
  /** Whatever the register called the operator, when it named one at all. */
  operator?: string;
  technology?: CellTechnology;
  source: 'osm' | 'opencellid';
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const distanceKm = (
  lat1: number, lon1: number, lat2: number, lon2: number
): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Distance to the nearest transmitter, turned into bars.
 *
 * These thresholds are deliberately pessimistic. A camper who expects one bar
 * and gets three has a nice surprise; one who expects three and gets none may
 * have no way to call for help. The whole ladder is a guess about flat, open
 * ground — which most dispersed sites are not.
 */
export const barsForKm = (km: number): number => {
  if (km <= 2) return 5;
  if (km <= 5) return 4;
  if (km <= 10) return 3;
  if (km <= 20) return 2;
  if (km <= 35) return 1;
  return 0;
};

/** The word a camper actually reads. Bars are the drawing; this is the answer. */
export const strengthForBars = (bars: number): SignalStrength => {
  if (bars >= 4) return 'strong';
  if (bars === 3) return 'good';
  if (bars >= 1) return 'weak';
  return 'none';
};

/** Newest generation wins when a mast reports several. */
const TECH_RANK: Record<CellTechnology, number> = {
  '5G': 4, '4G LTE': 3, '3G': 2, '2G': 1
};

export const bestTechnology = (
  a?: CellTechnology, b?: CellTechnology
): CellTechnology | undefined => {
  if (!a) return b;
  if (!b) return a;
  return TECH_RANK[a] >= TECH_RANK[b] ? a : b;
};

/* ------------------------------------------------------------------ */
/* OpenStreetMap masts, via Overpass                                   */
/* ------------------------------------------------------------------ */

/**
 * Mirrors are tried in order. Overpass instances go down and rate-limit
 * routinely, which is survivable here — a mast that does not load is a mast
 * we do not draw, not a wrong answer.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

/**
 * The one User-Agent, imported rather than re-declared.
 *
 * This file used to default to the literal string
 * `'wandrlust-app (contact: set NWS_USER_AGENT in .env)'` — a to-do note
 * where a contact belongs — and NWS_USER_AGENT has never been set on any
 * deployment, so that is what went out to Overpass on every single cell
 * lookup. Overpass is volunteer-run and entitled to refuse traffic it
 * cannot identify. See USER_AGENT in alertSources.ts.
 */
const UA = USER_AGENT;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const yes = (value?: string): boolean =>
  value === 'yes' || value === 'designated' || value === 'limited';

/**
 * Which generations a mast serves, from whatever the surveyor tagged.
 *
 * Both the namespaced (`communication:lte`) and bare (`lte`) forms are in use
 * in the wild. Absent means nobody recorded it, which is why the return is
 * undefined rather than a guess at LTE.
 */
const technologyFromTags = (tags: Record<string, string>): CellTechnology | undefined => {
  if (yes(tags['communication:5g']) || yes(tags['5g']) || yes(tags['communication:nr'])) {
    return '5G';
  }
  if (yes(tags['communication:lte']) || yes(tags.lte)) return '4G LTE';
  if (yes(tags['communication:umts']) || yes(tags.umts)) return '3G';
  if (yes(tags['communication:gsm']) || yes(tags.gsm)) return '2G';
  return undefined;
};

/** Match an OSM operator string to a carrier, or leave it unattributed. */
export const carrierFromOperator = (operator?: string): CarrierId | undefined => {
  if (!operator) return undefined;
  const needle = operator.toLowerCase();
  for (const carrier of CARRIERS) {
    if (carrier.osmNames.some((name) => needle.includes(name))) return carrier.id;
  }
  return undefined;
};

/**
 * The two ways a mobile mast is tagged in OpenStreetMap.
 *
 * `tower:type=communication` covers the structures; `communication:mobile_phone`
 * covers equipment mounted on something that is not itself a mast — a water
 * tower, a church spire, a rooftop. Both matter in the backcountry, where a
 * lone mast on a ridge is as likely to be tagged one way as the other.
 */
const MAST_FILTERS = [
  '["man_made"~"^(mast|tower)$"]["tower:type"="communication"]',
  '["communication:mobile_phone"="yes"]'
];

const parseElements = (elements: unknown): CellTower[] => {
  if (!Array.isArray(elements)) return [];

  const towers: CellTower[] = [];
  for (const raw of elements as OverpassElement[]) {
    const lat = raw.lat ?? raw.center?.lat;
    const lon = raw.lon ?? raw.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const tags = raw.tags ?? {};
    const operator = tags.operator ?? tags['operator:short'] ?? undefined;

    towers.push({
      latitude: lat,
      longitude: lon,
      carrier: carrierFromOperator(operator),
      operator,
      technology: technologyFromTags(tags),
      source: 'osm'
    });
  }
  return towers;
};

const runOverpass = async (query: string, timeoutMs: number): Promise<CellTower[] | null> => {
  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { elements?: unknown };
      return parseElements(data?.elements);
    } catch {
      // Try the next mirror. Only every mirror failing is an outage.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/**
 * `out center N` — the same statement `src/services/overpass.ts` already uses
 * successfully against these mirrors.
 *
 * `center` is what makes a WAY usable: a mast mapped as a small square returns
 * as a way with no lat/lon of its own, and without this we would silently drop
 * every one of them. The default `body` mode carries the tags along, which is
 * where the operator name and the generation come from. The count is a hard
 * cap so one query over a city cannot return a megabyte.
 */
const outStatement = (limit: number): string => `out center ${limit};`;

/** Masts within `radiusKm` of a point. Null when every mirror failed. */
export const fetchOsmMastsNear = async (
  lat: number,
  lon: number,
  radiusKm: number,
  timeoutMs = 12_000
): Promise<CellTower[] | null> => {
  const radius = Math.round(radiusKm * 1000);
  const around = `(around:${radius},${lat.toFixed(5)},${lon.toFixed(5)})`;

  const clauses = MAST_FILTERS.flatMap((filter) => [
    `node${filter}${around};`,
    `way${filter}${around};`
  ]).join('');

  // Tell Overpass the same budget we are actually going to wait. Declaring
  // [timeout:20] while aborting at 12s left the mirror grinding for another
  // eight seconds on a query whose answer nobody would ever read — rude to a
  // volunteer service, and it makes the next request more likely to be
  // rate-limited.
  const serverTimeoutS = Math.max(5, Math.round(timeoutMs / 1000));

  return runOverpass(
    `[out:json][timeout:${serverTimeoutS}];(${clauses});${outStatement(300)}`,
    timeoutMs
  );
};

/* ------------------------------------------------------------------ */
/* OpenCellID                                                          */
/* ------------------------------------------------------------------ */

/** OpenCellID's radio names, mapped onto what a camper calls them. */
const RADIO_TO_TECHNOLOGY: Record<string, CellTechnology> = {
  NR: '5G',
  LTE: '4G LTE',
  UMTS: '3G',
  CDMA: '3G',
  GSM: '2G'
};

/**
 * Cells for one carrier inside a bounding box.
 *
 * NULL AND EMPTY ARE DIFFERENT and both are preserved all the way to the UI:
 * null is "we could not ask", an empty array is "we asked and the register has
 * nothing filed here". Neither is "no signal", but only the second one is even
 * evidence about the ground.
 */
export const fetchOpenCellIdFor = async (
  carrier: CarrierNetwork,
  lat: number,
  lon: number,
  spanDeg: number,
  key: string,
  signal: AbortSignal
): Promise<CellTower[] | null> => {
  const bbox = [
    lon - spanDeg, lat - spanDeg,
    lon + spanDeg, lat + spanDeg
  ].map((n) => n.toFixed(4)).join(',');

  const towers: CellTower[] = [];
  let anyResponse = false;

  for (const mnc of carrier.mncs) {
    try {
      const url =
        `https://opencellid.org/cell/getInArea?key=${encodeURIComponent(key)}` +
        `&BBOX=${bbox}&mcc=${carrier.mcc}&mnc=${mnc}&format=json&limit=200`;

      const res = await fetch(url, { signal });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        cells?: { lat?: number; lon?: number; radio?: string }[];
      };
      if (!Array.isArray(data?.cells)) continue;
      anyResponse = true;

      for (const cell of data.cells) {
        if (typeof cell.lat !== 'number' || typeof cell.lon !== 'number') continue;
        towers.push({
          latitude: cell.lat,
          longitude: cell.lon,
          carrier: carrier.id,
          operator: carrier.label,
          technology: cell.radio
            ? RADIO_TO_TECHNOLOGY[cell.radio.toUpperCase()]
            : undefined,
          source: 'opencellid'
        });
      }
    } catch {
      // One network code failing does not invalidate the other.
    }
  }

  return anyResponse ? towers : null;
};
