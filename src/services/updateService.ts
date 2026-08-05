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

  const announce = () => {
    // `waiting` with an existing controller means a genuinely newer build is
    // ready. Without the controller check this would fire on first install,
    // when there is nothing to update from.
    if (!registration?.waiting || !navigator.serviceWorker.controller) return;
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
    if (registration.waiting && navigator.serviceWorker.controller) {
      applyUpdate(registration);
    }
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

      document.addEventListener('visibilitychange', onVisibility);
      checkNow(registration);
    } catch {
      /* No worker available. The app works fine without updates being watched. */
    }
  })();

  return () => {
    disposed = true;
    if (poll) clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisibility);
  };
};
