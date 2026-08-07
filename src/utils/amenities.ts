import type { CampsiteAmenities, RoadAccess, ShadeType, WaterType, ToiletType } from '../types';

/**
 * Turning "we don't know" into text, in one place.
 *
 * Every field on `CampsiteAmenities` is optional because for most dispersed
 * sites nobody has recorded anything. The temptation in a component is to
 * write `amenities.water ?? 'none'` or `stayLimitDays ?? 14`, which puts a
 * confident-looking value on screen that came from nowhere. These helpers make
 * the honest rendering the easy one: a known value, or nothing at all.
 *
 * The distinction that matters is between FALSE and UNKNOWN. "No toilet" is
 * something somebody checked. "Toilet not recorded" is not. Rendering both as
 * an unlit icon tells the user the same thing about two very different states.
 */

export const ROAD_ACCESS_LABEL: Record<RoadAccess, string> = {
  paved: 'Paved',
  gravel: 'Gravel',
  high_clearance: 'High clearance',
  '4x4_only': '4x4 only'
};

export const WATER_LABEL: Record<WaterType, string> = {
  none: 'No water',
  potable: 'Potable water',
  natural_stream: 'Natural stream',
  seasonal_creek: 'Seasonal creek'
};

export const TOILET_LABEL: Record<ToiletType, string> = {
  none: 'No toilet',
  vault: 'Vault toilet',
  flush: 'Flush toilet',
  pack_out: 'Pack out'
};

export const SHADE_LABEL: Record<ShadeType, string> = {
  full: 'Full shade',
  partial: 'Partial shade',
  none: 'No shade'
};

/** Shown wherever a labelled slot exists but the value is unknown. */
export const UNKNOWN_LABEL = 'Not recorded';

/**
 * How many facts we actually hold about a site.
 *
 * Used to decide whether to show a "nothing recorded" note instead of a row of
 * empty chips.
 */
export const knownAmenityCount = (a: CampsiteAmenities | undefined): number =>
  a ? Object.values(a).filter((v) => v !== undefined && v !== null).length : 0;

/**
 * Strongest signal across carriers, or undefined when nobody has measured any.
 *
 * Note the difference from the old behaviour: this returns undefined for a
 * missing record, where before a missing record produced `0`, which the UI
 * then drew as "0 bars" — an assertion of no coverage.
 */
export const bestCellSignal = (a: CampsiteAmenities | undefined): number | undefined => {
  const c = a?.cellSignal;
  if (!c) return undefined;
  const values = [c.verizon, c.att, c.tmobile].filter(
    (n): n is number => typeof n === 'number'
  );
  return values.length ? Math.max(...values) : undefined;
};

/** `true`/`false`/unknown rendered as words, never as a silently-off icon. */
export const yesNoUnknown = (value: boolean | undefined): string =>
  value === undefined ? UNKNOWN_LABEL : value ? 'Yes' : 'No';