/**
 * Move a stranded install back onto the real address.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * The app answers on five hostnames. Four of them are historical, and
 * `vercel.json` redirects a page load from any of them to wandrlust.dev — so a
 * browser visiting an old address ends up in the right place and nothing looks
 * wrong.
 *
 * A HOME-SCREEN INSTALL DOES NOT GET THAT FAR. The manifest's `start_url` is
 * relative, so an app installed from `wandrlust-topaz.vercel.app` launches
 * there forever, and the service worker then serves the shell from that
 * origin's own cache without a navigation the redirect could catch. The app
 * opens, looks completely normal, and is running on an origin where
 * `localStorage` — and therefore the entire Supabase session — belongs to a
 * different site. Signing in on wandrlust.dev does nothing for it.
 *
 * Everything still LOOKED fine because almost nothing needs the session to
 * reach our own server: the browser talks to Supabase directly. Beacon is the
 * one route that sends the camper's token to `/api`, so Beacon was the only
 * thing that broke, and it broke permanently, and the only visible symptom was
 * "sign in to send out a beacon" shown to somebody already signed in.
 * Production logs settled it — seven refusals in eight seconds, every one
 * `host=wandrlust-topaz.vercel.app`, no Authorization header on any of them.
 *
 * WHY THE SERVICE WORKER IS TORN DOWN FIRST. Leaving it registered leaves a
 * cache on the old origin that can keep serving that shell, which is what made
 * this survive every previous attempt to fix it. Unregistering, then clearing
 * that origin's caches, then leaving, is what makes the move stick.
 *
 * The list is deliberately EXACT rather than "anything that is not
 * wandrlust.dev". Vercel's per-deployment preview URLs are legitimate places
 * to open the app, localhost is where it is developed, and bouncing either
 * would trade this bug for a worse one.
 */

/** The historical hostnames, matching the redirects in `vercel.json`. */
const STRANDED_HOSTS = new Set([
  'www.wandrlust.dev',
  'wandrlust-topaz.vercel.app',
  'wandrlust-blofstedts-projects.vercel.app',
  'wandrlust-git-main-blofstedts-projects.vercel.app'
]);

const CANONICAL_ORIGIN = 'https://wandrlust.dev';

/**
 * True when this document is running somewhere its sign-in can never work.
 *
 * Exported so the caller reads as a sentence and so this is testable without
 * a browser navigation.
 */
export const isStrandedHost = (hostname: string): boolean =>
  STRANDED_HOSTS.has(hostname.toLowerCase());

/**
 * Send this document to the canonical origin, taking its path with it.
 *
 * Returns `true` when it is leaving, so the caller can stop before mounting
 * an app that is about to be replaced. Everything here is best-effort: a
 * browser that refuses to unregister a worker still gets redirected, because
 * being on the right origin matters more than the cleanup.
 */
export const leaveStrandedHost = (): boolean => {
  if (typeof window === 'undefined' || !isStrandedHost(window.location.hostname)) {
    return false;
  }

  const target =
    CANONICAL_ORIGIN + window.location.pathname + window.location.search + window.location.hash;

  void (async () => {
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((registrations ?? []).map((r) => r.unregister()));
    } catch {
      // No worker, or the browser would not say. The redirect still stands.
    }
    try {
      const names = await caches?.keys?.();
      await Promise.all((names ?? []).map((n) => caches.delete(n)));
    } catch {
      // Same: the stale cache outliving us is better than not leaving at all.
    }
    // `replace`, not `assign` — the old address must not sit in history where
    // a back gesture would land the camper straight back on it.
    window.location.replace(target);
  })();

  return true;
};
