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
 * ORDER IS LOAD-BEARING. Read the whole function before moving a line.
 *
 *  1. FIRE first, always. "Fire Weather Watch" contains "weather" and would
 *     fall through to storm, and getting fire wrong is the most dangerous
 *     failure this function can have.
 *  2. FREEZING RAIN before flood. Canada issues "freezing rain warning" and
 *     "rainfall warning" as different products with different responses — one
 *     is an ice hazard, the other a water hazard. A bare /rain/ test in the
 *     flood branch would claim both, so the icy ones are claimed first and the
 *     flood branch matches "rainfall" rather than "rain".
 *
 * The Canadian names matter as much as the American ones here. Environment
 * Canada's products are worded differently — "rainfall warning", "arctic
 * outflow", "snow squall", "les suêtes wind" — and every one of them that
 * falls through lands on the generic grey advisory icon, which is what made
 * the map unreadable before.
 */
export const classifyHazard = (eventName: string): HazardFamily => {
  const e = (eventName ?? '').toLowerCase();

  // Wildfire smoke is filed by ECCC as an air quality statement; a camper
  // deciding whether to sleep in it is making a fire-season decision.
  //
  // "air quality" and "air stagnation" are in this list because they are the
  // names the agencies actually use. NWS issues wildfire smoke as an "Air
  // Quality Alert" and ECCC as an "Air Quality Statement" — neither string
  // contains the word smoke, so both used to fall all the way through to
  // 'other', which the map badges as nothing at all and draws nowhere.
  if (/red flag|fire weather|wildfire|fire danger|burn ban|extreme fire|smoke|air quality|air stagnation/.test(e)) {
    return 'fire';
  }
  // Claimed before the flood branch — see the note above.
  if (/freezing rain|ice storm|freezing drizzle/.test(e)) return 'winter';

  // Rainfall products live in the flood family because the RESPONSE is the
  // same one: water is the problem. The MAP splits them apart again for
  // drawing only (`alertBadge` in src/utils/alertOverlay.ts) — a flood gets a
  // pin on a point, regional rainfall gets an area — because a pin on a
  // rainfall warning claims someone looked at that point. Nothing downstream
  // of this function sees that split.
  if (/flood|hydrologic|dam break|seiche|storm surge|rainfall|heavy rain|tsunami/.test(e)) {
    return 'flood';
  }
  if (/tornado|thunderstorm|hurricane|tropical|typhoon|severe weather|squall|waterspout/.test(e)) {
    return 'storm';
  }
  if (/snow|blizzard|ice|freez|winter|frost|sleet|avalanche|cold|chill|arctic/.test(e)) {
    return 'winter';
  }
  if (/heat|hot|humidex/.test(e)) return 'heat';
  if (/wind|gale|dust|suêtes|suetes/.test(e)) return 'wind';
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