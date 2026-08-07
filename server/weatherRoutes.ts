/**
 * Weather + hazard alert endpoints.
 *
 *   GET /api/weather?lat=&lon=            forecast + alerts for a point
 *   GET /api/weather/alerts?minLat=...    active alerts for a viewport
 *
 * The feeds themselves, and the parsers that read them, live in
 * server/alertSources.ts — the background ingest needs the same ones.
 *
 * NWS is a two-step lookup: /points/{lat},{lon} returns the grid endpoint,
 * which then returns the forecast. We cache both, since grid assignment for a
 * coordinate never changes.
 */
import type { Express, Request, Response } from 'express';
/**
 * THE `.js` ON THESE IMPORTS IS LOAD-BEARING. DO NOT STRIP IT.
 *
 * On Vercel these modules are loaded by `api/index.ts` under strict ESM, where
 * an extensionless relative specifier throws ERR_MODULE_NOT_FOUND. That throw
 * was caught by `safeRegister`, so the weather routes silently never
 * registered and every `/api/weather` call fell through to the catch-all and
 * came back 404 — which the client rendered as "Weather unavailable (404)" on
 * every campsite, in production, while working perfectly in dev.
 */
import {
  NWS_BASE, getJson, nwsAlertToHazard, fetchNwsAlertsAtPoint, fetchEcccAlerts, looksUS
} from './alertSources.js';
import { fetchOpenMeteo } from './openMeteo.js';

const POINT_TTL_MS = 24 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 10 * 60 * 1000;
const ALERTS_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

interface CacheEntry { at: number; body: unknown; }
const cache = new Map<string, CacheEntry>();

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

const fetchNwsPoint = async (lat: number, lon: number) => {
  const key = `nws:point:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cached<any>(key, POINT_TTL_MS);
  if (hit) return hit;

  const data = await getJson(`${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  if (data) store(key, data);
  return data;
};

/** Normalise one NWS period — the hourly and twelve-hour shapes are the same. */
const nwsPeriod = (p: any, fallbackName: string) => ({
  name: p.name || fallbackName,
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
});

/**
 * The US forecast, hourly where we can get it.
 *
 * NWS publishes two forecasts per grid point: named twelve-hour periods
 * ("This Afternoon", "Tonight") and a plain hourly series. The app used only
 * the first, which is fine for "what's it like there" and useless for "what
 * will it be doing when I arrive" — a four-hour drive lands in the same
 * twelve-hour block you set off in, so the arrival forecast could only ever
 * repeat the current one back at you.
 *
 * Hourly is preferred and the twelve-hour set is the fallback, because the
 * hourly endpoint is the flakier of the two.
 */
const fetchNwsWeather = async (lat: number, lon: number) => {
  const point = await fetchNwsPoint(lat, lon);
  const forecastUrl = point?.properties?.forecast;
  const hourlyUrl = point?.properties?.forecastHourly;
  const timezone = point?.properties?.timeZone ?? null;

  const [hourly, forecast, hazards] = await Promise.all([
    hourlyUrl ? getJson(hourlyUrl) : Promise.resolve(null),
    forecastUrl ? getJson(forecastUrl) : Promise.resolve(null),
    fetchNwsAlertsAtPoint(lat, lon)
  ]);

  const hourlyPeriods = Array.isArray(hourly?.properties?.periods)
    ? hourly.properties.periods.slice(0, 48).map((p: any) =>
        nwsPeriod(
          p,
          new Date(p.startTime).toLocaleTimeString('en-US', {
            hour: 'numeric',
            timeZone: timezone || 'UTC'
          })
        )
      )
    : [];

  if (hourlyPeriods.length > 0) {
    return { periods: hourlyPeriods, alerts: hazards, timezone, resolution: 'hourly' as const };
  }

  const coarsePeriods = Array.isArray(forecast?.properties?.periods)
    ? forecast.properties.periods.slice(0, 14).map((p: any) => nwsPeriod(p, 'Forecast'))
    : [];

  return {
    periods: coarsePeriods,
    alerts: hazards,
    timezone,
    resolution: 'twelve_hour' as const
  };
};

const readCoords = (req: Request, keys: string[]): number[] | null => {
  const values = keys.map((k) => parseFloat(req.query[k] as string));
  return values.some((n) => Number.isNaN(n)) ? null : values;
};

export const registerWeatherRoutes = (app: Express): void => {
  app.get('/api/weather', async (req: Request, res: Response) => {
    const coords = readCoords(req, ['lat', 'lon']);
    if (!coords) return res.status(400).json({ error: 'lat and lon are required numbers' });
    const [lat, lon] = coords;

    const key = `weather:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const hit = cached<any>(key, FORECAST_TTL_MS);
    if (hit) return res.json(hit);

    const isUS = looksUS(lat, lon);
    let payload: Record<string, unknown>;

    if (isUS) {
      const nws = await fetchNwsWeather(lat, lon);

      /**
       * NWS first, Open-Meteo when it comes back empty.
       *
       * The NWS grid does not cover offshore water, parts of the territories,
       * or the odd gap near the border, and it has outages like anything else.
       * Falling through means a camper never sees "no forecast" for a place
       * that plainly has weather.
       */
      if (nws.periods.length > 0) {
        payload = {
          updatedAt: new Date().toISOString(),
          timezone: nws.timezone,
          periods: nws.periods,
          alerts: nws.alerts,
          source: 'nws',
          resolution: nws.resolution
        };
      } else {
        const fallback = await fetchOpenMeteo(lat, lon, true);
        payload = {
          updatedAt: new Date().toISOString(),
          timezone: fallback.timezone ?? nws.timezone,
          periods: fallback.periods,
          alerts: nws.alerts,
          source: fallback.periods.length > 0 ? 'open-meteo' : 'none',
          resolution: 'hourly',
          note: fallback.periods.length > 0
            ? 'The National Weather Service has no grid forecast for this point, so ' +
              'this forecast comes from Open-Meteo. Alerts are still NWS.'
            : 'No forecast is available for this point right now.'
        };
      }
    } else {
      /**
       * CANADA. THIS BRANCH USED TO RETURN NOTHING AT ALL.
       *
       * Environment Canada publishes alerts through its open GeoMet endpoint
       * but not point forecasts, so this returned an empty period list with a
       * note pointing at weather.gc.ca — which meant that for every Canadian
       * user, and this app is built in Calgary, the forecast panel and the
       * whole arrival-weather feature were permanently blank.
       *
       * Open-Meteo fills it. Its Canadian data is largely ECCC's own HRDPS and
       * RDPS model output, so this is the same forecast through a door that
       * answers. Alerts still come from ECCC and only from ECCC.
       */
      const [alerts, forecast] = await Promise.all([
        fetchEcccAlerts(lat, lon),
        fetchOpenMeteo(lat, lon, false)
      ]);

      payload = {
        updatedAt: new Date().toISOString(),
        timezone: forecast.timezone,
        periods: forecast.periods,
        alerts,
        source: forecast.periods.length > 0 ? 'open-meteo' : alerts.length > 0 ? 'eccc' : 'none',
        resolution: 'hourly',
        note: forecast.periods.length > 0
          ? 'Forecast from Open-Meteo, which serves Environment Canada model data. ' +
            'Warnings and watches come from Environment Canada directly.'
          : 'No forecast is available for this point right now. Warnings, if any, ' +
            'are still shown and still come from Environment Canada.'
      };
    }

    store(key, payload);
    return res.json(payload);
  });

  app.get('/api/weather/alerts', async (req: Request, res: Response) => {
    const coords = readCoords(req, ['minLat', 'minLon', 'maxLat', 'maxLon']);
    if (!coords) return res.status(400).json({ error: 'minLat, minLon, maxLat, maxLon required' });
    const [minLat, minLon, maxLat, maxLon] = coords;

    const key = `alerts:${coords.map((n) => n.toFixed(1)).join(',')}`;
    const hit = cached<any>(key, ALERTS_TTL_MS);
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