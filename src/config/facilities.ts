/**
 * EVERY KIND OF FACILITY, IN ONE TABLE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * There were three vocabularies for the same nine or ten things, and they
 * disagreed with each other:
 *
 *   `NearbyFacilityKind`   client-side, OpenStreetMap, 11 kinds, `toilet`
 *   `poi_kind` (Postgres)  10 kinds, `potable_water`, and no toilet AT ALL
 *   `PoiKind` (server)     3 kinds, and it calls a toilet a `restroom`
 *
 * So a toilet was `toilet` on a pin, `restroom` in the report sheet, and
 * unrepresentable in the database — which is the whole reason a camper could
 * never add the single most-hunted facility there is. Anything that reads or
 * writes a facility now reads its label, glyph, colour, OpenStreetMap
 * selectors and database enum value from HERE, so the chip under the search,
 * the pin on the map and the row in Postgres cannot drift apart again.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FACILITY IS AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * Two sources feed the layer, and they are never blended into one voice:
 *
 *   OpenStreetMap  somebody mapped one, at some point. Not that it is open,
 *                  maintained, unlocked, or still standing.
 *   a camper       somebody using this app said it was there. One person,
 *                  until others confirm it.
 *
 * Neither is a promise, and finding NOTHING is never a fact. The emptiest
 * country is the least surveyed, which is exactly where a camper is standing.
 * Every screen that draws these says so — see `nearbyAmenityService.ts` for
 * the long version of that rule.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Toilet, GlassWater, ShowerHead, ArrowDownToLine, Fuel, Flame,
  WashingMachine, ShoppingCart, Trash2, Wind, Footprints, Fish, Sailboat,
  Route
} from 'lucide-react';
import type { FacilityKind } from '../types';

/**
 * The `poi_kind` enum values in Postgres, as they actually are.
 *
 * `toilet` is added by migration 15. The three OSM-only kinds below map to
 * `null` because there is no enum value for them and inventing one would
 * mean a migration for something no camper has asked to add by hand — you do
 * not submit a trailhead, you walk to it.
 */
export type PoiDbKind =
  | 'toilet' | 'potable_water' | 'dump_station' | 'propane' | 'fuel'
  | 'shower' | 'laundry' | 'trash' | 'air_compressor' | 'cell_booster_spot'
  | 'other';

export interface FacilitySpec {
  /** Two or three words. A chip is read at a glance over a map. */
  label: string;
  /** Plural, for the chip row: "Toilets" reads as a search, "Toilet" as a fact. */
  plural: string;
  /**
   * The EMOJI, for a pin on the map. Colour is doing the work of telling one
   * pin from another at a glance over satellite imagery, and an emoji carries
   * its own.
   */
  glyph: string;
  /**
   * The LINE ICON, for the row of buttons under the search.
   *
   * Not the emoji. Ten emoji in a row is ten different art styles, ten
   * different weights and ten different palettes fighting each other and the
   * map behind them; drawn as one stroke weight in one colour they read as one
   * control. The colour a facility owns stays where it means something — on
   * its pins — rather than being sprayed across the chrome as well.
   */
  icon: LucideIcon;
  color: string;
  /** Overpass selectors that mean this kind. Empty = not in OpenStreetMap. */
  osm: string[];
  /** The `poi_kind` value a camper's submission is stored as. */
  dbKind: PoiDbKind | null;
  /** Gets a chip under the search box. */
  searchable: boolean;
  /** A camper can add one by hand. */
  addable: boolean;
}

/**
 * THE TABLE.
 *
 * Order matters: it is the order of the chips under the search, and it runs
 * roughly by how often a camper goes looking. Toilet and water first because
 * those are the two that decide whether you stay another night.
 */
export const FACILITY: Record<FacilityKind, FacilitySpec> = {
  toilet: {
    label: 'Toilet', plural: 'Toilets', glyph: '🚻', icon: Toilet, color: '#C084FC',
    osm: ['node["amenity"="toilets"]', 'way["amenity"="toilets"]'],
    dbKind: 'toilet', searchable: true, addable: true
  },
  water: {
    label: 'Drinking water', plural: 'Water', glyph: '🚰', icon: GlassWater, color: '#38BDF8',
    osm: [
      'node["amenity"="drinking_water"]',
      'node["man_made"="water_tap"]["drinking_water"="yes"]'
    ],
    dbKind: 'potable_water', searchable: true, addable: true
  },
  shower: {
    label: 'Shower', plural: 'Showers', glyph: '🚿', icon: ShowerHead, color: '#60A5FA',
    osm: ['node["amenity"="shower"]', 'way["amenity"="shower"]'],
    dbKind: 'shower', searchable: true, addable: true
  },
  dump: {
    label: 'Dump station', plural: 'Dump', glyph: '🚽', icon: ArrowDownToLine, color: '#A3E635',
    osm: [
      'node["amenity"="sanitary_dump_station"]',
      'way["amenity"="sanitary_dump_station"]'
    ],
    dbKind: 'dump_station', searchable: true, addable: true
  },
  fuel: {
    label: 'Fuel', plural: 'Fuel', glyph: '⛽', icon: Fuel, color: '#FB7185',
    osm: ['node["amenity"="fuel"]', 'way["amenity"="fuel"]'],
    dbKind: 'fuel', searchable: true, addable: true
  },
  propane: {
    label: 'Propane', plural: 'Propane', glyph: '🔥', icon: Flame, color: '#FDBA74',
    /* `fuel:lpg` is on ordinary fuel stations that also sell it; the shop tag
       is the dedicated bottle exchange. Both are somewhere you refill. */
    osm: [
      'node["amenity"="fuel"]["fuel:lpg"="yes"]',
      'node["shop"="gas"]'
    ],
    dbKind: 'propane', searchable: true, addable: true
  },
  laundry: {
    label: 'Laundry', plural: 'Laundry', glyph: '🧺', icon: WashingMachine, color: '#F9A8D4',
    osm: ['node["shop"="laundry"]', 'node["amenity"="laundry"]'],
    dbKind: 'laundry', searchable: true, addable: true
  },
  groceries: {
    label: 'Groceries', plural: 'Groceries', glyph: '🛒', icon: ShoppingCart, color: '#F0ABFC',
    osm: [
      'node["shop"="supermarket"]', 'way["shop"="supermarket"]',
      'node["shop"="convenience"]', 'way["shop"="convenience"]'
    ],
    /* No enum value, and it does not need one: a supermarket is the kind of
       thing OpenStreetMap already has everywhere, and a camper adding one by
       hand adds nothing the map did not know. */
    dbKind: null, searchable: true, addable: false
  },
  waste: {
    label: 'Rubbish disposal', plural: 'Rubbish', glyph: '🗑️', icon: Trash2, color: '#FCD34D',
    osm: [
      'node["amenity"="waste_disposal"]', 'way["amenity"="waste_disposal"]',
      'node["amenity"="recycling"]["recycling_type"="centre"]'
    ],
    dbKind: 'trash', searchable: true, addable: true
  },
  air: {
    label: 'Air compressor', plural: 'Air', glyph: '💨', icon: Wind, color: '#93C5FD',
    osm: ['node["amenity"="compressed_air"]'],
    dbKind: 'air_compressor', searchable: true, addable: true
  },
  /* ---------------------------------------------------------------- *
   * Below here: found, never submitted, and never given a chip.
   * ---------------------------------------------------------------- */
  trail: {
    label: 'Trailhead', plural: 'Trailheads', glyph: '🥾', icon: Footprints, color: '#86EFAC',
    /* Where a walk STARTS, rather than the path itself. A hiking route is a
       line hundreds of km long whose nearest point to a campsite is
       meaningless; the head is a place you drive to and park. */
    osm: [
      'node["highway"="trailhead"]',
      'node["information"="guidepost"]["hiking"="yes"]'
    ],
    dbKind: null, searchable: false, addable: false
  },
  fishing: {
    label: 'Fishing spot', plural: 'Fishing', glyph: '🎣', icon: Fish, color: '#67E8F9',
    osm: ['node["leisure"="fishing"]', 'way["leisure"="fishing"]'],
    dbKind: null, searchable: false, addable: false
  },
  boat: {
    label: 'Boat ramp', plural: 'Boat ramps', glyph: '🛶', icon: Sailboat, color: '#7DD3FC',
    /* A slipway is the ramp itself. Marinas are excluded on purpose: a marina
       is a business with a gate, not somewhere to put a canoe in. */
    osm: ['node["leisure"="slipway"]', 'way["leisure"="slipway"]'],
    dbKind: null, searchable: false, addable: false
  },
  /**
   * The odd one out, and deliberately so.
   *
   * Not a facility somebody built; the nearest driveable track, looked up only
   * for a point sitting in public land, to answer "could I get a vehicle
   * anywhere near here?". It rides in the facility list because it behaves
   * identically once found — a chip on the pin, framed and routed when tapped
   * — but it is never a claim that the road reaches a place to camp, and it is
   * neither searchable nor addable.
   */
  road: {
    label: 'Driveable road', plural: 'Roads', glyph: '🛣️', icon: Route, color: '#FDE047',
    osm: [], dbKind: null, searchable: false, addable: false
  }
};

/** Every kind, in table order. */
export const FACILITY_KINDS = Object.keys(FACILITY) as FacilityKind[];

/** The kinds that get a chip under the search box, in table order. */
export const SEARCHABLE_FACILITY_KINDS = FACILITY_KINDS.filter(
  (kind) => FACILITY[kind].searchable
);

/** The kinds a camper may add by hand, in table order. */
export const ADDABLE_FACILITY_KINDS = FACILITY_KINDS.filter(
  (kind) => FACILITY[kind].addable
);

/* ------------------------------------------------------------------ *
 * The old flat lookups, kept so callers do not all have to change.
 * ------------------------------------------------------------------ */

export const FACILITY_LABEL: Record<FacilityKind, string> = Object.fromEntries(
  FACILITY_KINDS.map((kind) => [kind, FACILITY[kind].label])
) as Record<FacilityKind, string>;

export const FACILITY_GLYPH: Record<FacilityKind, string> = Object.fromEntries(
  FACILITY_KINDS.map((kind) => [kind, FACILITY[kind].glyph])
) as Record<FacilityKind, string>;

export const FACILITY_COLOR: Record<FacilityKind, string> = Object.fromEntries(
  FACILITY_KINDS.map((kind) => [kind, FACILITY[kind].color])
) as Record<FacilityKind, string>;

/**
 * Which kind a `poi_kind` row is, coming back out of the database.
 *
 * `cell_booster_spot` and `other` have no facility kind and never draw: the
 * first is not a facility, and the second is a shrug. They are in the enum
 * because migration 02 put them there, not because anything renders them.
 */
const BY_DB_KIND = new Map<string, FacilityKind>(
  FACILITY_KINDS
    .filter((kind) => FACILITY[kind].dbKind !== null)
    .map((kind) => [FACILITY[kind].dbKind as string, kind])
);

export const facilityKindFromDb = (dbKind: string): FacilityKind | null =>
  BY_DB_KIND.get(dbKind) ?? null;

/**
 * How many separate campers it takes before a camper-added facility stops
 * being drawn hollow.
 *
 * ONE. Deliberately, and it is not a confidence threshold — it is the
 * difference between "one person said this" and "somebody else agreed". The
 * database's own promote-at-five rule still governs `status`; this only
 * governs how the pin LOOKS, because a facility nobody can see is a facility
 * nobody can confirm, and five was a number this app would never reach.
 *
 * Same shape as Beacon's ladder in `config/beacon.ts`: evidence, not
 * certainty, and the wording says which one it is.
 */
export const FACILITY_CONFIRMED_AT = 1;

export interface FacilitySourceStyle {
  /** One line, plain English, for the card the pin opens. */
  meaning: string;
  /** Hollow ring rather than a solid fill. */
  hollow: boolean;
}

/**
 * What a pin's fill MEANS.
 *
 * Solid is not "verified" — nothing here is. Solid means more than one source
 * says so; hollow means exactly one person did. Both are drawn, always: a
 * facility hidden until it earns a fill is one nobody can ever agree with.
 */
export const facilitySourceStyle = (
  fromOsm: boolean, confirmations: number
): FacilitySourceStyle => {
  if (fromOsm && confirmations > 0) {
    return {
      meaning: `Mapped in OpenStreetMap, and ${confirmations === 1
        ? 'one camper has'
        : `${confirmations} campers have`} confirmed it here.`,
      hollow: false
    };
  }
  if (fromOsm) {
    return {
      meaning: 'Mapped in OpenStreetMap by a volunteer. Nobody using Wandrlust has checked it.',
      hollow: false
    };
  }
  if (confirmations >= FACILITY_CONFIRMED_AT) {
    return {
      meaning: `Added by a camper, and ${confirmations === 1
        ? 'one other has'
        : `${confirmations} others have`} confirmed it.`,
      hollow: false
    };
  }
  return {
    meaning: 'One camper added this. Nobody else has confirmed it yet.',
    hollow: true
  };
};
