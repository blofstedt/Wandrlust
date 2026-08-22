import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

import { useToast } from './ui/Feedback';
import { watchForUpdates, applyUpdate } from '../services/updateService';

/**
 * Tells the user when a new version of the app is ready.
 *
 * WHY THIS IS A PILL ON THE MAP AND NOT A TOAST. It used to drive the shared
 * toast system, which puts its messages at the TOP of the screen — the one
 * strip of a phone a hand holding it cannot reach, and the same strip the
 * search box, the account menu and the notch are already competing for. An
 * update notice that never expires and cannot be comfortably pressed is a
 * banner in the way rather than an offer.
 *
 * So it sits at the bottom, centred, just above the map's own tap hint, in
 * the same glass-and-round-border language as the rest of the map chrome.
 * One tap updates; the small × puts it away.
 *
 * It renders inside <main>, not at the root, which is what keeps it clear of
 * the phone's tab bar without anybody having to guess that bar's height.
 *
 * Nothing here reloads the page on its own. Ignoring the pill is a valid
 * answer — the waiting worker takes over on the next cold start either way,
 * which is what the dismiss button says out loud.
 */
export const UpdatePrompt: React.FC = () => {
  const { toast } = useToast();

  // The toast context object is rebuilt on each render; holding it in a ref
  // keeps the watcher from being torn down and re-established every time.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  /** The waiting build, and the registration to hand over to. */
  const [update, setUpdate] = useState<{
    registration: ServiceWorkerRegistration;
    worker: ServiceWorker;
  } | null>(null);

  /**
   * Which build the user has waved away.
   *
   * Keyed on the worker rather than a plain boolean: dismissing one update
   * must not silence the NEXT one, and the watcher re-announces the same
   * waiting worker every time the app is brought back to the foreground.
   */
  const dismissed = useRef<ServiceWorker | null>(null);

  useEffect(
    () =>
      watchForUpdates((registration) => {
        const worker = registration.waiting;
        if (!worker || dismissed.current === worker) return;
        setUpdate((prev) => (prev?.worker === worker ? prev : { registration, worker }));
      }),
    []
  );

  if (!update) return null;

  const handleUpdate = () => {
    if (applyUpdate(update.registration)) return;
    // The waiting worker went away before we could hand over to it. Say so
    // instead of leaving a button that appears to do nothing.
    setUpdate(null);
    toastRef.current({
      kind: 'info',
      message: 'Reopen Wandrlust to finish updating',
      detail: 'The update will apply on the next launch.',
      duration: 6000
    });
  };

  return (
    <div
      className="absolute bottom-24 md:bottom-16 left-1/2 -translate-x-1/2 z-[1500]
                 max-w-[calc(100%-1.5rem)] anim-in-up"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 pl-1 pr-1 py-1 rounded-full bg-slate-900/95 backdrop-blur-md border border-emerald-500/60 shadow-2xl">
        <button
          type="button"
          onClick={handleUpdate}
          className="flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-full bg-emerald-500 text-slate-950 text-xs font-extrabold whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          New version — update
        </button>
        <button
          type="button"
          onClick={() => {
            dismissed.current = update.worker;
            setUpdate(null);
          }}
          className="tap-safe w-7 h-7 rounded-full text-slate-400 hover:text-slate-100 hover:bg-slate-800 flex items-center justify-center shrink-0"
          aria-label="Not now — the update applies next time you open Wandrlust"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
