/**
 * The two official alert feeds, and how we read them.
 *
 *   US      api.weather.gov   (NWS — asks for a contact string in User-Agent)
 *   Canada  api.weather.gc.ca (ECCC GeoMet, OGC API Features)
 *
 * This module used to live inside weatherRoutes.ts. It moved out when the
 * background ingest needed the same parsers: two copies of a classifier that
 * decides whether something is a fire warning is exactly the kind of thing
 * that drifts, and shared/hazards.ts already exists for that reason.
 *
 * Nothing here throws. A feed that is down returns an empty list, and the
 * caller reports the outage rather than pretending there are no alerts.
 */
// `.js` is required: this module is loaded under strict ESM on Vercel, where
// an extensionless relative import throws. See the note in weatherRoutes.ts.
import { classifyHazard, normaliseSeverity, normaliseUrgency } from '../shared/hazards.js';
import type { HazardFamily, AlertSeverity } from '../shared/hazards.js';

export const NWS_BASE = 'https://api.weather.gov';
export const ECCC_ALERTS = 'https://api.weather.gc.ca/collections/weather-alerts/items';

const UA = process.env.NWS_USER_AGENT ?? 'wandrlust-app (contact: set NWS_USER_AGENT in .env)';
const jsonHeaders = { 'User-Agent': UA, Accept: 'application/geo+json' };

export interface NormalisedAlert {
  id: string;
  family: HazardFamily;
  event: string;
  headline: string;
  description: string;
  instruction: string | null;
  severity: AlertSeverity | 'severe' | 'moderate' | 'minor';
  urgency: string;
  certainty: string | null;
  areaDescription: string;
  sender: string;
  effective: string | null;
  expires: string | null;
  source: 'nws' | 'eccc';
  geometry?: unknown;
  centroid?: [number, number];
  /**
   * How many separate forecast regions this one alert covers.
   *
   * Only ECCC sets it, because only ECCC fans a single alert out into one row
   * per region. It is what lets the UI say "12 areas" instead of drawing
   * twelve markers that all mean the same thing.
   */
  zoneCount?: number;
}

export const getJson = async (url: string, timeoutMs = 9000): Promise<any | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: jsonHeaders, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Every outer ring in a Polygon or MultiPolygon, as [lon, lat] pairs. */
const outerRings = (geometry: any): [number, number][][] => {
  if (!geometry?.coordinates) return [];

  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0];
    return Array.isArray(ring) ? [ring] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((polygon: any) => polygon?.[0])
      .filter((ring: any) => Array.isArray(ring));
  }
  return [];
};

/** Shoelace area in square degrees. Only ever used to rank rings by size. */
const ringArea = (ring: [number, number][]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2);
};

/**
 * Mean of a ring's vertices, ignoring the repeated closing point.
 *
 * A GeoJSON ring states its first vertex twice, once to open and once to
 * close. Averaging it twice pulls the result toward that one corner — enough
 * to shift a marker several kilometres off the middle of a forecast region,
 * and always in the same direction.
 */
const ringCentroid = (ring: [number, number][]): [number, number] => {
  const closed =
    ring.length > 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const points = closed ? ring.slice(0, -1) : ring;
  if (points.length === 0) return [ring[0][1], ring[0][0]];

  let lon = 0;
  let lat = 0;
  for (const [x, y] of points) { lon += x; lat += y; }
  return [lat / points.length, lon / points.length];
};

/**
 * Where an alert applies, when the feed actually says.
 *
 * Both feeds return a GeoJSON geometry per alert — but not always. NWS in
 * particular sends `geometry: null` for zone-based products, naming the
 * affected zones by URL instead. We keep the polygon when there is one and
 * return null when there isn't.
 *
 * We do NOT fall back to the centre of the requested viewport, or to anything
 * else. A fire warning drawn in the wrong valley is worse than a fire warning
 * that only appears in the list, and this app's whole premise is not showing
 * people things it cannot stand behind.
 */
export const alertLocation = (
  feature: any
): { geometry: unknown; centroid: [number, number] } | null => {
  const geometry = feature?.geometry;
  if (!geometry || !geometry.type || !geometry.coordinates) return null;

  /**
   * The marker goes in the BIGGEST piece of the warned area, not the average
   * of all of them.
   *
   * Averaging every vertex was fine for one compact polygon and wrong the
   * moment an alert covers several separate regions — a warning for Vancouver
   * Island and the Rockies would put its marker in the water between them,
   * pointing at somewhere the warning explicitly does not cover. Taking the
   * largest ring guarantees the marker lands inside an area that is genuinely
   * under this alert.
   */
  const rings = outerRings(geometry);
  if (rings.length > 0) {
    const largest = rings.reduce((best, r) => (ringArea(r) > ringArea(best) ? r : best));
    if (largest.length > 0) return { geometry, centroid: ringCentroid(largest) };
  }

  // Anything that is not a polygon (a bare Point, mostly) still gets placed.
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  const walk = (node: any): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumLon += node[0];
      sumLat += node[1];
      count += 1;
      return;
    }
    node.forEach(walk);
  };
  walk(geometry.coordinates);

  if (count === 0) return null;
  return { geometry, centroid: [sumLat / count, sumLon / count] };
};

export const nwsAlertToHazard = (feature: any): NormalisedAlert => {
  const p = feature?.properties ?? {};
  const event = p.event ?? 'Weather alert';
  return {
    id: String(p.id ?? feature?.id ?? `${event}-${p.effective ?? ''}`),
    family: classifyHazard(event),
    event,
    headline: p.headline ?? event,
    description: p.description ?? '',
    instruction: p.instruction ?? null,
    severity: normaliseSeverity(p.severity),
    urgency: normaliseUrgency(p.urgency),
    certainty: p.certainty ?? null,
    areaDescription: p.areaDesc ?? '',
    sender: p.senderName ?? 'NWS',
    effective: p.effective ?? p.onset ?? null,
    expires: p.expires ?? p.ends ?? null,
    source: 'nws',
    ...(alertLocation(feature) ?? {})
  };
};

/**
 * ---------------------------------------------------------------------------
 * THE ECCC FIELD NAMES. GET THESE WRONG AND THE MAP LIES.
 * ---------------------------------------------------------------------------
 *
 * This parser previously read `alert_type` as the event name, and `alert_type`
 * is not the event — it is the SEVERITY WORD: "warning", "watch", "advisory",
 * "statement". So every Canadian alert in the app was titled "warning",
 * described as "warning", classified as 'other' because "warning" matches no
 * hazard keyword, and drawn as an identical grey triangle. Thirty-odd of them
 * across the Rockies, every one useless.
 *
 * The real names, from ECCC's own pygeoapi config and the GeoMet alerts docs:
 *
 *   alert_name_en        the event — "wind warning", "Special Weather Statement"
 *   alert_short_name_en  a terser form of the same
 *   alert_type           warning | watch | advisory | statement | ended
 *   alert_coverage_en    what the alert covers
 *   feature_name_en      the affected region — "Alma - Desbiens area"
 *   province             two-letter province code
 *   status_en            issued | continued | ended | ...
 *   risk_colour_en       yellow | orange | red, ECCC's own severity ramp
 *   impact_en            minor | moderate | major | severe
 *   expiration_datetime / event_end_datetime
 *   effective_datetime / event_start_datetime
 *
 * Note there is NO long description field in this collection — it is an index,
 * not the full CAP bulletin. So `description` is deliberately left empty rather
 * than stuffed with a repeat of the title, and the UI must cope with that.
 */
const pick = (p: any, names: string[]): string | undefined => {
  for (const name of names) {
    const value = p?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

/**
 * ECCC's severity, from the strongest signal available.
 *
 * `risk_colour_en` and `impact_en` are the real severity fields; `alert_type`
 * is the fallback ladder (warning > watch > advisory > statement) and is what
 * most products actually carry.
 */
const ecccSeverity = (p: any): NormalisedAlert['severity'] => {
  const colour = String(p?.risk_colour_en ?? '').toLowerCase();
  if (colour === 'red') return 'extreme';
  if (colour === 'orange') return 'severe';

  const impact = String(p?.impact_en ?? '').toLowerCase();
  if (impact === 'severe' || impact === 'extreme') return 'extreme';
  if (impact === 'major') return 'severe';
  if (impact === 'moderate') return 'moderate';

  const kind = String(p?.alert_type ?? '').toLowerCase();
  if (kind.includes('warning')) return 'severe';
  if (kind.includes('watch')) return 'moderate';
  return 'minor';
};

/** True once ECCC has stood an alert down. These must never reach the map. */
export const isEndedEcccAlert = (feature: any): boolean => {
  const p = feature?.properties ?? {};
  return String(p.status_en ?? '').toLowerCase() === 'ended' ||
    String(p.alert_type ?? '').toLowerCase() === 'ended';
};

export const ecccAlertToHazard = (feature: any): NormalisedAlert => {
  const p = feature?.properties ?? {};

  const event = pick(p, ['alert_name_en', 'alert_short_name_en']) ??
    // Last resort only. If we ever land here the title reads like the old bug,
    // so it is worth it being obviously a fallback rather than silently wrong.
    (p.alert_type ? `Weather ${String(p.alert_type).toLowerCase()}` : 'Weather alert');

  const area = pick(p, ['feature_name_en', 'area', 'location']) ??
    (typeof p.province === 'string' ? p.province : '');

  /**
   * The identity of the ALERT, not of this row.
   *
   * ECCC returns one feature per affected region, so a single wind warning
   * arrives as a dozen rows sharing an `alert_code`. Keying on that is what
   * lets `mergeZoneAlerts` put them back together into one thing on the map.
   */
  const identity = pick(p, ['alert_code', 'identifier']) ??
    `${event}|${p.alert_type ?? ''}|${p.expiration_datetime ?? ''}`;

  return {
    id: String(identity),
    family: classifyHazard(`${event} ${pick(p, ['alert_coverage_en']) ?? ''}`),
    event,
    headline: pick(p, ['headline_en', 'headline', 'alert_coverage_en']) ?? event,
    description: pick(p, ['descrip_en', 'description_en', 'description']) ?? '',
    instruction: pick(p, ['instruction_en', 'instruction']) ?? null,
    severity: ecccSeverity(p),
    urgency: 'expected',
    certainty: null,
    areaDescription: area,
    sender: 'Environment and Climate Change Canada',
    effective: pick(p, ['effective_datetime', 'event_start_datetime', 'effective']) ?? null,
    expires: pick(p, ['expiration_datetime', 'event_end_datetime', 'expires']) ?? null,
    source: 'eccc',
    ...(alertLocation(feature) ?? {})
  };
};

/**
 * One alert per alert, however many regions it covers.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * ECCC publishes weather alerts one row PER AFFECTED FORECAST REGION. A single
 * snowfall warning over the Rockies is thirty-odd features, each with its own
 * polygon and its own region name, all sharing one `alert_code`. Drawing a
 * marker per feature blanketed the map in identical triangles — and every one
 * of them opened the same popup, so the map looked like thirty emergencies and
 * told you nothing about any of them.
 *
 * Merging them is not cosmetic. Thirty triangles reads as thirty hazards; it
 * overstates what the feed said, which is the one thing this app does not do.
 *
 * The merged alert keeps EVERY region's polygon (as a MultiPolygon, so the
 * drawn area is still exactly what ECCC warned about) and every region's name,
 * and takes its marker position from the largest of them.
 */
export const mergeZoneAlerts = (alerts: NormalisedAlert[]): NormalisedAlert[] => {
  const byIdentity = new Map<string, NormalisedAlert & { _areas: string[] }>();

  for (const alert of alerts) {
    const existing = byIdentity.get(alert.id);

    if (!existing) {
      byIdentity.set(alert.id, {
        ...alert,
        _areas: alert.areaDescription ? [alert.areaDescription] : []
      });
      continue;
    }

    if (alert.areaDescription && !existing._areas.includes(alert.areaDescription)) {
      existing._areas.push(alert.areaDescription);
    }

    // Collect this region's polygons alongside the ones already gathered.
    const parts = [existing.geometry, alert.geometry]
      .flatMap((g: any) => {
        if (!g) return [];
        if (g.type === 'Polygon') return [g.coordinates];
        if (g.type === 'MultiPolygon') return g.coordinates;
        return [];
      });

    if (parts.length > 0) {
      existing.geometry = { type: 'MultiPolygon', coordinates: parts };
      const placed = alertLocation({ geometry: existing.geometry });
      if (placed) existing.centroid = placed.centroid;
    }

    // The worst severity any region was given governs the merged alert.
    if (SEVERITY_ORDER[alert.severity] > SEVERITY_ORDER[existing.severity]) {
      existing.severity = alert.severity;
    }
  }

  return [...byIdentity.values()].map(({ _areas, ...alert }) => ({
    ...alert,
    zoneCount: _areas.length,
    // Three names is enough to recognise where this is; the rest is a count.
    areaDescription: _areas.length > 3
      ? `${_areas.slice(0, 3).join(', ')} and ${_areas.length - 3} more areas`
      : _areas.join(', ')
  }));
};

const SEVERITY_ORDER: Record<string, number> = {
  extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: 0
};

/** Alerts active at a single point (used by the per-site weather lookup). */
export const fetchNwsAlertsAtPoint = async (lat: number, lon: number): Promise<NormalisedAlert[]> => {
  const data = await getJson(`${NWS_BASE}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
  return Array.isArray(data?.features) ? data.features.map(nwsAlertToHazard) : [];
};

/**
 * Every actual alert currently in force across the NWS.
 *
 * `status=actual` drops exercise and test products — we do not want a drill
 * waking somebody at 3am. `message_type=alert` drops the update/cancel
 * bookkeeping messages, which carry no new information for a camper.
 */
export const fetchNwsActiveAlerts = async (): Promise<NormalisedAlert[] | null> => {
  const data = await getJson(
    `${NWS_BASE}/alerts/active?status=actual&message_type=alert&limit=500`,
    20000
  );
  if (!data) return null;
  return Array.isArray(data.features) ? data.features.map(nwsAlertToHazard) : [];
};

export const fetchEcccAlerts = async (
  lat: number, lon: number, spanDeg = 1.0
): Promise<NormalisedAlert[]> => {
  const bbox = [
    (lon - spanDeg).toFixed(3), (lat - spanDeg).toFixed(3),
    (lon + spanDeg).toFixed(3), (lat + spanDeg).toFixed(3)
  ].join(',');

  const data = await getJson(`${ECCC_ALERTS}?bbox=${bbox}&lang=en&limit=50&f=json`);
  if (!Array.isArray(data?.features)) return [];
  return mergeZoneAlerts(
    data.features.filter((f: any) => !isEndedEcccAlert(f)).map(ecccAlertToHazard)
  );
};

/**
 * Every ECCC alert inside the app's Canadian coverage.
 *
 * One bbox spanning the provinces, capped at the 60th parallel to match
 * config/coverage.ts. Returns null when the feed could not be reached, so the
 * caller can tell "nothing active" apart from "we did not get an answer".
 */
export const fetchEcccActiveAlerts = async (): Promise<NormalisedAlert[] | null> => {
  const data = await getJson(
    `${ECCC_ALERTS}?bbox=-141.0,41.0,-52.0,60.0&lang=en&limit=500&f=json`,
    20000
  );
  if (!data) return null;
  if (!Array.isArray(data.features)) return [];
  return mergeZoneAlerts(
    data.features.filter((f: any) => !isEndedEcccAlert(f)).map(ecccAlertToHazard)
  );
};

/** Rough test for "is this coordinate in the contiguous US". */
export const looksUS = (lat: number, lon: number): boolean =>
  lat >= 24.4 && lat <= 49.5 && lon >= -125.1 && lon <= -66.8;
