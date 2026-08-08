/**
 * Keeping the installed app up to date.
 *
 * Once Wandrlust is on a home screen it stops going through a browser address
 * bar, so there is no reload button and nothing that naturally re-checks the
 * server. Without this, an installed copy could sit on an old build
 * indefinitely — which for fire and flood alerting is not a cosmetic problem.
 *
 * How an update reaches someone, in order of how quickly it happens:
 *
 *   1. They are using the app when one lands → they get a toast offering to
 *      apply it now.
 *   2. They switch away from the app while an update is waiting → it is
 *      applied silently in the background, and the next time they open it
 *      they are simply on the new version.
 *   3. They ignore it entirely → the waiting worker takes over on the next
 *      cold start, because that is what a waiting worker does.
 *
 * Nothing here ever reloads the page while the user is looking at it without
 * being asked. Yanking the map out from under someone mid-pan to apply a
 * patch release is not an improvement.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROMPT NEVER FIRED ON INSTALLED PWAs (the bug this fixes)
 * ---------------------------------------------------------------------------
 *
 * The old announce check was `!navigator.serviceWorker.controller` — a guard
 * against a false "update ready" toast on first install, when there is no
 * controller yet. That guard is wrong on a home-screen PWA:
 *
 *   - iOS Safari: `controller` is briefly `null` on every cold start from the
 *     home screen, until the new worker claims the client. With the old
 *     guard, the first announce after launch returned early and the toast
 *     never showed.
 *   - Android Chrome: same, milder, but real.
 *   - Backgrounded PWAs: if the OS evicted the SW between visits, the
 *     controller is null on next launch and stays that way.
 *
 * The correct "is this a real update" check is whether a worker is WAITING
 * AND a different worker is already ACTIVE. If both exist, and they're not
 * the same script, there's a newer build to announce. If `active` is null
 * (first install), there is no "from" version and no update to show.
 *
 * ALSO: the only re-check trigger was `visibilitychange`, which fires on
 * background → foreground. Mobile browsers aggressively throttle
 * `setInterval` in backgrounded PWAs, so the 30-minute poll was effectively
 * dead. For an installed PWA the user is mostly *looking at* the app, not
 * leaving and coming back, so the only thing that would fire a check is
 * `focus` and `pageshow`. Both are wired in below.
 */

/** How often to ask the server whether a newer worker exists. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Don't re-check more than this often, however many events fire. */
const MIN_CHECK_GAP_MS = 60 * 1000;

let lastCheck = 0;
let applying = false;

const checkNow = (registration: ServiceWorkerRegistration): void => {
  const now = Date.now();
  if (now - lastCheck < MIN_CHECK_GAP_MS) return;
  lastCheck = now;
  // Never throws into the caller: a failed check just means we try later.
  registration.update().catch(() => undefined);
};

/**
 * Force a one-off update check. Bypasses `MIN_CHECK_GAP_MS` so the manual
 * "Check for updates" button in Settings actually does something when the
 * user taps it, instead of silently no-op'ing because the last auto-check
 * ran ten seconds ago.
 *
 * Resolves with the registration if a new worker became `waiting` during
 * the check, otherwise null. Callers usually pass the result to the same
 * `onUpdateReady` callback `watchForUpdates` uses, so the manual button
 * and the automatic check surface the same toast.
 */
export const checkForUpdate = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.ready.catch(() => null));
  if (!registration) return null;

  // Bypass the throttle. A user-initiated check is exactly the case the
  // throttle exists to NOT cover.
  lastCheck = 0;
  try {
    await registration.update();
  } catch {
    return null;
  }
  return registration.waiting && registration.active && registration.waiting !== registration.active
    ? registration
    : null;
};

/**
 * Hand control to the waiting worker and reload onto the new version.
 *
 * Safe to call more than once — the guard matters because `controllerchange`
 * can fire for reasons other than our own request.
 */
export const applyUpdate = (registration: ServiceWorkerRegistration): void => {
  if (applying) return;
  const waiting = registration.waiting;
  if (!waiting) return;

  applying = true;
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => { window.location.reload(); },
    { once: true }
  );
  waiting.postMessage('SKIP_WAITING');
};

/**
 * Watch for new versions.
 *
 * `onUpdateReady` fires when a new build is installed and waiting. Returns a
 * cleanup function. Never throws — on a browser without service workers, or
 * over plain HTTP, it simply does nothing.
 */
export const watchForUpdates = (
  onUpdateReady: (registration: ServiceWorkerRegistration) => void
): (() => void) => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => undefined;
  }

  let disposed = false;
  let registration: ServiceWorkerRegistration | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  /**
   * A real update is when a worker is WAITING while a DIFFERENT worker is
   * already ACTIVE. If `active` is null (first install, no controller yet)
   * the waiting worker IS the install, not an update — we say nothing. If
   * the waiting worker IS the active one (a tab was kept open and the worker
   * skipped waiting), there is also nothing to announce.
   */
  const isRealUpdate = (reg: ServiceWorkerRegistration | null): boolean => {
    if (!reg?.waiting || !reg.active) return false;
    return reg.waiting !== reg.active;
  };

  const announce = () => {
    if (!registration) return;
    if (!isRealUpdate(registration)) return;
    onUpdateReady(registration);
  };

  const onVisibility = () => {
    if (!registration || disposed) return;

    if (document.visibilityState === 'visible') {
      checkNow(registration);
      announce();
      return;
    }

    // They've switched away. This is the moment to apply an update without
    // anyone noticing: the reload happens to a page nobody is looking at.
    if (registration.waiting && registration.active) {
      applyUpdate(registration);
    }
  };

  const onFocus = () => {
    if (!registration || disposed) return;
    checkNow(registration);
    // Announce is a no-op when nothing is waiting; cheap to call here so the
    // toast appears the moment the user looks at the app after a deploy.
    announce();
  };

  (async () => {
    try {
      registration = (await navigator.serviceWorker.getRegistration()) ?? null;
      // The worker is registered elsewhere (pushService) and may not be ready
      // at the moment this runs.
      if (!registration) {
        registration = await navigator.serviceWorker.ready;
      }
      if (disposed || !registration) return;

      // Catch updates that arrived BEFORE this listener attached. Without
      // this, a worker that became `waiting` while the app was loading (or
      // while the user had it open and a poll already completed) would slip
      // through the `updatefound` listener and never trigger the toast.
      announce();

      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') announce();
        });
      });

      poll = setInterval(() => {
        if (registration) checkNow(registration);
      }, POLL_INTERVAL_MS);

      // `visibilitychange` catches the background → foreground case.
      // `focus` and `pageshow` catch the case the user is actively looking
      // at the app: mobile PWAs are mostly in the foreground, so the poll
      // and visibility handler together are not enough. Without these, an
      // installed PWA may sit open on an old build for the entire session.
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onFocus);
      window.addEventListener('pageshow', onFocus);
      checkNow(registration);
    } catch {
      /* No worker available. The app works fine without updates being watched. */
    }
  })();

  return () => {
    disposed = true;
    if (poll) clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onFocus);
  };
};
