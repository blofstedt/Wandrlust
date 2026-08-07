/* eslint-disable no-restricted-globals */
/**
 * Wandrlust service worker.
 *
 * Two jobs: Web Push delivery, and making the app installable and launchable
 * without a signal.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NOW A CACHE HERE, WHEN THERE DELIBERATELY WASN'T
 * ---------------------------------------------------------------------------
 * This worker used to refuse to cache anything, on the grounds that a second
 * cache layer is a reliable way to ship stale JavaScript. That risk is real,
 * but it comes from one specific mistake: serving a cached HTML document, or
 * caching JS at a URL whose contents can change. Neither happens here.
 *
 *   - The HTML document is always fetched network-first. A new deploy is
 *     picked up on the next load, every time. The cache is only ever the
 *     fallback for when the network genuinely isn't there.
 *   - Everything under /assets/ is content-hashed by Vite. A changed file is
 *     a different filename, so a cached asset can never be a stale version of
 *     a current one — it is either current or unreferenced.
 *
 * The reason this is worth doing at all: the app's headline feature is
 * offline maps for places with no cell service, but those tiles live in
 * IndexedDB behind the app shell. With nothing cached, opening the app with
 * no signal got you a browser error page and no way to reach the maps you'd
 * already downloaded. The tiles were only reachable if you'd left the tab
 * open before losing signal.
 *
 * WHAT IS DELIBERATELY NOT CACHED:
 *   - /api/* — boundary, weather and alert data. Stale hazard information is
 *     worse than none. These must fail honestly so the UI can say so.
 *   - Anything cross-origin, especially map tiles. The app has its own
 *     explicit offline-region download, and a silent second tile cache would
 *     make coverage look better than the app knows it to be.
 *
 * Lifecycle: a new worker installs and then WAITS rather than taking over
 * mid-session, so a running page can't end up half-updated. The app notices
 * the waiting worker and offers to apply it; if the user ignores that, it
 * activates on the next cold start anyway.
 */

/**
 * Replaced at build time (see the pwa-build-stamp plugin in vite.config.ts).
 *
 * This matters more than it looks: browsers only treat a worker as "new" if
 * the bytes of this file changed. Without a per-build stamp in here, deploying
 * new app code would never trigger an update notification.
 */
const BUILD_ID = '__BUILD_ID__';
const PRECACHE_ASSETS = ['__PRECACHE_ASSETS__'];

const CACHE_NAME = `wandrlust-shell-${BUILD_ID}`;

/** The document itself, plus the things needed to render a first frame. */
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Unreplaced build placeholders are filtered out, so this file stays
      // valid and harmless when served straight from public/ in development.
      const urls = [...SHELL_URLS, ...PRECACHE_ASSETS.filter((u) => u.startsWith('/'))];

      // One missing file must not fail the whole install and leave the app
      // with no worker at all.
      await Promise.all(
        urls.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
        )
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('wandrlust-shell-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

/** The app asks for this when the user accepts an update. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

const isAsset = (url) => url.pathname.startsWith('/assets/');

/* ------------------------------------------------------------------ */
/* Map tiles                                                           */
/* ------------------------------------------------------------------ */

/**
 * A bounded cache of map imagery, so panning back over ground you've already
 * covered doesn't re-download it and flash empty.
 *
 * THIS IS NOT THE OFFLINE MAPS FEATURE, and it must never be mistaken for it.
 * Offline mode reads explicitly downloaded regions out of IndexedDB through a
 * separate tile layer and shows a blank placeholder for anything missing — it
 * does not consult this cache at all. So nothing here can make the offline
 * manager claim coverage the user never downloaded. This only makes the online
 * map feel less like it is rebuilding itself constantly.
 *
 * Capped by entry count. Tile imagery is fetched by <img>, which makes the
 * responses opaque — their real size is invisible to us and browsers pad them
 * heavily against the storage quota, so an unbounded cache here would quietly
 * eat a phone's allowance.
 */
const TILE_CACHE = 'wandrlust-tiles';
const TILE_CACHE_MAX = 400;
/** Trimming walks the whole key list, so do it occasionally, not per tile. */
const TILE_TRIM_EVERY = 40;

const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'tiles.mapbox.com'
];

const isTile = (url) => TILE_HOSTS.some((host) => url.hostname.endsWith(host));

let tilePutCount = 0;

const trimTileCache = async () => {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - TILE_CACHE_MAX;
  // Cache API preserves insertion order, so the front of the list is oldest.
  if (excess > 0) await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
};

const cacheTile = async (request, response) => {
  // An opaque response has status 0 and we cannot see whether it succeeded;
  // anything we CAN read must have actually worked before we keep it.
  if (response.type !== 'opaque' && !response.ok) return;

  const cache = await caches.open(TILE_CACHE);
  await cache.put(request, response);

  tilePutCount += 1;
  if (tilePutCount % TILE_TRIM_EVERY === 0) await trimTileCache();
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Map imagery. Cache-first: a given z/x/y is the same picture every time, so
  // a hit is always correct and always beats a round trip.
  if (isTile(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            // Clone before the browser consumes the body for the <img>.
            const copy = response.clone();
            event.waitUntil(cacheTile(request, copy).catch(() => undefined));
            return response;
          })
      )
    );
    return;
  }

  // Anything else on someone else's server — fonts, Supabase. Not ours.
  if (url.origin !== self.location.origin) return;

  // Live data. Must reach the network or fail visibly.
  if (url.pathname.startsWith('/api/')) return;

  // Content-hashed and therefore immutable: cache-first is safe here, and it
  // is what makes a cold start offline instant rather than impossible.
  if (isAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  // The document. Network-first, always — this is what guarantees a deploy is
  // picked up rather than a stale shell being served forever.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put('/', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) || Response.error())
    );
    return;
  }

  // Icons, the manifest, the legal markdown. Serve what we have and refresh
  // it quietly in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

/**
 * Visual treatment per hazard family. Fire and flood get `requireInteraction`
 * so they stay on screen until acknowledged — a storm warning you swiped away
 * while driving is a storm warning you never read.
 */
const FAMILY = {
  fire: { icon: '/icons/alert-fire.png', badge: '/icons/badge.png', urgent: true },
  flood: { icon: '/icons/alert-flood.png', badge: '/icons/badge.png', urgent: true },
  storm: { icon: '/icons/alert-storm.png', badge: '/icons/badge.png', urgent: true },
  winter: { icon: '/icons/alert-winter.png', badge: '/icons/badge.png', urgent: false },
  heat: { icon: '/icons/alert-heat.png', badge: '/icons/badge.png', urgent: false },
  wind: { icon: '/icons/alert-wind.png', badge: '/icons/badge.png', urgent: false },
  zone_heat: { icon: '/icons/alert-zone.png', badge: '/icons/badge.png', urgent: false },
  booking: { icon: '/icons/booking.png', badge: '/icons/badge.png', urgent: false },
  hazard: { icon: '/icons/hazard.png', badge: '/icons/badge.png', urgent: false },
  default: { icon: '/icons/icon-192.png', badge: '/icons/badge.png', urgent: false }
};

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Wandrlust', body: event.data ? event.data.text() : '' };
  }

  const family = payload.family || 'default';
  const style = FAMILY[family] || FAMILY.default;

  const title = payload.title || 'Wandrlust alert';
  const options = {
    body: payload.body || '',
    icon: style.icon,
    badge: style.badge,
    tag: payload.tag || `${family}-${payload.id || Date.now()}`,
    // Replace an existing notification with the same tag rather than stacking
    // five flood warnings for the same river.
    renotify: Boolean(payload.renotify),
    requireInteraction: style.urgent,
    timestamp: payload.timestamp || Date.now(),
    data: {
      url: payload.url || '/',
      id: payload.id || null,
      family,
      lat: payload.lat ?? null,
      lon: payload.lon ?? null
    },
    actions: payload.actions || [
      { action: 'open', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  // Vibration is Android-only and ignored elsewhere.
  if (style.urgent) options.vibrate = [80, 60, 80, 60, 120];

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const data = event.notification.data || {};
  let target = data.url || '/';

  // Deep link to the alert's location so tapping a fire warning puts you on
  // the map where it applies, not on the default view.
  if (data.lat != null && data.lon != null) {
    const sep = target.includes('?') ? '&' : '?';
    target = `${target}${sep}lat=${data.lat}&lon=${data.lon}`;
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Reuse an open tab if there is one; don't pile up windows.
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) client.navigate(target);
            return;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

/**
 * Browsers rotate push subscriptions periodically. Without handling this the
 * user silently stops receiving alerts, which for a safety feature is the
 * worst possible failure mode: it looks like everything is fine.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
        const fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });

        await fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldEndpoint: event.oldSubscription?.endpoint ?? null,
            subscription: fresh.toJSON()
          })
        });
      } catch (err) {
        // Nothing useful to do here; the client re-registers on next launch.
      }
    })()
  );
});