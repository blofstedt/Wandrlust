/**
 * Motion system — inspired by PebbleOS.
 *
 * WHAT MAKES PEBBLE MOTION FEEL LIKE PEBBLE
 *
 * Pebble's signature easing is "moook" (`interpolate_moook_soft` in
 * PebbleOS). It is NOT a smooth cubic bezier. It is a FRAME-BASED curve: a
 * couple of accelerating frames in, a small number of middle frames
 * (`TIMELINE_NUM_MOOOK_FRAMES_MID` is 3), then an overshoot past the target
 * that settles back in discrete steps.
 *
 * That discreteness is the whole character. Smooth easing feels liquid;
 * moook feels mechanical and deliberate, like something physically snapping
 * into place.
 *
 * Pebble's other defaults we borrow: 250 ms base duration and ease-in-out as
 * the fallback curve.
 *
 * ACCESSIBILITY
 *
 * Every helper respects `prefers-reduced-motion`. When a user has asked their
 * OS for less motion, durations collapse to near-zero and overshoot is removed
 * entirely. This is not optional polish; motion can trigger vestibular
 * symptoms.
 */

/* ------------------------------------------------------------------ */
/* Reduced motion                                                      */
/* ------------------------------------------------------------------ */

export const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

export const onReducedMotionChange = (cb: (reduced: boolean) => void): (() => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
};

/* ------------------------------------------------------------------ */
/* Durations — Pebble's 250 ms baseline                                */
/* ------------------------------------------------------------------ */

export const DURATION = {
  tap: 120,
  base: 250,
  panel: 320,
  scene: 420
} as const;

export const duration = (ms: number): number => (prefersReducedMotion() ? 1 : ms);

/* ------------------------------------------------------------------ */
/* Moook                                                               */
/* ------------------------------------------------------------------ */

/**
 * Frame offsets for the moook curve. Structure follows PebbleOS: a short ramp
 * in, configurable middle frames, then an overshoot that settles in discrete
 * steps. Hand-tuned for 60 fps browsers rather than copied from firmware
 * targeting a 30 fps e-paper panel.
 */
const MOOOK_IN = [0, 0.15, 0.42];
const MOOOK_OUT = [1.18, 1.08, 1.02, 0.995, 1];

/** PebbleOS uses 3 middle frames for timeline up/down moves. */
export const MOOOK_FRAMES_MID = 3;

/** @returns eased progress, which briefly EXCEEDS 1 during the overshoot. */
export const moook = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (prefersReducedMotion()) return t;

  const inFrames = MOOOK_IN.length;
  const outFrames = MOOOK_OUT.length;
  const total = inFrames + MOOOK_FRAMES_MID + outFrames;
  const frame = t * total;

  if (frame < inFrames) {
    const i = Math.floor(frame);
    const f = frame - i;
    const a = MOOOK_IN[i] ?? 0;
    const b = MOOOK_IN[i + 1] ?? MOOOK_IN[inFrames - 1];
    return a + (b - a) * f;
  }

  if (frame < inFrames + MOOOK_FRAMES_MID) {
    // Middle: linear travel, which gives moook its mechanical feel.
    const midProgress = (frame - inFrames) / MOOOK_FRAMES_MID;
    const start = MOOOK_IN[inFrames - 1];
    const end = MOOOK_OUT[0];
    return start + (end - start) * midProgress;
  }

  const outIndex = frame - inFrames - MOOOK_FRAMES_MID;
  const i = Math.floor(outIndex);
  const f = outIndex - i;
  const a = MOOOK_OUT[i] ?? 1;
  const b = MOOOK_OUT[i + 1] ?? 1;
  return a + (b - a) * f;
};

/** Softer moook: same shape, smaller overshoot. */
export const moookSoft = (t: number): number => {
  const v = moook(t);
  return v > 1 ? 1 + (v - 1) * 0.45 : v;
};

export const moookSecondHalf = (t: number): number => moook(0.5 + t * 0.5);

/* ------------------------------------------------------------------ */
/* CSS timing functions                                                */
/* ------------------------------------------------------------------ */

/**
 * CSS approximations. A bezier can't reproduce discrete frames, but it can
 * reproduce the overshoot-and-settle silhouette, which carries most of the
 * character. Use these for CSS transitions; use JS `moook()` for frames.
 */
export const EASE = {
  moook: 'cubic-bezier(0.16, 1.36, 0.36, 1)',
  moookSoft: 'cubic-bezier(0.22, 1.12, 0.36, 1)',
  standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  enter: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  exit: 'cubic-bezier(0.4, 0.0, 1, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
} as const;

export const transition = (
  properties: string | string[],
  ms: number = DURATION.base,
  easing: string = EASE.moook,
  delayMs = 0
): string => {
  const props = Array.isArray(properties) ? properties : [properties];
  const d = duration(ms);
  const delay = prefersReducedMotion() ? 0 : delayMs;
  return props.map((p) => `${p} ${d}ms ${easing} ${delay}ms`).join(', ');
};

/* ------------------------------------------------------------------ */
/* Stagger                                                             */
/* ------------------------------------------------------------------ */

/**
 * Capped so a long list doesn't leave the last item waiting seconds. The
 * effect should read as "the list assembled", not "please wait".
 */
export const stagger = (index: number, stepMs = 28, maxMs = 220): number => {
  if (prefersReducedMotion()) return 0;
  return Math.min(index * stepMs, maxMs);
};

/* ------------------------------------------------------------------ */
/* JS-driven animation                                                 */
/* ------------------------------------------------------------------ */

export interface AnimateOptions {
  duration?: number;
  easing?: (t: number) => number;
  delay?: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

/** rAF tween using a JS easing function, so discrete moook frames survive. */
export const animate = ({
  duration: ms = DURATION.base,
  easing = moook,
  delay = 0,
  onUpdate,
  onComplete
}: AnimateOptions): (() => void) => {
  if (prefersReducedMotion()) {
    onUpdate(1);
    onComplete?.();
    return () => undefined;
  }

  let raf = 0;
  let cancelled = false;
  let start = 0;

  const tick = (now: number) => {
    if (cancelled) return;
    if (!start) start = now;
    const elapsed = now - start - delay;

    if (elapsed < 0) {
      raf = requestAnimationFrame(tick);
      return;
    }

    const t = Math.min(1, elapsed / ms);
    onUpdate(easing(t));

    if (t < 1) raf = requestAnimationFrame(tick);
    else onComplete?.();
  };

  raf = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
};

export const animateNumber = (
  from: number,
  to: number,
  onUpdate: (value: number) => void,
  ms = DURATION.scene
): (() => void) =>
  animate({
    duration: ms,
    easing: moookSoft,
    onUpdate: (p) => onUpdate(Math.round(from + (to - from) * p))
  });

/* ------------------------------------------------------------------ */
/* Haptics                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pebble paired motion with vibration constantly. On the web the Vibration
 * API is Android-only and silently absent elsewhere, so this is progressive
 * enhancement — never rely on it for feedback.
 */
export const haptic = (pattern: 'tap' | 'success' | 'warning' | 'error' = 'tap'): void => {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  if (prefersReducedMotion()) return;

  const patterns: Record<string, number | number[]> = {
    tap: 10,
    success: [12, 40, 12],
    warning: [20, 60, 20],
    error: [40, 50, 40, 50, 40]
  };
  try {
    navigator.vibrate(patterns[pattern]);
  } catch {
    /* not supported */
  }
};
