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
import { classifyHazard, normaliseSeverity, normaliseUrgency } from '../shared/hazards';
import type { HazardFamily, AlertSeverity } from '../shared/hazards';

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

  // Average every vertex. Alert areas are compact enough that this lands
  // inside them for practical purposes, and it only positions the marker —
  // the polygon itself is drawn from the real coordinates.
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

export const ecccAlertToHazard = (feature: any): NormalisedAlert => {
  const p = feature?.properties ?? {};
  const event = p.alert_type ?? p.headline ?? 'Weather alert';
  // ECCC encodes urgency in the alert "type": warning > watch > advisory.
  const kind = String(p.alert_type ?? '').toLowerCase();
  const severity = kind.includes('warning') ? 'severe' : kind.includes('watch') ? 'moderate' : 'minor';

  return {
    id: String(p.identifier ?? feature?.id ?? `${event}-${p.effective ?? ''}`),
    family: classifyHazard(`${event} ${p.headline ?? ''}`),
    event,
    headline: p.headline ?? event,
    description: p.descrip_en ?? p.description ?? '',
    instruction: p.instruction_en ?? null,
    severity,
    urgency: 'expected',
    certainty: null,
    areaDescription: p.area ?? p.location ?? '',
    sender: 'Environment and Climate Change Canada',
    effective: p.effective ?? null,
    expires: p.expires ?? null,
    source: 'eccc',
    ...(alertLocation(feature) ?? {})
  };
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
  return Array.isArray(data?.features) ? data.features.map(ecccAlertToHazard) : [];
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
  return Array.isArray(data.features) ? data.features.map(ecccAlertToHazard) : [];
};

/** Rough test for "is this coordinate in the contiguous US". */
export const looksUS = (lat: number, lon: number): boolean =>
  lat >= 24.4 && lat <= 49.5 && lon >= -125.1 && lon <= -66.8;
