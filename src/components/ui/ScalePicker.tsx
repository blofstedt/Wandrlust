import React, { useCallback, useRef, useState } from 'react';
import { haptic, prefersReducedMotion } from '../../utils/animation';

/**
 * A slider with named stops, and a real "nobody answered" state.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN AN <input type="range">
 * ---------------------------------------------------------------------------
 *
 * A native range input has no way to be empty. It always has a value, and its
 * value is the middle of the track — so a form built from them silently
 * publishes a full set of confident middling answers from somebody who touched
 * nothing. That is the single most dishonest thing a form can do in this app,
 * so the control had to be able to say "not answered" and mean it.
 *
 * Everything else follows from that: `value` is `number | undefined`, the
 * thumb is not drawn until there is a value, and the track sits dim until
 * somebody commits. Clearing an answer is possible too — tapping the stop you
 * are already on removes it — because a mis-tap should not be permanent.
 *
 * Interaction is deliberately all three of tap, drag and arrow keys. Tap is
 * what people do on a phone, drag is what makes it feel like a slider rather
 * than a row of buttons, and the keys are what make it usable at all with a
 * keyboard or a screen reader.
 */

export interface ScalePickerProps {
  /** Low to high. Two to five of them; more than five is a menu, not a scale. */
  stops: string[];
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  label: string;
  /** Rendered to the left of the label. An emoji, usually. */
  emoji?: string;
  hint?: string;
  /** Tints the fill. Defaults to the app's emerald. */
  accent?: string;
}

export const ScalePicker: React.FC<ScalePickerProps> = ({
  stops, value, onChange, label, emoji, hint, accent = '#10B981'
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const answered = value != null;
  const last = stops.length - 1;

  /** Which stop a page X coordinate lands on. */
  const stopAt = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(last, Math.max(0, Math.round(ratio * last)));
  }, [last]);

  const commit = useCallback((next: number, viaTap: boolean) => {
    // Tapping the stop you are already on clears it. Only on a tap — doing
    // this mid-drag would make the answer flicker out from under your thumb.
    if (viaTap && value === next) {
      onChange(undefined);
      haptic('tap');
      return;
    }
    if (value !== next) haptic('tap');
    onChange(next);
  }, [value, onChange]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
    commit(stopAt(e.clientX), true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    commit(stopAt(e.clientX), false);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(Math.max(0, (value ?? 0) - (answered ? 1 : 0)), false);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      commit(answered ? Math.min(last, value + 1) : 0, false);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      onChange(undefined);
    }
  };

  const percent = answered ? (value / last) * 100 : 0;
  // The overshoot-and-settle curve, matched to Segmented so the whole form
  // moves the same way. Collapses to nothing under prefers-reduced-motion.
  const motion = prefersReducedMotion()
    ? 'none'
    : `left 250ms cubic-bezier(0.16, 1.36, 0.36, 1), width 250ms cubic-bezier(0.16, 1.36, 0.36, 1)`;

  return (
    <div className="rounded-2xl border border-slate-700/80 bg-slate-800/40 p-3">
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <p className="text-xs font-bold text-slate-200 flex items-center gap-1.5 min-w-0">
          {emoji && <span aria-hidden="true">{emoji}</span>}
          <span className="truncate">{label}</span>
        </p>
        {/* The answer, in words. This is the part people actually read — the
            track is just how you change it. */}
        <p
          className={`text-xs font-bold shrink-0 tabular-nums ${
            answered ? '' : 'text-slate-500 font-semibold'
          }`}
          style={answered ? { color: accent } : undefined}
        >
          {answered ? stops[value] : 'Not answered'}
        </p>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={answered ? value : undefined}
        aria-valuetext={answered ? stops[value] : 'Not answered'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        // Generous vertical padding: the visible track is thin but the thing
        // you can hit is 44px tall, which is what makes this workable one-handed.
        className="relative py-2.5 cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 rounded-lg"
      >
        <div className="h-1.5 rounded-full bg-slate-700/80 relative">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${percent}%`,
              background: accent,
              opacity: answered ? 1 : 0,
              transition: motion
            }}
          />

          {/* The notches. Always visible, so the number of choices is obvious
              before you touch anything. */}
          {stops.map((stop, i) => {
            const passed = answered && i <= value;
            return (
              <span
                key={stop}
                aria-hidden="true"
                className="absolute w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 top-1/2"
                style={{
                  left: `${(i / last) * 100}%`,
                  background: passed ? accent : '#475569',
                  transition: prefersReducedMotion() ? 'none' : 'background 180ms linear'
                }}
              />
            );
          })}

          {answered && (
            <span
              aria-hidden="true"
              className="absolute w-4 h-4 rounded-full border-2 border-slate-900 shadow-lg -translate-x-1/2 -translate-y-1/2 top-1/2"
              style={{
                left: `${percent}%`,
                background: accent,
                transition: motion,
                transform: dragging ? 'translate(-50%, -50%) scale(1.15)' : undefined
              }}
            />
          )}
        </div>
      </div>

      {/* End labels only. Printing all five under a phone-width track turns
          into unreadable four-point type. */}
      <div className="flex justify-between text-[11px] text-slate-500 -mt-0.5">
        <span className="truncate max-w-[45%]">{stops[0]}</span>
        <span className="truncate max-w-[45%] text-right">{stops[last]}</span>
      </div>

      {hint && answered && (
        <p className="text-[12px] text-slate-400 mt-1.5 anim-in-up">{hint}</p>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */

/**
 * Yes / no / not answered.
 *
 * Same principle as the scale: there is a third state and it is the default.
 * Tapping the answer you already gave clears it.
 */
export const TriToggle: React.FC<{
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
  label: string;
  emoji?: string;
  /** Colours a `true` answer red instead of emerald. For the knock question. */
  danger?: boolean;
}> = ({ value, onChange, label, emoji, danger = false }) => {
  const pick = (next: boolean) => {
    haptic(next && danger ? 'warning' : 'tap');
    onChange(value === next ? undefined : next);
  };

  const yesActive = value === true;
  const noActive = value === false;

  return (
    <div className="rounded-2xl border border-slate-700/80 bg-slate-800/40 p-3 flex items-center justify-between gap-3">
      <p className="text-xs font-bold text-slate-200 flex items-center gap-1.5 min-w-0">
        {emoji && <span aria-hidden="true">{emoji}</span>}
        <span className="min-w-0">{label}</span>
      </p>
      <div className="flex gap-1.5 shrink-0" role="group" aria-label={label}>
        <button
          type="button"
          aria-pressed={yesActive}
          onClick={() => pick(true)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors duration-150 tap-target ${
            yesActive
              ? danger
                ? 'bg-red-950/70 border-red-500/70 text-red-200'
                : 'bg-emerald-950/70 border-emerald-500/70 text-emerald-200'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
          }`}
        >
          Yes
        </button>
        <button
          type="button"
          aria-pressed={noActive}
          onClick={() => pick(false)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors duration-150 tap-target ${
            noActive
              ? 'bg-slate-700 border-slate-500 text-slate-100'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
          }`}
        >
          No
        </button>
      </div>
    </div>
  );
};
