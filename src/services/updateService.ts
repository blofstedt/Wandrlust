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
 * WHY THE PROMPT NEVER FIRED ON INSTALLED PWAs
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
 *
 * ---------------------------------------------------------------------------
 * WHY AN UPDATE COULD APPEAR TO APPLY AND THEN ROLL BACK (the bug this fixes)
 * ---------------------------------------------------------------------------
 *
 * Users saw a new version arrive and then found themselves back on the old one.
 * Nothing was actually rolling back — several separate paths were leaving a
 * page running OLD JavaScript, and there was no way for a page to notice:
 *
 *   1. THE SERVICE WORKER CLAIMS PAGES IT DOES NOT RELOAD. `clients.claim()`
 *      makes a newly activated worker take over EVERY open page, but only the
 *      page that called `applyUpdate` ever reloaded — that is the only place a
 *      `controllerchange` listener existed. A second tab, or the installed PWA
 *      alongside a browser tab, kept rendering the previous build forever.
 *      Switching to it looks exactly like the update reverting.
 *
 *   2. THE BACKGROUND APPLY RELOADED A PAGE NOBODY WAS LOOKING AT. Applying on
 *      `hidden` calls `location.reload()` on a backgrounded tab, which mobile
 *      browsers are free to freeze, discard or never finish. When it doesn't
 *      finish, the user returns to the pre-reload page — the old build.
 *
 *   3. BFCACHE RESTORES THE OLD PAGE WHOLESALE. Navigating back, or returning
 *      to a frozen PWA, can restore a snapshot of a page from before the
 *      update. It comes back alive, running old code, with no event that says
 *      "you are stale".
 *
 *   4. A FAILED APPLY WEDGED THE MECHANISM PERMANENTLY. `applying` was a latch
 *      that was set and never cleared, so if the handover didn't complete, every
 *      later attempt — including the user tapping "Update now" — returned
 *      early and did nothing, for the rest of the page's life.
 *
 * The fix is for a page to be able to answer "am I stale?" at any moment. The
 * worker reports its build id (see `public/sw.js`); the page records the id it
 * loaded under and re-checks on every foreground, focus and bfcache restore.
 * If the worker in charge is a different build than the page was loaded from,
 * the page reloads itself. That covers all four paths above with one rule,
 * including ones we haven't thought of.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INSTALLED APP THEN STOPPED UPDATING ENTIRELY
 * ---------------------------------------------------------------------------
 *
 * The two safety valves added with that fix were both one-way. Neither could
 * ever reopen, so each one eventually latched shut and took the whole update
 * mechanism with it — silently, which is what made it hard to see: no prompt,
 * no reload, no error, just an app sitting on an old build forever while a
 * browser tab on the same machine updated normally.
 *
 *   1. THE RELOAD BUDGET NEVER RESET. Three staleness reloads per session,
 *      counted globally and never cleared — and a successful update spends one.
 *      A browser tab gets a fresh session per visit so it never noticed; an
 *      installed PWA is a single session that can live for weeks, so it hit the
 *      cap after three deploys and stopped moving. The budget is now per target
 *      build, so a new release always has room to land.
 *
 *   2. THE APPLY LATCH WAS CLEARED BY A TIMER ON A HIDDEN PAGE. The background
 *      apply runs precisely when the app is being backgrounded, and mobile
 *      browsers freeze timers in hidden pages, so the `setTimeout` meant to
 *      release the latch could simply never run. It is a timestamp now, checked
 *      when asked rather than cleared on a schedule.
 *
 * The rule both fixes follow: anything that can block an update must be able to
 * unblock itself without depending on the page staying awake.
 */

/** How often to ask the server whether a newer worker exists. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Don't re-check more than this often, however many events fire. */
const MIN_CHECK_GAP_MS = 60 * 1000;

/** How long to wait for the worker to answer "which build are you?". */
const BUILD_ID_TIMEOUT_MS = 2000;

/**
 * If a handover doesn't complete in this long, assume it isn't going to and
 * release the latch so the next attempt can try again.
 */
const APPLY_TIMEOUT_MS = 10 * 1000;

/**
 * Guards against a reload loop if the server itself is serving mixed builds.
 *
 * THE BUDGET IS PER TARGET BUILD, AND THAT IS THE WHOLE POINT. It used to be a
 * single counter that only ever went up and was never cleared, which quietly
 * killed updating altogether on exactly the copy of the app that needs it most:
 *
 *   - `sessionStorage` survives for as long as the page does, and an installed
 *     PWA is one long-lived page. Backgrounding it, locking the phone and
 *     reopening it days later is all the same session.
 *   - Every SUCCESSFUL update spent one of the three attempts, because landing
 *     on a new build is itself a staleness reload.
 *   - So after three deploys the counter was exhausted, `mayReloadForStaleness`
 *     returned false forever, and the app silently stopped moving off its build
 *     — no toast, no reload, no error. A browser tab kept working because each
 *     visit is a fresh session with a fresh counter.
 *
 * A loop is reloading again and again TOWARD THE SAME BUILD and still coming up
 * stale. A different build id is not a loop, it is the next release, and it
 * gets a full budget of its own.
 */
const RELOAD_GUARD_KEY = 'wandrlust:build-reload';
const RELOAD_GUARD_MS = 60 * 1000;
const RELOAD_MAX_ATTEMPTS = 3;

let lastCheck = 0;

/**
 * When the current handover started, or 0 if none is in flight.
 *
 * A timestamp rather than a boolean latch plus a `setTimeout`, because the
 * timeout was scheduled on a page that is by definition about to be
 * backgrounded — and mobile browsers freeze timers in hidden pages. A frozen
 * timeout left the latch stuck on, and a stuck latch made `applyUpdate` return
 * "yes, applying" while doing nothing at all, for the rest of the page's life.
 * That killed both the silent background apply and the user's own "Update now"
 * button. Comparing timestamps needs no timer to fire and cannot get stuck.
 */
let applyingSince = 0;

const applyInFlight = (): boolean =>
  applyingSince !== 0 && Date.now() - applyingSince < APPLY_TIMEOUT_MS;

/**
 * The build id of the worker that was in charge when this page loaded. Set
 * once, on the first successful reading, and never updated — the whole point
 * is to detect the page drifting away from it.
 */
let loadedBuildId: string | null = null;

/** A reload we owe but couldn't safely perform yet because the page is hidden. */
let reloadWhenVisible = false;

const checkNow = (registration: ServiceWorkerRegistration): void => {
  const now = Date.now();
  if (now - lastCheck < MIN_CHECK_GAP_MS) return;
  lastCheck = now;
  // Never throws into the caller: a failed check just means we try later.
  registration.update().catch(() => undefined);
};

/* ------------------------------------------------------------------ */
/* Build identity                                                      */
/* ------------------------------------------------------------------ */

/**
 * Ask a worker which build it is, over a private MessageChannel so the reply
 * can't be confused with any other worker message.
 *
 * Resolves `null` rather than rejecting on any problem — an older worker
 * predating this handshake simply never replies, and a version of the app that
 * can't identify itself must degrade to the previous behaviour, not break.
 */
const askBuildId = (worker: ServiceWorker): Promise<string | null> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const channel = new MessageChannel();
      const timer = setTimeout(() => finish(null), BUILD_ID_TIMEOUT_MS);
      channel.port1.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        const id = (event.data as { buildId?: unknown } | null)?.buildId;
        finish(typeof id === 'string' && id ? id : null);
      };
      worker.postMessage({ type: 'GET_BUILD_ID' }, [channel.port2]);
    } catch {
      finish(null);
    }
  });

/**
 * The worker currently answering for this page. Prefer the controller, but fall
 * back to the registration's active worker: on a cold PWA launch the controller
 * is briefly null even though a perfectly good worker is running.
 */
const answeringWorker = (
  registration: ServiceWorkerRegistration | null
): ServiceWorker | null =>
  navigator.serviceWorker.controller ?? registration?.active ?? null;

/**
 * Reload budget. Reloading because the page is stale is safe exactly once per
 * staleness; if reloading somehow doesn't fix it — a CDN mid-deploy serving two
 * builds, say — we must not spin. Capped by both frequency and total attempts,
 * and any storage failure fails open, because being stuck on a stale build is
 * the worse outcome.
 */
const mayReloadForStaleness = (targetBuildId: string): boolean => {
  try {
    const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
    const state = raw
      ? (JSON.parse(raw) as { at?: number; n?: number; target?: unknown })
      : null;
    const at = typeof state?.at === 'number' ? state.at : 0;
    // Attempts only count against the build we are trying to reach. A new
    // build id means a new release, so the count starts again from zero.
    const n =
      state?.target === targetBuildId && typeof state?.n === 'number' ? state.n : 0;

    if (n >= RELOAD_MAX_ATTEMPTS) return false;
    // Rate-limit repeat attempts at the SAME build only. On the first attempt
    // at a new one there is nothing to be looping on, and refusing it because
    // some earlier build reloaded half a minute ago is how a release gets
    // skipped entirely.
    if (n > 0 && Date.now() - at < RELOAD_GUARD_MS) return false;

    sessionStorage.setItem(
      RELOAD_GUARD_KEY,
      JSON.stringify({ at: Date.now(), n: n + 1, target: targetBuildId })
    );
    return true;
  } catch {
    return true;
  }
};

/**
 * Reload if the worker in charge is a different build than this page loaded
 * under — i.e. the page is running code that is no longer the current version.
 *
 * Only ever reloads a VISIBLE page. Reloading a hidden one is the unreliable
 * path that caused half of this bug in the first place; if we're hidden we note
 * the debt and settle it the moment the user looks at the app again.
 */
const reloadIfStale = async (
  registration: ServiceWorkerRegistration | null,
  knownBuildId?: string | null
): Promise<void> => {
  const worker = answeringWorker(registration);
  if (!worker) return;

  const current = knownBuildId ?? (await askBuildId(worker));
  // No answer: an old worker, or one too busy to reply. Nothing to conclude.
  if (!current) return;

  // First reading of this page's life. This is the baseline, not a mismatch —
  // on a first install there is no previous version to have drifted from.
  if (loadedBuildId === null) {
    loadedBuildId = current;
    return;
  }

  if (current === loadedBuildId) return;

  if (document.visibilityState !== 'visible') {
    reloadWhenVisible = true;
    return;
  }

  if (!mayReloadForStaleness(current)) return;
  window.location.reload();
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

  try {
    await registration.update();
  } catch {
    return null;
  } finally {
    // A manual check still counts as a check. Leaving `lastCheck` at 0 (as
    // this used to) meant the next automatic check was unthrottled too.
    lastCheck = Date.now();
  }

  // A user who just asked "am I up to date?" is also the ideal moment to catch
  // a page that has quietly drifted onto an old build.
  void reloadIfStale(registration);

  return registration.waiting && registration.active && registration.waiting !== registration.active
    ? registration
    : null;
};

/**
 * Hand control to the waiting worker and reload onto the new version.
 *
 * Safe to call more than once — the guard matters because `controllerchange`
 * can fire for reasons other than our own request. Unlike the previous version
 * the guard is not permanent: if the handover never completes, the latch is
 * released so the user's next attempt isn't silently swallowed.
 */
export const applyUpdate = (registration: ServiceWorkerRegistration): boolean => {
  if (applyInFlight()) return true;

  const waiting = registration.waiting;
  if (!waiting) {
    // Nothing waiting, but this page may still be the stale one — the worker
    // could have activated on its own while this page kept running old code.
    void reloadIfStale(registration);
    return false;
  }

  applyingSince = Date.now();

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => {
      // Reloading a hidden page is unreliable: mobile browsers may freeze or
      // discard it mid-navigation, and the user comes back to the old build.
      // Attempt it anyway — when it works the swap is invisible, which is the
      // nicest outcome — but record the debt so the staleness check on the next
      // foreground finishes the job if this didn't.
      reloadWhenVisible = true;
      window.location.reload();
    },
    { once: true }
  );

  waiting.postMessage('SKIP_WAITING');

  // The handover should take milliseconds. If it hasn't happened within
  // APPLY_TIMEOUT_MS it isn't going to, and `applyInFlight` will say so the
  // next time anyone asks — no timer has to survive a backgrounded page for
  // the mechanism to un-wedge itself.
  return true;
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

  /** Settle any reload we owed from while the page was hidden. */
  const settleDebt = () => {
    if (!reloadWhenVisible) return;
    reloadWhenVisible = false;
    void reloadIfStale(registration);
  };

  const onVisibility = () => {
    if (!registration || disposed) return;

    if (document.visibilityState === 'visible') {
      settleDebt();
      void reloadIfStale(registration);
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
    settleDebt();
    void reloadIfStale(registration);
    checkNow(registration);
    // Announce is a no-op when nothing is waiting; cheap to call here so the
    // toast appears the moment the user looks at the app after a deploy.
    announce();
  };

  /**
   * bfcache restores a page wholesale, running whatever code it had when it was
   * frozen. `persisted` is the only signal that this happened, and it is
   * precisely the case where the page is most likely to be stale.
   */
  const onPageShow = (event: PageTransitionEvent) => {
    if (!registration || disposed) return;
    if (event.persisted) {
      void reloadIfStale(registration);
      return;
    }
    onFocus();
  };

  /**
   * The worker announcing that it has taken over. This is the case a page
   * cannot otherwise detect: it is now being served by a build it did not load
   * from, and every open page gets this, not just the one that applied.
   */
  const onWorkerMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; buildId?: unknown } | null;
    if (data?.type !== 'BUILD_ACTIVATED') return;
    const buildId = typeof data.buildId === 'string' ? data.buildId : null;
    void reloadIfStale(registration, buildId);
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

      // Record which build is in charge before anything else can change it.
      // Everything downstream compares against this.
      await reloadIfStale(registration);
      if (disposed) return;

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
      window.addEventListener('pageshow', onPageShow);
      navigator.serviceWorker.addEventListener('message', onWorkerMessage);
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
    window.removeEventListener('pageshow', onPageShow);
    navigator.serviceWorker.removeEventListener('message', onWorkerMessage);
  };
};
