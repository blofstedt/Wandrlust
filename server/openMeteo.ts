/**
 * Open-Meteo — the forecast source for everywhere the NWS doesn't cover.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * THE BUG THIS FIXES: "forecast not available" for every Canadian user, which
 * is to say for the whole reason this app supports Canada.
 *
 * The app had exactly one forecast source, the US National Weather Service.
 * North of the border it fell through to Environment Canada, which publishes
 * ALERTS openly through its GeoMet OGC endpoint but does not publish point
 * FORECASTS there. So the Canadian branch returned an empty period list and a
 * note explaining the absence, and every panel that wanted a forecast — the
 * campsite sheet, and now the arrival forecast that the whole navigation
 * feature is built around — had nothing to draw.
 *
 * Open-Meteo fills it: free, no key, no rate limit worth worrying about for
 * this volume, global, and hourly. Its Canadian data is largely ECCC's own
 * HRDPS and RDPS models, so this is not a lesser source so much as the same
 * source through a queryable door.
 *
 * ALERTS ARE NOT TOUCHED. Fire, flood and storm warnings still come only from
 * NWS and Environment Canada, because an alert carries legal weight and a
 * chain of custody, and a model interpolation does not. A forecast says what
 * the sky will probably do. An alert says an agency has decided you are in
 * danger. Those are different things and only one of them gets to come from a
 * convenience API.
 *
 * ---------------------------------------------------------------------------
 * WHY HOURLY
 * ---------------------------------------------------------------------------
 *
 * The arrival forecast asks "what will it be doing when I get there", and NWS
 * twelve-hour periods answer that with "sometime this afternoon" — which for a
 * three-hour drive is the same block you set off in. Hourly makes the answer
 * mean something.
 */

/** One hour of forecast, in the shape the client already renders. */
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

export interface OpenMeteoResult {
  periods: ForecastPeriod[];
  timezone: string | null;
  /** Null when the lookup failed — distinct from an empty forecast. */
  ok: boolean;
}

/**
 * Hourly forecast for a point.
 *
 * Units are chosen per country rather than globally: Fahrenheit and mph in the
 * United States, Celsius and km/h elsewhere. This is the one place in the app
 * where the unit is decided by where the CAMPSITE is rather than by a user
 * setting, and that is deliberate — a forecast is compared against road signs
 * and local radio, not against a preference.
 */
export const fetchOpenMeteo = async (
  lat: number,
  lon: number,
  imperial: boolean
): Promise<OpenMeteoResult> => {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    forecast_days: '3',
    timezone: 'auto',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: controller.signal
    });
    if (!res.ok) return { periods: [], timezone: null, ok: false };

    const data = await res.json();
    const hourly = data?.hourly;
    if (!Array.isArray(hourly?.time)) return { periods: [], timezone: null, ok: false };

    const unit = imperial ? 'F' : 'C';
    const speedUnit = imperial ? 'mph' : 'km/h';
    const now = Date.now();

    const periods: ForecastPeriod[] = [];

    for (let i = 0; i < hourly.time.length; i += 1) {
      /**
       * Open-Meteo returns local wall-clock strings with `timezone=auto`, and
       * no offset on them. Parsed as-is a browser would read them as its own
       * local time, so a camper in Calgary looking at a site in Nevada would
       * see the hours shifted. The offset the API reports alongside is applied
       * here, on the server, once.
       */
      const offsetSeconds = Number(data.utc_offset_seconds) || 0;
      const startTime = new Date(
        new Date(`${hourly.time[i]}Z`).getTime() - offsetSeconds * 1000
      );
      if (Number.isNaN(startTime.getTime())) continue;

      // Everything before the current hour is history, not forecast.
      if (startTime.getTime() < now - 60 * 60_000) continue;

      const code = hourly.weather_code?.[i];
      const temperature = hourly.temperature_2m?.[i];
      if (typeof temperature !== 'number') continue;

      const windSpeed = hourly.wind_speed_10m?.[i];

      periods.push({
        // Rendered in the viewer's locale on the client; this is the fallback
        // label and the one used for accessibility text.
        name: startTime.toLocaleTimeString('en-US', {
          hour: 'numeric',
          timeZone: data.timezone || 'UTC'
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

      // Two days of hours is plenty for planning a drive, and keeps the
      // payload small enough for a phone on one bar.
      if (periods.length >= 48) break;
    }

    return { periods, timezone: data?.timezone ?? null, ok: true };
  } catch {
    return { periods: [], timezone: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
};
