/**
 * The report form, defined once as data.
 *
 * The sheet renders this list; the spot detail view reads the same list back
 * to turn a stored `2` into the words "half full". A scale whose labels lived
 * in the input and the output separately would drift, and a slider that means
 * "busy" going in and "quiet" coming out is worse than no slider.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY QUESTION IS OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * A camper standing in the dark next to their van will answer two or three of
 * these and put the phone away. If skipping were awkward, they would drag a
 * slider to the middle just to get past it — and a middle answer nobody meant
 * is worse than no answer, because it is indistinguishable from one somebody
 * did mean.
 *
 * So: untouched stays `undefined`, `undefined` is stored as null, and nothing
 * downstream ever averages it in or renders it as a zero. The only things this
 * form insists on are the proof of being there.
 */
import type { RoadAccess } from '../types';

export interface SpotScaleField {
  /** Matches the key in `SpotVisitReport` and the column in `beacon_visits`. */
  key: 'crowding' | 'rating' | 'view' | 'maxRig' | 'roadAccess'
     | 'levelGround' | 'shade' | 'nightLight';
  question: string;
  /** One stop per position, low to high. Two to five of them. */
  stops: string[];
  /** Sits under the row when the field has been answered. */
  hint?: string;
  /** Which section of the sheet it belongs to. */
  group: 'stay' | 'ground';
  emoji: string;
}

/**
 * Note the stop counts differ — `levelGround` and `shade` have three, most
 * have five. Padding everything to five to look tidy would have invented two
 * meaningless positions on each.
 */
export const SPOT_SCALE_FIELDS: SpotScaleField[] = [
  {
    key: 'crowding',
    question: 'How busy was it?',
    stops: ['Had it to myself', 'One or two others', 'Half full', 'Busy', 'Packed'],
    group: 'stay',
    emoji: '🚐'
  },
  {
    key: 'view',
    question: 'How is the view?',
    stops: ['Nothing to look at', 'Fine', 'Good', 'Great', 'Worth the drive alone'],
    group: 'stay',
    emoji: '🏔️'
  },
  {
    key: 'nightLight',
    question: 'How dark does it get?',
    stops: ['Pitch black', 'Properly dark', 'Some light around', 'Lit up all night'],
    hint: 'Streetlights and floodlights, not the moon.',
    group: 'stay',
    emoji: '🌌'
  },
  {
    key: 'rating',
    question: 'Would you come back?',
    stops: ['No', 'Probably not', 'Maybe', 'Yes', 'In a heartbeat'],
    group: 'stay',
    emoji: '⭐'
  },
  {
    key: 'maxRig',
    question: 'Biggest rig that fits',
    stops: ['Tent only', 'Car or van', 'Up to 25 ft', 'Up to 35 ft', '40 ft and up'],
    group: 'ground',
    emoji: '📏'
  },
  {
    key: 'roadAccess',
    question: 'Road getting in',
    stops: ['Paved', 'Gravel, any car', 'High clearance', '4x4 only'],
    group: 'ground',
    emoji: '🛣️'
  },
  {
    key: 'levelGround',
    question: 'Is the ground level?',
    stops: ['Sloped', 'Mostly level', 'Dead flat'],
    group: 'ground',
    emoji: '📐'
  },
  {
    key: 'shade',
    question: 'Sun or shade?',
    stops: ['Full sun', 'Some shade', 'Mostly shaded'],
    hint: 'Matters for solar as much as for comfort.',
    group: 'ground',
    emoji: '🌳'
  }
];

/** Turn a stored value back into the words the camper picked. */
export const scaleLabel = (
  key: SpotScaleField['key'],
  value: number | undefined
): string | null => {
  if (value == null) return null;
  const field = SPOT_SCALE_FIELDS.find((f) => f.key === key);
  if (!field) return null;
  // Averages arrive fractional. Round to the nearest real stop rather than
  // inventing "between busy and packed".
  const index = Math.round(value);
  return field.stops[Math.min(Math.max(index, 0), field.stops.length - 1)] ?? null;
};

/* ------------------------------------------------------------------ */
/* Translating the scales into the older campsite vocabulary            */
/* ------------------------------------------------------------------ */

/**
 * A report answer, in the terms `Campsite.amenities` uses.
 *
 * Needed because a spot added here also lands in the on-device campsite list,
 * which predates these scales and speaks in road-access names and RV feet.
 * Indexed by scale value, so an UNANSWERED field (index -1) falls off the end
 * and comes back undefined rather than being translated into a confident
 * "tent only, 4x4 only" nobody said.
 */
export const ROAD_ACCESS_BY_SCALE: Record<number, RoadAccess> = {
  0: 'paved',
  1: 'gravel',
  2: 'high_clearance',
  3: '4x4_only'
};

/**
 * The midpoint of each rig band, in feet.
 *
 * A band is a range and this is one number, so it is deliberately the
 * conservative end: "up to 35 ft" stores 35, not 40, because somebody with a
 * 38-footer reading "35" and driving on is a better outcome than the reverse.
 */
export const RIG_FEET_BY_SCALE: Record<number, number> = {
  0: 0,
  1: 20,
  2: 25,
  3: 35,
  4: 40
};

/* ------------------------------------------------------------------ */
/* The amenity questions                                               */
/* ------------------------------------------------------------------ */

/**
 * Asked ONLY when the POI sweep found nothing of that kind within 5 km.
 *
 * The sweep is the point. Making somebody confirm there is a gas station 400 m
 * away, when OpenStreetMap already knows its name and its distance, is the
 * kind of question that makes a form feel long for no gain. When we found one
 * we show it instead of asking; when we found none we ask, because a camper
 * knows about the pit toilet up the forest road and OSM does not.
 */
export interface AmenityQuestion {
  key: 'hasShower' | 'hasRestroom' | 'hasFuel';
  kind: 'shower' | 'restroom' | 'fuel';
  question: string;
  emoji: string;
  /** Shown when the sweep DID find one. */
  foundPrefix: string;
}

export const AMENITY_QUESTIONS: AmenityQuestion[] = [
  {
    key: 'hasShower',
    kind: 'shower',
    question: 'Shower within a few miles?',
    emoji: '🚿',
    foundPrefix: 'Shower'
  },
  {
    key: 'hasRestroom',
    kind: 'restroom',
    question: 'Restroom within a few miles?',
    emoji: '🚻',
    foundPrefix: 'Restroom'
  },
  {
    key: 'hasFuel',
    kind: 'fuel',
    question: 'Gas within a few miles?',
    emoji: '⛽',
    foundPrefix: 'Gas'
  }
];

/** How far out the POI sweep looks, in metres. Quoted in the UI copy. */
export const POI_RADIUS_M = 5000;

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/**
 * The knock question, worded so a "yes" is obviously consequential.
 *
 * It is the only answer on this form that changes what every other camper
 * sees, so the sheet says so out loud before they tap rather than after.
 */
export const KNOCK_QUESTION = 'Did anyone knock or move you on?';
export const KNOCK_CONSEQUENCE =
  'A yes turns this spot red for everyone, and shows them what you write below. ' +
  'It stays on the map on purpose — so the next camper sees the warning instead ' +
  'of finding the same empty pullout and parking here anyway.';

export const REPORT_INTRO =
  'Everything here is optional except the photo. Answer what you know, skip what ' +
  'you do not — a question you skip stays blank rather than being guessed at.';

/** Said before they submit, because afterwards it is an unpleasant surprise. */
export const REPORT_VISIBILITY_NOTE =
  'Your report is shown to other campers with your photo. Your exact position is ' +
  'used to check you were here and is not published.';

export const PHOTO_REQUIRED_REASON =
  'A photo taken here is the part nobody can fake from the couch.';

/** Ceiling on photos per report. Enough for a spot, not an album. */
export const MAX_PHOTOS = 4;
