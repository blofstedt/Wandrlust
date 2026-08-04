/* eslint-disable no-restricted-globals */
/**
 * Wandrlust service worker.
 *
 * Handles Web Push delivery and notification interaction. Deliberately does
 * NOT do offline asset caching — the app already manages its own offline map
 * tiles in IndexedDB, and a second, competing cache layer is a reliable way
 * to ship stale JavaScript to users.
 *
 * Lifecycle note: `skipWaiting` + `clients.claim` means a new worker takes
 * over immediately rather than waiting for every tab to close. For a safety
 * app that matters — you don't want someone receiving fire alerts from a
 * three-versions-old worker.
 */

const SW_VERSION = 'wandrlust-sw-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
