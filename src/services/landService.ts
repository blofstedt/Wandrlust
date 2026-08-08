/**
 * Land-vs-water test for pin drops.
 *
 * Answers one question: has the user tapped somewhere that is obviously
 * open water? A pin in the middle of Lake Superior is never a campsite,
 * and letting one drop there produces a destination card full of
 * confident nonsense — a drive time, a weather forecast, a cell-signal
 * estimate, all for a spot in a shipping lane.
 *
 * HOW IT ANSWERS, AND WHY IT LEANS THE WAY IT DOES
 *
 * The app ships with a bitmask of the covered area, one bit per grid
 * cell of about two kilometres, built from Natural Earth coastlines and
 * lakes by `scripts/buildMapAssets.ts`. It is ~45 KB over the wire,
 * loads once, and after that every check is an array index — no network,
 * no latency, and it keeps working offline, which matters because the
 * whole point of this app is the places with no signal.
 *
 * The mask is built with land grown by one cell, and that bias is the
 * entire design. Two ways to be wrong, and they are not equally bad:
 *
 *   - Refusing a pin the user is entitled to drop is unrecoverable. The
 *     tap does nothing, there is no override, and it happens exactly
 *     where dispersed camping happens — a lake shore, a coastal forest
 *     road, an island.
 *   - Accepting a pin a couple of kilometres offshore is a shrug. The
 *     user moves it.
 *
 * So this only ever says "water" when the tap is more than a cell clear
 * of anything the source data calls land, and it says "land" whenever it
 * is unsure, including when the mask has not finished loading or failed
 * to load at all. It is a guard against the absurd, not a survey.
 */

/** Header: magic(8) + minLon,minLat,cellDeg(3×f64) + width,height(2×u32). */
const HEADER_BYTES = 40;
const MAGIC = 'WLMASK01';

interface LandMask {
  minLon: number;
  minLat: number;
  cellDeg: number;
  width: number;
  height: number;
  bits: Uint8Array;
}

let mask: LandMask | null = null;
let loadPromise: Promise<LandMask | null> | null = null;
/** Set once a load has definitively failed, so we stop retrying. */
let unavailable = false;

const parseMask = (buffer: ArrayBuffer): LandMask | null => {
  if (buffer.byteLength <= HEADER_BYTES) return null;

  const view = new DataView(buffer);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (view.getUint8(i) !== MAGIC.charCodeAt(i)) return null;
  }

  const width = view.getUint32(32, true);
  const height = view.getUint32(36, true);
  if (!width || !height) return null;

  // A truncated file would silently read as "everything is water" and
  // start refusing pins across whole regions. Better to have no mask.
  const expected = Math.ceil((width * height) / 8);
  if (buffer.byteLength - HEADER_BYTES < expected) return null;

  return {
    minLon: view.getFloat64(8, true),
    minLat: view.getFloat64(16, true),
    cellDeg: view.getFloat64(24, true),
    width,
    height,
    bits: new Uint8Array(buffer, HEADER_BYTES)
  };
};

/**
 * Fetch and cache the mask. Never throws; returns null if it cannot be
 * had, which callers read as "don't block the user".
 */
export const loadLandMask = async (): Promise<LandMask | null> => {
  if (mask) return mask;
  if (unavailable) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetch('/map/land-mask.bin');
      if (!res.ok) { unavailable = true; return null; }
      const parsed = parseMask(await res.arrayBuffer());
      if (!parsed) { unavailable = true; return null; }
      mask = parsed;
      return mask;
    } catch {
      unavailable = true;
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
};

/**
 * Start the download early so the first tap doesn't wait on it.
 * Safe to call more than once.
 */
export const primeLandMask = (): void => { void loadLandMask(); };

/**
 * Is this point somewhere a pin makes sense?
 *
 * Synchronous by design — a pin drop must feel instant, and a tap
 * handler that awaits a promise before doing anything is a tap handler
 * that feels broken on a slow connection. Returns `true` (allow the
 * pin) whenever the mask is missing, still loading, or the point falls
 * outside the grid entirely.
 */
export const isOnLand = (lat: number, lon: number): boolean => {
  if (!mask) return true;

  const col = Math.floor((lon - mask.minLon) / mask.cellDeg);
  const row = Math.floor((lat - mask.minLat) / mask.cellDeg);
  if (col < 0 || col >= mask.width || row < 0 || row >= mask.height) return true;

  const index = row * mask.width + col;
  return (mask.bits[index >> 3] & (1 << (index & 7))) !== 0;
};

/** True only when we positively know the point is open water. */
export const isOnWater = (lat: number, lon: number): boolean => !isOnLand(lat, lon);
