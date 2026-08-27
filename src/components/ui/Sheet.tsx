import React, { useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';

/**
 * Modal / bottom-sheet primitive.
 *
 * Handles the accessibility work every dialog needs and most hand-rolled ones
 * skip: focus-in on open, focus RETURN to the trigger on close, tab trapping,
 * Escape, scroll lock without the iOS jump, role="dialog" + aria-modal, and a
 * backdrop press that only fires when the press STARTS on the backdrop (so a
 * drag ending outside doesn't dismiss a half-finished form).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * Where the panel sits.
   *
   * `sheet`  — edge to edge along the bottom, the classic drawer.
   * `dialog` — a card floating in the middle of the screen.
   * `dock`   — a card floating LOW: centred, held clear of the phone's tab
   *            bar, no wider than it needs to be. This is the one for a panel
   *            opened from a control down at thumb level — the map's layers
   *            and its search. A drawer for those was wrong twice over: it
   *            took the full width of the screen for a handful of switches,
   *            and it swallowed the bottom of the map, which is the part
   *            somebody has their thumb on and is usually looking at.
   */
  variant?: 'sheet' | 'dialog' | 'dock';
  maxWidthClass?: string;
  /**
   * Leave the app behind this panel working.
   *
   * A modal takes the whole screen hostage: everything behind it is dimmed,
   * inert, and hidden from a screen reader, which is right for a form you
   * must finish or abandon. It is wrong for a panel the app can keep
   * running underneath — the Tools card sits above the tab bar and the bar
   * is still visibly there, so a thumb landing on Map has every reason to
   * expect Map.
   *
   * Set this and the panel stops trapping Tab, stops claiming `aria-modal`,
   * and lets whatever the app raises above the backdrop stay live. Escape
   * and the backdrop press still close it. It is the CALLER's job to lift
   * the still-usable part above the backdrop's z-index; this flag only
   * stops the panel from fighting it.
   */
  interactiveBehind?: boolean;
  /**
   * Sit the panel on top of the on-screen keyboard instead of underneath it.
   *
   * A bottom sheet with a text field in it has a problem on a phone: the
   * keyboard covers the bottom of the screen, which is exactly where the
   * sheet is. `100dvh` does not shrink for the keyboard on iOS, so nothing
   * in CSS notices. The visual viewport does, so we measure it and hold the
   * panel's bottom edge at the top of the keyboard.
   *
   * Degrades to a normal bottom sheet anywhere `visualViewport` is missing.
   */
  liftAboveKeyboard?: boolean;
  /**
   * Let the caller decide what gets focus.
   *
   * By default the panel focuses its first control, which is the close
   * button. For a search sheet that is the wrong thing: the caller focuses
   * the input inside the tap that opened the panel — the only way iOS will
   * raise the keyboard — and this stops the panel taking it straight back.
   */
  autoFocus?: boolean;
  /**
   * Override the backdrop's stacking order. Default `z-[1800]`, same as
   * every other sheet, so siblings stack by DOM order.
   *
   * Only reach for this when a panel must appear above OTHER open sheets
   * regardless of where it sits in the tree — the sign-in dialog is the one
   * case today: it can be triggered from inside almost any other sheet
   * ("save this spot" while signed out), and several of those sheets are
   * mounted after it in `App.tsx`, so DOM order alone would sometimes bury
   * it behind the very panel that opened it.
   */
  zIndexClass?: string;
}

/**
 * How much of the screen the on-screen keyboard is covering, in pixels.
 *
 * `visualViewport` is the only thing that knows. Zero when it is missing,
 * when the keyboard is down, or when this is switched off.
 */
export const useKeyboardInset = (active: boolean): number => {
  const [inset, setInset] = React.useState(0);

  useEffect(() => {
    if (!active) { setInset(0); return; }
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      // Anything under 80px is browser chrome moving, not a keyboard.
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(covered > 80 ? covered : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);

  return inset;
};

export const Sheet: React.FC<SheetProps> = ({
  isOpen, onClose, title, subtitle, icon, children, footer,
  variant = 'sheet', maxWidthClass = 'sm:max-w-md', interactiveBehind = false,
  liftAboveKeyboard = false, autoFocus = true, zIndexClass = 'z-[1800]'
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useRef(`sheet-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    if (isOpen) restoreFocusRef.current = document.activeElement as HTMLElement;
  }, [isOpen]);

  // Lock background scroll without the iOS position:fixed jump.
  useEffect(() => {
    if (!isOpen) return;
    const original = document.body.style.overflow;
    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !autoFocus || !panelRef.current) return;
    const first = panelRef.current.querySelector<HTMLElement>(FOCUSABLE);
    const t = setTimeout(() => (first ?? panelRef.current)?.focus(), 40);
    return () => clearTimeout(t);
  }, [isOpen, autoFocus]);

  useEffect(() => {
    if (isOpen) return;
    restoreFocusRef.current?.focus?.();
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !panelRef.current) return;
    /* Non-modal: Tab is allowed to walk out of the panel and into the app,
       because the app behind it is genuinely usable. Trapping here would
       leave a keyboard on a different set of controls than a thumb. */
    if (interactiveBehind) return;

    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null);
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];

    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose, interactiveBehind]);

  const keyboardInset = useKeyboardInset(isOpen && liftAboveKeyboard);

  if (!isOpen) return null;
  const isSheet = variant === 'sheet';
  const isDock = variant === 'dock';

  /*
    A dock is narrower than a dialog by default and narrow at EVERY width,
    not just above `sm`. It is a card that has to sit over a live map without
    burying it, so `w-full` up to a phone's edges is exactly what it must not
    be. Callers can still override.
  */
  const widthClass = isDock
    ? (maxWidthClass === 'sm:max-w-md' ? 'max-w-sm' : maxWidthClass)
    : maxWidthClass;

  /*
    Where the card lands.

    The dock's `5.25rem` is the tab bar's measured height (a 62px row plus
    its padding) with a little air under the card, and the safe-area inset on
    top of that for the phones with a home indicator. Above `sm` there is no
    tab bar, so it relaxes to an ordinary margin.
  */
  const overlayClass = isSheet
    ? 'items-end sm:items-center p-0 sm:p-4'
    : isDock
      ? 'items-end px-4 pt-4 pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:pb-8'
      : 'items-center p-4';

  return (
    <div
      /* `backdrop-blur-sm` as a class, not only as the end state of
         `anim-backdrop`: under `prefers-reduced-motion` that animation does not
         run, and the blur is not decoration — it is what separates a card from
         the busy map behind it. */
      className={`fixed inset-0 ${zIndexClass} flex justify-center bg-slate-950/70 backdrop-blur-sm anim-backdrop ${overlayClass}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}
    >
      <div
        ref={panelRef}
        style={
          keyboardInset
            ? { maxHeight: `calc(100dvh - ${keyboardInset}px - 1rem)` }
            : undefined
        }
        role="dialog"
        aria-modal={interactiveBehind ? undefined : true}
        aria-labelledby={titleId.current}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`w-full ${widthClass} bg-slate-900 border-slate-700 shadow-2xl flex flex-col outline-none ${
          isSheet
            ? 'max-h-[90vh] border-t sm:border rounded-t-3xl sm:rounded-2xl anim-sheet-up sm:anim-expand'
            : isDock
              /* Shorter than a centred dialog because it starts from the
                 bottom of the screen: 70vh from down there still leaves the
                 header, the beacon pill and the top of the map in view, which
                 is the whole point of docking it rather than drawering it. */
              ? 'max-h-[70vh] border rounded-2xl anim-in-up'
              /*
                A dialog is a card floating in the middle of the screen, so it
                stops short of the edges the sheet is allowed to reach — the
                tab bar and the header stay visible around it, which is what
                tells you it is a layer and not a new screen. The 78 is
                measured, not chosen: the phone tab bar is about 9vh, and a
                centred card any taller than this reaches under it. The 40rem
                caps it on a desktop, where 78vh of a tall monitor is a card
                nobody can read across.

                A FIXED height, not a maximum, and that is the point of it.
                Every tool in this app opens one of these, and a stack of
                panels that are each a different height — settings tall,
                Scout Mode short, reports somewhere between — reads as a
                different screen every time rather than one app. Short content
                leaves room at the bottom; long content scrolls inside. One
                box, always.
              */
              : 'h-[min(78vh,40rem)] border rounded-2xl anim-expand'
        }`}
      >
        {isSheet && (
          <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0">
            <div className="w-10 h-1 rounded-full bg-slate-600" />
          </div>
        )}

        {/* The subtitle WRAPS. It used to be `truncate`, which is fine for a
            three-word caption and wrong for the ones that are a sentence —
            "Wandrlust does not know where you are yet" arrived on a phone as
            "Wandrlust does not know where you are …", which reads like the
            app broke off mid-thought. */}
        <header className="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-slate-800 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            {icon && <div className="shrink-0 mt-0.5">{icon}</div>}
            <div className="min-w-0">
              <h2 id={titleId.current} className="text-sm font-bold text-slate-100">{title}</h2>
              {subtitle && <p className="text-xs text-slate-400 leading-snug mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 shrink-0 tap-target flex items-center justify-center"
            aria-label={`Close ${title}`}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-soft">{children}</div>
        {footer && <footer className="border-t border-slate-800 p-3 shrink-0">{footer}</footer>}
      </div>
    </div>
  );
};

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

/** Tabs with a sliding indicator that overshoots and settles. */
export function Segmented<T extends string>({
  options, value, onChange, className = ''
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.id === value));

  return (
    <div role="tablist" className={`relative flex bg-slate-800/60 rounded-xl p-1 ${className}`}>
      <div
        className="absolute top-1 bottom-1 rounded-lg bg-emerald-600 shadow-md"
        style={{
          width: `calc((100% - 8px) / ${options.length})`,
          left: `calc(4px + (100% - 8px) * ${activeIndex} / ${options.length})`,
          transition: 'left 250ms cubic-bezier(0.16, 1.36, 0.36, 1)'
        }}
        aria-hidden="true"
      />
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            className={`relative z-10 flex-1 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors duration-200 ${
              active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
