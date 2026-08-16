/**
 * Folding OpenStreetMap and camper-added facilities into one set of pins.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * Two sources describe the same ground. A vault toilet at a trailhead is
 * usually in OpenStreetMap AND, once somebody logs it here, in `pois`.
 * Drawing both puts two toilet pins forty metres apart, which reads as two
 * toilets — and a camper who walks to the wrong one finds nothing.
 *
 * ---------------------------------------------------------------------------
 * BUT NOTHING IS EVER DISCARDED
 * ---------------------------------------------------------------------------
 *
 * The same rule `mergeCampsites.ts` is built on applies here, for the same
 * reason: showing one thing twice is untidy, hiding a real one is the failure
 * that matters. So a merge produces ONE PIN CARRYING BOTH FACTS — "mapped in
 * OpenStreetMap, and two campers confirmed it" — rather than picking a winner
 * and dropping the loser. The camper-added record keeps its id, because that
 * is what a confirmation vote has to be attached to.
 *
 * The threshold is tight and the KIND must match. Two toilets eighty metres
 * apart at opposite ends of a campground are genuinely two toilets, and a
 * shower next to a tap is not the same object as the tap. Merging across
 * either of those would delete something real.
 *
 * Pure functions only — no I/O, no React.
 */
import type { FacilityKind, MapFacility } from '../types';
import { distanceKm } from './geo';

/**
 * 40 metres.
 *
 * Chosen against how the two sources actually disagree: a volunteer tracing
 * from aerial imagery and a camper standing at the door will land tens of
 * metres apart on the same building, and rarely more. Anything looser starts
 * eating the second toilet in a campground.
 */
const MERGE_RADIUS_KM = 0.04;

/** Do these two records plausibly describe the same physical thing? */
export const looksLikeSameFacility = (a: MapFacility, b: MapFacility): boolean => {
  if (a.kind !== b.kind) return false;
  return distanceKm(a.latitude, a.longitude, b.latitude, b.longitude) < MERGE_RADIUS_KM;
};

/**
 * Fold two records for one thing into a single pin.
 *
 * The camper's record leads, because it is the one that can be confirmed and
 * the one whose words a camper wrote. OpenStreetMap donates whatever it has
 * that the camper did not fill in — usually the name — and never overwrites.
 */
const combine = (camper: MapFacility, osm: MapFacility): MapFacility => ({
  ...camper,
  name: camper.name ?? osm.name,
  fee: camper.fee ?? osm.fee,
  /* Both, and the pin says both. This is the flag that turns "one camper
     said so" into "it is on the public map too", which is a real difference
     in how much a camper should trust the pin. */
  fromOsm: true
});

/** ~1 km cells, so this compares neighbours instead of everything. */
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
 * One list of pins, no duplicates, nothing lost.
 *
 * Camper records are placed first so that an OpenStreetMap node describing
 * the same thing folds INTO one that can be voted on, rather than the other
 * way round — a pin whose id is an OSM node id has nothing to attach a
 * confirmation to.
 */
export const mergeFacilities = (
  camperAdded: MapFacility[],
  fromOsm: MapFacility[]
): MapFacility[] => {
  const buckets = new Map<string, MapFacility[]>();
  const merged: MapFacility[] = [];

  const place = (facility: MapFacility) => {
    merged.push(facility);
    const key = cellKey(facility.latitude, facility.longitude);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(facility);
    else buckets.set(key, [facility]);
  };

  camperAdded.forEach(place);

  for (const node of fromOsm) {
    let target: MapFacility | undefined;

    for (const key of neighbourKeys(node.latitude, node.longitude)) {
      const candidate = buckets.get(key)?.find((other) => looksLikeSameFacility(other, node));
      if (candidate) { target = candidate; break; }
    }

    if (target) {
      // `target` is already in `merged`; update it in place so the bucket
      // index and the output list keep pointing at the same object.
      Object.assign(target, combine(target, node));
      continue;
    }

    place(node);
  }

  return merged;
};

/**
 * The camper-added rows, turned into pins.
 *
 * `upvotes - downvotes` rather than raw upvotes: two people saying it is gone
 * should undo two people saying it is there. Floored at zero, because a
 * negative count would read as a fact about the facility rather than as a
 * disagreement, and the prune rule already removes the ones that lose badly.
 */
export const poiToMapFacility = (row: {
  id: string;
  name: string | null;
  detail: string | null;
  latitude: number;
  longitude: number;
  is_free: boolean | null;
  upvotes: number;
  downvotes: number;
}, kind: FacilityKind): MapFacility => ({
  id: `poi-${row.id}`,
  kind,
  name: row.name?.trim() || undefined,
  latitude: row.latitude,
  longitude: row.longitude,
  fromOsm: false,
  poiId: row.id,
  confirmations: Math.max(0, (row.upvotes ?? 0) - (row.downvotes ?? 0)),
  detail: row.detail?.trim() || undefined,
  fee: row.is_free === null ? undefined : !row.is_free
});
