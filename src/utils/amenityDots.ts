import type { CampsiteAmenities, NearbyFacility, NearbyFacilityKind } from '../types';
import {
  ROAD_ACCESS_LABEL, SHADE_LABEL, TOILET_LABEL, WATER_LABEL, bestCellSignal
} from './amenities';
import { AlertBadge, BADGE_COLOR, WARNING_EMOJI, WARNING_LABEL } from './alertOverlay';
import { FACILITY_GLYPH, FACILITY_LABEL } from '../services/nearbyAmenityService';
import { isUnderControl, type ActiveFire } from '../services/fireService';

/**
 * THE COLOURED DOTS THAT SIT ABOVE A PIN.
 *
 * This replaces the map legend. A legend asks the camper to hold a key in
 * their head and match colours to a panel in the corner; the dots put the
 * same information on the pin itself, and tapping the pin expands each dot
 * into the words it stood for. Nothing on the map means anything you cannot
 * read by tapping the thing it is drawn on.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. A dot is only drawn for a fact somebody
 * recorded. Every field on `CampsiteAmenities` is optional and absent means
 * "nobody has checked", so an unknown produces NO dot — never a grey one,
 * which would read as a checked "no". A recorded absence ("no water here")
 * is a real fact, so it gets a hollow ring in that subject's colour and says
 * so in words when expanded.
 *
 *   good    — something the camper gains. Coloured.
 *   neutral — a recorded limit or constraint (road, stay limit, rig length).
 *   bad     — a live hazard, or a recorded absence / requirement.
 *
 * COLOUR CARRIES THE SUBJECT, FILL CARRIES THE ANSWER. Every dot wears the
 * colour of the thing it is about — water is always blue, a toilet always
 * violet — and says yes or no by being solid or a ring. Grey used to do that
 * job: a recorded "no water here" came out slate, next to a slate stay limit
 * and a slate rough road, so a pin's row of dots was mostly the same dull
 * pebble repeated and the colours that were left had nothing to contrast
 * against. Hollow-for-absent keeps the honesty (a recorded no is still
 * visibly different from a yes, and an unknown still draws nothing at all)
 * and gives the row back its palette.
 */
export type DotTone = 'good' | 'neutral' | 'bad';

export interface MarkerDot {
  /** Stable within one pin; used only as a React-free render key. */
  key: string;
  color: string;
  /** The words the dot expands into. Full sentence case, no abbreviations. */
  label: string;
  /** Shown in the expanded chip, never in the collapsed dot. */
  glyph: string;
  tone: DotTone;
  /**
   * This one moves.
   *
   * Reserved for a hazard happening NOW — a fire burning up the valley, a
   * heat warning, a cold snap, smoke. Everything else holds still, including
   * the bad-but-static facts like "no water" or "fee charged": those are
   * worth a colour, not a heartbeat. Motion is the loudest thing a 7px dot
   * can do, so spending it on a fee turned the whole row into a twitch and
   * left the fire with nothing louder to say.
   */
  urgent?: boolean;
  /**
   * Solid, or a ring of the same colour.
   *
   * A ring means "somebody checked and the answer was no" — never "unknown",
   * which produces no dot at all. Defaults to solid.
   */
  hollow?: boolean;
  /**
   * A facility near the spot rather than a fact about it.
   *
   * Present only on the dots produced by `facilityDots`. The map makes these
   * chips tappable and routes to the coordinate.
   */
  facility?: NearbyFacility;
}

/**
 * One hue per subject, all of them at the same brightness so no single dot
 * shouts louder than its neighbour for reasons of palette rather than
 * meaning. Hazards are excluded — they come from `BADGE_COLOR`, so a dot
 * matches the cloud it is standing in.
 */
const COLOR = {
  water: '#38BDF8',
  toilet: '#C084FC',
  fire: '#FB923C',
  pet: '#F472B6',
  shade: '#4ADE80',
  signal: '#22D3EE',
  free: '#34D399',
  trash: '#FBBF24',
  road: '#FDE047',
  rough: '#F59E0B',
  rig: '#818CF8',
  stay: '#2DD4BF',
  shower: '#60A5FA',
  dump: '#A3E635',
  fuel: '#FB7185',
  groceries: '#F0ABFC',
  warn: '#FB7185',
  /* The two fire colours the map's flame layer used, kept so the dot above a
     pin says exactly what the flame used to. */
  fireRunning: '#EF4444',
  fireHeld: '#F97316'
} as const;

/** The colour a nearby facility's dot and its route line are drawn in. */
export const FACILITY_COLOR: Record<NearbyFacilityKind, string> = {
  toilet: COLOR.toilet,
  shower: COLOR.shower,
  water: COLOR.water,
  dump: COLOR.dump,
  fuel: COLOR.fuel,
  groceries: COLOR.groceries
};

/**
 * A live hazard over this spot — smoke, a heat warning, a fire.
 *
 * These lead the row, because they change whether a camper should go at all.
 * They are the same colours and words as the hazard clouds drawn on the map,
 * so the dot above a pin and the shape it is standing in are obviously the
 * same warning.
 */
export const hazardDots = (badges: AlertBadge[]): MarkerDot[] =>
  badges.map((b) => ({
    key: `hz-${b}`,
    color: BADGE_COLOR[b],
    label: WARNING_LABEL[b],
    glyph: WARNING_EMOJI[b],
    tone: 'bad' as const,
    urgent: true
  }));

/**
 * An active fire burning near this point.
 *
 * THE FLAMES USED TO BE DRAWN ON THE MAP and are not any more. Scattering
 * every incident in the viewport across the map made the fire feed look like
 * the subject of the app: a dozen flames over ground the camper was never
 * going to visit, each of them a tappable thing competing with the pins. The
 * data still matters, but only ever as an answer about a PLACE — so it is
 * now one dot above the point being read, in the same row as everything else
 * about that point, and the full list is a tap away in the card.
 *
 * One dot however many fires: what changes a decision is the nearest one and
 * roughly how much is burning, not each incident's name. Colour follows the
 * agency's own reading — red while it is not reported under control, orange
 * once it is — and the label never rounds "under control" up to "safe",
 * because a contained fire is still a fire and its smoke does not stop at the
 * containment line.
 */
export const fireDots = (
  near: Array<{ fire: ActiveFire; distanceKm: number }>
): MarkerDot[] => {
  const nearest = near[0];
  if (!nearest) return [];

  const running = near.some((n) => !isUnderControl(n.fire));
  const km = nearest.distanceKm;
  const distance = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
  const count = near.length > 1 ? `${near.length} active fires, nearest` : 'Active fire';

  return [{
    key: 'fire-near',
    color: running ? COLOR.fireRunning : COLOR.fireHeld,
    label: `${count} ${distance} away${running ? '' : ' — reported under control'}`,
    glyph: '\u{1F525}',
    tone: 'bad',
    urgent: true
  }];
};

/**
 * Everything recorded about the spot itself, in the order a camper deciding
 * where to sleep tends to ask: can I get there, can I drink, can I go, will I
 * cook, will I burn, does it cost.
 */
export const amenityDots = (a: CampsiteAmenities | undefined): MarkerDot[] => {
  if (!a) return [];
  const dots: MarkerDot[] = [];

  if (a.roadAccess) {
    const rough = a.roadAccess === 'high_clearance' || a.roadAccess === '4x4_only';
    dots.push({
      key: 'road',
      color: rough ? COLOR.rough : COLOR.road,
      label: `${ROAD_ACCESS_LABEL[a.roadAccess]} road`,
      glyph: '🛣️',
      tone: rough ? 'neutral' : 'good'
    });
  }

  if (a.water) {
    const none = a.water === 'none';
    dots.push({
      key: 'water',
      color: COLOR.water,
      hollow: none,
      label: WATER_LABEL[a.water],
      glyph: '💧',
      tone: none ? 'bad' : 'good'
    });
  }

  if (a.toilet) {
    const none = a.toilet === 'none';
    dots.push({
      key: 'toilet',
      color: COLOR.toilet,
      hollow: none,
      label: TOILET_LABEL[a.toilet],
      glyph: '🚻',
      tone: none ? 'bad' : 'good'
    });
  }

  if (a.fireRing !== undefined) {
    dots.push({
      key: 'fire-ring',
      color: COLOR.fire,
      hollow: !a.fireRing,
      label: a.fireRing ? 'Fire ring' : 'No fire ring',
      glyph: '🔥',
      tone: a.fireRing ? 'good' : 'bad'
    });
  }

  if (a.shade) {
    dots.push({
      key: 'shade',
      color: COLOR.shade,
      hollow: a.shade === 'none',
      label: SHADE_LABEL[a.shade],
      glyph: '🌲',
      tone: a.shade === 'none' ? 'bad' : 'good'
    });
  }

  const bars = bestCellSignal(a);
  if (bars !== undefined) {
    dots.push({
      key: 'signal',
      color: COLOR.signal,
      hollow: bars === 0,
      label: bars > 0 ? `${bars}-bar signal, best carrier` : 'No signal recorded here',
      glyph: '📶',
      tone: bars > 0 ? 'good' : 'bad'
    });
  }

  if (a.petFriendly !== undefined) {
    dots.push({
      key: 'pet',
      color: COLOR.pet,
      hollow: !a.petFriendly,
      label: a.petFriendly ? 'Pet friendly' : 'No pets',
      glyph: '🐾',
      tone: a.petFriendly ? 'good' : 'bad'
    });
  }

  if (a.trashService !== undefined && a.trashService) {
    dots.push({
      key: 'trash', color: COLOR.trash, label: 'Trash service', glyph: '🗑️', tone: 'good'
    });
  }

  if (a.maxRvLengthFeet !== undefined) {
    dots.push({
      key: 'rv',
      color: COLOR.rig,
      label: `Rigs up to ${a.maxRvLengthFeet} ft`,
      glyph: '🚐',
      tone: 'neutral'
    });
  }

  if (a.stayLimitDays !== undefined) {
    dots.push({
      key: 'stay',
      color: COLOR.stay,
      label: `${a.stayLimitDays}-day stay limit`,
      glyph: '🗓️',
      tone: 'neutral'
    });
  }

  if (a.isFree !== undefined) {
    dots.push({
      key: 'free',
      color: a.isFree ? COLOR.free : COLOR.warn,
      hollow: !a.isFree,
      label: a.isFree ? 'Free' : 'Fee charged',
      glyph: '💲',
      tone: a.isFree ? 'good' : 'bad'
    });
  }

  if (a.permitRequired) {
    dots.push({
      key: 'permit', color: COLOR.warn, label: 'Permit required', glyph: '📝', tone: 'bad'
    });
  }

  return dots;
};

/**
 * Facilities near the spot, as dots you can tap.
 *
 * These are NOT facts about the spot — they are a toilet somebody mapped a
 * couple of kilometres up the road — so they carry the distance in their
 * label and never merge with the site's own dots visually: they sit last in
 * the row, always solid (they exist; the question of "is there one HERE" is
 * answered by the site's own dot), and tapping one routes to it.
 *
 * They are only ever produced for a SELECTED pin, because looking them up
 * costs an Overpass query per spot.
 */
export const facilityDots = (facilities: NearbyFacility[]): MarkerDot[] =>
  facilities.map((f) => ({
    key: `near-${f.id}`,
    color: FACILITY_COLOR[f.kind],
    label: `${FACILITY_LABEL[f.kind]} ${f.distanceKm} km away`,
    glyph: FACILITY_GLYPH[f.kind],
    tone: 'good' as const,
    facility: f
  }));

/**
 * How many dots a collapsed pin shows before it stops.
 *
 * Six 6px dots and their gaps come to about 52px — a shade wider than the pin
 * itself, which is as far as a row can spread before two neighbouring pins'
 * rows start colliding. Anything past that is a "+n" dot, and tapping the pin
 * shows the lot.
 */
export const COLLAPSED_DOT_LIMIT = 6;
