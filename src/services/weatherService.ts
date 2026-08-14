/**
 * Weather, forecasts, and hazard alerts.
 *
 * Free government sources, no API keys:
 *   US     NWS      api.weather.gov      (requires a User-Agent contact string)
 *   Canada ECCC     api.weather.gc.ca    (OGC API Features)
 *
 * Both are proxied through our own server so we can set the User-Agent NWS
 * asks for, cache responses, and avoid per-origin CORS differences.
 *
 * The classifier itself lives in `shared/hazards.ts` — it is used identically
 * on the server, and two copies of a safety-critical regex is how they drift.
 */
import {
  classifyHazard, SEVERITY_RANK,
  type HazardFamily, type AlertSeverity, type AlertUrgency
} from '../../shared/hazards';
import { fetchOpenMeteoForecast, isUnitedStates } from '../../shared/openMeteo';

export type { HazardFamily, AlertSeverity, AlertUrgency };
export { classifyHazard };

export interface HazardAlert {
  id: string;
  family: HazardFamily;
  event: string;
  headline: string;
  description: string;
  instruction: string | null;
  severity: AlertSeverity;
  urgency: AlertUrgency;
  certainty: string | null;
  areaDescription: string;
  sender: string;
  effective: string | null;
  expires: string | null;
  source: 'nws' | 'eccc';
  /**
   * The area the alert covers, as GeoJSON, when the feed supplied one.
   *
   * Frequently absent: NWS sends `geometry: null` for zone-based products and
   * names the zones by URL instead. An alert without this cannot be drawn on
   * the map, and is deliberately not given an invented position — it appears
   * in the alert list only.
   */
  geometry?: unknown;
  /** `[lat, lon]` centre of `geometry`. Present exactly when `geometry` is. */
  centroid?: [number, number];
  /**
   * What `geometry` actually is.
   *
   *   'polygon' — the agency drew this shape for this alert. A storm-based
   *               warning: the area is the hazard.
   *   'zone'    — the alert named forecast zones and we drew those zones'
   *               published outlines. Heat, cold, smoke and wind products are
   *               all issued this way. The shape is the region under warning,
   *               NOT the edge of the hazard, and the UI says so.
   *
   * Absent when the alert could not be placed at all.
   */
  areaSource?: 'polygon' | 'zone';
  /**
   * How many separate forecast regions this one alert covers.
   *
   * Environment Canada publishes an alert once PER REGION, so a snowfall
   * warning over the Rockies arrives as thirty rows sharing one code. They are
   * merged back into a single alert server-side; this is the count that was
   * merged, so the UI can say "12 areas" rather than drawing twelve markers
   * that all mean the same thing.
   */
  zoneCount?: number;
}

export interface ForecastPeriod {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string | null;
  windDirection: string | null;
  shortForecast: string;
  detailedForecast: string;
  precipProbability: number | null;
  icon: string | null;
}

/**
 * How finely the forecast is sliced.
 *
 * Matters because the arrival forecast is only meaningfully different from the
 * current one at hourly resolution — a twelve-hour block swallows most drives
 * whole — and the UI has to be able to say which it is looking at rather than
 * implying an hour-by-hour prediction it does not have.
 */
export type ForecastResolution = 'hourly' | 'twelve_hour';

export interface WeatherSnapshot {
  updatedAt: string;
  timezone: string | null;
  periods: ForecastPeriod[];
  alerts: HazardAlert[];
  /**
   * Where the FORECAST came from. Alerts always come from NWS or Environment
   * Canada regardless of this value — a model interpolation never gets to
   * carry a warning.
   */
  source: 'nws' | 'eccc' | 'open-meteo' | 'none';
  resolution?: ForecastResolution;
  note?: string;
}

export const EMPTY_WEATHER: WeatherSnapshot = {
  updatedAt: new Date(0).toISOString(),
  timezone: null,
  periods: [],
  alerts: [],
  source: 'none'
};

/** Named so the UI can credit the forecast without a lookup table inline. */
export const SOURCE_LABEL: Record<WeatherSnapshot['source'], string> = {
  nws: 'US National Weather Service',
  eccc: 'Environment Canada',
  'open-meteo': 'Open-Meteo (Environment Canada model data in Canada)',
  none: 'no source'
};

/**
 * The colours here are the SAME hexes the map draws each family in
 * (`BADGE_COLOR` in src/utils/alertOverlay.ts). A camper who taps a teal pin
 * has to land on a teal card, or the two look like two different warnings.
 * If you change one, change the other.
 */
export const HAZARD_STYLE: Record<
  HazardFamily,
  { label: string; color: string; bg: string; border: string; icon: string }
> = {
  fire: { label: 'Fire', color: '#EA580C', bg: 'bg-orange-950/60', border: 'border-orange-600/60', icon: '🔥' },
  flood: { label: 'Flood / rain', color: '#14B8A6', bg: 'bg-teal-950/60', border: 'border-teal-600/60', icon: '🌊' },
  storm: { label: 'Storm', color: '#7C3AED', bg: 'bg-violet-950/60', border: 'border-violet-600/60', icon: '⛈️' },
  winter: { label: 'Cold', color: '#7DD3FC', bg: 'bg-sky-950/60', border: 'border-sky-600/60', icon: '❄️' },
  heat: { label: 'Heat', color: '#B91C1C', bg: 'bg-red-950/60', border: 'border-red-600/60', icon: '🌡️' },
  wind: { label: 'Wind', color: '#94A3B8', bg: 'bg-slate-800/60', border: 'border-slate-600/60', icon: '💨' },
  other: { label: 'Advisory', color: '#64748B', bg: 'bg-slate-800/60', border: 'border-slate-600/60', icon: 'ℹ️' }
};

/** Highest severity first, then soonest expiry. */
export const sortAlerts = (alerts: HazardAlert[]): HazardAlert[] =>
  [...alerts].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.expires ?? '').localeCompare(b.expires ?? '');
  });

/** True for anything a camper should act on before pitching. */
export const isActionable = (alert: HazardAlert): boolean =>
  SEVERITY_RANK[alert.severity] >= SEVERITY_RANK.severe ||
  alert.family === 'fire' ||
  alert.family === 'flood';

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; data: WeatherSnapshot }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 60;

/**
 * Straight to Open-Meteo, when our own API cannot answer.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A SAFETY NET, AND IT IS DELIBERATELY HALF AN ANSWER
 * ---------------------------------------------------------------------------
 *
 * `/api/weather` went down for a whole release — a server module failed to
 * import, the endpoint 404'd, and every camper saw "Weather unavailable" on
 * every spot with no way for the app to recover. Open-Meteo needs no key and
 * sends permissive CORS headers, so the browser can ask it directly. That
 * turns an outage of our own making into a working forecast.
 *
 * WHAT IT CANNOT DO IS ALERTS, and the note says so out loud. Warnings come
 * only from the National Weather Service and Environment Canada, both of which
 * we reach through our own server. An empty alert list from this path means
 * "we could not check", and if that ever renders as "all clear" then this
 * fallback has made the app more dangerous rather than less.
 */
const directForecast = async (
  latitude: number,
  longitude: number,
  reason: string,
  signal?: AbortSignal
): Promise<WeatherSnapshot> => {
  const result = await fetchOpenMeteoForecast(
    latitude, longitude, isUnitedStates(latitude, longitude), 10_000, signal
  );

  if (result.periods.length === 0) {
    return { ...EMPTY_WEATHER, note: `No forecast available right now (${reason}).` };
  }

  return {
    updatedAt: new Date().toISOString(),
    timezone: result.timezone,
    periods: result.periods,
    alerts: [],
    source: 'open-meteo',
    resolution: 'hourly',
    note:
      `Forecast fetched straight from Open-Meteo because this app's own ` +
      `weather service is unreachable (${reason}). WARNINGS AND WATCHES ARE ` +
      'NOT INCLUDED on this route — check the National Weather Service or ' +
      'Environment Canada before you rely on the sky being clear.'
  };
};

/**
 * Never throws, and tries not to come back empty.
 *
 * Our own API first, because only it can carry official alerts alongside the
 * forecast. Open-Meteo directly if that fails, because a forecast without
 * alerts beats a blank panel — as long as the missing alerts are stated.
 */
export const fetchWeather = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<WeatherSnapshot> => {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const remember = (data: WeatherSnapshot): WeatherSnapshot => {
    // Bounded: a long trip planning session used to grow this map forever.
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), data });
    return data;
  };

  try {
    const res = await fetch(
      `/api/weather?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
      { signal }
    );

    if (!res.ok) return remember(await directForecast(latitude, longitude, `${res.status}`, signal));

    const data = (await res.json()) as WeatherSnapshot;

    // The endpoint answered but had nothing — both government feeds and the
    // server's own Open-Meteo leg came back empty. Worth one more try from
    // here: a serverless function blocked upstream still leaves the phone with
    // a working route to the same data.
    if (!Array.isArray(data.periods) || data.periods.length === 0) {
      const direct = await directForecast(latitude, longitude, 'empty response', signal);
      if (direct.periods.length > 0) {
        // Alerts DID come back from our own server on this path, so keep them
        // rather than dropping them with the empty forecast.
        return remember({
          ...direct,
          alerts: Array.isArray(data.alerts) ? data.alerts : [],
          note: Array.isArray(data.alerts)
            ? 'No official forecast covers this point, so the hours below come ' +
              'from Open-Meteo. Warnings and watches are unaffected.'
            : direct.note
        });
      }
      return remember(data);
    }

    return remember(data);
  } catch {
    // Aborted by the caller — not a failure, and it must not be cached.
    if (signal?.aborted) return EMPTY_WEATHER;

    const direct = await directForecast(latitude, longitude, 'offline', signal);
    return direct.periods.length > 0
      ? remember(direct)
      : { ...EMPTY_WEATHER, note: 'Weather unavailable offline' };
  }
};

export interface AreaAlertResult {
  /**
   * False when the lookup did not complete — offline, a 5xx, a cold serverless
   * function, a phone whose radio has not woken up yet.
   *
   * THIS FLAG IS THE WHOLE POINT OF THIS TYPE. It used to return a bare array
   * and fold every one of those cases into `[]`, which the map then drew as
   * fact: the warning clouds were wiped off the screen by a request that never
   * got an answer. "We could not check" and "there is nothing in force" are
   * different facts about the weather, and only one of them is safe to draw.
   */
  ok: boolean;
  alerts: HazardAlert[];
  /** True when the request was cancelled by the caller. Not a failure. */
  aborted: boolean;
}

/** Alerts only, for a wide area — the map-wide hazard layer. */
export const fetchAreaAlerts = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  signal?: AbortSignal
): Promise<AreaAlertResult> => {
  try {
    const params = new URLSearchParams({
      minLat: bbox.minLat.toFixed(4),
      minLon: bbox.minLon.toFixed(4),
      maxLat: bbox.maxLat.toFixed(4),
      maxLon: bbox.maxLon.toFixed(4)
    });

    const res = await fetch(`/api/weather/alerts?${params}`, { signal });
    if (!res.ok) return { ok: false, alerts: [], aborted: false };

    const data = await res.json();
    // A 200 carrying no `alerts` array is a broken response, not a quiet sky.
    if (!Array.isArray(data?.alerts)) return { ok: false, alerts: [], aborted: false };

    return { ok: true, alerts: sortAlerts(data.alerts), aborted: false };
  } catch {
    // An abort is the caller changing their mind, and the caller already
    // ignores superseded responses. It is neither a failure nor an answer.
    return { ok: false, alerts: [], aborted: Boolean(signal?.aborted) };
  }
};

/* ------------------------------------------------------------------ *
 * The connection to the issuing agencies
 * ------------------------------------------------------------------ */

export interface AlertAuthority {
  id: string;
  name: string;
  scope: string;
  covers: string;
  url: string;
}

export interface AlertFeedStatus {
  /** False when this deployment has no service-role key — nothing is pushed. */
  configured: boolean;
  pushDispatchConfigured: boolean;
  intervalMinutes: number;
  authorities: AlertAuthority[];
  activeAlerts: number | null;
  lastRun: {
    finishedAt: string;
    ok: boolean;
    feeds: Record<string, { state: 'ok' | 'unreachable' | 'skipped'; received: number }>;
    error: string | null;
  } | null;
}

/**
 * Whether the official alert feed is actually connected.
 *
 * Returns null when the endpoint cannot be reached, which the UI must show as
 * "unknown" rather than "fine" — a silent alert pipeline is the failure mode
 * that matters most here.
 */
export const fetchAlertFeedStatus = async (
  signal?: AbortSignal
): Promise<AlertFeedStatus | null> => {
  try {
    const res = await fetch('/api/alerts/status', { signal });
    if (!res.ok) return null;
    return (await res.json()) as AlertFeedStatus;
  } catch {
    return null;
  }
};

/** Compact "what's it like on arrival" string for cards and sheets. */
export const summarise = (snapshot: WeatherSnapshot): string => {
  if (snapshot.periods.length === 0) return 'No forecast available';
  const now = snapshot.periods[0];
  return `${now.shortForecast}, ${now.temperature}°${now.temperatureUnit}`;
};

/* ------------------------------------------------------------------ *
 * What it will be like when you get there
 * ------------------------------------------------------------------ */

export interface ArrivalForecast {
  /** When we think you arrive, given the route's driving time. */
  arrivesAt: Date;
  /** The forecast period covering that moment, or null if none reaches it. */
  period: ForecastPeriod | null;
  /** True when arrival falls inside the first period — i.e. it's basically now. */
  isNow: boolean;
  /**
   * Why there is no period, when there isn't one. Either the forecast doesn't
   * reach that far out, or there is no forecast at all.
   */
  note?: string;
}

/**
 * Match a driving time against the forecast timeline.
 *
 * NWS publishes twelve-hour day/night periods and Environment Canada
 * something similar, so a three-hour drive usually lands inside the period
 * you are already in — which is worth saying out loud rather than dressing a
 * present-tense forecast up as a prediction. `isNow` is what lets the UI make
 * that distinction.
 *
 * A period is treated as running until the next one starts, and the last
 * period until the forecast simply ends. Beyond that we say we don't know,
 * because a multi-day drive is past the point where any of this is a forecast.
 */
export const forecastOnArrival = (
  snapshot: WeatherSnapshot,
  travelMinutes: number
): ArrivalForecast => {
  const arrivesAt = new Date(Date.now() + Math.max(0, travelMinutes) * 60_000);

  if (snapshot.periods.length === 0) {
    return { arrivesAt, period: null, isNow: false, note: 'No forecast available here' };
  }

  const at = arrivesAt.getTime();
  const starts = snapshot.periods.map((p) => new Date(p.startTime).getTime());

  for (let i = 0; i < snapshot.periods.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
    if (Number.isNaN(start)) continue;

    // Before the first period means we arrive sooner than the forecast's own
    // clock, which happens when the feed is a few minutes stale.
    if (at < start && i === 0) {
      return { arrivesAt, period: snapshot.periods[0], isNow: true };
    }
    if (at >= start && at < end) {
      // The last period has no end, so anything past its start would match it
      // forever. Cap it at a day out and admit we don't know beyond that.
      if (end === Number.POSITIVE_INFINITY && at - start > 24 * 60 * 60_000) {
        return {
          arrivesAt,
          period: null,
          isNow: false,
          note: 'That is further out than the forecast goes'
        };
      }
      return { arrivesAt, period: snapshot.periods[i], isNow: i === 0 };
    }
  }

  return {
    arrivesAt,
    period: null,
    isNow: false,
    note: 'That is further out than the forecast goes'
  };
};