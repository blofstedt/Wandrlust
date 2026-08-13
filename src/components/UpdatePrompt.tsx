import React, { useEffect, useRef } from 'react';

import { useToast } from './ui/Feedback';
import { watchForUpdates, applyUpdate } from '../services/updateService';

/**
 * Tells the user when a new version of the app is ready.
 *
 * Renders nothing itself — it drives the shared toast system, so the update
 * notice looks and behaves like every other message in the app instead of
 * being a bespoke banner.
 *
 * The toast never expires (`duration: 0`). An update notice that quietly
 * disappears after four seconds is one the user will miss, and then wonder
 * why a fix they were told about never arrived.
 */
export const UpdatePrompt: React.FC = () => {
  const { toast } = useToast();

  // The toast context object is rebuilt on each render; holding it in a ref
  // keeps the watcher from being torn down and re-established every time.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  /**
   * Which build we've already shown a toast for. Keyed rather than a plain
   * boolean: a single `announced` flag meant that if the update failed to
   * apply, or a second deploy landed during the session, the user was never
   * told again — the app just sat there on the old version with no way back to
   * the prompt.
   */
  const announcedFor = useRef<ServiceWorker | null>(null);

  useEffect(
    () =>
      watchForUpdates((registration) => {
        const waiting = registration.waiting;
        if (!waiting || announcedFor.current === waiting) return;
        announcedFor.current = waiting;

        toastRef.current({
          kind: 'info',
          message: 'A new version of Wandrlust is ready',
          detail: 'Applied automatically next time you open the app.',
          duration: 0,
          action: {
            label: 'Update now',
            onClick: () => {
              if (applyUpdate(registration)) return;
              // The waiting worker went away before we could hand over to it.
              // Say so instead of leaving a button that appears to do nothing.
              announcedFor.current = null;
              toastRef.current({
                kind: 'info',
                message: 'Reopen Wandrlust to finish updating',
                detail: 'The update will apply on the next launch.',
                duration: 6000
              });
            }
          }
        });
      }),
    []
  );

  return null;
};