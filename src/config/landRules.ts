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

/* Loi sur les terres du domaine de l'État. Keyed on three ids below — see
   the note there for why that is not belt-and-braces but a bug that was. */
const QUEBEC: PublishedLandRules = {
  rules: [
    '21 consecutive days in one spot',
    'Stay 60 m back from water, roads and private land',
    'Free, no permit, on plain public land',
    'ZECs, réserves and pourvoiries run their own way'
  ],
  basis: "Québec's general public land rule, not a record for this zone"
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

  /*
   * BC's rule is the Land Act permission policy, not the Forest Act
   * designation the polygon comes from — the map draws provincial forest and
   * the 14 days apply to Crown land generally. The 72-hour clause is the part
   * campers get wrong: leaving for a night does not restart the count, and the
   * province says so explicitly, so it is worth one of the four lines.
   */
  bc_provincial_forest: {
    rules: [
      '14 consecutive days in one spot',
      'Away 72 hours before the count restarts',
      'Free, no permit, on open Crown land',
      'Tenures, parks and rec sites have their own rules'
    ],
    basis: "British Columbia's general Crown land rule, not a record for this forest"
  },

  /*
   * QUEBEC — AND THE ID THAT DID NOT MATCH, WHICH IS WHY THIS COMMENT IS LONG.
   *
   * These rules were written before Quebec had a boundary source, keyed on
   * `quebec_patp` against the day one arrived. Two arrived — `qc_patp_multi_use`
   * and `qc_patp_north_multi_use` — and neither is called `quebec_patp`, so
   * from the day Quebec started drawing on the map until this was found, every
   * one of its parcels answered "stay limit and permit rules not recorded —
   * ask the agency" with the researched, correct rules sitting in this file
   * three lines away. This is exactly the trap the BLM entry above is doubled
   * up to avoid, and it caught us anyway: A RULEBOOK KEYED ON AN ID THAT
   * NOBODY SENDS FAILS SILENTLY AND LOOKS LIKE HONESTY.
   *
   * Both live ids are listed now, and the old key is kept beside them so a
   * seeder or a cache still carrying it does not lose its rules either.
   *
   * Quebec's 21 days come from the Loi sur les terres du domaine de l'État,
   * and the setback is the part that catches people out — 60 m from water is
   * further than it sounds when the reason you drove there was the lake.
   *
   * The last line is not a nicety. ZECs, réserves fauniques and pourvoiries
   * cover a great deal of southern Quebec's public land, each with its own
   * gate, fee and register, and none of them are cut out of the polygons this
   * app draws.
   */
  quebec_patp: QUEBEC,
  qc_patp_multi_use: QUEBEC,
  qc_patp_north_multi_use: QUEBEC,

  /*
   * NEWFOUNDLAND AND LABRADOR GETS NO NUMBER, FOR NOVA SCOTIA'S REASON.
   *
   * Crown land here draws as the province minus its alienated titles — 95% of
   * the island and almost all of Labrador — and it had no entry in this file
   * at all, so every parcel of it answered "rules not recorded". That is worse
   * than useless on the province with the most public land in the country.
   *
   * The day count is still not stated. "21 days a year for Canadians" is
   * everywhere in the camping guides and nowhere in anything the province
   * publishes, and the house rule is that a number with no source does not go
   * on the screen — see Nova Scotia above. What IS published is the residency
   * condition and where camping is not allowed, so that is what this says.
   */
  nl_crown_land: {
    rules: [
      'Free for residents of Canada, no permit',
      'Not in parks, protected areas or on private land',
      'Posted signs override this — read them',
      'How long you may stay is not published — ask Crown Lands'
    ],
    basis:
      "Newfoundland and Labrador's general Crown land guidance, not a record " +
      'for this parcel'
  },

  /* New Brunswick calls a night out "occasional use", which needs no
     authorisation. The 75 m setback is for RVs only — tents are exempt. */
  new_brunswick_crown_land: {
    rules: [
      '21 days is the usual limit for casual camping',
      'RVs stay 75 m back from any waterway',
      'Free, and no authorisation for occasional use',
      'Never block a road, trail or waterway'
    ],
    basis: "New Brunswick's general Crown land rule, not a record for this parcel"
  },

  /*
   * NOVA SCOTIA GETS NO NUMBER, ON PURPOSE.
   *
   * Every other province in this file publishes a stay limit in plain words.
   * Nova Scotia publishes what you may do on Crown land without a permit, and
   * the day count is not in it — the figures that circulate come from camping
   * guides rather than from the province. So this says what is actually known
   * and leaves the number to the department, which is the honest shape of a
   * rule nobody has written down.
   */
  nova_scotia_crown_land: {
    rules: [
      'Short recreational stays, no permit needed',
      'Staying longer needs the department\'s permission',
      'Wilderness areas and wildlife areas have their own rules',
      'The woods close in bad fire seasons — check before you go'
    ],
    basis: "Nova Scotia's general Crown land guidance, not a record for this parcel"
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
  },
  /**
   * The permit regime that applies AT THIS POINT, where one does.
   *
   * A parcel record cannot answer this and used to try: every Alberta parcel
   * said the Public Lands Camping Pass was required, across a Green Area that
   * reaches the Northwest Territories, for a pass that covers a strip down the
   * Eastern Slopes. Removing that flag alone would have swapped one wrong
   * answer for another — "no permit recorded" on the Ghost — so the point is
   * asked instead, against the province's own published outline. See
   * `permitForLandPoint` in `config/permits.ts`.
   */
  permitHere?: { name: string; certainty: 'site' | 'boundary' | 'area' } | null
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
    /*
     * The point beats the parcel, always. It is the agency's own shape asked
     * at the camper's own coordinates, where the parcel flag is a property of
     * a polygon that may be a tenth inside the regime and nine tenths out.
     */
    if (permitHere) {
      rules.push(
        permitHere.certainty === 'area'
          ? `${permitHere.name} may apply — check before you go`
          : `${permitHere.name} required before you camp`
      );
    } else if (land.permitRequired === true) {
      rules.push(`${land.permitName ?? 'A permit'} required before you camp`);
    } else if (land.permitRequired === false) {
      rules.push('No permit recorded for dispersed camping');
    }
    if (land.stayLimitDays == null) rules.push('Stay limit not recorded — ask the agency');
    if (!permitHere && land.permitRequired == null) {
      rules.push('Permit rules not recorded — ask the agency');
    }
    return { rules, basis: null };
  }

  const published = publishedRulesFor(land.sourceId);
  if (published) {
    rules.push(...published.rules);
    return { rules, basis: published.basis };
  }

  if (permitHere) {
    rules.push(
      permitHere.certainty === 'area'
        ? `${permitHere.name} may apply — check before you go`
        : `${permitHere.name} required before you camp`
    );
    rules.push('Stay limit not recorded — ask the agency');
    return { rules, basis: null };
  }

  rules.push('Stay limit and permit rules not recorded — ask the agency');
  return { rules, basis: null };
};
