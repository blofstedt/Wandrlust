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

  const announced = useRef(false);

  useEffect(
    () =>
      watchForUpdates((registration) => {
        if (announced.current) return;
        announced.current = true;

        toastRef.current({
          kind: 'info',
          message: 'A new version of Wandrlust is ready',
          detail: 'Applied automatically next time you open the app.',
          duration: 0,
          action: { label: 'Update now', onClick: () => applyUpdate(registration) }
        });
      }),
    []
  );

  return null;
};