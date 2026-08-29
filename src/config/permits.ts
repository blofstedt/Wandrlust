/**
 * PERMITS THAT APPLY TO CAMPING THIS APP OTHERWISE CALLS FREE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * "Free" and "no permit" are not the same claim, and the app was making the
 * first while implying the second. Four bundled Alberta spots described free
 * Crown Land camping on ground where the province has required a paid pass for
 * years. A camper reading that drives four hours and gets a fine — which is
 * precisely the failure this codebase says it will never risk.
 *
 * So a permit is a fact with a source, a price, an issuer and somewhere to go
 * and get one, and it is carried as data rather than buried in a sentence
 * somebody remembered to write.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED IS NOT THE SAME AS PAID
 * ---------------------------------------------------------------------------
 *
 * Alabama Hills needs a permit and the permit costs nothing. Alberta's costs
 * $30. Both are "you cannot legally camp here without doing something first",
 * and collapsing them into one warning would either frighten people off a free
 * form or let them drive into a fine. `free` keeps them apart, and `cost` is a
 * STRING because "Free" and "$30 a year" are both true answers and only one of
 * them is a number.
 *
 * ---------------------------------------------------------------------------
 * EVERY ENTRY CARRIES THE DATE IT WAS CHECKED
 * ---------------------------------------------------------------------------
 *
 * Fees change and rules change. A permit record with no date is a claim with
 * no shelf life, and this app does not make those. `checked` is shown to the
 * camper, so an old answer looks old.
 */
import type { Campsite } from '../types';
import { insideCampingPassArea } from './albertaCampingPass';

export interface CampingPermit {
  id: string;
  /** The agency's own name for it, so it is searchable and recognisable. */
  name: string;
  /** The body that issues it. */
  issuer: string;
  /** Who is actually required to hold one. */
  whoNeeds: string;
  /**
   * What it costs, in the agency's own terms. Never a number — see the note
   * above. "Free" is a valid and important value.
   */
  cost: string;
  /** True when the permit itself costs nothing. Required, but not paid. */
  free: boolean;
  /** Where a camper can actually get one. */
  url: string;
  /** Anything they would otherwise be caught out by. One or two sentences. */
  note?: string;
  /** ISO date this was last checked against the issuer's own page. */
  checked: string;
}

/**
 * Where a regime applies, when it is not attached to one spot by hand.
 *
 * `bbox` is an APPROXIMATION of a real boundary and is treated as one: an
 * area match never says "required", only "may apply — check". The exact line
 * is the agency's and this app does not hold it.
 */
interface PermitArea {
  permitId: string;
  country: string;
  stateProvince: string;
  bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /**
   * The agency's OWN published boundary, where we hold it.
   *
   * Beats a bbox and is reported as such — a rectangle around the Alberta
   * pass area swallows Edmonton, Red Deer and a great deal of farmland, so
   * every match had to be hedged into "may apply" and the hedge was doing the
   * work of the shape. With the real outline the answer is an answer.
   */
  contains?: (lat: number, lon: number) => boolean;
  /**
   * Only ever matches DISPERSED camping, never a named campground.
   *
   * This is load-bearing and was nearly got wrong. Alberta's Public Lands
   * Camping Pass covers RANDOM camping on public land — it has nothing to say
   * about the province's developed campgrounds, which charge their own nightly
   * fee instead. An area rule that fired on every Alberta row would have put a
   * "buy a pass" warning on precisely the campgrounds where the pass does not
   * apply.
   */
  dispersedOnly: true;
}

export const CAMPING_PERMITS: Record<string, CampingPermit> = {
  'ab-public-lands-camping-pass': {
    id: 'ab-public-lands-camping-pass',
    name: 'Public Lands Camping Pass',
    issuer: 'Government of Alberta',
    whoNeeds:
      'Everyone 18 and over who random camps on public land along the Eastern ' +
      'Slopes — roughly Grande Prairie down to Waterton, west of Highways 43 and 22.',
    cost: '$30 a year, or $20 for three days, per person',
    free: false,
    url: 'https://www.alberta.ca/public-lands-camping-pass',
    note:
      'It covers random camping on public land, NOT the province’s developed ' +
      'campgrounds, which charge their own nightly fee. Buy it before you go — ' +
      'there is nowhere to buy one at the roadside.',
    checked: '2026-08-29'
  },

  'on-crown-land-non-resident': {
    id: 'on-crown-land-non-resident',
    name: 'Non-Resident Crown Land Camping Permit',
    issuer: 'Government of Ontario',
    whoNeeds:
      'Non-residents of Canada aged 18 and over, camping on Crown land north ' +
      'of the French and Mattawa rivers. Canadian residents need no permit.',
    cost: '$10.57 a person a night, including HST (free for Canadian residents)',
    free: false,
    url: 'https://www.ontario.ca/page/non-resident-crown-land-camping-and-green-zones',
    note:
      'Canadian residents camp free on Crown land, up to 21 days on any one ' +
      'site per year. The permit is for everyone else, and there are exemptions ' +
      '— under 18s, a camping unit rented from an Ontario business, and Ontario ' +
      'property owners.',
    checked: '2026-08-29'
  },

  'blm-alabama-hills': {
    id: 'blm-alabama-hills',
    name: 'Alabama Hills Designated Camping Permit',
    issuer: 'Bureau of Land Management, Bishop Field Office',
    whoNeeds: 'Anyone camping outside a developed campground in the Alabama Hills.',
    cost: 'Free',
    free: true,
    url: 'https://www.blm.gov/visit/alabama-hills',
    note:
      'Free, and still required. It does not reserve you a site. Camping is ' +
      'only allowed in the designated semi-primitive sites, not anywhere you ' +
      'can park — that changed and the old free-for-all is over.',
    checked: '2026-08-29'
  }
};

/**
 * Areas where a regime applies to dispersed camping.
 *
 * Deliberately short. A regime goes in here only where the boundary is
 * something this app can approximate honestly AND the answer is worth
 * hedging about; anything more precise is attached to the spot itself with
 * `permitId`, which says "required" rather than "may apply".
 */
const PERMIT_AREAS: PermitArea[] = [
  {
    permitId: 'ab-public-lands-camping-pass',
    country: 'Canada',
    stateProvince: 'Alberta',
    /*
     * The province's own 66,710 km² outline, simplified to about 2 km. See
     * `albertaCampingPass.ts` — this replaced a bounding box that was wrong
     * by most of Alberta.
     */
    contains: insideCampingPassArea,
    dispersedOnly: true
  },
  {
    permitId: 'on-crown-land-non-resident',
    country: 'Canada',
    stateProvince: 'Ontario',
    // North of the French and Mattawa rivers, which run at roughly 46.3°N.
    bbox: { minLat: 46.3, minLon: -96.0, maxLat: 57.0, maxLon: -74.0 },
    dispersedOnly: true
  }
];

export interface PermitMatch {
  permit: CampingPermit;
  /**
   * Three strengths of claim, and they must not read alike.
   *
   * `site`     recorded against this exact spot. A requirement.
   * `boundary` inside the agency's OWN published area, which this app holds
   *            simplified to a couple of kilometres. As good as an answer,
   *            except within sight of the edge — and it says so.
   * `area`     inside a rectangle this app drew around a regime because it
   *            does not hold the real shape. A thing to go and check, never
   *            an answer.
   */
  certainty: 'site' | 'boundary' | 'area';
}

/**
 * A named campground run by an agency, rather than a place you pull off a
 * forestry road and sleep. Area regimes never match one — see `dispersedOnly`.
 */
const isDeveloped = (site: Campsite): boolean => site.source === 'agency_dataset';

/**
 * Which permit, if any, a camper needs for this spot.
 *
 * Returns null when nothing is recorded — which means NOBODY HAS SAID, not
 * "no permit needed". Anything rendering this has to keep that distinction:
 * the absence of a permit record is not permission.
 */
export const permitFor = (site: Campsite): PermitMatch | null => {
  if (site.permitId) {
    const permit = CAMPING_PERMITS[site.permitId];
    if (permit) return { permit, certainty: 'site' };
  }

  if (isDeveloped(site)) return null;

  const state = site.address?.stateProvince ?? '';
  const country = site.address?.country ?? '';

  for (const area of PERMIT_AREAS) {
    if (area.country !== country || area.stateProvince !== state) continue;

    if (area.contains) {
      if (!area.contains(site.latitude, site.longitude)) continue;
      const permit = CAMPING_PERMITS[area.permitId];
      if (permit) return { permit, certainty: 'boundary' };
      continue;
    }

    if (area.bbox) {
      const { minLat, minLon, maxLat, maxLon } = area.bbox;
      if (
        site.latitude < minLat || site.latitude > maxLat ||
        site.longitude < minLon || site.longitude > maxLon
      ) continue;
    }
    const permit = CAMPING_PERMITS[area.permitId];
    if (permit) return { permit, certainty: 'area' };
  }

  return null;
};

/** The chip's short label. Two words, and it has to carry the difference. */
export const permitChipLabel = (match: PermitMatch): string => {
  if (match.certainty === 'area') return 'Permit may apply';
  return match.permit.free ? 'Permit needed' : 'Permit to buy';
};

/** The whole hedged sentence, for the tooltip and the screen reader. */
export const permitChipFull = (match: PermitMatch): string => {
  const cost = match.permit.cost.toLowerCase();
  switch (match.certainty) {
    case 'site':
      return `${match.permit.name} — ${cost}. Tap for the details and where to get one.`;
    case 'boundary':
      return `${match.permit.name} — ${cost}. This spot is inside ` +
        `${match.permit.issuer}’s published area for it; the line this app holds ` +
        'is accurate to a couple of kilometres. Tap for the details.';
    default:
      return `${match.permit.name} may apply here (${cost}). This spot is inside ` +
        'a rectangle drawn around the area it covers, which is not the same as ' +
        'the real boundary. Tap to check before you go.';
  }
};
