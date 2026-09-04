import React, { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

/** The `beforeinstallprompt` event, which TypeScript's DOM lib has no type for. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'wandrlust-install-dismissed-at';
const DISMISS_DAYS = 14;
const SHOW_DELAY_MS = 2500;

const isStandalone = (): boolean => {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
};

const isIos = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Phones and tablets only — a mouse-driven laptop shouldn't be nagged to "install" a bookmark. */
const isTouchDevice = (): boolean => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

const recentlyDismissed = (): boolean => {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Boolean(at) && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
};

/**
 * A one-time nudge to install the app, for phones and tablets that opened
 * Wandrlust straight in the browser instead of arriving through the /home
 * pitch page (which has its own install flow already).
 *
 * Chrome/Android hand over a real install prompt via `beforeinstallprompt`;
 * Safari/iOS never fires that event, so there it's short instructions instead
 * of a button that can't exist. Delayed a couple seconds so it doesn't fight
 * the map for attention the instant the page loads, and it remembers a
 * dismissal for two weeks rather than reappearing on every visit.
 */
export const InstallPrompt: React.FC = () => {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isStandalone() || !isTouchDevice() || recentlyDismissed()) return;

    if (isIos()) {
      const t = setTimeout(() => setShowIosHint(true), SHOW_DELAY_MS);
      return () => clearTimeout(t);
    }

    const onPrompt = (event: Event) => {
      // Keep it: calling `prompt()` later is what puts the install sheet up
      // on a tap, which is the only moment a browser will honour it.
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
    setInstallEvent(null);
    setShowIosHint(false);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    // A browser will not replay the same prompt, so it goes either way.
    setInstallEvent(null);
  };

  if (dismissed || (!installEvent && !showIosHint)) return null;

  return (
    <div
      className="fixed left-3 right-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-4 md:left-auto md:right-4 md:w-80 z-[1600] anim-in-up"
      role="status"
    >
      <div className="rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-3.5 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0">
          <Download className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-100">Install Wandrlust</p>

          {installEvent ? (
            <>
              <p className="text-xs text-slate-400 leading-relaxed mt-0.5">
                Add it to your home screen for offline maps and hazard alerts.
              </p>
              <button
                onClick={install}
                className="mt-2.5 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Install
              </button>
            </>
          ) : (
            <p className="text-xs text-slate-400 leading-relaxed mt-0.5">
              Tap <Share className="w-3 h-3 inline -mt-0.5" aria-hidden="true" /> Share, then{' '}
              <strong className="text-slate-300">Add to Home Screen</strong> — offline maps and
              hazard alerts only work once it’s installed this way.
            </p>
          )}
        </div>

        <button
          onClick={dismiss}
          className="p-1 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 shrink-0"
          aria-label="Dismiss install prompt"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
