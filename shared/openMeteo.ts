/**
 * Reading an Open-Meteo response, shared by the server and the browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED RATHER THAN SERVER-ONLY
 * ---------------------------------------------------------------------------
 *
 * The forecast used to have exactly one route to the screen: our own
 * `/api/weather`. When that endpoint broke — and it did, silently, for a whole
 * release — every camper saw "Weather unavailable (404)" on every spot, and
 * there was nothing the app could do about it from the client.
 *
 * Open-Meteo needs no key and sends permissive CORS headers, so the browser
 * can ask it directly. That makes it a genuine last rung: if our own API is
 * down, misconfigured, or mid-deploy, the app still puts a real forecast on
 * screen instead of an apology. The parsing had to be shared for that, and
 * `shared/hazards.ts` already exists for exactly this reason — two copies of
 * the same weather logic is how they drift.
 *
 * ALERTS ARE NOT IN HERE AND MUST NOT BE. Fire, flood and storm warnings come
 * only from the National Weather Service and Environment Canada. A forecast
 * says what the sky will probably do; an alert says an agency has decided you
 * are in danger. Only one of those gets to come from a convenience API.
 */

/** One hour of forecast, in the shape every panel in the app renders. */
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
 * WMO weather interpretation codes.
 *
 * The full table from the WMO 4677 code set that Open-Meteo publishes. Written
 * out rather than bucketed, because "light freezing drizzle" and "heavy snow"
 * are different decisions for somebody sleeping in a van.
 */
const WMO_CODE: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Light snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail'
};

/** Compass point from a bearing, for the wind direction label. */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const compass = (degrees: number | null | undefined): string | null =>
  typeof degrees === 'number'
    ? COMPASS[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16]
    : null;

/**
 * The query string for an hourly forecast at a point.
 *
 * Units are chosen per country rather than globally: Fahrenheit and mph in the
 * United States, Celsius and km/h elsewhere. This is the one place in the app
 * where the unit is decided by where the CAMPSITE is rather than by a user
 * setting, and that is deliberate — a forecast is compared against road signs
 * and local radio, not against a preference.
 */
export const openMeteoUrl = (lat: number, lon: number, imperial: boolean): string => {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    forecast_days: '3',
    timezone: 'auto',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh'
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
};

export interface OpenMeteoResult {
  periods: ForecastPeriod[];
  timezone: string | null;
  /** False when the lookup failed — distinct from an empty forecast. */
  ok: boolean;
}

export const EMPTY_OPEN_METEO: OpenMeteoResult = {
  periods: [], timezone: null, ok: false
};

/** Turn a raw Open-Meteo body into forecast periods. Never throws. */
export const parseOpenMeteo = (data: any, imperial: boolean): OpenMeteoResult => {
  const hourly = data?.hourly;
  if (!Array.isArray(hourly?.time)) return EMPTY_OPEN_METEO;

  const unit = imperial ? 'F' : 'C';
  const speedUnit = imperial ? 'mph' : 'km/h';
  const now = Date.now();

  /**
   * Open-Meteo returns local wall-clock strings with `timezone=auto`, and no
   * offset on them. Parsed as-is a browser would read them as its own local
   * time, so a camper in Calgary looking at a site in Nevada would see the
   * hours shifted. The offset the API reports alongside is applied once, here.
   */
  const offsetSeconds = Number(data?.utc_offset_seconds) || 0;

  const periods: ForecastPeriod[] = [];

  for (let i = 0; i < hourly.time.length; i += 1) {
    const startTime = new Date(
      new Date(`${hourly.time[i]}Z`).getTime() - offsetSeconds * 1000
    );
    if (Number.isNaN(startTime.getTime())) continue;

    // Everything before the current hour is history, not forecast.
    if (startTime.getTime() < now - 60 * 60_000) continue;

    const temperature = hourly.temperature_2m?.[i];
    if (typeof temperature !== 'number') continue;

    const code = hourly.weather_code?.[i];
    const windSpeed = hourly.wind_speed_10m?.[i];

    periods.push({
      // Rendered in the viewer's locale on the client; this is the fallback
      // label and the one used for accessibility text.
      name: startTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        timeZone: data?.timezone || 'UTC'
      }),
      startTime: startTime.toISOString(),
      isDaytime: hourly.is_day?.[i] === 1,
      temperature: Math.round(temperature),
      temperatureUnit: unit,
      windSpeed: typeof windSpeed === 'number'
        ? `${Math.round(windSpeed)} ${speedUnit}`
        : null,
      windDirection: compass(hourly.wind_direction_10m?.[i]),
      shortForecast: WMO_CODE[code] ?? 'Unknown',
      detailedForecast: '',
      precipProbability: typeof hourly.precipitation_probability?.[i] === 'number'
        ? hourly.precipitation_probability[i]
        : null,
      icon: null
    });

    // Two days of hours is plenty for planning a drive, and keeps the payload
    // small enough for a phone on one bar.
    if (periods.length >= 48) break;
  }

  return { periods, timezone: data?.timezone ?? null, ok: true };
};

/**
 * Fetch and parse in one call, for whichever side is asking.
 *
 * Takes its own fetch timeout because the server runs inside a capped
 * serverless invocation and the browser does not.
 */
export const fetchOpenMeteoForecast = async (
  lat: number,
  lon: number,
  imperial: boolean,
  timeoutMs = 10_000,
  signal?: AbortSignal
): Promise<OpenMeteoResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(openMeteoUrl(lat, lon, imperial), { signal: controller.signal });
    if (!res.ok) return EMPTY_OPEN_METEO;
    return parseOpenMeteo(await res.json(), imperial);
  } catch {
    return EMPTY_OPEN_METEO;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

/** Rough test for "is this coordinate in the contiguous US" — picks the units. */
export const isUnitedStates = (lat: number, lon: number): boolean =>
  lat >= 24.4 && lat <= 49.5 && lon >= -125.1 && lon <= -66.8;