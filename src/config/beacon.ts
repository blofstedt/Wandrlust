/**
 * Everything Beacon says out loud, in one table.
 *
 * The map pin, the results panel and the verification sheet all read from
 * here, so a tier cannot mean one thing on the map and something softer in a
 * sheet. The `tier` values match the `beacon_tier` enum in migration 13 — if
 * you add one, add it there first.
 *
 * THE WORDING IS THE FEATURE. Beacon guesses where you might legally sleep,
 * and a guess dressed up as an answer is how somebody wakes up to a ticket or
 * a knock on the window. So every label here describes the EVIDENCE rather
 * than a confidence level, and the grey tier says "nobody has been here" in
 * those words rather than something reassuring like "unverified".
 */
import type { BeaconTier, BeaconSignEvidence, BeaconOutcome } from '../types';

export interface BeaconTierStyle {
  label: string;
  /** One line, plain English, shown under the label. */
  meaning: string;
  color: string;
  colorSoft: string;
  ring: string;
  emoji: string;
}

/**
 * How many separate campers each rung of the ladder takes.
 *
 * THE ONLY COPY OF THESE NUMBERS ON THE CLIENT. `beacon_tier_for()` in
 * migration 14 holds the matching copy on the server, and the server is the
 * one that decides — this exists so the UI can say "one more camper and this
 * turns green" without guessing.
 *
 * They are deliberately low. A ladder whose top rung needs five separate
 * campers is a ladder nothing ever climbs while the app is young, and a colour
 * nobody ever sees teaches nobody anything.
 */
export const BEACON_TIER_STEPS = {
  reported: 1,
  corroborated: 2,
  confirmed: 4
} as const;

/**
 * The colour ramp only ever moves toward "good": grey → amber → lime → green.
 *
 * Red is not on the ramp. It belongs to `flagged` alone, so a red pin on this
 * map means exactly one thing — somebody got a knock on the window here — and
 * never gets confused with "we are only part-way confident".
 */
export const BEACON_TIER_STYLE: Record<BeaconTier, BeaconTierStyle> = {
  lead: {
    label: 'Lead',
    meaning: 'Public map data suggests this. Nobody has been here.',
    color: '#94A3B8',
    colorSoft: 'rgba(148, 163, 184, 0.16)',
    ring: 'rgba(148, 163, 184, 0.45)',
    emoji: '🔍'
  },
  reported: {
    label: 'Reported',
    meaning: 'One camper has actually been here and reported back.',
    color: '#F59E0B',
    colorSoft: 'rgba(245, 158, 11, 0.16)',
    ring: 'rgba(245, 158, 11, 0.45)',
    emoji: '🌘'
  },
  corroborated: {
    label: 'Corroborated',
    meaning: 'Two separate campers have been here and agreed it works.',
    color: '#A3E635',
    colorSoft: 'rgba(163, 230, 53, 0.16)',
    ring: 'rgba(163, 230, 53, 0.45)',
    emoji: '🌗'
  },
  confirmed: {
    label: 'Confirmed',
    meaning: 'Four or more campers have stayed here, recently.',
    color: '#10B981',
    colorSoft: 'rgba(16, 185, 129, 0.16)',
    ring: 'rgba(16, 185, 129, 0.45)',
    emoji: '✅'
  },
  /**
   * Red, and STILL ON THE MAP.
   *
   * The old behaviour took a spot off the map the moment anybody got moved on,
   * which quietly recreated the problem it was trying to solve: the next
   * camper finds the same empty pullout on their own, parks, and gets the same
   * knock at 3am — with the app having known and said nothing. A red pin
   * carrying the reporter's own words is a warning; a missing pin is silence.
   */
  flagged: {
    label: 'Knock reported',
    meaning: 'A camper was woken up or moved on here. Read what they said.',
    color: '#EF4444',
    colorSoft: 'rgba(239, 68, 68, 0.16)',
    ring: 'rgba(239, 68, 68, 0.45)',
    emoji: '🚨'
  },
  /** Not a place any more — gated, built on, gone. Genuinely off the map. */
  withdrawn: {
    label: 'Gone',
    meaning: 'This is not a place you can park any more.',
    color: '#64748B',
    colorSoft: 'rgba(100, 116, 139, 0.16)',
    ring: 'rgba(100, 116, 139, 0.45)',
    emoji: '⛔'
  }
};

export const beaconTierStyle = (tier: string): BeaconTierStyle =>
  BEACON_TIER_STYLE[tier as BeaconTier] ?? BEACON_TIER_STYLE.lead;

/**
 * "One more camper and this turns green."
 *
 * Returns null at the top of the ladder and for the two tiers that are not on
 * it. Shown on the spot sheet because a visible next rung is what makes
 * somebody bother to file a report at all.
 */
export const nextTierHint = (tier: BeaconTier, verifyCount: number): string | null => {
  if (tier === 'flagged' || tier === 'withdrawn' || tier === 'confirmed') return null;

  const next = verifyCount < BEACON_TIER_STEPS.reported
    ? BEACON_TIER_STEPS.reported
    : verifyCount < BEACON_TIER_STEPS.corroborated
    ? BEACON_TIER_STEPS.corroborated
    : BEACON_TIER_STEPS.confirmed;

  const needed = next - verifyCount;
  if (needed <= 0) return null;

  const tierName = next === BEACON_TIER_STEPS.reported
    ? BEACON_TIER_STYLE.reported.label
    : next === BEACON_TIER_STEPS.corroborated
    ? BEACON_TIER_STYLE.corroborated.label
    : BEACON_TIER_STYLE.confirmed.label;

  return `${needed} more camper${needed === 1 ? '' : 's'} moves this to ${tierName}.`;
};

/**
 * What to say about the signage check.
 *
 * Note that `unknown` gets a sentence, not silence. A camper who sees nothing
 * about signs will assume there were none; a camper who reads "signs were not
 * checked here" knows to look up when they arrive.
 */
export const SIGN_EVIDENCE_COPY: Record<BeaconSignEvidence, string> = {
  clear: 'Street-level imagery near here shows no parking restriction signs.',
  unknown: 'Signs were not checked here — nobody has driven this road with a camera.',
  restricted: 'Street-level imagery shows a parking restriction sign here.'
};

/** The permanent caveat. Rendered on every Beacon surface, never conditional. */
export const BEACON_CAVEAT = 'Check the signs when you arrive.';

/**
 * The four-hour rule, described the way it actually works.
 *
 * A browser cannot record location with the tab closed, so what the app can
 * genuinely prove is two endpoints inside the fence four hours apart. Saying
 * "we tracked you for four hours" would be a lie, and saying nothing would let
 * a camper assume it.
 */
export const DWELL_EXPLAINER =
  'Vouching for a spot takes four hours. The app checks where you are when you ' +
  'arrive and again when you submit — it cannot watch in between, so keep it ' +
  'open now and then if you want the time to count.';

export const GEOFENCE_METRES = 50;
export const DWELL_MINUTES_REQUIRED = 240;

/**
 * The boolean form. Order is the order a camper answers them in, and
 * `signs_restricted` is first because it is the one that takes a spot down.
 */
export interface BeaconQuestion {
  key: 'signs_restricted' | 'ground_flat' | 'quiet_overnight';
  question: string;
  /** What a `true` answer means for the spot. Shown as a hint under the row. */
  hint?: string;
}

export const BEACON_QUESTIONS: BeaconQuestion[] = [
  {
    key: 'signs_restricted',
    question: 'Any restricted parking signs?',
    hint: 'If yes, this spot comes off the map straight away.'
  },
  { key: 'ground_flat', question: 'Is the ground flat enough to sleep on?' },
  { key: 'quiet_overnight', question: 'Was it quiet overnight?' }
];

/** The takedown reasons, in the order they appear in the report sheet. */
export interface BeaconOutcomeOption {
  outcome: BeaconOutcome;
  label: string;
  emoji: string;
}

export const BEACON_TAKEDOWN_OPTIONS: BeaconOutcomeOption[] = [
  { outcome: 'ticketed', label: 'I got a ticket', emoji: '🎫' },
  { outcome: 'asked_to_leave', label: 'I was asked to leave', emoji: '👮' },
  { outcome: 'posted_no_parking', label: 'There are no-parking signs', emoji: '🚫' },
  { outcome: 'gone', label: 'It is gated, gone or unusable', emoji: '🚧' }
];

/**
 * Feature tokens, turned into something a person can read.
 *
 * Only used to explain what the model has learned ("it trusts rest areas more
 * than residential streets around here"). An unmapped token falls back to its
 * raw form rather than being hidden, because a model explanation with silent
 * gaps in it is worse than a slightly technical one.
 */
const TOKEN_LABELS: Record<string, string> = {
  'feature=parking': 'parking areas',
  'feature=rest_area': 'rest areas',
  'feature=passing_place': 'passing places',
  'feature=turning_circle': 'turning circles',
  'feature=camp_site': 'campsites',
  'parking=free': 'free parking',
  'parking=fee': 'paid parking',
  'camp=free': 'free campsites',
  'camp=fee': 'paid campsites',
  'land=blm': 'BLM land',
  'land=usfs': 'National Forest',
  'land=crown': 'Crown land',
  'land=protected': 'protected areas',
  'land=forest': 'mapped forest',
  'land=park_edge': 'park edges',
  'land=residential': 'residential streets',
  'land=unmapped': 'unmapped ground',
  'land=business': 'business property',
  'land=agricultural': 'farmland',
  'land=sensitive_site': 'schools and hospitals',
  'lot=business': 'business car parks',
  'access=customers': 'customer parking',
  'road=track': 'tracks',
  'road=unclassified': 'minor roads',
  'road=residential': 'residential roads',
  'road=service': 'service roads',
  'road=none': 'spots with no road nearby',
  'sign:no_parking=absent': 'places with no restriction signs on camera',
  'sign:parking_allowed=present': 'places with a parking sign on camera',
  'imagery=dense': 'well-photographed streets'
};

export const beaconTokenLabel = (token: string): string =>
  TOKEN_LABELS[token] ?? token.replace(/[=:]/g, ' ');
