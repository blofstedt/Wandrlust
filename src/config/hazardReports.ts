/**
 * Camper hazard reports — how each kind looks on the map and reads in a list.
 *
 * ONE TABLE, TWO CONSUMERS: the report form offers these, and the map draws
 * them. They were previously two hand-kept lists and would have drifted the
 * first time somebody added a kind.
 *
 * These are DELIBERATELY DRAWN DIFFERENTLY FROM OFFICIAL ALERTS. A National
 * Weather Service fire warning is a triangle; a camper saying "there's fire
 * activity up the valley" is a rounded chip. One is an agency with a legal
 * duty and a detection network behind it, the other is one person's eyes.
 * Making them look alike would let the second borrow the authority of the
 * first, which is exactly the kind of overstatement this app refuses to make.
 *
 * The `kind` values match the `hazard_kind` enum in migration 02. If you add
 * one, add it there first.
 */

export interface HazardReportStyle {
  label: string;
  /** Glyph drawn in the map chip and beside the kind in lists. */
  emoji: string;
  /** Chip fill. */
  color: string;
  /**
   * Whether this is one of the kinds that changes a driver's decisions rather
   * than just their expectations. Prominent kinds draw at full size and stay
   * legible when the map is busy.
   */
  prominent?: boolean;
}

export const HAZARD_REPORT_STYLE: Record<string, HazardReportStyle> = {
  fire_activity: { label: 'Fire activity', emoji: '🔥', color: '#F97316', prominent: true },
  flooding: { label: 'Flooding', emoji: '🌊', color: '#0EA5E9', prominent: true },
  enforcement_activity: { label: 'Enforcement', emoji: '🚔', color: '#3B82F6', prominent: true },
  washout: { label: 'Washed out road', emoji: '🕳️', color: '#B45309', prominent: true },
  weak_bridge: { label: 'Weak bridge', emoji: '🌉', color: '#B45309' },
  low_clearance: { label: 'Low clearance', emoji: '📏', color: '#A855F7' },
  downed_tree: { label: 'Downed tree', emoji: '🌲', color: '#16A34A' },
  deep_mud: { label: 'Deep mud', emoji: '🟤', color: '#78350F' },
  snow_drift: { label: 'Snow drift', emoji: '❄️', color: '#38BDF8' },
  debris: { label: 'Debris', emoji: '🪨', color: '#94A3B8' },
  wildlife: { label: 'Wildlife', emoji: '🐻', color: '#CA8A04' },
  other: { label: 'Hazard', emoji: '⚠️', color: '#EAB308' }
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
