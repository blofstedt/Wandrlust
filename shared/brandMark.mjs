/**
 * THE WANDRLUST MARK, DEFINED ONCE.
 *
 * Two things draw this logo and they must not drift apart: the icon generator
 * (`scripts/generateIcons.mjs`, which bakes the home-screen and notification
 * PNGs) and the app's own header (`src/components/ui/BrandMark.tsx`).
 *
 * Plain `.mjs` on purpose: node runs the generator directly, with no build
 * step, so this cannot be TypeScript. `allowJs` lets the client import it.
 *
 * ---------------------------------------------------------------------------
 * THE COMPASS, WHICH IS THE ONE PEOPLE LIKED
 * ---------------------------------------------------------------------------
 *
 * This was briefly a drawn compass ROSE — four solid two-tone points, the
 * shape a paper map puts in its corner — on the argument that a hairline
 * needle cannot survive a home screen at 48px. It was replaced, because the
 * argument was about legibility and the answer was about the wrong thing:
 * Wandrlust's mark is the lucide compass, a needle set in a ring, and that is
 * what the app has always looked like to the person using it.
 *
 * What DID survive from that round is the sizing. The old compass asked for
 * half the canvas and got 41% of it, because it was measured against a padded
 * 24-unit design box rather than against the mark's own widest points; on
 * Android, after the launcher crops the middle 72 of every 108 units, that
 * left a small compass adrift in a green square. Everything here is reckoned
 * against `MARK_EXTENT` — the real outer edge of the ring, stroke included —
 * so "56% of the tile" means 56% of the tile. The mark is a little bigger
 * than the original at every size, which is the whole of the brief.
 */

/** The mark is drawn inside a 24×24 box, centred on 12,12. */
export const MARK_VIEWBOX = 24;

/** The ring's radius, and the weight every line is drawn at. */
const RING_RADIUS = 10;
const STROKE = 2.1;

/**
 * The mark's widest diameter as a fraction of the 24-unit design box.
 *
 * The stroke is centred on the path, so half of it hangs outside the ring and
 * counts towards the width. Forgetting that is how the old icon came out
 * smaller than it asked to be.
 */
export const MARK_EXTENT = (RING_RADIUS * 2 + STROKE) / MARK_VIEWBOX;

/**
 * The needle and the ring, exactly as lucide draws its `compass` glyph.
 *
 * Copied rather than read out of the package at runtime: the browser bundle
 * cannot reach into `node_modules/lucide-react/dist` the way the generator
 * script can, and one of the two rendering the wrong shape is precisely the
 * drift this file exists to stop.
 */
export const MARK_NEEDLE =
  'm16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411' +
  'a2 2 0 0 1 1.265-1.265z';

export const MARK_RING = { cx: 12, cy: 12, r: RING_RADIUS };

/** The line weight, exported so the header draws at the icon's weight. */
export const MARK_STROKE = STROKE;

/**
 * The wordmark's gradient, so the icon on the home screen and the badge in the
 * header are visibly the same brand.
 */
export const BRAND_GRADIENT_STOPS = [
  { offset: '0%', color: '#34D399' },
  { offset: '48%', color: '#0D9488' },
  { offset: '100%', color: '#D97706' }
];

/** White on the gradient. There is no second tone — it is one line. */
export const MARK_INK = { lit: '#FFFFFF' };

/**
 * The mark as an SVG fragment, to drop inside a 24-unit group.
 *
 * @param {{ lit?: string; strokeWidth?: number }} [ink]
 */
export const markElements = (ink = {}) => {
  const lit = ink.lit ?? MARK_INK.lit;
  const width = ink.strokeWidth ?? STROKE;

  return (
    `<g fill="none" stroke="${lit}" stroke-width="${width}"` +
    ` stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${MARK_NEEDLE}"/>` +
    `<circle cx="${MARK_RING.cx}" cy="${MARK_RING.cy}" r="${MARK_RING.r}"/>` +
    `</g>`
  );
};
