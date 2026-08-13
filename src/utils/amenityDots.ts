import type {
  CampsiteAmenities, CellCoverage, DestinationLand, NearbyFacility, NearbyFacilityKind
} from '../types';
import type { WeatherSnapshot } from '../services/weatherService';
import type { RouteResult } from '../services/routingService';
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
  /**
   * The words on the chip. SHORT — two or three, and the glyph carries the
   * subject. A chip is read at a glance over a map, so anything longer stops
   * being a label and starts being a paragraph lying across the terrain.
   */
  label: string;
  /**
   * The whole, hedged truth, for the chip's tooltip and screen readers.
   *
   * This is where the caveats live now that the chip itself is short: which
   * reading "under control" is, that a signal estimate is a distance to a
   * mast rather than anything measured, what the router actually said. The
   * short label is never allowed to say more than this does.
   */
  full?: string;
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
  /**
   * Something the chip DOES when tapped, rather than something it says.
   *
   * EVERY CHIP IS TAPPABLE NOW. The ones listed here take the camera out to
   * the thing they are talking about — the way the fire chip always did — and
   * bring it back afterwards. A chip with no action still answers when tapped:
   * it unfurls into its own full, hedged sentence, which on a phone was
   * otherwise unreachable because it lived in a `title` attribute.
   *
   *   fires      the fires this chip is counting, named one at a time
   *   alert      the warning area this point is standing in
   *   land       the parcel the boundary layer matched under this point
   *   road       the nearest mapped driveable track, drawn as a line
   *   gap        where the router's road stops, and the walk left after it
   *   directions hands off to the phone's own maps app — this is the car chip,
   *              and it is why there is no longer a separate "Go" button
   */
  action?: 'fires' | 'alert' | 'land' | 'road' | 'gap' | 'directions';
  /**
   * Which warning family this chip stands for, on hazard chips only.
   *
   * Carried so the map can find the alert again when the chip is tapped,
   * without re-deriving it from the label a human reads.
   */
  badge?: AlertBadge;
}

/**
 * One hue per subject, all of them at the same brightness so no single dot
 * shouts louder than its neighbour for reasons of palette rather than
 * meaning. Hazards are excluded — they come from `BADGE_COLOR`, so a dot
 * matches the warning area it is standing in.
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
  trail: '#86EFAC',
  fishing: '#67E8F9',
  boat: '#7DD3FC',
  waste: '#FCD34D',
  warn: '#FB7185',
  /* The two fire colours the map's flame layer used, kept so the dot above a
     pin says exactly what the flame used to. */
  fireRunning: '#EF4444',
  fireHeld: '#F97316',
  weather: '#7DD3FC',
  route: '#93C5FD',
  land: '#A78BFA'
} as const;

/** The colour a nearby facility's dot and its route line are drawn in. */
export const FACILITY_COLOR: Record<NearbyFacilityKind, string> = {
  toilet: COLOR.toilet,
  shower: COLOR.shower,
  water: COLOR.water,
  dump: COLOR.dump,
  fuel: COLOR.fuel,
  groceries: COLOR.groceries,
  trail: COLOR.trail,
  fishing: COLOR.fishing,
  boat: COLOR.boat,
  waste: COLOR.waste,
  road: COLOR.road
};

/** "300 m" under a kilometre, "1.4 km" over it. */
const nearDistance = (km: number): string =>
  km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(1)} km`;

/**
 * A live hazard over this spot — smoke, a heat warning, a fire.
 *
 * These lead the row, because they change whether a camper should go at all.
 * They are the same colours and words as the hazard areas drawn on the map,
 * so the dot above a pin and the shape it is standing in are obviously the
 * same warning.
 */
export const hazardDots = (badges: AlertBadge[]): MarkerDot[] =>
  badges.map((b) => ({
    key: `hz-${b}`,
    color: BADGE_COLOR[b],
    label: WARNING_LABEL[b],
    // "Where?" is the next question after "what?", and the answer is a shape
    // an agency drew. Tapping goes and looks at it.
    full: `${WARNING_LABEL[b]} warning covers this point — tap to see the area it covers`,
    glyph: WARNING_EMOJI[b],
    tone: 'bad' as const,
    urgent: true,
    action: 'alert' as const,
    badge: b
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
    label: near.length > 1 ? `${near.length} · ${distance}` : distance,
    full: `${count} ${distance} away${running ? '' : ' — reported under control'}` +
      ' — tap to see them',
    glyph: '\u{1F525}',
    tone: 'bad',
    urgent: true,
    action: 'fires'
  }];
};

/**
 * Every one of these is hedged, because the number behind it is a distance to
 * a mast rather than a reading off a phone.
 */
const SIGNAL_SHORT: Record<string, string> = {
  strong: 'Strong',
  good: 'Signal',
  weak: 'Weak',
  none: 'No signal'
};

/**
 * The sky in one character, so the chip beside it only has to carry the
 * temperature. Matched loosely on the forecast wording because every feed
 * words it differently; anything unrecognised falls back to the thermometer,
 * which claims nothing about the sky at all.
 */
const skyGlyph = (forecast: string): string => {
  const f = forecast.toLowerCase();
  if (/thunder|storm/.test(f)) return '\u26C8\uFE0F';
  if (/snow|flurr|ice|freezing/.test(f)) return '\u{1F328}\uFE0F';
  if (/rain|shower|drizzle/.test(f)) return '\u{1F327}\uFE0F';
  if (/fog|haze|mist|smoke/.test(f)) return '\u{1F32B}\uFE0F';
  if (/partly|mostly sunny|few clouds/.test(f)) return '\u26C5';
  if (/cloud|overcast/.test(f)) return '\u2601\uFE0F';
  if (/clear|sunny|fair/.test(f)) return '\u2600\uFE0F';
  return '\u{1F321}\uFE0F';
};

const SIGNAL_COPY: Record<string, string> = {
  strong: 'Strong signal likely',
  good: 'Usable signal likely',
  weak: 'Weak signal at best',
  none: 'Probably no signal'
};

/**
 * What it is LIKE here right now: weather, signal, and the land underneath.
 *
 * These used to be tiles in a panel over the bottom half of the screen, which
 * meant the answer to "what is this place?" was always somewhere other than
 * the place. They are the same three answers, moved onto the pin they are
 * about, in the same row as everything else it has to say.
 *
 * Each one is skipped rather than guessed. No forecast, no mast in range and
 * no boundary polygon all produce no chip — an unknown never becomes a chip
 * saying "none", because "we could not find a mast" and "there is no signal"
 * are different claims and only the first one is ours to make.
 */
export const conditionDots = (
  weather: WeatherSnapshot,
  coverage: CellCoverage,
  land: DestinationLand | undefined,
  route?: RouteResult | null
): MarkerDot[] => {
  const dots: MarkerDot[] = [];

  /*
   * The drive, and where it stops being a drive.
   *
   * The router almost never reaches the pin itself, and the gap is the part
   * worth saying out loud: it is the walk, or the two-track, between the last
   * road anybody has mapped and the spot. Said here rather than buried under
   * a duration, because arriving to find 4 km of it left is the surprise this
   * chip exists to prevent.
   */
  if (route?.ok) {
    const hrs = Math.floor(route.durationMin / 60);
    const mins = Math.round(route.durationMin % 60);
    const drive = hrs ? `${hrs} h ${mins} m` : `${mins} min`;
    const worst = route.warnings.find((w) => w.severity === 'critical')
      ?? route.warnings.find((w) => w.severity === 'caution');

    dots.push({
      key: 'route',
      color: COLOR.route,
      label: `${drive} \u00B7 ${Math.round(route.distanceKm)} km`,
      full: `${drive} drive, ${Math.round(route.distanceKm)} km by road` +
        (worst ? ` \u2014 ${worst.message}` : '') +
        ' \u2014 tap to start navigating',
      glyph: '\u{1F697}',
      tone: 'neutral',
      // THE CAR CHIP IS THE GO BUTTON NOW. It used to be a green button under
      // the pin saying the same thing twice: this chip already knows how long
      // the drive is, so it is the obvious thing to press to start it.
      action: 'directions'
    });

    // The gap is its own chip because it is its own problem: the drive is
    // fine and then it simply stops, and that is the bit worth a second look.
    if (route.gapToDestinationKm > 0.15) {
      dots.push({
        key: 'route-gap',
        color: COLOR.rough,
        label: `${route.gapToDestinationKm.toFixed(1)} km short`,
        full: `The road this router carries ends ${route.gapToDestinationKm.toFixed(1)} km ` +
          'from the spot \u2014 usually an unmapped track, sometimes nothing at all ' +
          '\u2014 tap to see where it stops',
        glyph: '\u{1F6A7}',
        tone: 'bad',
        action: 'gap'
      });
    }
  }

  // A fire ban is a rule in force now, so it leads and it breathes.
  if (land?.fireBanActive) {
    dots.push({
      key: 'fire-ban',
      color: COLOR.fireRunning,
      label: 'Fire ban in effect',
      glyph: '\u{1F6AB}',
      tone: 'bad',
      urgent: true
    });
  }

  const now = weather.periods[0];
  if (now) {
    dots.push({
      key: 'weather-now',
      color: COLOR.weather,
      // The sky is the glyph's job, so the chip only carries the number.
      label: `${now.temperature}\u00B0${now.temperatureUnit}`,
      full: `${now.temperature}\u00B0${now.temperatureUnit}, ${now.shortForecast}` +
        (now.windSpeed ? `, wind ${now.windSpeed}` : ''),
      glyph: skyGlyph(now.shortForecast),
      tone: 'neutral'
    });
  }

  const overall = coverage.overall;
  if (overall) {
    dots.push({
      key: 'coverage',
      color: COLOR.signal,
      hollow: overall.strength === 'none',
      label: SIGNAL_SHORT[overall.strength],
      full: `${SIGNAL_COPY[overall.strength]} \u2014 nearest mast ` +
        `${overall.nearestTowerKm} km, terrain ignored`,
      glyph: '\u{1F4F6}',
      tone: overall.strength === 'none' ? 'bad'
        : overall.strength === 'weak' ? 'neutral' : 'good'
    });
  }

  if (land) {
    const detail = [
      land.designation,
      land.stayLimitDays != null ? `${land.stayLimitDays}-day limit` : null,
      land.permitRequired ? land.permitName ?? 'permit required' : null
    ].filter(Boolean).join(' \u00B7 ');

    dots.push({
      key: 'land',
      color: COLOR.land,
      label: land.name,
      full: (detail ? `${land.name} \u2014 ${detail}` : land.name) +
        ' \u2014 tap to see the parcel this came from. Its edges are approximate.',
      glyph: '\u{1F6E1}\uFE0F',
      tone: 'neutral',
      action: 'land'
    });

    // A permit is a thing to go and get before leaving, so it is not allowed
    // to hide at the end of a sentence about the name of the forest.
    if (land.permitRequired) {
      dots.push({
        key: 'permit',
        color: COLOR.warn,
        label: 'Permit',
        full: `${land.permitName ?? 'A permit'} is required here`,
        glyph: '\u{1F3AB}',
        tone: 'bad'
      });
    }
  }

  return dots;
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
      /*
       * Tapping goes and finds the nearest mapped track and draws it. The two
       * facts are NOT the same fact and the wording keeps them apart: the
       * rating is a camper's account of the drive in, the line is whatever
       * OpenStreetMap has near the spot. They usually agree. They can disagree.
       */
      full: `A camper recorded the road in as ${ROAD_ACCESS_LABEL[a.roadAccess].toLowerCase()}` +
        ' — tap to see the nearest track the map has',
      glyph: '🛣️',
      tone: rough ? 'neutral' : 'good',
      action: 'road'
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
  facilities
    // Nearest six. Ten kinds are looked up now, and a stack of ten chips over
    // the pin is taller than the phone it is on — so the row shows the six
    // closest and the rest stay out of the way. Nothing is being hidden that
    // the camper is closer to.
    .slice(0, 6)
    .map((f) => {
      /**
       * The road chip is worded differently because it is a weaker claim.
       *
       * A toilet chip means somebody mapped a toilet. A road chip means only
       * that a driveable track passes near this point — not that it is open,
       * passable in your vehicle, ungated, or that it ever reaches anywhere
       * you could park for the night. The full text says so, because this is
       * the chip most likely to be read as "you can camp here".
       */
      if (f.kind === 'road') {
        return {
          key: `near-${f.id}`,
          color: FACILITY_COLOR.road,
          label: `Road ${nearDistance(f.distanceKm)}`,
          full:
            `A driveable track runs about ${nearDistance(f.distanceKm)} from here` +
            `${f.name ? ` (${f.name})` : ''} \u2014 tap to see it. ` +
            'A road nearby is not a campsite: it may be gated, seasonal, ' +
            'impassable, or never widen into anywhere you could stop.',
          glyph: FACILITY_GLYPH.road,
          tone: 'good' as const,
          facility: f,
          // Drawn as the line it is, rather than routed to as if it were a
          // destination: nobody drives TO a road, they drive along it.
          action: 'road' as const
        };
      }

      return {
        key: `near-${f.id}`,
        color: FACILITY_COLOR[f.kind],
        label: `${f.distanceKm} km`,
        full: `${FACILITY_LABEL[f.kind]} ${f.distanceKm} km away \u2014 tap for a route`,
        glyph: FACILITY_GLYPH[f.kind],
        tone: 'good' as const,
        facility: f
      };
    });

/*
 * There is deliberately no cap on collapsed dots any more.
 *
 * A pin used to show the first few and roll the rest into a grey "+n", which
 * hid the very thing the dots are for: how much is known about a spot. The
 * dots are now beads on a ring that widens to fit, so every recorded fact
 * gets one. See `collapsedDotRing` in MapComponent.
 */
