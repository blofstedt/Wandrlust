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
  variant?: 'sheet' | 'dialog';
  maxWidthClass?: string;
}

export const Sheet: React.FC<SheetProps> = ({
  isOpen, onClose, title, subtitle, icon, children, footer,
  variant = 'sheet', maxWidthClass = 'sm:max-w-md'
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
    if (!isOpen || !panelRef.current) return;
    const first = panelRef.current.querySelector<HTMLElement>(FOCUSABLE);
    const t = setTimeout(() => (first ?? panelRef.current)?.focus(), 40);
    return () => clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    restoreFocusRef.current?.focus?.();
  }, [isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !panelRef.current) return;

    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null);
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];

    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  if (!isOpen) return null;
  const isSheet = variant === 'sheet';

  return (
    <div
      className={`fixed inset-0 z-[1800] flex justify-center bg-slate-950/70 anim-backdrop ${
        isSheet ? 'items-end sm:items-center p-0 sm:p-4' : 'items-center p-4'
      }`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`w-full ${maxWidthClass} bg-slate-900 border-slate-700 shadow-2xl flex flex-col outline-none ${
          isSheet
            ? 'max-h-[90vh] border-t sm:border rounded-t-3xl sm:rounded-2xl anim-sheet-up sm:anim-expand'
            /* A dialog is a card floating in the middle of the screen, so it
               stops short of the edges the sheet is allowed to reach — the
               tab bar and the header stay visible around it, which is what
               tells you it is a layer and not a new screen. */
            : 'max-h-[82vh] border rounded-2xl anim-expand'
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
