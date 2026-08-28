/**
 * Folding four sources of campsites into one list.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SOURCES
 * ---------------------------------------------------------------------------
 *
 *   curated        21 sites bundled into the app, ids like `waiparous-ghost-pluz`
 *   Supabase       what other campers have contributed, ids as stored
 *   OpenStreetMap  live Overpass results, ids like `osm-node-123`
 *   local          this device's own submissions, `user-…` or legacy `custom-…`
 *
 * The same physical pullout can arrive from more than one of them: a spot
 * somebody added here can also be in OpenStreetMap, and a curated site is
 * usually in OSM too. Showing it twice is not a cosmetic problem — two pins
 * 40 m apart reads as two places to sleep, and a camper drives to the wrong
 * one.
 *
 * ---------------------------------------------------------------------------
 * NEVER MERGE ON PROXIMITY ALONE. AT ANY DISTANCE.
 * ---------------------------------------------------------------------------
 *
 * Dispersed camping means pullouts strung along a forest road, sometimes two
 * hundred metres apart, sometimes less. Merging two of them because they are
 * close HIDES A REAL SITE, and the camper never learns it existed. Showing one
 * site twice is untidy; hiding one is the failure that matters. So a merge
 * needs a name agreement as well as proximity, and the distance threshold is
 * deliberately tight.
 *
 * Pure functions only — no I/O, no React. Everything here is testable by
 * calling it.
 */
import type { Campsite, CampsiteSource } from '../types';
import { distanceMiles } from './geo';

/**
 * Which source wins when two records describe one place.
 *
 * A curated or camper-contributed record carries a description, a land
 * manager, and possibly reviews. An OpenStreetMap node is usually a bare
 * point with a name, so it loses — but it still donates any field the winner
 * does not have.
 */
const PRECEDENCE: Record<CampsiteSource, number> = {
  verified: 4,
  user_submitted: 3,
  /*
   * Between the two, and the reasoning is about what each source KNOWS.
   *
   * A government campground beats a bare OpenStreetMap node easily: it brings
   * a real name, the managing agency, and a count of pitches, where the node
   * is often a dot with a label. It loses to a camper, because a camper has
   * been there — they can say what the road was like and whether the tap
   * works, and an agency spreadsheet cannot. Ranked below `user_submitted`
   * for that reason alone, not because the data is worse.
   *
   * The loser still donates every field the winner lacks, so a merge of the
   * two keeps the agency's description AND the camper's amenities.
   */
  agency_dataset: 2,
  overpass: 1
};

const rank = (site: Campsite): number => PRECEDENCE[site.source] ?? 0;

/** ~100 m. Two records for one pullout are typically within 50 m. */
const MERGE_RADIUS_MILES = 0.06;

/**
 * Words that carry no identity, so "Willow Springs Campground" and
 * "Willow Springs Dispersed" can recognise each other.
 */
const NOISE = /\b(campground|campsite|camping|camp|site|sites|dispersed|area|recreation|blm|nf|national forest|national grassland|the)\b/g;

const normaliseName = (name: string): string =>
  (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Names that identify nothing.
 *
 * These are compared against the NORMALISED name, not the raw one — Overpass
 * writes "Unnamed Dispersed Site", and `normaliseName` strips "dispersed" and
 * "site" as noise, leaving "unnamed". Listing the raw strings here is the
 * obvious mistake and it silently disables this whole branch.
 */
const PLACEHOLDER_NAMES = new Set(['', 'unnamed', 'unnamed dispersed']);

/** Do these two records plausibly describe the same physical place? */
export const looksLikeSameSite = (a: Campsite, b: Campsite): boolean => {
  if (distanceMiles(a.latitude, a.longitude, b.latitude, b.longitude) >= MERGE_RADIUS_MILES) {
    return false;
  }

  /**
   * A fuzzed stealth pin is only accurate to about 2 km, so it can land
   * within 100 m of an unrelated site by chance. It must never absorb one.
   */
  if (a.isApproximate || b.isApproximate) return false;

  const nameA = normaliseName(a.name);
  const nameB = normaliseName(b.name);

  // One side is an unnamed OSM node sitting on top of a named site.
  if (PLACEHOLDER_NAMES.has(nameA) || PLACEHOLDER_NAMES.has(nameB)) return true;

  if (nameA === nameB) return true;

  /**
   * Substring either way, so "Willow Springs" and "Willow Springs North"
   * recognise each other. Both sides are known non-empty here — an empty
   * name is a placeholder and returned above — which matters because
   * `''.includes('')` is true and would merge every unnamed site on the map
   * into one.
   */
  return nameA.includes(nameB) || nameB.includes(nameA);
};

/**
 * Fold `loser` into `winner` without ever overwriting a recorded value.
 *
 * The rule is one line long and it is the whole point: a field the winner
 * already has is kept; a field it lacks may be donated. Two sources
 * disagreeing about whether there is water is not something this function
 * gets to resolve by picking the newer one.
 */
const absorb = (winner: Campsite, loser: Campsite): Campsite => ({
  ...winner,
  elevationFt: winner.elevationFt ?? loser.elevationFt,
  description: winner.description || loser.description,
  images: winner.images?.length ? winner.images : loser.images,
  capacityStatus: winner.capacityStatus ?? loser.capacityStatus,
  address: {
    ...loser.address,
    ...Object.fromEntries(
      Object.entries(winner.address ?? {}).filter(([, v]) => v !== undefined && v !== '')
    )
  } as Campsite['address'],
  amenities: {
    ...loser.amenities,
    ...Object.fromEntries(
      Object.entries(winner.amenities ?? {}).filter(([, v]) => v !== undefined)
    )
  }
});

/** ~1 km cells, so the pass below compares neighbours instead of everything. */
const cellKey = (lat: number, lon: number): string =>
  `${lat.toFixed(2)},${lon.toFixed(2)}`;

const neighbourKeys = (lat: number, lon: number): string[] => {
  const keys: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLon = -1; dLon <= 1; dLon += 1) {
      keys.push(cellKey(lat + dLat * 0.01, lon + dLon * 0.01));
    }
  }
  return keys;
};

/**
 * One list, no duplicates, nothing lost.
 *
 * Two passes. Exact id first — which is what catches an OpenStreetMap site
 * coming back from Supabase after somebody checked into it, because the id is
 * identical by construction. Then proximity plus name, bucketed into ~1 km
 * cells so this stays linear as the list grows across a session.
 *
 * Order of the inputs is the order of precedence for ties.
 */
export const mergeCampsites = (...groups: Campsite[][]): Campsite[] => {
  const byId = new Map<string, Campsite>();

  // Pass 1 — exact id.
  for (const group of groups) {
    for (const site of group) {
      if (!site?.id || typeof site.latitude !== 'number') continue;
      const existing = byId.get(site.id);
      if (!existing) { byId.set(site.id, site); continue; }
      byId.set(
        site.id,
        rank(site) > rank(existing) ? absorb(site, existing) : absorb(existing, site)
      );
    }
  }

  // Pass 2 — same place under two different ids.
  const buckets = new Map<string, Campsite[]>();
  const merged: Campsite[] = [];

  // Strongest sources first, so a curated record is already placed when the
  // OpenStreetMap version of it arrives and gets folded in.
  for (const site of [...byId.values()].sort((a, b) => rank(b) - rank(a))) {
    let target: Campsite | undefined;

    for (const key of neighbourKeys(site.latitude, site.longitude)) {
      const candidate = buckets.get(key)?.find((other) => looksLikeSameSite(other, site));
      if (candidate) { target = candidate; break; }
    }

    if (target) {
      // `target` is already in `merged`; update it in place so the bucket
      // index and the output list keep pointing at the same object.
      Object.assign(target, absorb(target, site));
      continue;
    }

    merged.push(site);
    const key = cellKey(site.latitude, site.longitude);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(site);
    else buckets.set(key, [site]);
  }

  return merged;
};
