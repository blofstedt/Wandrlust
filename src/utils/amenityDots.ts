import type { CampsiteAmenities } from '../types';
import {
  ROAD_ACCESS_LABEL, SHADE_LABEL, TOILET_LABEL, WATER_LABEL, bestCellSignal
} from './amenities';
import { AlertBadge, BADGE_COLOR, WARNING_EMOJI, WARNING_LABEL } from './alertOverlay';

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
 * is a real fact, so it gets a slate dot and says so in words when expanded.
 *
 *   good    — something the camper gains. Coloured.
 *   neutral — a recorded limit or constraint (road, stay limit, rig length).
 *   bad     — a live hazard, or a recorded absence / requirement.
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
}

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
  limit: '#94A3B8',
  absent: '#64748B',
  warn: '#FB7185'
} as const;

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
    tone: 'bad' as const
  }));

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
      color: rough ? COLOR.limit : COLOR.road,
      label: `${ROAD_ACCESS_LABEL[a.roadAccess]} road`,
      glyph: '🛣️',
      tone: rough ? 'neutral' : 'good'
    });
  }

  if (a.water) {
    const none = a.water === 'none';
    dots.push({
      key: 'water',
      color: none ? COLOR.absent : COLOR.water,
      label: WATER_LABEL[a.water],
      glyph: '💧',
      tone: none ? 'bad' : 'good'
    });
  }

  if (a.toilet) {
    const none = a.toilet === 'none';
    dots.push({
      key: 'toilet',
      color: none ? COLOR.absent : COLOR.toilet,
      label: TOILET_LABEL[a.toilet],
      glyph: '🚻',
      tone: none ? 'bad' : 'good'
    });
  }

  if (a.fireRing !== undefined) {
    dots.push({
      key: 'fire-ring',
      color: a.fireRing ? COLOR.fire : COLOR.absent,
      label: a.fireRing ? 'Fire ring' : 'No fire ring',
      glyph: '🔥',
      tone: a.fireRing ? 'good' : 'bad'
    });
  }

  if (a.shade) {
    dots.push({
      key: 'shade',
      color: a.shade === 'none' ? COLOR.absent : COLOR.shade,
      label: SHADE_LABEL[a.shade],
      glyph: '🌲',
      tone: a.shade === 'none' ? 'bad' : 'good'
    });
  }

  const bars = bestCellSignal(a);
  if (bars !== undefined) {
    dots.push({
      key: 'signal',
      color: bars > 0 ? COLOR.signal : COLOR.absent,
      label: bars > 0 ? `${bars}-bar signal, best carrier` : 'No signal recorded here',
      glyph: '📶',
      tone: bars > 0 ? 'good' : 'bad'
    });
  }

  if (a.petFriendly !== undefined) {
    dots.push({
      key: 'pet',
      color: a.petFriendly ? COLOR.pet : COLOR.absent,
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
      color: COLOR.limit,
      label: `Rigs up to ${a.maxRvLengthFeet} ft`,
      glyph: '🚐',
      tone: 'neutral'
    });
  }

  if (a.stayLimitDays !== undefined) {
    dots.push({
      key: 'stay',
      color: COLOR.limit,
      label: `${a.stayLimitDays}-day stay limit`,
      glyph: '🗓️',
      tone: 'neutral'
    });
  }

  if (a.isFree !== undefined) {
    dots.push({
      key: 'free',
      color: a.isFree ? COLOR.free : COLOR.warn,
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
 * How many dots a collapsed pin shows before it stops.
 *
 * Six 6px dots and their gaps come to about 52px — a shade wider than the pin
 * itself, which is as far as a row can spread before two neighbouring pins'
 * rows start colliding. Anything past that is a "+n" dot, and tapping the pin
 * shows the lot.
 */
export const COLLAPSED_DOT_LIMIT = 6;
