import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FacilityKind } from '../types';
import { FACILITY, SEARCHABLE_FACILITY_KINDS } from '../config/facilities';
import { haptic, prefersReducedMotion } from '../utils/animation';

/**
 * "WHERE'S THE NEAREST TOILET" — AS AN ARC THAT FANS OUT OF THE MAGNIFIER.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A ROW ANY MORE
 * ---------------------------------------------------------------------------
 *
 * These were chips: first across the top of the phone, where half of them sat
 * off the right-hand edge behind a sideways scroll nobody finds; then inside
 * the search card, which meant opening a keyboard to press a button that has
 * nothing to do with typing. Both versions spent a strip of the map on a
 * control that is used for two seconds at a time.
 *
 * So they live in the button now. Press the magnifier in the map's control
 * stack and they swing out along an arc into the empty middle of the screen,
 * one after the other, big enough for a thumb; press one and the whole fan
 * folds back into the button it came from. Nothing is docked, nothing is
 * scrolled, nothing is hidden behind anything else, and the map is only
 * covered while a finger is actually on the way to a symbol.
 *
 * THE ARC IS NOT DECORATION. Ten targets in a straight line down the side of a
 * phone is 400px of travel and half of them land under the hand; on an arc
 * struck from the button, every one of them is the same short distance from
 * where the thumb already is. That is the whole reason radial menus exist.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ARC REFUSES TO SAY
 * ---------------------------------------------------------------------------
 *
 * Nothing, here — the arc is only the switch. The sentence that matters, the
 * one that says NOBODY HAS MAPPED ONE HERE rather than "there are none", is
 * `facilityNotice` in `MapComponent`, in the map's own notice column, because
 * that is a statement about the map and it has to stay on screen after this
 * has folded itself away.
 */

/**
 * WHERE THE FAN SWEEPS, in degrees anticlockwise from "straight right", and
 * how far out it throws the symbols.
 *
 * These three numbers are set against two hard edges, not chosen by eye.
 *
 * The SPAN cannot reach the vertical: the map's control stack runs up the
 * right-hand side above and below this button, and an arc that starts at 90°
 * puts its first symbol directly on top of the layers button. Starting at 114°
 * pushes both ends of the fan a clear 70px to the left of the stack.
 *
 * The RADIUS then follows from the arithmetic of ten 44px targets: the arc has
 * to be about 420px long for them to sit side by side without touching, and an
 * arc of 132° needs a radius of 182 to be that long. Smaller and the symbols
 * overlap; larger and the top of the fan runs into the notices at the top of
 * the map.
 */
const ARC_FROM = 114;
const ARC_TO = 246;
const ARC_RADIUS = 182;

interface FacilityArcProps {
  active: FacilityKind[];
  onToggle: (kind: FacilityKind) => void;
  onClearAll: () => void;
  /** Whether the fan is out. The caller owns it — the button lives up there. */
  open: boolean;
  onClose: () => void;
}

export const FacilityArc: React.FC<FacilityArcProps> = ({
  active, onToggle, onClearAll, open, onClose
}) => {
  /*
    Two flags, not one.

    `mounted` keeps the buttons in the DOM for the length of the fold-back, so
    they animate home into the magnifier instead of blinking out of existence.
    `out` is the position they are animating TO, and it has to be set in a
    LATER frame than the mount — an element that appears already holding its
    final transform has nothing to transition from.
  */
  const [mounted, setMounted] = useState(open);
  const [out, setOut] = useState(false);
  const timer = useRef<number | null>(null);

  /* House rule: the motion is the app's personality, never a toll. Asked for
     less of it, the symbols are simply THERE and simply gone — no travel, no
     stagger, and no wait before the fan can be used. */
  const still = prefersReducedMotion();

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);

    if (open) {
      setMounted(true);
      if (still) { setOut(true); return undefined; }
      const frame = requestAnimationFrame(() => setOut(true));
      return () => cancelAnimationFrame(frame);
    }

    setOut(false);
    if (still) { setMounted(false); return undefined; }
    timer.current = window.setTimeout(() => setMounted(false), 260);
    return undefined;
  }, [open, still]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  /* Escape folds it, like every other mode in the app. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const activeSet = new Set(active);

  /*
    "Clear" joins the end of the fan, and only when there is something to
    clear. A permanent × on an arc of nine symbols is a tenth symbol that does
    nothing nine times out of ten.
  */
  const items: {
    key: string;
    label: string;
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
    on: boolean;
    onPick: () => void;
  }[] = [
    ...SEARCHABLE_FACILITY_KINDS.map((kind) => ({
      key: kind,
      label: FACILITY[kind].label,
      icon: FACILITY[kind].icon,
      on: activeSet.has(kind),
      onPick: () => onToggle(kind)
    })),
    ...(active.length > 0
      ? [{
          key: 'clear',
          label: 'Turn all of these off',
          icon: X,
          on: false,
          onPick: onClearAll
        }]
      : [])
  ];

  const step = items.length > 1 ? (ARC_TO - ARC_FROM) / (items.length - 1) : 0;

  return (
    /*
      No size of its own: it is an ORIGIN, not a container. It sits at the
      centre of the button that opened it — the caller wraps that button in a
      `relative` box — and every symbol is placed from there by transform.
      Nothing about the arc has to know where on the screen the button ended
      up, which is what makes it survive the stack growing and shrinking as
      cards open under it.
    */
    <div className="absolute left-1/2 top-1/2 w-0 h-0 z-[1001]">
      {items.map((item, index) => {
        const angle = ((ARC_FROM + step * index) * Math.PI) / 180;
        const dx = Math.cos(angle) * ARC_RADIUS;
        const dy = -Math.sin(angle) * ARC_RADIUS;
        const Icon = item.icon;

        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={item.key === 'clear' ? undefined : item.on}
            aria-label={item.label}
            title={item.label}
            onClick={() => { haptic('tap'); item.onPick(); onClose(); }}
            /*
              `--ease-moook` with a per-item delay is the app's own motion:
              each symbol overshoots its place and settles, a beat after the
              one before it, so the fan reads as one gesture rather than ten
              things arriving at once. Folding back runs the delays in
              reverse, so the far end of the arc leaves first.
            */
            className={`pointer-events-auto absolute w-11 h-11 -ml-[22px] -mt-[22px] rounded-full border flex items-center justify-center shadow-2xl backdrop-blur-md ${
              item.key === 'clear'
                ? 'bg-slate-950/95 border-slate-500 text-slate-300'
                : item.on
                  ? 'bg-slate-100 border-slate-100 text-slate-900'
                  : 'bg-slate-950/95 border-slate-500 text-slate-100'
            }`}
            style={{
              transform: out
                ? `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(1)`
                : 'translate(0px, 0px) scale(0.4)',
              opacity: out ? 1 : 0,
              transition: still
                ? 'none'
                : 'transform 260ms var(--ease-moook), opacity 160ms linear',
              transitionDelay: still
                ? '0ms'
                : `${(out ? index : items.length - 1 - index) * 22}ms`
            }}
          >
            <Icon className="w-5 h-5" strokeWidth={item.on ? 2.3 : 2} />
          </button>
        );
      })}
    </div>
  );
};

FacilityArc.displayName = 'FacilityArc';
