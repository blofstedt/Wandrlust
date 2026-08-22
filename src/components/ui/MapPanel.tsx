import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useKeyboardInset } from './Sheet';

/**
 * A CARD DOCKED AT THE BOTTOM OF THE MAP.
 *
 * The layer menu was the first thing to look like this, and it was the only
 * thing that did: search opened a full-width drawer welded to the bottom edge,
 * and the account button dropped a narrow dropdown hanging off its own corner.
 * Three controls sitting in one row of chrome, opening three different shapes
 * in three different places — and two of them could be open at once, over each
 * other.
 *
 * Now every control in that stack opens THIS, in the same place, at the same
 * size, with the same header. The caller holds one piece of state saying which
 * panel is open, so opening one closes the last; there is nothing to overlap.
 *
 * WHY IT IS HELD CLEAR OF THE CONTROL STACK rather than drawn over it:
 * `100vw - 8rem` is the screen minus the buttons on the right and the same
 * margin again on the left, which is what keeps it centred AND keeps every
 * control visible while you use it. Nothing you might want to press next
 * disappears behind the thing you are pressing now.
 *
 * `maxHeight` stops it reaching the top of the map: the beacon pill and any
 * notice up there stay readable, and a list longer than the gap scrolls inside
 * the card instead of running off the screen.
 */
interface MapPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Named in the header, and used as the dialog's accessible name. */
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * How much of the bottom of the map another card is already taking. The
   * panel rides above it rather than being buried by it.
   */
  overlayPx?: number;
  /**
   * Hold the card's bottom edge at the top of the on-screen keyboard, so a
   * field inside it and everything under that field stay visible while typing.
   * Only the search panel needs this.
   */
  liftAboveKeyboard?: boolean;
  /**
   * Let the caller decide what gets focus. The search panel focuses its own
   * input inside the tap that opened it — the only way iOS raises the keyboard
   * — and this stops the panel taking it straight back for the close button.
   */
  autoFocus?: boolean;
  children: React.ReactNode;
}

export const MapPanel: React.FC<MapPanelProps> = ({
  isOpen, onClose, title, icon: Icon, overlayPx = 0,
  liftAboveKeyboard = false, autoFocus = true, children
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const keyboardPx = useKeyboardInset(liftAboveKeyboard && isOpen);

  /* Escape closes it. Every panel has an X and a tap-anywhere-else, but a
     keyboard has neither. */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !autoFocus || !panelRef.current) return;
    const first = panelRef.current.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const t = setTimeout(() => first?.focus(), 40);
    return () => clearTimeout(t);
  }, [isOpen, autoFocus]);

  if (!isOpen) return null;

  /* The gap between the bottom of the map and the card. It clears whatever
     card is already open down there, and the keyboard on top of that. */
  const lift = `calc(1.5rem + ${overlayPx}px + ${keyboardPx}px)`;

  return (
    <>
      {/*
        A tap anywhere else puts it away — and is SWALLOWED, not passed
        through. Dismissing a panel and dropping a destination pin with one
        tap is two things happening for one intention, and the pin was never
        the one that was meant.
      */}
      <div
        className="absolute inset-0 z-[999]"
        onPointerDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={title}
        className="absolute left-1/2 -translate-x-1/2 z-[1000] flex flex-col w-[min(21rem,calc(100vw-8rem))] bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden anim-in-up transition-[bottom] duration-200"
        style={{
          bottom: lift,
          maxHeight: `calc(100% - 4rem - ${overlayPx}px - ${keyboardPx}px)`
        }}
      >
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800 shrink-0">
          <span className="text-xs font-bold text-slate-200 flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate">{title}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="tap-safe p-1.5 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 shrink-0"
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* `min-h-0` is what lets this scroll instead of overflowing the card
            — a flex child defaults to `min-height: auto`, which refuses to
            shrink below its content. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain scroll-soft">
          {children}
        </div>
      </div>
    </>
  );
};
