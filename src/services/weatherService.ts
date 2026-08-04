/**
 * Weather, forecasts, and hazard alerts.
 *
 * Two free government sources, no API keys:
 *   US     NWS      api.weather.gov      (requires a User-Agent contact string)
 *   Canada ECCC     api.weather.gc.ca    (OGC API Features)
 *
 * Both are proxied through our own server so we can set the User-Agent NWS
 * asks for, cache responses, and avoid per-origin CORS differences.
 *
 * Alerts are the safety-critical part. We classify every alert into a hazard
 * family so the map can colour and prioritise them, and we NEVER downgrade a
 * severity we don't recognise — unknown maps to the more cautious value.
 */

export type HazardFamily = 'fire' | 'flood' | 'storm' | 'winter' | 'heat' | 'wind' | 'other';
export type AlertSeverity = 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown';
export type AlertUrgency = 'immediate' | 'expected' | 'future' | 'past' | 'unknown';

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

export interface WeatherSnapshot {
  updatedAt: string;
  timezone: string | null;
  periods: ForecastPeriod[];
  alerts: HazardAlert[];
  source: 'nws' | 'eccc' | 'none';
  note?: string;
}

export const EMPTY_WEATHER: WeatherSnapshot = {
  updatedAt: new Date(0).toISOString(),
  timezone: null,
  periods: [],
  alerts: [],
  source: 'none'
};

/* ------------------------------------------------------------------ */
/* Hazard classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Map an NWS/ECCC event name onto a hazard family.
 *
 * Order matters: fire is checked FIRST because "Fire Weather Watch" would
 * otherwise fall through to another family, and getting fire wrong is the
 * most dangerous failure here.
 */
export const classifyHazard = (eventName: string): HazardFamily => {
  const e = (eventName ?? '').toLowerCase();

  if (/red flag|fire weather|wildfire|fire danger|burn ban|extreme fire/.test(e)) return 'fire';
  if (/flood|flash flood|hydrologic|dam break|seiche|storm surge/.test(e)) return 'flood';
  if (/tornado|thunderstorm|hurricane|tropical|typhoon|severe weather|squall|waterspout/.test(e))
    return 'storm';
  if (/snow|blizzard|ice|freez|winter|frost|sleet|avalanche|cold|chill/.test(e)) return 'winter';
  if (/heat|hot/.test(e)) return 'heat';
  if (/wind|gale|dust/.test(e)) return 'wind';
  return 'other';
};

export const HAZARD_STYLE: Record<
  HazardFamily,
  { label: string; color: string; bg: string; border: string; icon: string }
> = {
  fire: { label: 'Fire', color: '#F97316', bg: 'bg-orange-950/60', border: 'border-orange-600/60', icon: '🔥' },
  flood: { label: 'Flood', color: '#0EA5E9', bg: 'bg-sky-950/60', border: 'border-sky-600/60', icon: '🌊' },
  storm: { label: 'Storm', color: '#A855F7', bg: 'bg-purple-950/60', border: 'border-purple-600/60', icon: '⛈️' },
  winter: { label: 'Winter', color: '#38BDF8', bg: 'bg-cyan-950/60', border: 'border-cyan-600/60', icon: '❄️' },
  heat: { label: 'Heat', color: '#EF4444', bg: 'bg-red-950/60', border: 'border-red-600/60', icon: '🌡️' },
  wind: { label: 'Wind', color: '#94A3B8', bg: 'bg-slate-800/60', border: 'border-slate-600/60', icon: '💨' },
  other: { label: 'Advisory', color: '#64748B', bg: 'bg-slate-800/60', border: 'border-slate-600/60', icon: 'ℹ️' }
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: 0
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

/** Never throws: on failure returns an empty snapshot with a note. */
export const fetchWeather = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<WeatherSnapshot> => {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  try {
    const res = await fetch(
      `/api/weather?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
      { signal }
    );
    if (!res.ok) return { ...EMPTY_WEATHER, note: `Weather unavailable (${res.status})` };

    const data = (await res.json()) as WeatherSnapshot;
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return { ...EMPTY_WEATHER, note: 'Weather unavailable offline' };
  }
};

/** Alerts only, for a wide area — the map-wide hazard layer. */
export const fetchAreaAlerts = async (
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
  signal?: AbortSignal
): Promise<HazardAlert[]> => {
  try {
    const params = new URLSearchParams({
      minLat: bbox.minLat.toFixed(4),
      minLon: bbox.minLon.toFixed(4),
      maxLat: bbox.maxLat.toFixed(4),
      maxLon: bbox.maxLon.toFixed(4)
    });
    const res = await fetch(`/api/weather/alerts?${params}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.alerts) ? sortAlerts(data.alerts) : [];
  } catch {
    return [];
  }
};

/** Compact "what's it like on arrival" string for cards and sheets. */
export const summarise = (snapshot: WeatherSnapshot): string => {
  if (snapshot.periods.length === 0) return 'No forecast available';
  const now = snapshot.periods[0];
  return `${now.shortForecast}, ${now.temperature}°${now.temperatureUnit}`;
};
