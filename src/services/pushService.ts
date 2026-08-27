import { upsertPushSubscription, removePushSubscription, updateAlertLocation as saveAlertLocation } from './dataService';

/**
 * Web Push subscription management.
 *
 * PERMISSION ETIQUETTE
 *
 * We never call `Notification.requestPermission()` on page load. A cold
 * permission prompt gets denied ~90% of the time, and a denial is permanent
 * until the user digs into browser settings — so a badly-timed prompt
 * permanently disables safety alerts for that person.
 *
 * `canPrompt()` exists so the UI can explain the value first and only then
 * ask, triggered by an explicit user gesture.
 *
 * PLATFORM REALITY
 *
 * iOS Safari only supports Web Push for apps installed to the Home Screen
 * (16.4+). `getPushSupport()` reports that distinctly so the UI can tell an
 * iPhone user to install the app rather than showing a button that silently
 * fails.
 */

export type PushSupport =
  | 'supported'
  | 'unsupported'
  | 'ios-needs-install'
  | 'insecure-context';

export interface PushStatus {
  support: PushSupport;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

const isIos = (): boolean =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  // iPadOS 13+ reports as Mac; touch points disambiguate.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // Non-standard iOS property.
  (navigator as any).standalone === true;

export const getPushSupport = (): PushSupport => {
  if (typeof window === 'undefined') return 'unsupported';
  // Push requires a secure context. localhost counts as secure.
  if (!window.isSecureContext) return 'insecure-context';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window)) {
    return isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  }
  if (isIos() && !isStandalone()) return 'ios-needs-install';
  return 'supported';
};

export const getPushStatus = async (): Promise<PushStatus> => {
  const support = getPushSupport();
  if (support !== 'supported') {
    return { support, permission: 'unsupported', subscribed: false };
  }

  const permission = Notification.permission;
  let subscribed = false;

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    subscribed = Boolean(sub);
  } catch {
    subscribed = false;
  }

  return { support, permission, subscribed };
};

/** True when it is safe to show a "turn on alerts" prompt. */
export const canPrompt = (): boolean =>
  getPushSupport() === 'supported' && Notification.permission === 'default';

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
};

/**
 * VAPID keys are base64url; the subscribe API wants a BufferSource.
 *
 * We allocate an explicit ArrayBuffer rather than letting Uint8Array infer
 * ArrayBufferLike — the DOM types require a plain ArrayBuffer, and a
 * SharedArrayBuffer-backed view is rejected.
 */
const urlBase64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalised);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

export interface SubscribeResult {
  ok: boolean;
  message: string;
  status: PushStatus;
}

/**
 * Ask for permission and register a push subscription.
 * MUST be called from a user gesture — browsers block it otherwise.
 */
export const subscribeToPush = async (): Promise<SubscribeResult> => {
  const support = getPushSupport();

  if (support === 'ios-needs-install') {
    return {
      ok: false,
      message:
        'On iPhone and iPad, add Wandrlust to your Home Screen first — Safari only delivers alerts to installed apps.',
      status: await getPushStatus()
    };
  }
  if (support === 'insecure-context') {
    return {
      ok: false,
      message: 'Alerts need a secure (HTTPS) connection.',
      status: await getPushStatus()
    };
  }
  if (support === 'unsupported') {
    return {
      ok: false,
      message: 'This browser does not support push notifications.',
      status: await getPushStatus()
    };
  }

  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    return {
      ok: false,
      message: 'Push is not configured on this deployment (missing VAPID key).',
      status: await getPushStatus()
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      message:
        permission === 'denied'
          ? 'Alerts are blocked. You can re-enable them in your browser’s site settings.'
          : 'Alerts were not enabled.',
      status: await getPushStatus()
    };
  }

  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!reg) {
    return {
      ok: false,
      message: 'Could not start the background service.',
      status: await getPushStatus()
    };
  }

  await navigator.serviceWorker.ready;

  try {
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        // Required by Chrome: every push must produce a visible notification.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      }));

    const saved = await persistSubscription(subscription);
    if (!saved.ok) return { ...saved, status: await getPushStatus() };

    return {
      ok: true,
      message: 'Alerts are on.',
      status: await getPushStatus()
    };
  } catch (err: any) {
    return {
      ok: false,
      message: err?.message ?? 'Could not register for alerts.',
      status: await getPushStatus()
    };
  }
};

export const unsubscribeFromPush = async (): Promise<SubscribeResult> => {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();

    if (sub) {
      await removeSubscription(sub.endpoint);
      await sub.unsubscribe();
    }

    return { ok: true, message: 'Alerts are off.', status: await getPushStatus() };
  } catch (err: any) {
    return {
      ok: false,
      message: err?.message ?? 'Could not turn alerts off.',
      status: await getPushStatus()
    };
  }
};

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

const persistSubscription = async (
  subscription: PushSubscription
): Promise<{ ok: boolean; message: string }> => {
  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, message: 'Browser returned an incomplete subscription' };
  }

  const result = await upsertPushSubscription({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    userAgent: navigator.userAgent.slice(0, 300)
  });

  return { ok: result.ok, message: result.ok ? 'Subscribed' : result.message };
};

const removeSubscription = async (endpoint: string): Promise<void> => {
  await removePushSubscription(endpoint);
};

/**
 * Keep the server's idea of where you are roughly current, so location-scoped
 * alerts can be targeted without the server tracking you continuously.
 *
 * Coordinates are rounded to ~1 km before they leave the device. That is
 * plenty for "is this fire warning near you" and useless for following anyone
 * around.
 */
export const updateAlertLocation = async (
  lat: number,
  lon: number
): Promise<void> => {
  const coarseLat = Math.round(lat * 100) / 100;
  const coarseLon = Math.round(lon * 100) / 100;
  await saveAlertLocation(coarseLat, coarseLon);
};

/** Local test notification — verifies the SW without a server round trip. */
export const sendTestNotification = async (): Promise<boolean> => {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || Notification.permission !== 'granted') return false;
    await reg.showNotification('Wandrlust alerts are working', {
      body: 'This is a test. Real alerts look like this.',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: 'wandrlust-test'
    });
    return true;
  } catch {
    return false;
  }
};