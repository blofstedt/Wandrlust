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
  NWS_BASE, getJson, fetchNwsAlertsAtPoint, fetchEcccAlerts, looksUS,
  fetchNwsAlertsForStates, resolveNwsZoneGeometry, describeFailure,
  type FetchFailure
} from './alertSources.js';
import { fetchOpenMeteo } from './openMeteo.js';
import { statesInBbox, stateDistanceRank } from './usStates.js';

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

/**
 * Does an alert's area overlap the requested viewport?
 *
 * Bounding box against bounding box, deliberately. It over-includes an alert
 * whose box clips the view while its polygon does not, and over-including a
 * warning is the safe direction to be wrong in.
 */
const intersectsBox = (
  geometry: any,
  minLat: number, minLon: number, maxLat: number, maxLon: number
): boolean => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (node: any): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      return;
    }
    node.forEach(walk);
  };
  walk(geometry?.coordinates);
  // No usable coordinates: keep it rather than drop it.
  if (!Number.isFinite(w) || !Number.isFinite(s)) return true;
  return !(e < minLon || w > maxLon || n < minLat || s > maxLat);
};

/* ------------------------------------------------------------------ */
/* How much ground one alerts query may ask about                      */
/* ------------------------------------------------------------------ */
/**
 * THE VIEWPORT IS NOT ALLOWED TO BE A CONTINENT, AND THIS IS WHY.
 *
 * The client asks for its viewport padded to three times its own size, so a
 * camper zoomed out to "the west" was asking this endpoint about roughly forty
 * degrees of latitude. That box touches twenty states, and every zone-based
 * product in twenty states — every heat advisory, every cold snap, every air
 * quality statement — arrives with a null geometry and has to have its forecast
 * zones fetched one batch at a time before it can be drawn at all.
 *
 * One gesture therefore fanned out into a hundred-odd requests to
 * api.weather.gov, several such gestures were in flight at once because a pan
 * is a stream of them, and NWS did the only sensible thing and started refusing
 * them. A refused feed came back null, null meant "we could not check", and the
 * whole response was thrown away — which is what put the map in the state it
 * was reported in: American clouds left over from an earlier, tighter view,
 * nothing at all over Canada, and the layer blinking as the occasional request
 * squeaked through.
 *
 * So the query is clamped. Past this much ground a cloud is a smear a few
 * pixels wide that tells a camper nothing anyway, and asking for it costs the
 * warnings they CAN read. The response says when it has been clamped, and the
 * client keeps asking rather than recording the whole padded box as loaded.
 */
const MAX_SPAN_LAT = 14;
const MAX_SPAN_LON = 24;

/**
 * Most states one query will ask NWS about, nearest the middle of the view
 * first.
 *
 * The cap is on the ZONE LOOKUPS that follow, not really on the alert query
 * itself — twenty states of zone-based products is what blows the budget. Ten
 * comfortably covers a clamped box, and `stateDistanceRank` makes sure the ten
 * are the ones under the camper rather than the ones the table happened to
 * list first.
 */
const MAX_STATES = 10;

interface ClampedBox {
  minLat: number; minLon: number; maxLat: number; maxLon: number;
  /** True when the caller asked about more ground than this box covers. */
  clipped: boolean;
}

const clampBox = (
  minLat: number, minLon: number, maxLat: number, maxLon: number
): ClampedBox => {
  const centreLat = (minLat + maxLat) / 2;
  const centreLon = (minLon + maxLon) / 2;
  const spanLat = Math.abs(maxLat - minLat);
  const spanLon = Math.abs(maxLon - minLon);

  const clipped = spanLat > MAX_SPAN_LAT || spanLon > MAX_SPAN_LON;
  if (!clipped) return { minLat, minLon, maxLat, maxLon, clipped: false };

  const halfLat = Math.min(spanLat, MAX_SPAN_LAT) / 2;
  const halfLon = Math.min(spanLon, MAX_SPAN_LON) / 2;

  return {
    minLat: centreLat - halfLat,
    maxLat: centreLat + halfLat,
    minLon: centreLon - halfLon,
    maxLon: centreLon + halfLon,
    clipped: true
  };
};

/** Whether a feed answered, per feed, in the shape the client reads. */
type FeedState = 'ok' | 'unreachable' | 'skipped';

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
      const [ecccAlerts, forecast] = await Promise.all([
        fetchEcccAlerts(lat, lon),
        fetchOpenMeteo(lat, lon, false)
      ]);

      /*
       * Null means GeoMet did not answer. There is nothing to draw either way,
       * but the NOTE has to change: "no warnings here" and "we could not ask
       * about warnings here" are the two different things this app exists to
       * keep apart, and a camper reading the second as the first is exactly
       * the failure that matters.
       */
      const alertsUnavailable = ecccAlerts === null;
      const alerts = ecccAlerts ?? [];

      payload = {
        updatedAt: new Date().toISOString(),
        timezone: forecast.timezone,
        periods: forecast.periods,
        alerts,
        alertsUnavailable,
        source: forecast.periods.length > 0 ? 'open-meteo' : alerts.length > 0 ? 'eccc' : 'none',
        resolution: 'hourly',
        note: alertsUnavailable
          ? 'Environment Canada could not be reached, so warnings could not be checked ' +
            'for this point. That is not the same as there being none.'
          : forecast.periods.length > 0
            ? 'Forecast from Open-Meteo, which serves Environment Canada model data. ' +
              'Warnings and watches come from Environment Canada directly.'
            : 'No forecast is available for this point right now. Warnings, if any, ' +
              'are still shown and still come from Environment Canada.'
      };
    }

    /*
     * Never cache a lookup that could not reach the alert feed. Ten minutes is
     * the right TTL for a forecast and far too long to keep repeating "we
     * could not check for warnings" after the feed has come back.
     */
    if (!(payload as { alertsUnavailable?: boolean })?.alertsUnavailable) {
      store(key, payload);
    }
    return res.json(payload);
  });

  app.get('/api/weather/alerts', async (req: Request, res: Response) => {
    const coords = readCoords(req, ['minLat', 'minLon', 'maxLat', 'maxLon']);
    if (!coords) return res.status(400).json({ error: 'minLat, minLon, maxLat, maxLon required' });
    const [minLat, minLon, maxLat, maxLon] = coords;

    const box = clampBox(minLat, minLon, maxLat, maxLon);

    const key = `alerts:${[box.minLat, box.minLon, box.maxLat, box.maxLon]
      .map((n) => n.toFixed(1)).join(',')}`;
    const hit = cached<any>(key, ALERTS_TTL_MS);
    if (hit) return res.json(hit);

    const centreLat = (box.minLat + box.maxLat) / 2;
    const centreLon = (box.minLon + box.maxLon) / 2;
    // Half-height and half-width separately: GeoMet is asked about the box on
    // screen, not about a square drawn round its longer side.
    const halfLat = Math.max(Math.abs(box.maxLat - box.minLat) / 2, 1.0);
    const halfLon = Math.max(Math.abs(box.maxLon - box.minLon) / 2, 1.5);

    /**
     * ASK BY STATE, NOT BY POINT.
     *
     * This used to ask NWS for alerts at the single coordinate in the middle of
     * the viewport. Everything the user could see but was not centred on — the
     * heat advisory over the next range, the smoke two counties north — was
     * never requested, so it could never be drawn. States are the coarsest
     * thing the NWS API will answer for, and one request covers the screen.
     *
     * Capped and sorted nearest-first: see MAX_STATES.
     */
    const states = statesInBbox(box.minLon, box.minLat, box.maxLon, box.maxLat)
      .map((code) => ({ code, rank: stateDistanceRank(code, centreLat, centreLon) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_STATES)
      .map((entry) => entry.code);

    /**
     * Canada does not start at the 49th parallel everywhere.
     *
     * The old test was `maxLat > 48.0`, which is right west of the lakes and
     * wrong for exactly the places this app supports best: southern Ontario
     * sits at 42–44°N, so every Environment Canada warning around Toronto,
     * Windsor and the north shore of Lake Erie was skipped outright.
     */
    const touchesCanada =
      box.maxLat > 48.5 || (box.maxLat > 41.6 && box.maxLon > -95.5);

    /**
     * BOTH FEEDS AT ONCE, WHICH THEY NEVER WERE.
     *
     * NWS was awaited, then its zone outlines were awaited, and only then was
     * Environment Canada asked. Three timeouts end to end came to more than
     * the thirty seconds this function is allowed to live, so on a slow morning
     * the Canadian half of the map was being fetched by a request the platform
     * had already killed. They do not depend on each other and never did.
     */
    /**
     * WHY a feed said no, kept alongside the fact that it did.
     *
     * Not for the camper — "HTTP 403" helps nobody deciding where to sleep, and
     * the map still says only that warnings could not be checked. It is for
     * whoever has to work out what is wrong, because the previous version threw
     * the reason away and a feed that had been refusing this deployment since
     * the day it launched was indistinguishable from a phone with no signal.
     */
    const failures: Partial<Record<'nws' | 'eccc', FetchFailure>> = {};

    const [nwsAlerts, ecccAlerts] = await Promise.all([
      states.length > 0
        ? fetchNwsAlertsForStates(states, (f) => { failures.nws = f; }).then((rows) => (
            rows === null
              ? null
              // Zone-based products (heat, cold, smoke, wind, red flag) arrive
              // with a null geometry and a list of the zones they cover.
              // Resolve the zones nearest the middle of the view first: the
              // lookup budget decides which alerts can be drawn at all.
              : resolveNwsZoneGeometry(rows, { lat: centreLat, lon: centreLon })
          ))
        : Promise.resolve<any[] | null>([]),
      touchesCanada
        ? fetchEcccAlerts(
            centreLat, centreLon, halfLat, halfLon, (f) => { failures.eccc = f; }
          )
        : Promise.resolve<any[] | null>(null)
    ]);

    const feeds: Record<'nws' | 'eccc', FeedState> = {
      nws: states.length === 0 ? 'skipped' : nwsAlerts === null ? 'unreachable' : 'ok',
      eccc: !touchesCanada ? 'skipped' : ecccAlerts === null ? 'unreachable' : 'ok'
    };

    // Logged as well as returned: the response is only seen by whoever thinks
    // to look at it, and a feed refusing every request all day should be
    // visible in the deployment's own logs without anybody hunting for it.
    (['nws', 'eccc'] as const).forEach((id) => {
      if (feeds[id] === 'unreachable') {
        console.warn(`[alerts] ${id} unreachable: ${describeFailure(failures[id] ?? null)}`);
      }
    });

    const collected: any[] = [...(nwsAlerts ?? []), ...(ecccAlerts ?? [])];

    // De-duplicate by id; the two feeds overlap near the border.
    const seen = new Set<string>();
    const deduped = collected.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    /**
     * Back down to what is actually on screen.
     *
     * A state-wide query returns warnings from corners of the state the user is
     * nowhere near. Anything we could place is kept only if its area really
     * overlaps the requested box. Anything we could NOT place is kept as-is —
     * the client counts those and tells the user how many alerts it could not
     * position, and quietly dropping them would turn an honest gap into a
     * silent one.
     */
    const alerts = deduped.filter((a) => !a.geometry || intersectsBox(
      a.geometry, box.minLat, box.minLon, box.maxLat, box.maxLon
    ));

    /**
     * NOTHING ANSWERED AT ALL. That, and only that, is a 503.
     *
     * There is no half of this worth drawing and nothing worth caching, and the
     * client's contract for a non-OK response is to keep whatever warnings it
     * already has and try again — which is the right thing to do when we know
     * nothing.
     */
    const answered = Object.values(feeds).filter((state) => state === 'ok').length;
    const asked = Object.values(feeds).filter((state) => state !== 'skipped').length;

    if (asked > 0 && answered === 0) {
      return res.status(503).json({
        error: 'The weather alert feeds could not be reached.',
        detail: 'This is not a report that no warnings are in force.',
        feeds
      });
    }

    /**
     * ONE FEED ANSWERED AND THE OTHER DID NOT — DRAW THE HALF WE HAVE, AND SAY
     * WHICH HALF IS MISSING.
     *
     * This used to be a 503 as well, on the reasoning that a map showing the
     * Canadian half of the border while NWS is down is more misleading than one
     * that admits it does not know. That reasoning was right about the danger
     * and wrong about what the code actually did: throwing the response away
     * did not make the map admit anything. It left the previous answer sitting
     * on screen, unlabelled and now stale, which is the same lie with an extra
     * step — and it is exactly what was reported: American warnings drawn
     * beside a blank Canada.
     *
     * So the half we have is returned WITH the gap named, and the client puts
     * the gap on the screen where the camper can read it. `partial` is what
     * stops the client recording the area as loaded, so it keeps retrying until
     * the missing feed comes back.
     */
    const partial = asked > 0 && answered < asked;

    const payload = {
      alerts,
      fetchedAt: new Date().toISOString(),
      feeds,
      /** Diagnostic only. Never rendered — see the note on `failures`. */
      feedDetail: {
        nws: describeFailure(failures.nws ?? null),
        eccc: describeFailure(failures.eccc ?? null)
      },
      partial,
      /** True when this answer covers less ground than the caller asked about. */
      clipped: box.clipped,
      area: {
        minLat: box.minLat, minLon: box.minLon,
        maxLat: box.maxLat, maxLon: box.maxLon
      }
    };

    // A partial answer is never cached. Five minutes of serving one feed's
    // silence to every camper in the region is how a blip becomes an outage.
    if (!partial) store(key, payload);
    return res.json(payload);
  });
};