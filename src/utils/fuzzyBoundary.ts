import type { EdgeAccuracy } from '../services/boundaryService';

/**
 * Fuzzy boundary rendering.
 *
 * A crisp 1px line says "the boundary is exactly here." That claim is false
 * for every dataset we have, and the failure mode is trespass. onX — the
 * benchmark for this category — reports parcel boundaries "typically accurate
 * within 20 feet". Agency administrative boundaries are looser still.
 *
 * So we draw a BAND instead of a LINE, and the band's width is the dataset's
 * real positional uncertainty.
 *
 * THE IMPORTANT DETAIL: the band is defined in METRES ON THE GROUND, not
 * pixels. A fixed pixel width would silently shrink the implied uncertainty as
 * you zoom in — exactly backwards, because zooming in is when people decide
 * where to park.
 *
 * HOW THE FADE IS PRODUCED (this changed for performance):
 * The band used to be five stacked SVG strokes per polygon, smoothed by an SVG
 * `feGaussianBlur` applied to the whole map pane. That filter forced the
 * browser to re-rasterise every path in the pane on every frame of a pan, and
 * with a few hundred polygons on screen it made the map unusable. The band is
 * now drawn on a canvas with fewer strokes and smoothed by a compositor-level
 * CSS blur, which the GPU handles for free. Same band, same width, same
 * meaning — only the smoothing technique is different.
 */

export const UNCERTAINTY_METRES: Record<EdgeAccuracy, number> = {
  /** County/cadastral fabric. onX cites ~20 ft; we round up and add margin. */
  cadastral_derived: 25,
  /** Agency administrative boundary. No published figure; assume coarse. */
  administrative: 75,
  /** Cartographic generalisation. Edges may be off by hundreds of metres. */
  generalised: 200
};

export const UNCERTAINTY_LABEL: Record<EdgeAccuracy, string> = {
  cadastral_derived: '±25 m',
  administrative: '±75 m',
  generalised: '±200 m'
};

/** Ground resolution of a Web Mercator pixel at a given latitude and zoom. */
export const metresPerPixel = (latitude: number, zoom: number): number =>
  (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);

export interface FuzzRing {
  weight: number;
  opacity: number;
}

/**
 * Width of the uncertainty band in screen pixels.
 *
 * Clamped so it stays legible without swallowing the map when zoomed far out.
 */
export const bandWidthPx = (
  accuracy: EdgeAccuracy,
  latitude: number,
  zoom: number
): number => {
  const mpp = metresPerPixel(latitude, zoom);
  const uncertainty = UNCERTAINTY_METRES[accuracy] ?? UNCERTAINTY_METRES.administrative;
  return Math.max(3, Math.min(uncertainty / mpp, 48));
};

/**
 * Build the stack of strokes that renders the uncertainty band, widest first.
 *
 * The widest stroke always spans the full band, so dropping to fewer rings
 * (which we do when there is a lot of land on screen) makes the fade coarser
 * but never makes the stated uncertainty look smaller than it is.
 */
export const buildFuzzRings = (
  accuracy: EdgeAccuracy,
  latitude: number,
  zoom: number,
  rings = 3
): FuzzRing[] => {
  const bandPx = bandWidthPx(accuracy, latitude, zoom);
  const count = Math.max(1, Math.round(rings));

  // One stroke plus the CSS blur still reads as a fade, just a softer one.
  if (count === 1) return [{ weight: bandPx, opacity: 0.22 }];

  const out: FuzzRing[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1); // 0 = outermost and widest, 1 = innermost core
    out.push({
      weight: bandPx * (1 - 0.85 * t),
      opacity: 0.1 + 0.15 * t
    });
  }
  return out;
};

/**
 * How many strokes to spend per polygon.
 *
 * Every ring is another path the renderer has to stroke, so the budget shrinks
 * as the number of polygons on screen grows. This is the difference between a
 * map that redraws in a frame and one that hitches for a second.
 */
export const ringBudget = (featureCount: number): number => {
  if (featureCount > 700) return 2;
  if (featureCount > 300) return 3;
  return 4;
};

/**
 * Blur radius that smooths the discrete strokes into a continuous gradient.
 *
 * Scaled to the band so a wide band doesn't end up looking like a hard edge,
 * but capped: blur too hard and the band spreads until it reads as a vague
 * glow rather than a stated margin of error.
 */
export const edgeBlurPx = (widestBandPx: number): number =>
  Math.max(1.5, Math.min(widestBandPx * 0.18, 4));

/** True when the band is too thin to be worth stacking strokes for. */
export const shouldSimplify = (
  accuracy: EdgeAccuracy,
  latitude: number,
  zoom: number
): boolean => UNCERTAINTY_METRES[accuracy] / metresPerPixel(latitude, zoom) < 4;

export const uncertaintyCaution = (accuracy: EdgeAccuracy): string => {
  const m = UNCERTAINTY_METRES[accuracy];
  const ft = Math.round(m * 3.28084);
  return `Edges are approximate to roughly ±${m} m (±${ft} ft). The faded band is the uncertainty zone — inside it, you may be on either side of the real boundary.`;
};

