/**
 * How a scouted road is drawn, and what the drawing claims.
 *
 * ---------------------------------------------------------------------------
 * ONE LINE, ONE COLOUR, FADING ALONG ITS LENGTH
 * ---------------------------------------------------------------------------
 *
 * A scouted road is a single line whose colour changes continuously as the
 * ride changes — the way a cycling computer paints a climb. It carries ONE
 * fact: how rough the drive was. Not what the road is made of; a phone cannot
 * know that (see `scoutMode.ts`), and OpenStreetMap already answers it in the
 * backroads layer.
 *
 * A pothole needs no marker of its own. At a point per second the bad twenty
 * metres is its own span, and it simply goes red inside an otherwise calm
 * road. That is more legible than a pin and it cannot drift away from the
 * thing it describes.
 *
 * ---------------------------------------------------------------------------
 * WHY STRAW → AMBER → ORANGE → CRIMSON, AND NOT GREEN → RED
 * ---------------------------------------------------------------------------
 *
 * The default basemap is satellite. Green disappears into forest, and it
 * already means "campable land" everywhere else in this app. Blue is worse:
 * a blue line on satellite imagery reads as a river.
 *
 * Amber is the family the backroads layer already picked, for the reason
 * written in its own config — it reads against green forest, grey rock and
 * red desert alike. Extending it into straw at one end and crimson at the
 * other keeps roads one colour family, and makes this a refinement of a
 * meaning the map already has rather than a second meaning competing with it.
 *
 * It is also a single brightness progression, so it survives greyscale and
 * red-green colour blindness. Green→red does not, and roughly one man in
 * twelve is in that group.
 *
 * ---------------------------------------------------------------------------
 * OPACITY IS THE HONESTY CHANNEL
 * ---------------------------------------------------------------------------
 *
 * A continuous gradient LOOKS like precision. Drive a road once and you have
 * one vehicle's suspension on one day, which is not a fact about the road.
 *
 * So a single pass is drawn faint, and passes accumulate: the layer draws
 * every recorded trace, and where they overlap the alpha compounds. One pass
 * is a whisper, five is solid. Nothing counts or merges anything — overdraw
 * does it, which is why there is no pass-counting code anywhere in this
 * feature. GPS scatter means repeat passes land a few metres apart and read
 * as a braid rather than one line; that is the honest picture of what was
 * actually recorded, and it is what a track log has always looked like.
 */

/** Alpha of a single pass. `1-(1-a)^n` gives 0.40, 0.64, 0.78, 0.87, 0.92… */
export const PASS_ALPHA = 0.4;

/** Line weight in pixels. Wide enough that two offset passes blend. */
export const SCOUT_WEIGHT = 4;

/** The dark casing under every trace, so it reads over bright imagery. */
export const SCOUT_CASING = { color: '#0F172A', opacity: 0.35, extraWeight: 3 };

/**
 * Below this the traces are shorter than the pixels they would be drawn on,
 * and a county of overlapping strands is a smear that says nothing.
 */
export const SCOUT_MIN_ZOOM = 11;

/** The ramp, low roughness first. Interpolated between, never stepped. */
export const ROUGHNESS_STOPS: { at: number; color: [number, number, number] }[] = [
  { at: 0.0, color: [253, 230, 138] }, // straw   #FDE68A
  { at: 0.35, color: [251, 191, 36] }, // amber   #FBBF24
  { at: 0.7, color: [249, 115, 22] },  // orange  #F97316
  { at: 1.0, color: [153, 27, 27] }    // crimson #991B1B
];

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A roughness index (0–1) as a CSS colour.
 *
 * Interpolated in plain RGB. Not the most perceptually even space, but the
 * ramp is a single warm sweep with no hue wrap in it, so the cheap version
 * and the correct version are indistinguishable at four-pixel line width.
 */
export const roughnessColor = (index: number): string => {
  const r = clamp01(index);

  let lo = ROUGHNESS_STOPS[0];
  let hi = ROUGHNESS_STOPS[ROUGHNESS_STOPS.length - 1];
  for (let i = 0; i < ROUGHNESS_STOPS.length - 1; i += 1) {
    if (r >= ROUGHNESS_STOPS[i].at && r <= ROUGHNESS_STOPS[i + 1].at) {
      lo = ROUGHNESS_STOPS[i];
      hi = ROUGHNESS_STOPS[i + 1];
      break;
    }
  }

  const span = hi.at - lo.at;
  const t = span <= 0 ? 0 : (r - lo.at) / span;
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t);

  return `rgb(${mix(lo.color[0], hi.color[0])}, ${mix(lo.color[1], hi.color[1])}, ${mix(
    lo.color[2],
    hi.color[2]
  )})`;
};

/**
 * The words for a roughness index.
 *
 * Four names for a continuous scale, used in the legend and on a card — never
 * to bucket the line itself, which stays continuous. They are phrased as
 * consequences rather than adjectives, because "washboard" is a texture and
 * "slow down, high clearance" is a decision.
 */
export const ROUGHNESS_BANDS: { upTo: number; label: string; meaning: string }[] = [
  { upTo: 0.25, label: 'Smooth', meaning: 'Any car.' },
  { upTo: 0.5, label: 'Rattly', meaning: 'Fine, but slow down.' },
  { upTo: 0.75, label: 'Rough', meaning: 'High clearance.' },
  { upTo: 1.01, label: 'Punishing', meaning: '4×4, or find another way in.' }
];

export const roughnessLabel = (index: number): string =>
  ROUGHNESS_BANDS.find((b) => index < b.upTo)?.label ?? 'Punishing';

/**
 * WHEN A TRACE IS DRAWN SMALLER THAN ITS DETAIL, TAKE THE WORST.
 *
 * Zoomed out, a hundred metres is a pixel and several spans collapse into
 * one. Averaging them hides the twenty metres that would break an axle
 * inside four hundred that were fine — which is the single thing this layer
 * exists to show. It errs loud, always.
 */
export const collapseRoughness = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => (b > a ? b : a), 0);
