import React, { useEffect, useRef, useState } from 'react';
import type { FacilityKind } from '../types';
import { FACILITY, SEARCHABLE_FACILITY_KINDS } from '../config/facilities';
import { haptic, prefersReducedMotion } from '../utils/animation';

/**
 * "WHERE'S THE NEAREST TOILET" — AS A PANEL THAT SPRINGS OUT OF THE MAGNIFIER.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS IT HAD TO BE
 * ---------------------------------------------------------------------------
 *
 * These were chips: first a row across the top of the phone, where half of
 * them sat off the right-hand edge behind a sideways scroll nobody finds; then
 * inside the search card, which meant raising a keyboard to press a button
 * that has nothing to do with typing. Both spent a permanent strip of the map
 * on a control used for two seconds at a time.
 *
 * Then they fanned out of the magnifier on arcs, which fixed the strip and the
 * keyboard and put every target the same short reach from the thumb. What it
 * could not fix was READING: nine unlabelled symbols scattered on a curve,
 * with no order to scan them in, over the middle of the map. Colour helps —
 * a camper learns blue-is-water from the pins — but a drop falling into a
 * drain still has to be decoded, and decoding is not something to ask of
 * somebody at dusk with an empty water tank.
 *
 * So: a small panel, pinned by its bottom-right corner to the button, growing
 * up and to the left out of it. Nine round tiles in three rows, each in the
 * colour its pins wear on the map, each with its name underneath. It reads
 * left to right like everything else, nothing needs decoding, and it covers a
 * corner of the map rather than the middle of it. Press one and the panel
 * folds back into the button it came from.
 *
 * The motion is what survived from the arc, and it is the point: the panel
 * scales out of the button's own corner with the app's overshoot curve, tiles
 * arriving a beat apart, and plays exactly backwards on the way home.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PANEL REFUSES TO SAY
 * ---------------------------------------------------------------------------
 *
 * Nothing, here — this is only the switch. The sentence that matters, the one
 * that says NOBODY HAS MAPPED ONE HERE rather than "there are none", is
 * `facilityNotice` in `MapComponent`, in the map's own notice column, because
 * that is a statement about the map and it has to stay on screen after this
 * has folded itself away.
 */

/**
 * HOW LONG IT TAKES, and the beat between one tile and the next.
 *
 * Slow enough to read as a hand opening rather than a thing blinking into
 * existence — the arc's first version ran in 260ms and was gone before the eye
 * caught it. The fold-back is the same motion in reverse: same duration, same
 * beat, last tile leaving first.
 *
 * `UNMOUNT_MS` must outlast the whole fold, tail included, or the last tiles
 * are deleted mid-flight and the return is never seen. The arc did exactly
 * that — it unmounted at 260ms while its tail ran to 458.
 */
const PANEL_MS = 320;
const TILE_MS = 260;
const STAGGER_MS = 26;
const UNMOUNT_MS = PANEL_MS + STAGGER_MS * 9 + 60;

interface FacilityPickerProps {
  active: FacilityKind[];
  onToggle: (kind: FacilityKind) => void;
  onClearAll: () => void;
  /** Whether the panel is out. The caller owns it — the button lives up there. */
  open: boolean;
  onClose: () => void;
}

export const FacilityPicker: React.FC<FacilityPickerProps> = ({
  active, onToggle, onClearAll, open, onClose
}) => {
  /*
    Two flags, not one.

    `mounted` keeps the panel in the DOM for the length of the fold-back, so it
    animates home into the magnifier instead of blinking out of existence.
    `out` is the state it is animating TO, and it has to be set in a LATER
    frame than the mount — an element that appears already holding its final
    transform has nothing to transition from.
  */
  const [mounted, setMounted] = useState(open);
  const [out, setOut] = useState(false);
  const timer = useRef<number | null>(null);

  /* House rule: the motion is the app's personality, never a toll. Asked for
     less of it, the panel is simply THERE and simply gone — no growth, no
     stagger, and no wait before it can be used. */
  const still = prefersReducedMotion();

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);

    if (open) {
      setMounted(true);
      if (still) { setOut(true); return undefined; }
      /*
        TWO frames, not one, and this is not superstition.

        With one, the panel arrived already open. React flushes this effect
        inside the same tick as the click, the rAF callback lands in that same
        frame BEFORE the browser has painted anything, and a browser that has
        never painted the starting transform has nothing to animate away from
        — so the growth was skipped entirely while the fold-back, whose
        starting state was on screen, played perfectly. One frame to paint the
        panel small, the next to tell it to grow.
      */
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setOut(true));
      });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }

    setOut(false);
    if (still) { setMounted(false); return undefined; }
    timer.current = window.setTimeout(() => setMounted(false), UNMOUNT_MS);
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

  return (
    /*
      Pinned by its bottom-right corner to the button that opened it — the
      caller wraps that button in a `relative` box — and grown from that same
      corner, so it visibly comes OUT of the magnifier rather than appearing
      near it. `right` clears the button's own width; `bottom` lines the
      panel's floor up with the button's.

      Nothing here has to know where on the screen the button ended up, which
      is what makes it survive the control stack growing and shrinking as
      cards open underneath it.
    */
    <div
      className="absolute z-[1001] origin-bottom-right"
      style={{
        right: 'calc(50% + 30px)',
        bottom: 'calc(50% - 22px)',
        transform: out ? 'scale(1)' : 'scale(0.6)',
        opacity: out ? 1 : 0,
        transition: still
          ? 'none'
          : `transform ${PANEL_MS}ms var(--ease-moook), opacity ${Math.round(PANEL_MS * 0.55)}ms linear`
      }}
    >
      <div
        className="pointer-events-auto w-[15rem] max-w-[calc(100vw-5.5rem)] rounded-2xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl p-3"
        role="group"
        aria-label="Show facilities on this map"
      >
        <div className="grid grid-cols-3 gap-y-2.5 gap-x-1">
          {SEARCHABLE_FACILITY_KINDS.map((kind, index) => {
            const spec = FACILITY[kind];
            const Icon = spec.icon;
            const on = activeSet.has(kind);

            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => { haptic('tap'); onToggle(kind); onClose(); }}
                className="flex flex-col items-center gap-1 rounded-xl py-1 no-press"
                style={{
                  /* Each tile arrives a beat after the one before it, and
                     leaves in the opposite order — the panel's own growth plus
                     nine small landings reads as one gesture. */
                  transform: out ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.8)',
                  opacity: out ? 1 : 0,
                  transition: still
                    ? 'none'
                    : `transform ${TILE_MS}ms var(--ease-moook), opacity ${Math.round(TILE_MS * 0.7)}ms linear`,
                  transitionDelay: still
                    ? '0ms'
                    : `${(out ? index : SEARCHABLE_FACILITY_KINDS.length - 1 - index) * STAGGER_MS}ms`
                }}
              >
                {/*
                  THE TILE WEARS THE COLOUR ITS PINS WEAR.

                  Colour is doing one job here and doing it well: tying the
                  button to the pins it is about to put on the map. Off, it is
                  the outline and the symbol; on, it fills. The map's own table
                  is the single source of both (`config/facilities.ts`), so a
                  tile and its pins cannot drift apart.
                */}
                <span
                  className="w-11 h-11 rounded-full border-2 flex items-center justify-center shadow-lg"
                  style={{
                    color: on ? '#020617' : spec.color,
                    backgroundColor: on ? spec.color : 'rgba(2,6,23,0.75)',
                    borderColor: spec.color
                  }}
                >
                  <Icon className="w-5 h-5" strokeWidth={on ? 2.4 : 2.1} />
                </span>
                <span
                  className={`text-[11px] font-bold leading-none text-center ${
                    on ? 'text-slate-100' : 'text-slate-400'
                  }`}
                >
                  {spec.plural}
                </span>
              </button>
            );
          })}
        </div>

        {/*
          Only when there is something to clear. A permanent "clear" under a
          grid of nine is a tenth control that does nothing nine times out of
          ten — and its absence is itself a useful signal that no layer is on.
        */}
        {active.length > 0 && (
          <button
            type="button"
            onClick={() => { haptic('tap'); onClearAll(); onClose(); }}
            className="mt-2.5 w-full py-2 rounded-xl border border-slate-700 bg-slate-900/80 text-[12px] font-bold text-slate-300 hover:text-slate-100 hover:border-slate-500"
            style={{
              opacity: out ? 1 : 0,
              transition: still ? 'none' : `opacity ${TILE_MS}ms linear`,
              transitionDelay: still ? '0ms' : `${out ? STAGGER_MS * 9 : 0}ms`
            }}
          >
            Turn {active.length === 1 ? 'it' : 'them all'} off
          </button>
        )}
      </div>
    </div>
  );
};

FacilityPicker.displayName = 'FacilityPicker';
