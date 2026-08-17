/**
 * WHAT THE AGENCY PUBLISHES, FOR LAND WHOSE OWN RECORD SAYS NOTHING.
 *
 * `public_lands` carries a stay limit and a permit flag per parcel, and for
 * almost every parcel on the map both are null. Until now that came out of the
 * app as "stay limit and permit rules not recorded — ask the agency", on BLM
 * land, in a national forest, on Ontario Crown land: places where the rule is
 * not a mystery at all. It is written in the Code of Federal Regulations and
 * on a provincial web page, it has been the same for years, and a camper who
 * is told the app does not know it will reasonably conclude the app is not
 * worth asking.
 *
 * So each SOURCE gets the rule its agency publishes for that whole class of
 * land. Not a per-parcel record, and never presented as one.
 *
 * THE LINE THIS FILE MUST NOT CROSS. These are general rules, and general
 * rules have exceptions everywhere: a BLM field office that sets seven days, a
 * national forest with its own closure order, a wilderness area inside the
 * forest, a stretch of Crown land posted against camping. Every card built
 * from this says out loud that it is the agency's general rule and not a
 * record for the parcel underneath the pin — that is what `basis` is for, and
 * nothing here may be shown without it. A general rule quoted as a specific
 * permission is exactly the overstatement this app exists not to make.
 *
 * Keyed on the `_source` id a boundary feature carries — see BOUNDARY_SOURCES
 * in `server/boundaryRoutes.ts` and LAND_SOURCES in `scripts/landSources.ts`,
 * which use the same ids.
 */

export interface PublishedLandRules {
  /**
   * The rules, one per bullet, in the fewest words that stay true.
   *
   * Kept to four at most and short enough to read at a glance: this lands in a
   * bubble on a phone, and a card nobody finishes is not information.
   */
  rules: string[];
  /**
   * Where the bullets come from, as a sentence. Shown under every list.
   *
   * Written out per source rather than assembled from an agency name, because
   * the honest sentence is not the same shape for all of them — PAD-US does
   * not publish camping rules at all, it just says who the manager is.
   */
  basis: string;
}

/* 43 CFR 8365.1-2. The "14–28–25" rule campers quote to each other. */
const BLM: PublishedLandRules = {
  rules: [
    '14 nights in any 28-day period',
    'Then move at least 25 miles (40 km) away',
    'No permit or fee for most dispersed camping',
    'Field offices can and do set shorter limits'
  ],
  basis: "The BLM's general rule for its land, not a record for this parcel"
};

export const PUBLISHED_LAND_RULES: Record<string, PublishedLandRules> = {
  /*
   * BLM under both ids it travels under: `blm_lands` is the live map's
   * source (server/boundaryRoutes.ts) and `blm_sma_national` is the seeder's
   * (scripts/landSources.ts). Same agency, same regulation — and an id that
   * only half-matches is exactly how a rulebook silently stops applying.
   */
  blm_lands: BLM,
  blm_sma_national: BLM,

  /* 36 CFR 261.58(a). The relocation distance is set per forest — five miles,
     ten and twenty-five are all in force somewhere — so it is not stated. */
  usfs_national_forest: {
    rules: [
      '14 nights in any 30-day period',
      'Then move on — each forest sets how far',
      'Often capped at 28 nights in a year as well',
      'No permit or fee for most dispersed camping'
    ],
    basis: "The Forest Service's general rule, not a record for this forest"
  },

  /* alberta.ca/camping-on-public-land, and the Public Lands Camping Pass. */
  alberta_green_area: {
    rules: [
      '14 consecutive nights in one spot',
      'Then move at least 1 km for 72 hours',
      'Public Lands Camping Pass on the Eastern Slopes',
      'Some areas are closed to random camping'
    ],
    basis: "Alberta's general public land rule, not a record for this parcel"
  },

  /*
   * A PLUZ is a managed zone laid over Crown land and the whole point of one
   * is that it overrides the general rule, so the only honest general thing to
   * say is that this zone has its own.
   */
  alberta_pluz: {
    rules: [
      'This zone sets its own camping rules',
      'Some allow camping only at marked sites',
      'Public Lands Camping Pass on the Eastern Slopes',
      'Read the zone before you count on staying'
    ],
    basis: 'A Public Land Use Zone overrides the general rule — check this one'
  },

  /*
   * "AT ONE SITE" MEANS THE SPOT YOU ARE PARKED ON, NOT THE POLYGON.
   *
   * All three provincial rules below are written as "21 days at any one site",
   * and the phrase invites exactly one wrong reading: that a site is the parcel
   * the map draws, so crossing an internal boundary would restart the clock.
   * It does not. The site is the piece of ground your camp occupies — the
   * pullout, the clearing, the beach — and the count follows YOU, not which
   * administrative area you happen to be standing in. The map's polygons are
   * planning units and forest designations; no province counts nights by them.
   *
   * This matters for what the map draws, and it is the reason the zoomed-out
   * view is free to weld neighbouring parcels into one block: an internal line
   * between two same-rules parcels carries no meaning a camper could act on,
   * so hiding it hides nothing. The bullets below say "in one spot" instead of
   * "at one site" for the same reason — plain, and impossible to read as a
   * claim about the shape on the screen.
   */
  saskatchewan_provincial_forest: {
    rules: [
      '21 consecutive nights in one spot',
      'The limit is per campsite, not per forest',
      'Free, with nothing to buy or register',
      'Parks and rec sites inside the forest differ'
    ],
    basis: "Saskatchewan's general Crown land rule, not a record for this land"
  },

  manitoba_provincial_forest: {
    rules: [
      '21 nights in one spot, unless posted otherwise',
      'The limit is per campsite, not per forest',
      'Free, no permit, for residents of Canada',
      'Parks and wildlife areas have their own rules'
    ],
    basis: "Manitoba's general Crown land rule, not a record for this forest"
  },

  ontario_clupa_general_use: {
    rules: [
      '21 nights in one spot per calendar year',
      'The limit is per campsite, not per area',
      'Free for Canadian residents',
      'Non-residents need a permit across much of the north'
    ],
    basis: "Ontario's general Crown land rule, not a record for this area"
  },

  /*
   * PAD-US grades a polygon Open / Restricted / Closed and says nothing
   * whatever about sleeping. This entry exists to say that clearly instead of
   * letting the silence read as "no rules here".
   */
  padus_open_access: {
    rules: [
      'Open access means you may enter, not that you may stay',
      'Whoever manages this parcel sets the stay limit',
      'Worth a phone call before you plan a night here'
    ],
    basis: 'PAD-US records public access, not camping rules'
  }
};

/** The published rules for a boundary source, if there are any. */
export const publishedRulesFor = (
  sourceId: string | undefined
): PublishedLandRules | undefined =>
  sourceId ? PUBLISHED_LAND_RULES[sourceId] : undefined;

export interface LandRuleCard {
  /** The bullets, in reading order. Never empty. */
  rules: string[];
  /**
   * Where they came from, when that needs saying.
   *
   * Null when the bullets are the parcel's own recorded rules, which need no
   * disclaimer beyond the boundary caveat every card already carries. A
   * string whenever they are the agency's general rule instead — and in that
   * case it is not optional, see the header.
   */
  basis: string | null;
}

/**
 * The rules for a piece of public land, as bullets a camper can act on.
 *
 * "Humboldt–Toiyabe National Forest" on its own is trivia. What a camper wants
 * off the back of the name is how long they can stay, whether they have to buy
 * something first, and whether they can light a fire.
 *
 * THREE SOURCES OF TRUTH, IN ORDER, AND NEVER MIXED. The parcel's own record
 * if it has one. Otherwise the rule its agency publishes for that whole class
 * of land, clearly labelled as that. Otherwise — a source nobody has written a
 * rulebook for — the honest admission. Keeping them unmixed is the point: a
 * card must never leave a camper unable to tell which of its lines is about
 * the ground they are standing on.
 *
 * A MISSING RULE IS STILL SAID OUT LOUD, NEVER TREATED AS PERMISSION.
 */
export const landRules = (
  land: {
    sourceId?: string;
    stayLimitDays?: number;
    moveDistanceKm?: number;
    permitRequired?: boolean;
    permitName?: string;
    fireBanActive?: boolean;
  }
): LandRuleCard => {
  const rules: string[] = [];

  /*
   * The one line that is about tonight rather than about the regulations, so
   * it leads whatever follows it. It is also the one line that is always a
   * recorded fact, which is why a general-rule card carrying it understates
   * itself slightly — the safe direction.
   */
  if (land.fireBanActive) rules.push('Fire ban in effect — no open flame');

  const recorded = land.stayLimitDays != null || land.permitRequired != null;

  if (recorded) {
    if (land.stayLimitDays != null) {
      rules.push(
        `Stay up to ${land.stayLimitDays} days, then move` +
        // Moving 200 m down the same track does not restart the clock, where
        // the manager has said how far. Where they haven't, we don't invent it.
        (land.moveDistanceKm != null ? ` at least ${land.moveDistanceKm} km` : ' on')
      );
    }
    if (land.permitRequired === true) {
      rules.push(`${land.permitName ?? 'A permit'} required before you camp`);
    } else if (land.permitRequired === false) {
      rules.push('No permit recorded for dispersed camping');
    }
    if (land.stayLimitDays == null) rules.push('Stay limit not recorded — ask the agency');
    if (land.permitRequired == null) rules.push('Permit rules not recorded — ask the agency');
    return { rules, basis: null };
  }

  const published = publishedRulesFor(land.sourceId);
  if (published) {
    rules.push(...published.rules);
    return { rules, basis: published.basis };
  }

  rules.push('Stay limit and permit rules not recorded — ask the agency');
  return { rules, basis: null };
};
