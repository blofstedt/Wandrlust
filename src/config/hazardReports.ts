import type { WarningMotion } from '../utils/alertOverlay';

/**
 * Camper hazard reports — how each kind looks on the map and reads in a list.
 *
 * ONE TABLE, TWO CONSUMERS: the report form offers these, and the map draws
 * them. They were previously two hand-kept lists and would have drifted the
 * first time somebody added a kind.
 *
 * Camper reports now wear the SAME animated cloud as an official warning, by
 * request — a coloured cloud with a slow drifting strand, keyed to the hazard.
 * What still keeps the two apart is behaviour, not looks: an official warning
 * is a non-interactive overlay drawn over the agency's own area, while a camper
 * report is a tappable marker that opens a card saying, in as many words, that
 * it is one person's report and not verified. The `motion` below is the strand
 * style each kind animates with, matching the weather families in alertOverlay.
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
  /** The animated strand style this kind wears on its map cloud. */
  motion: WarningMotion;
}

export const HAZARD_REPORT_STYLE: Record<string, HazardReportStyle> = {
  fire_activity: { label: 'Fire activity', emoji: '🔥', color: '#F97316', prominent: true, motion: 'squiggle' },
  flooding: { label: 'Flooding', emoji: '🌊', color: '#0EA5E9', prominent: true, motion: 'wave' },
  enforcement_activity: { label: 'Enforcement', emoji: '🚔', color: '#3B82F6', prominent: true, motion: 'wave' },
  washout: { label: 'Washed out road', emoji: '🕳️', color: '#B45309', prominent: true, motion: 'wave' },
  weak_bridge: { label: 'Weak bridge', emoji: '🌉', color: '#B45309', motion: 'zigzag' },
  low_clearance: { label: 'Low clearance', emoji: '📏', color: '#A855F7', motion: 'heatline' },
  downed_tree: { label: 'Downed tree', emoji: '🌲', color: '#16A34A', motion: 'zigzag' },
  deep_mud: { label: 'Deep mud', emoji: '🟤', color: '#78350F', motion: 'wave' },
  snow_drift: { label: 'Snow drift', emoji: '❄️', color: '#38BDF8', motion: 'zigzag' },
  debris: { label: 'Debris', emoji: '🪨', color: '#94A3B8', motion: 'zigzag' },
  wildlife: { label: 'Wildlife', emoji: '🐻', color: '#CA8A04', motion: 'squiggle' },
  other: { label: 'Hazard', emoji: '⚠️', color: '#EAB308', motion: 'wave' }
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