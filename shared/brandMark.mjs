/**
 * THE WANDRLUST MARK, DEFINED ONCE.
 *
 * Two things draw this logo and they must not drift apart: the icon generator
 * (`scripts/generateIcons.mjs`, which bakes the home-screen and notification
 * PNGs) and the app's own header (`src/components/ui/BrandMark.tsx`). They used
 * to be unrelated — a lucide `compass` glyph in the generator and a lucide
 * `<Compass>` component in the navbar — which only looked like one logo by
 * coincidence. This file is the coincidence made deliberate.
 *
 * Plain `.mjs` on purpose: node runs the generator directly, with no build
 * step, so this cannot be TypeScript. `allowJs` lets the client import it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DRAWN RATHER THAN BORROWED
 * ---------------------------------------------------------------------------
 *
 * A stock icon set is built for 20px buttons: hairline strokes, generous
 * padding, everything legible only because it sits next to a word explaining
 * it. An app icon is the opposite job. It is seen at 48px on a cluttered home
 * screen with no caption, next to two hundred other rounded squares, and the
 * only thing that survives that is MASS — filled shapes with real weight.
 *
 * So this is a compass ROSE — four solid two-tone points, the shape every
 * paper map in the world puts in its corner — rather than a needle floating
 * inside a hairline circle. The ring went for two reasons. It ate a third of
 * the icon's width to say nothing, and a white ring around a two-tone needle
 * is already the most famous icon on the iPhone; being mistaken for Safari at
 * a glance is not branding.
 */

/** Every path below is drawn inside a 24×24 box, centred on 12,12. */
export const MARK_VIEWBOX = 24;

/**
 * The rose.
 *
 * North and south reach slightly further than east and west, which is what
 * stops a four-point star reading as a sparkle: a compass rose has a long
 * axis, and the eye takes the long one for north. The waist is deliberately
 * fat — a slender rose is elegant at 512px and a smear of white at 48.
 */
const TIP_VERTICAL = 11.4;
const TIP_HORIZONTAL = 10.4;
const WAIST_RADIUS = 4.6;

/** The mark's widest diameter as a fraction of the 24-unit design box. */
export const MARK_EXTENT = (Math.max(TIP_VERTICAL, TIP_HORIZONTAL) * 2) / MARK_VIEWBOX;

const build = () => {
  const c = MARK_VIEWBOX / 2;
  const w = WAIST_RADIUS / Math.SQRT2;
  const f = (n) => Number(n.toFixed(2));

  const centre = [c, c];
  const north = [c, c - TIP_VERTICAL];
  const south = [c, c + TIP_VERTICAL];
  const east = [c + TIP_HORIZONTAL, c];
  const west = [c - TIP_HORIZONTAL, c];
  const ne = [c + w, c - w];
  const se = [c + w, c + w];
  const sw = [c - w, c + w];
  const nw = [c - w, c - w];

  const tri = (a, b, d) =>
    `M${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])} ${f(d[0])} ${f(d[1])}Z`;

  return {
    /* Each point is split down its own axis, one facet lit and one in shadow,
       the way a rose is engraved on a chart. Clockwise from north on the lit
       side; the same four points anticlockwise on the shadowed side. */
    lit: [
      tri(north, ne, centre), tri(east, se, centre),
      tri(south, sw, centre), tri(west, nw, centre)
    ].join(' '),
    shadow: [
      tri(north, nw, centre), tri(east, ne, centre),
      tri(south, se, centre), tri(west, sw, centre)
    ].join(' ')
  };
};

const PATHS = build();

/** The lit facets of all four points, as one path. */
export const MARK_LIT = PATHS.lit;
/** The shadowed facets of all four points, as one path. */
export const MARK_SHADOW = PATHS.shadow;

/**
 * The wordmark's gradient, so the icon on the home screen and the badge in the
 * header are visibly the same brand.
 */
export const BRAND_GRADIENT_STOPS = [
  { offset: '0%', color: '#34D399' },
  { offset: '48%', color: '#0D9488' },
  { offset: '100%', color: '#D97706' }
];

/** Lit is white; shadow is the app's own near-black, not a grey. */
export const MARK_INK = { lit: '#FFFFFF', shadow: '#0B1220' };

/**
 * The mark itself, as an SVG fragment to drop inside a 24-unit group.
 *
 * `stroke-linejoin: round` with a hairline stroke in each facet's own colour
 * is not decoration — a rose point is a very acute angle, and left sharp it
 * renders as a single jagged pixel at icon sizes. Rounding it by a fraction of
 * a unit keeps the point crisp instead.
 *
 * @param {{ lit?: string; shadow?: string; shadowOpacity?: number }} [ink]
 */
export const markElements = (ink = {}) => {
  const lit = ink.lit ?? MARK_INK.lit;
  const shadow = ink.shadow ?? MARK_INK.shadow;
  const shadowOpacity = ink.shadowOpacity ?? 1;

  return (
    `<path d="${MARK_LIT}" fill="${lit}" stroke="${lit}"` +
    ` stroke-width="0.45" stroke-linejoin="round"/>` +
    `<path d="${MARK_SHADOW}" fill="${shadow}" stroke="${shadow}"` +
    ` stroke-width="0.45" stroke-linejoin="round" opacity="${shadowOpacity}"/>`
  );
};
