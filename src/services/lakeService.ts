/**
 * THE BIG LAKES, SO THE BOUNDARY FILL CAN STOP AT THE SHORELINE.
 *
 * Crown land and BLM polygons include the water inside them, and they are
 * right to — the province owns the lakebed the same way it owns the shore. But
 * this app paints those polygons as "you can sleep here", and a bay of Lake
 * Nipigon coming out the same green as the pine forest around it is a claim
 * somebody can act on. Nobody camps on a lake.
 *
 * The land mask already knows where the water is and the pin drop already
 * refuses it. This is the same fact in the one form a FILL can use: rings, to
 * subtract. See `punchLakes`, and `buildLakes` in scripts/buildMapAssets.ts
 * for where the file comes from.
 *
 * WHAT IT COVERS. Natural Earth 1:10m — roughly the lakes named on a wall map,
 * about 490 of them across the coverage area, everything down to ~40 km². The
 * Canadian Shield's quarter-million smaller lakes are not in it and this is
 * not pretending otherwise; the boundary's own "approximate to hundreds of
 * metres" caveat is doing the rest, as it always was.
 *
 * Loaded once, lazily, the first time boundaries are drawn — never on startup,
 * because a camper who never leaves the list view should not pay for it.
 */

export interface LakeRing {
  /** [minLon, minLat, maxLon, maxLat] — precomputed, and the reason this is fast. */
  bbox: [number, number, number, number];
  ring: [number, number][];
}

let cached: LakeRing[] | null = null;
let inflight: Promise<LakeRing[]> | null = null;

/**
 * Every lake, or an empty list.
 *
 * Never throws and never rejects, per the rule for this folder. A missing or
 * malformed file means the fill simply keeps covering the water, which is
 * exactly how the map behaved before this existed — worse, but not broken.
 */
export const loadLakes = async (): Promise<LakeRing[]> => {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const response = await fetch('/map/lakes-us-ca.json', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: any = await response.json();
      const lakes: LakeRing[] = Array.isArray(data?.lakes)
        ? data.lakes.filter(
            (l: any) =>
              Array.isArray(l?.bbox) && l.bbox.length === 4 &&
              Array.isArray(l?.ring) && l.ring.length >= 4
          )
        : [];
      cached = lakes;
      return lakes;
    } catch {
      // Cached as empty so a failed load is not retried on every pan. A
      // reload gets a fresh attempt, which is the right cadence for a static
      // file that is either there or is not.
      cached = [];
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
};

/** What has already been loaded, without asking for it. */
export const lakesLoaded = (): LakeRing[] | null => cached;

/** The lakes overlapping a viewport. Cheap: one bbox comparison each. */
export const lakesInBox = (
  box: { minLat: number; minLon: number; maxLat: number; maxLon: number }
): LakeRing[] => {
  const all = cached;
  if (!all?.length) return [];
  return all.filter(({ bbox }) =>
    bbox[2] >= box.minLon && bbox[0] <= box.maxLon &&
    bbox[3] >= box.minLat && bbox[1] <= box.maxLat
  );
};
