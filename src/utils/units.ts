/**
 * Turning a government feed's own temperature unit into whatever a camper
 * set in Settings.
 *
 * Every weather source hands back its OWN native unit and nothing converts
 * it: the National Weather Service answers in Fahrenheit, Environment Canada
 * and the Open-Meteo fallback answer in Celsius — see `imperial` in
 * `shared/openMeteo.ts`, which picks the unit by where the CAMPSITE is, not
 * by who is looking at it. So a Canadian forecast has always read in Celsius
 * and a US one in Fahrenheit, regardless of the "Metric units" toggle in
 * Settings — the toggle changed a row in Supabase and nothing else ever
 * looked at it. This is the one place that does.
 */

/** `72` from Fahrenheit becomes `22` in Celsius, and back again. */
const toCelsius = (value: number, unit: string): number =>
  unit.trim().toUpperCase().startsWith('F') ? ((value - 32) * 5) / 9 : value;

/**
 * The value and letter to actually show, given a camper's preference.
 *
 * Always converts from whichever unit the source used, so a US forecast
 * read with "Metric units" on comes out in Celsius, and a Canadian one read
 * with it off comes out in Fahrenheit — not just "whatever the feed already
 * happened to say".
 */
export const displayTemperature = (
  value: number,
  unit: string,
  useMetric: boolean
): { value: number; unit: 'C' | 'F' } => {
  const celsius = toCelsius(value, unit);
  if (useMetric) return { value: Math.round(celsius), unit: 'C' };
  const isFahrenheit = unit.trim().toUpperCase().startsWith('F');
  const fahrenheit = isFahrenheit ? value : (celsius * 9) / 5 + 32;
  return { value: Math.round(fahrenheit), unit: 'F' };
};

/** `"22°C"` or `"72°F"`, already converted to the camper's preference. */
export const formatTemperature = (
  value: number,
  unit: string,
  useMetric: boolean
): string => {
  const t = displayTemperature(value, unit, useMetric);
  return `${t.value}°${t.unit}`;
};
