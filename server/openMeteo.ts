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
 * campsite sheet, and the arrival forecast the whole navigation feature is
 * built around — had nothing to draw.
 *
 * Open-Meteo fills it: free, no key, no rate limit worth worrying about at
 * this volume, global, and hourly. Its Canadian data is largely ECCC's own
 * HRDPS and RDPS models, so this is not a lesser source so much as the same
 * source through a queryable door.
 *
 * ALERTS ARE NOT TOUCHED. Fire, flood and storm warnings still come only from
 * NWS and Environment Canada, because an alert carries legal weight and a
 * chain of custody, and a model interpolation does not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSING LIVES IN shared/
 * ---------------------------------------------------------------------------
 *
 * Because the browser needs it too. Open-Meteo sends permissive CORS headers,
 * so the client can call it directly when our own API is unreachable — see
 * `src/services/weatherService.ts`. That fallback is what turns an API outage
 * from "no forecast anywhere in the app" into "a forecast, from one rung
 * down the ladder", and it only works if both sides read the response the
 * same way.
 */
// `.js` is required under strict ESM on Vercel. See the note in weatherRoutes.ts.
import { fetchOpenMeteoForecast, type OpenMeteoResult, type ForecastPeriod }
  from '../shared/openMeteo.js';

export type { OpenMeteoResult, ForecastPeriod };

/** Hourly forecast for a point. Never throws; a failure is `ok: false`. */
export const fetchOpenMeteo = (
  lat: number,
  lon: number,
  imperial: boolean
): Promise<OpenMeteoResult> => fetchOpenMeteoForecast(lat, lon, imperial, 10_000);