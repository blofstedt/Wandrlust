/**
 * Hazard classification — shared by the server proxy and the client.
 *
 * This lived in two places (server/weatherRoutes.ts and
 * src/services/weatherService.ts) with identical regexes. Two copies of a
 * safety-critical classifier is exactly the kind of thing that drifts, so it
 * now lives once, here.
 */
export type HazardFamily =
  | 'fire' | 'flood' | 'storm' | 'winter' | 'heat' | 'wind' | 'other';

export type AlertSeverity = 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown';
export type AlertUrgency = 'immediate' | 'expected' | 'future' | 'past' | 'unknown';

/**
 * Map an NWS / ECCC event name onto a hazard family.
 *
 * Order matters: fire is checked FIRST because "Fire Weather Watch" would
 * otherwise fall through to another family, and getting fire wrong is the most
 * dangerous failure here.
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

/** Unknown values map to 'unknown' rather than being silently downgraded. */
export const normaliseSeverity = (raw: string | undefined): AlertSeverity => {
  const s = (raw ?? '').toLowerCase();
  return (['extreme', 'severe', 'moderate', 'minor'] as const).includes(s as any)
    ? (s as AlertSeverity)
    : 'unknown';
};

export const normaliseUrgency = (raw: string | undefined): AlertUrgency => {
  const u = (raw ?? '').toLowerCase();
  return (['immediate', 'expected', 'future', 'past'] as const).includes(u as any)
    ? (u as AlertUrgency)
    : 'unknown';
};

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  extreme: 4, severe: 3, moderate: 2, minor: 1, unknown: 0
};
