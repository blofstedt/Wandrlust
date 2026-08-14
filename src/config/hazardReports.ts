import type { LocalizedKind } from '../utils/alertOverlay';

/**
 * Camper hazard reports — how each kind looks on the map and reads in a list.
 *
 * ONE TABLE, TWO CONSUMERS: the report form offers these, and the map draws
 * them. They were previously two hand-kept lists and would have drifted the
 * first time somebody added a kind.
 *
 * Every one of these is something at a spot on a road, so the map draws it as
 * a teardrop pin — the only hazard left wearing one, now that official
 * warnings all draw as soft areas. `pin` says which of the four point families
 * it belongs to, and that decides the pin's colour and symbol: a fire, water,
 * a barricade for anything blocking the way, or a plain warning triangle.
 *
 * What keeps a report apart from an agency warning is behaviour, not looks: a
 * report is tappable and opens a card saying, in as many words, that it is one
 * person's account and not verified.
 *
 * `emoji` and `color` are the LIST identity — the report form, the report card,
 * the confirm sheet — where there is room to tell a downed tree from deep mud.
 * The map deliberately does not use them: twelve colours of pin is the noise
 * this table's `pin` grouping exists to remove.
 *
 * The `kind` values match the `hazard_kind` enum in migration 02. If you add
 * one, add it there first.
 */

export interface HazardReportStyle {
  label: string;
  /** Glyph drawn beside the kind in lists and cards. */
  emoji: string;
  /** Chip fill in lists and cards. */
  color: string;
  /**
   * Whether this is one of the kinds that changes a driver's decisions rather
   * than just their expectations. Prominent kinds draw at full size and stay
   * legible when the map is busy.
   */
  prominent?: boolean;
  /** Which of the four pin families the map draws this kind as. */
  pin: LocalizedKind;
}

export const HAZARD_REPORT_STYLE: Record<string, HazardReportStyle> = {
  fire_activity: { label: 'Fire activity', emoji: '🔥', color: '#EA580C', prominent: true, pin: 'fire' },
  flooding: { label: 'Flooding', emoji: '🌊', color: '#14B8A6', prominent: true, pin: 'flood' },
  enforcement_activity: { label: 'Enforcement', emoji: '🚔', color: '#3B82F6', prominent: true, pin: 'other' },
  washout: { label: 'Washed out road', emoji: '🕳️', color: '#B45309', prominent: true, pin: 'infrastructure' },
  weak_bridge: { label: 'Weak bridge', emoji: '🌉', color: '#B45309', pin: 'infrastructure' },
  low_clearance: { label: 'Low clearance', emoji: '📏', color: '#A855F7', pin: 'infrastructure' },
  downed_tree: { label: 'Downed tree', emoji: '🌲', color: '#16A34A', pin: 'infrastructure' },
  deep_mud: { label: 'Deep mud', emoji: '🟤', color: '#78350F', pin: 'infrastructure' },
  snow_drift: { label: 'Snow drift', emoji: '❄️', color: '#38BDF8', pin: 'infrastructure' },
  debris: { label: 'Debris', emoji: '🪨', color: '#94A3B8', pin: 'infrastructure' },
  wildlife: { label: 'Wildlife', emoji: '🐻', color: '#CA8A04', pin: 'other' },
  other: { label: 'Hazard', emoji: '⚠️', color: '#EAB308', pin: 'other' }
};

export const hazardReportStyle = (kind: string): HazardReportStyle =>
  HAZARD_REPORT_STYLE[kind] ?? HAZARD_REPORT_STYLE.other;

/** The order the report form offers them in — most-reported first. */
export const HAZARD_REPORT_KINDS: string[] = [
  'washout', 'flooding', 'fire_activity', 'enforcement_activity',
  'debris', 'deep_mud', 'snow_drift', 'downed_tree',
  'low_clearance', 'weak_bridge', 'wildlife', 'other'
];

/**
 * How much weight to give a report, from its confirmations.
 *
 * Not a truth value. A report nobody has confirmed is not false — it is more
 * likely to be simply new, since most reports are seen by nobody for days.
 * This only decides how loudly to draw it.
 */
export const reportStanding = (
  confirms: number,
  disputes: number
): 'confirmed' | 'reported' => (confirms - disputes >= 2 ? 'confirmed' : 'reported');