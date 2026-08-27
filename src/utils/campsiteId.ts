/**
 * Where a campsite id came from, and how to make a new one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREFIX IS THE SOURCE OF TRUTH
 * ---------------------------------------------------------------------------
 *
 * Four things produce campsites and they all end up in one array:
 *
 *   curated   a slug, e.g. `waiparous-ghost-pluz` — bundled in the app
 *   osm       `osm-node-123` / `osm-way-456` — live from Overpass
 *   user      `user-<uuid>` — somebody filled in the add form
 *   remote    whatever Supabase holds
 *
 * Six database tables carry `campsite_id text not null references
 * campsites(id)`, so before anything can be attached to a site — a check-in, a
 * review, a report — there has to be a row with that id. An OSM site is
 * materialised on demand; a device-local one cannot be, because it has never
 * been sent anywhere. Telling those two apart is what stops the app offering
 * an action that can only end in a foreign-key error, which is what it used to
 * do — the raw Postgres message went straight to the camper.
 */

export type CampsiteIdKind = 'curated' | 'osm' | 'user' | 'remote';

const OSM_ID = /^osm-(node|way|relation)-\d+$/;

/**
 * Classify an id.
 *
 * BOTH `user-` AND `custom-` COUNT AS 'user'. `custom-${Date.now()}` was the
 * old format and there are records carrying it in real browsers. Their ids are
 * never rewritten — an id is the only handle localforage, the saved list and
 * the offline region all share, and renaming one to tidy up the format would
 * orphan a spot somebody saved.
 */
export const campsiteIdKind = (id: string): CampsiteIdKind => {
  if (id.startsWith('user-') || id.startsWith('custom-')) return 'user';
  if (OSM_ID.test(id)) return 'osm';
  // A curated slug has no digits-only tail and no prefix; anything else came
  // from the database. The distinction only matters for display, so a wrong
  // guess here is cosmetic — unlike the two above, which gate writes.
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) ? 'curated' : 'remote';
};

/**
 * A fresh id for a spot somebody just added.
 *
 * A uuid rather than the old `custom-${Date.now()}`: two people adding a spot
 * in the same millisecond is unlikely but two DEVICES restoring the same
 * backup is not, and the id is a primary key the moment the site is shared.
 * Generated on the client, before the insert, so the local copy and the server
 * copy agree without a round trip — which matters because the local write has
 * to happen first and a signed-out submission never reaches the server at all.
 */
export const newUserCampsiteId = (): string => {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : // Older WebViews. Not cryptographically strong, and does not need to
        // be — this is a collision-avoidance id, not a secret.
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `user-${uuid}`;
};

/** True when this site can carry a check-in, review or report at all. */
export const canReferenceCampsite = (id: string): boolean => campsiteIdKind(id) !== 'user';