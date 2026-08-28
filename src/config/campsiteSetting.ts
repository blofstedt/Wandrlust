/**
 * Urban, suburban, wilderness — the words that go with the glyph.
 *
 * The pin's SHAPE says who claims there is a campsite here (a plaque for a
 * government campground, a ring for a camper's spot). The GLYPH says what kind
 * of place it is. This file is the only copy of what those glyphs mean, so a
 * skyline cannot say one thing on the map and something softer on a card.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH ONE CARRIES A CONSEQUENCE RATHER THAN A DESCRIPTION
 * ---------------------------------------------------------------------------
 *
 * "Urban" on its own is a geography lesson. What a camper actually needs to
 * know is what changes because of it: how likely somebody is to knock, whether
 * there are bylaws, whether it will be quiet. So each label is followed by the
 * thing it predicts, in the words a camper would use.
 */
import type { CampsiteSetting } from '../types';

export interface CampsiteSettingStyle {
  label: string;
  /** One line on what this means for a night's sleep. */
  meaning: string;
}

export const CAMPSITE_SETTING: Record<CampsiteSetting, CampsiteSettingStyle> = {
  urban: {
    label: 'In town',
    meaning:
      'Inside a built-up area. Expect bylaws, passers-by and a decent chance ' +
      'of being asked to move on — but also fuel, water and a shop.'
  },
  suburban: {
    label: 'Edge of town',
    meaning:
      'On the fringe of a settlement. Quieter than the centre and still close ' +
      'enough that somebody may notice a vehicle parked overnight.'
  },
  wilderness: {
    label: 'Back country',
    meaning:
      'Away from any mapped settlement. Nobody is likely to bother you, and ' +
      'nobody is likely to help you either — arrive self-sufficient.'
  }
};

/**
 * How the setting was arrived at, said plainly.
 *
 * A DERIVED setting is this app measuring the distance to the nearest mapped
 * town and drawing a conclusion about a place it has never seen. That is
 * useful and it is not the same as knowing, so it is never presented as a
 * fact — the hedge rides with it everywhere the label appears.
 */
export const settingProvenanceNote = (isDerived: boolean | undefined): string | null =>
  isDerived === false
    ? 'Set by a camper who was there.'
    : isDerived === true
    ? 'Worked out from how far this is from the nearest mapped town, not from anybody visiting.'
    : null;
