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

/** Build the stack of strokes that renders the uncertainty band. */
export const buildFuzzRings = (
  accuracy: EdgeAccuracy,
  latitude: number,
  zoom: number,
  rings = 5
): FuzzRing[] => {
  const mpp = metresPerPixel(latitude, zoom);
  const uncertainty = UNCERTAINTY_METRES[accuracy] ?? UNCERTAINTY_METRES.administrative;

  // Total band width in pixels, clamped so it stays legible without
  // swallowing the map when zoomed far out.
  const rawWidth = uncertainty / mpp;
  const bandPx = Math.max(3, Math.min(rawWidth, 48));

  const out: FuzzRing[] = [];
  for (let i = 0; i < rings; i += 1) {
    const t = (i + 1) / rings;
    out.push({
      weight: bandPx * (1 - t) + bandPx * 0.15,
      opacity: 0.06 + 0.16 * t
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
};

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

export const FUZZ_FILTER_ID = 'wandrlust-edge-fuzz';

/** Gaussian blur turns the discrete rings into a continuous gradient. */
export const ensureFuzzFilter = (blurPx = 2.5): void => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(FUZZ_FILTER_ID)) return;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';

  const defs = document.createElementNS(svgNs, 'defs');
  const filter = document.createElementNS(svgNs, 'filter');
  filter.setAttribute('id', FUZZ_FILTER_ID);
  filter.setAttribute('x', '-50%');
  filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%');
  filter.setAttribute('height', '200%');

  const blur = document.createElementNS(svgNs, 'feGaussianBlur');
  blur.setAttribute('in', 'SourceGraphic');
  blur.setAttribute('stdDeviation', String(blurPx));

  filter.appendChild(blur);
  defs.appendChild(filter);
  svg.appendChild(defs);
  document.body.appendChild(svg);
};
