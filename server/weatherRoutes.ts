/**
 * Weather + hazard alert endpoints.
 *
 *   GET /api/weather?lat=&lon=            forecast + alerts for a point
 *   GET /api/weather/alerts?minLat=...    active alerts for a viewport
 *
 * Sources are free government APIs with no keys:
 *   US      api.weather.gov   (NWS asks for a contact string in User-Agent)
 *   Canada  api.weather.gc.ca (ECCC GeoMet, OGC API Features)
 *
 * NWS is a two-step lookup: /points/{lat},{lon} returns the grid endpoint,
 * which then returns the forecast. We cache both, since grid assignment for a
 * coordinate never changes.
 */
import type { Express, Request, Response } from 'express';

const NWS_BASE = 'https://api.weather.gov';
const ECCC_ALERTS = 'https://api.weather.gc.ca/collections/weather-alerts/items';

// NWS requests a contact string. Falls back to a generic identifier.
const UA = process.env.NWS_USER_AGENT ?? 'wandrlust-app (contact: set NWS_USER_AGENT in .env)';
const jsonHeaders = { 'User-Agent': UA, Accept: 'application/geo+json' };

interface CacheEntry { at: number; body: unknown; }
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;

const cached = <T>(key: string, ttlMs: number): T | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return null; }
  return hit.body as T;
};

const store = (key: string, body: unknown): void => {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body });
};

const getJson = async (url: string, timeoutMs = 9000): Promise<any | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: jsonHeaders, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

type HazardFamily = 'fire' | 'flood' | 'storm' | 'winter' | 'heat' | 'wind' | 'other';

/**
 * Fire is checked FIRST because "Fire Weather Watch" would otherwise fall
 * through to another family, and getting fire wrong is the most dangerous
 * failure here.
 */
const classifyHazard = (eventName: string): HazardFamily => {
  const e = (eventName ?? '').toLowerCase();
  if (/red flag|fire weather|wildfire|fire danger|burn ban|extreme fire/.test(e)) return 'fire';
  if (/flood|flash flood|hydrologic|dam break|seiche|storm surge/.test(e)) return 'flood';
  if (/tornado|thunderstorm|hurricane|tropical|typhoon|severe weather|squall|waterspout/.test(e)) return 'storm';
  if (/snow|blizzard|ice|freez|winter|frost|sleet|avalanche|cold|chill/.test(e)) return 'winter';
  if (/heat|hot/.test(e)) return 'heat';
  if (/wind|gale|dust/.test(e)) return 'wind';
  return 'other';
};

const normaliseSeverity = (raw: string | undefined): string => {
  const s = (raw ?? '').toLowerCase();
  return ['extreme', 'severe', 'moderate', 'minor'].includes(s) ? s : 'unknown';
};

const normaliseUrgency = (raw: string | undefined): string => {
  const u = (raw ?? '').toLowerCase();
  return ['immediate', 'expected', 'future', 'past'].includes(u) ? u : 'unknown';
};

const nwsAlertToHazard = (feature: any) => {
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
    source: 'nws' as const
  };
};

const fetchNwsPoint = async (lat: number, lon: number) => {
  const key = `nws:point:${lat.toFixed(3)},${lon.toFixed(3)}`;
  // Grid assignment is stable; cache for a day.
  const hit = cached<any>(key, 24 * 60 * 60 * 1000);
  if (hit) return hit;
  const data = await getJson(`${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  if (data) store(key, data);
  return data;
};

const fetchNwsWeather = async (lat: number, lon: number) => {
  const point = await fetchNwsPoint(lat, lon);
  const forecastUrl = point?.properties?.forecast;
  const timezone = point?.properties?.timeZone ?? null;

  const [forecast, alerts] = await Promise.all([
    forecastUrl ? getJson(forecastUrl) : Promise.resolve(null),
    getJson(`${NWS_BASE}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`)
  ]);

  const periods = Array.isArray(forecast?.properties?.periods)
    ? forecast.properties.periods.slice(0, 14).map((p: any) => ({
        name: p.name,
        startTime: p.startTime,
        isDaytime: Boolean(p.isDaytime),
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed ?? null,
        windDirection: p.windDirection ?? null,
        shortForecast: p.shortForecast ?? '',
        detailedForecast: p.detailedForecast ?? '',
        precipProbability: p.probabilityOfPrecipitation?.value ?? null,
        icon: p.icon ?? null
      }))
    : [];

  const hazards = Array.isArray(alerts?.features) ? alerts.features.map(nwsAlertToHazard) : [];
  return { periods, alerts: hazards, timezone, source: 'nws' as const };
};

const ecccAlertToHazard = (feature: any) => {
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
    source: 'eccc' as const
  };
};

const fetchEcccAlerts = async (lat: number, lon: number, spanDeg = 1.0) => {
  const bbox = [
    (lon - spanDeg).toFixed(3), (lat - spanDeg).toFixed(3),
    (lon + spanDeg).toFixed(3), (lat + spanDeg).toFixed(3)
  ].join(',');
  const data = await getJson(`${ECCC_ALERTS}?bbox=${bbox}&lang=en&limit=50&f=json`);
  return Array.isArray(data?.features) ? data.features.map(ecccAlertToHazard) : [];
};

/** Rough test for "is this coordinate in the contiguous US". */
const looksUS = (lat: number, lon: number): boolean =>
  lat >= 24.4 && lat <= 49.5 && lon >= -125.1 && lon <= -66.8;

export const registerWeatherRoutes = (app: Express): void => {
  app.get('/api/weather', async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: 'lat and lon are required numbers' });
    }

    const key = `weather:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const hit = cached<any>(key, 10 * 60 * 1000);
    if (hit) return res.json(hit);

    let payload: any;

    if (looksUS(lat, lon)) {
      const nws = await fetchNwsWeather(lat, lon);
      payload = {
        updatedAt: new Date().toISOString(),
        timezone: nws.timezone,
        periods: nws.periods,
        alerts: nws.alerts,
        source: nws.periods.length > 0 || nws.alerts.length > 0 ? 'nws' : 'none'
      };
    } else {
      // Canada: ECCC publishes alerts openly; point forecasts are not
      // available through the same OGC endpoint, so we return alerts only
      // and say so rather than inventing a forecast.
      const alerts = await fetchEcccAlerts(lat, lon);
      payload = {
        updatedAt: new Date().toISOString(),
        timezone: null,
        periods: [],
        alerts,
        source: alerts.length > 0 ? 'eccc' : 'none',
        note:
          'Environment Canada alerts shown. Point forecasts are not available ' +
          'from the open ECCC endpoint; see weather.gc.ca for full forecasts.'
      };
    }

    store(key, payload);
    return res.json(payload);
  });

  app.get('/api/weather/alerts', async (req: Request, res: Response) => {
    const minLat = parseFloat(req.query.minLat as string);
    const minLon = parseFloat(req.query.minLon as string);
    const maxLat = parseFloat(req.query.maxLat as string);
    const maxLon = parseFloat(req.query.maxLon as string);

    if ([minLat, minLon, maxLat, maxLon].some((n) => Number.isNaN(n))) {
      return res.status(400).json({ error: 'minLat, minLon, maxLat, maxLon required' });
    }

    const key = `alerts:${[minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(1)).join(',')}`;
    const hit = cached<any>(key, 5 * 60 * 1000);
    if (hit) return res.json(hit);

    const centreLat = (minLat + maxLat) / 2;
    const centreLon = (minLon + maxLon) / 2;
    const span = Math.max(Math.abs(maxLat - minLat), Math.abs(maxLon - minLon)) / 2;

    const collected: any[] = [];

    if (looksUS(centreLat, centreLon) || looksUS(minLat, minLon) || looksUS(maxLat, maxLon)) {
      const data = await getJson(
        `${NWS_BASE}/alerts/active?point=${centreLat.toFixed(4)},${centreLon.toFixed(4)}`
      );
      if (Array.isArray(data?.features)) collected.push(...data.features.map(nwsAlertToHazard));
    }

    if (maxLat > 48.0) {
      collected.push(...(await fetchEcccAlerts(centreLat, centreLon, Math.max(span, 1.5))));
    }

    // De-duplicate by id; the two feeds overlap near the border.
    const seen = new Set<string>();
    const alerts = collected.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    const payload = { alerts, fetchedAt: new Date().toISOString() };
    store(key, payload);
    return res.json(payload);
  });
};
