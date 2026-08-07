import React, {
  Component, createContext, useContext, useState, useCallback, useEffect, useRef
} from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  CheckCircle2, AlertTriangle, XCircle, Info, X, RefreshCw, Compass
} from 'lucide-react';
import { haptic } from '../../utils/animation';

/* ==================================================================
   Toasts
   ================================================================== */

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
  /** ms. 0 keeps it until dismissed — use for errors the user must see. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  toast: (t: Omit<Toast, 'id'>) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  warning: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};

const KIND_STYLE: Record<
  ToastKind,
  { icon: React.ComponentType<{ className?: string }>; ring: string; accent: string }
> = {
  success: { icon: CheckCircle2, ring: 'border-emerald-500/60', accent: 'text-emerald-400' },
  error: { icon: XCircle, ring: 'border-rose-500/60', accent: 'text-rose-400' },
  warning: { icon: AlertTriangle, ring: 'border-amber-500/60', accent: 'text-amber-400' },
  info: { icon: Info, ring: 'border-sky-500/60', accent: 'text-sky-400' }
};

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    // Play the exit animation before unmounting.
    setLeaving((s) => new Set(s).add(id));
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
      setLeaving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }, 140);

    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const entry: Toast = { id, duration: 4000, ...t };

      setToasts((list) => {
        // Cap the stack so a burst of errors can't cover the screen.
        const next = [...list, entry];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      haptic(t.kind === 'success' ? 'success' : t.kind === 'error' ? 'error' : 'tap');

      if (entry.duration && entry.duration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), entry.duration));
      }
    },
    [dismiss]
  );

  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    },
    []
  );

  const value: ToastContextValue = {
    toast,
    dismiss,
    success: (message, detail) => toast({ kind: 'success', message, detail }),
    // Errors stay until dismissed: if something failed, the user needs to know.
    error: (message, detail) => toast({ kind: 'error', message, detail, duration: 0 }),
    warning: (message, detail) => toast({ kind: 'warning', message, detail, duration: 6000 }),
    info: (message, detail) => toast({ kind: 'info', message, detail })
  };

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Live region so screen readers announce toasts. */}
      <div
        className="fixed top-3 left-1/2 -translate-x-1/2 z-[3000] w-full max-w-sm px-3 space-y-2 pointer-events-none"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => {
          const style = KIND_STYLE[t.kind];
          const Icon = style.icon;
          const isLeaving = leaving.has(t.id);

          return (
            <div
              key={t.id}
              className={`pointer-events-auto rounded-2xl border ${style.ring} bg-slate-900/95 backdrop-blur-md shadow-2xl p-3 flex items-start gap-2.5 ${
                isLeaving ? 'anim-toast-out' : 'anim-toast-in'
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${style.accent}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-100 leading-snug">{t.message}</p>
                {t.detail && (
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{t.detail}</p>
                )}
                {t.action && (
                  <button
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                    className={`mt-1.5 text-[11px] font-bold ${style.accent} hover:underline`}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="p-1 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

/* ==================================================================
   Error boundary
   ================================================================== */

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackLabel?: string;
  onReset?: () => void;
}

/**
 * Catches render crashes so one bad component doesn't blank the whole app.
 *
 * Scoped boundaries matter: if the map throws, the user should still have
 * their saved list and settings. Wrap risky subtrees individually rather than
 * relying on one boundary at the root.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Replace with your telemetry sink in production.
    console.error('[Wandrlust] render error:', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="p-6 flex flex-col items-center justify-center text-center min-h-[220px] anim-fade">
        <div className="p-3 rounded-2xl bg-rose-950/50 border border-rose-800/60 mb-3">
          <AlertTriangle className="w-5 h-5 text-rose-400" />
        </div>
        <p className="text-sm font-bold text-slate-100 mb-1">
          {this.props.fallbackLabel ?? 'Something broke here'}
        </p>
        <p className="text-[11px] text-slate-400 max-w-xs leading-snug mb-4">
          The rest of the app is still working. You can retry this section, or carry on
          and come back to it.
        </p>
        {this.state.error && (
          <details className="mb-4 max-w-xs w-full">
            <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300">
              Technical detail
            </summary>
            <pre className="text-[9px] text-slate-500 mt-1.5 p-2 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto text-left">
              {this.state.error.message}
            </pre>
          </details>
        )}
        <button
          onClick={this.reset}
          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Try again
        </button>
      </div>
    );
  }
}

/* ==================================================================
   Skeletons
   ================================================================== */

export const SkeletonLine: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`skeleton rounded-md h-3 ${className}`} />
);

export const SkeletonCard: React.FC<{ index?: number }> = ({ index = 0 }) => (
  <div
    className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 anim-in-up"
    data-stagger={Math.min(index, 8)}
    aria-hidden="true"
  >
    <div className="flex gap-3">
      <div className="skeleton rounded-xl w-20 h-20 shrink-0" />
      <div className="flex-1 space-y-2 pt-1">
        <SkeletonLine className="w-3/4" />
        <SkeletonLine className="w-1/2" />
        <div className="flex gap-1.5 pt-1">
          <SkeletonLine className="w-12 h-4 rounded-full" />
          <SkeletonLine className="w-16 h-4 rounded-full" />
        </div>
      </div>
    </div>
  </div>
);

export const SkeletonList: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="space-y-3" role="status" aria-label="Loading campsites">
    {Array.from({ length: count }).map((_, i) => (
      <SkeletonCard key={i} index={i} />
    ))}
    <span className="sr-only">Loading…</span>
  </div>
);

/* ==================================================================
   Empty state
   ================================================================== */

export const EmptyState: React.FC<{
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}> = ({ icon: Icon = Compass, title, description, action }) => (
  <div className="flex flex-col items-center justify-center text-center py-10 px-6 anim-in-up">
    <div className="p-3.5 rounded-2xl bg-slate-800/60 border border-slate-700 mb-3 anim-expand">
      <Icon className="w-6 h-6 text-slate-400" />
    </div>
    <p className="text-sm font-bold text-slate-200 mb-1">{title}</p>
    <p className="text-[11px] text-slate-400 max-w-xs leading-snug mb-4">{description}</p>
    {action && (
      <button
        onClick={action.onClick}
        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
      >
        {action.label}
      </button>
    )}
  </div>
);

/* ==================================================================
   Animated number — watching a balance climb is half the reward
   ================================================================== */

export const AnimatedNumber: React.FC<{ value: number; className?: string }> = ({
  value,
  className = ''
}) => {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const [bumped, setBumped] = useState(false);

  useEffect(() => {
    if (prev.current === value) return;

    const from = prev.current;
    prev.current = value;

    // Pop when it goes up — small reward for earning.
    if (value > from) {
      setBumped(true);
      setTimeout(() => setBumped(false), 260);
    }

    let raf = 0;
    const start = performance.now();
    const dur = 420;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className={`${className} ${bumped ? 'anim-pop' : ''} inline-block tabular-nums`}>
      {display}
    </span>
  );
};

/* ==================================================================
   Offline banner
   ================================================================== */

export const OfflineIndicator: React.FC = () => {
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[2500] anim-in-up"
      role="status"
      aria-live="polite"
    >
      <div className="px-3 py-1.5 rounded-full bg-amber-500 text-slate-950 text-[11px] font-bold shadow-xl flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-pulse" />
        Offline — showing saved data
      </div>
    </div>
  );
};