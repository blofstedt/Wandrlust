/**
 * Web Push delivery.
 *
 *   GET  /api/push/status        is push configured on this deployment
 *   POST /api/push/resubscribe   service worker renewed a rotated subscription
 *   POST /api/push/test          send yourself one (auth required)
 *   POST /api/push/dispatch      fan out queued alerts (shared secret required)
 *
 * Requires `web-push` and VAPID keys:
 *
 *   npm install web-push
 *   npm run vapid
 *
 * DESIGN NOTE
 *
 * Delivery is queue-driven, not fire-and-forget. `notification_queue` rows are
 * written by the alert matcher (SQL, migration 05) and drained here. That
 * separation means a push provider outage delays alerts rather than losing
 * them, and it gives us an audit trail of what was sent to whom — which you
 * want the first time somebody says "I never got the fire warning".
 */
import type { Express, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const VAPID_PUBLIC = process.env.VITE_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:alerts@example.com';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin =
  SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;

/**
 * `web-push` is optional — the app runs fine without push configured.
 *
 * This used to be a bare `require('web-push')`. The project is ESM
 * ("type": "module"), so `require` is not defined, the try/catch swallowed the
 * ReferenceError, and push silently never worked even when the package WAS
 * installed. A dynamic import works in both dev (tsx) and the bundled build.
 */
let webpush: any = null;
let loading: Promise<void> | null = null;

const loadWebPush = async (): Promise<void> => {
  if (webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!loading) {
    loading = (async () => {
      try {
        const mod: any = await import('web-push');
        webpush = mod?.default ?? mod;
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      } catch {
        webpush = null;
        console.warn('Push disabled: `npm install web-push` to enable notifications.');
      }
    })();
  }
  await loading;
};

const isPushReady = async (): Promise<boolean> => {
  await loadWebPush();
  return Boolean(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
};

export interface PushPayload {
  title: string;
  body: string;
  family?: string;
  url?: string;
  id?: string;
  tag?: string;
  lat?: number;
  lon?: number;
  renotify?: boolean;
}

interface SubscriptionRow {
  id: number;
  user_id?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

const SUBSCRIPTION_COLUMNS = 'id, user_id, endpoint, p256dh, auth, failure_count';

/**
 * Send to one subscription.
 *
 * 404/410 mean the browser has permanently discarded the subscription — we
 * delete it immediately rather than retrying forever against a dead endpoint.
 */
const sendOne = async (
  sub: SubscriptionRow,
  payload: PushPayload
): Promise<{ ok: boolean; gone: boolean; error?: string }> => {
  if (!(await isPushReady())) return { ok: false, gone: false, error: 'push not configured' };

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600, urgency: payload.family === 'fire' ? 'high' : 'normal' }
    );
    return { ok: true, gone: false };
  } catch (err: any) {
    const status = err?.statusCode;
    return {
      ok: false,
      gone: status === 404 || status === 410,
      error: err?.message ?? 'send failed'
    };
  }
};

const markSubscriptionResult = async (
  sub: SubscriptionRow,
  result: { ok: boolean; gone: boolean }
): Promise<void> => {
  if (!admin) return;

  if (result.gone) {
    await admin.from('push_subscriptions').delete().eq('id', sub.id);
    return;
  }

  if (result.ok) {
    await admin
      .from('push_subscriptions')
      .update({ last_seen_at: new Date().toISOString(), failure_count: 0 })
      .eq('id', sub.id);
    return;
  }

  const failures = (sub.failure_count ?? 0) + 1;
  if (failures >= 5) {
    // Five consecutive failures: assume it's dead rather than hammering it.
    await admin.from('push_subscriptions').delete().eq('id', sub.id);
  } else {
    await admin.from('push_subscriptions').update({ failure_count: failures }).eq('id', sub.id);
  }
};

export const registerPushRoutes = (app: Express): void => {
  app.get('/api/push/status', async (_req: Request, res: Response) => {
    const configured = await isPushReady();
    res.json({
      configured,
      hasWebPushLib: Boolean(webpush),
      hasKeys: Boolean(VAPID_PUBLIC && VAPID_PRIVATE),
      publicKey: VAPID_PUBLIC ?? null
    });
  });

  /** Service worker calls this after the browser rotates a subscription. */
  app.post('/api/push/resubscribe', async (req: Request, res: Response) => {
    if (!admin) return res.status(503).json({ error: 'database not configured' });

    const { oldEndpoint, subscription } = req.body ?? {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }

    // Carry the user across from the old row; the service worker has no session.
    let userId: string | null = null;
    if (oldEndpoint) {
      const { data } = await admin
        .from('push_subscriptions')
        .select('user_id')
        .eq('endpoint', oldEndpoint)
        .maybeSingle();
      userId = data?.user_id ?? null;

      // Only drop the old row once we know who it belonged to, otherwise a
      // failed lookup orphans the subscription entirely.
      if (userId) await admin.from('push_subscriptions').delete().eq('endpoint', oldEndpoint);
    }

    if (!userId) return res.status(202).json({ ok: false, reason: 'unknown previous endpoint' });

    await admin.from('push_subscriptions').upsert(
      {
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        last_seen_at: new Date().toISOString(),
        failure_count: 0
      },
      { onConflict: 'endpoint' }
    );

    return res.json({ ok: true });
  });

  /** Send a test notification to the caller's own devices. */
  app.post('/api/push/test', async (req: Request, res: Response) => {
    if (!(await isPushReady())) return res.status(503).json({ error: 'push not configured' });
    if (!admin) return res.status(503).json({ error: 'database not configured' });

    const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (!token) return res.status(401).json({ error: 'authentication required' });

    const { data: userData, error: authError } = await admin.auth.getUser(token);
    if (authError || !userData?.user) return res.status(401).json({ error: 'invalid session' });

    const { data: subs } = await admin
      .from('push_subscriptions')
      .select(SUBSCRIPTION_COLUMNS)
      .eq('user_id', userData.user.id);

    if (!subs || subs.length === 0) return res.status(404).json({ error: 'no registered devices' });

    let sent = 0;
    for (const sub of subs as SubscriptionRow[]) {
      const result = await sendOne(sub, {
        title: 'Wandrlust alerts are working',
        body: 'This is a test. Real fire, flood and storm alerts look like this.',
        family: 'default',
        url: '/'
      });
      await markSubscriptionResult(sub, result);
      if (result.ok) sent += 1;
    }

    return res.json({ ok: sent > 0, sent, devices: subs.length });
  });

  /**
   * Drain the notification queue.
   *
   * Call from a scheduler every few minutes. Protected by a shared secret,
   * since it can send to every user.
   */
  app.post('/api/push/dispatch', async (req: Request, res: Response) => {
    if (!(await isPushReady())) return res.status(503).json({ error: 'push not configured' });
    if (!admin) return res.status(503).json({ error: 'database not configured' });

    const secret = req.headers['x-dispatch-secret'];
    if (!process.env.PUSH_DISPATCH_SECRET || secret !== process.env.PUSH_DISPATCH_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const batchSize = Math.min(Number(req.query.limit) || 200, 500);

    const { data: queued } = await admin
      .from('notification_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (!queued || queued.length === 0) return res.json({ ok: true, processed: 0, sent: 0 });

    // One query for every device in the batch, instead of one query per queued
    // notification. A 200-item batch went from 200 round trips to 1.
    const userIds = Array.from(new Set((queued as any[]).map((item) => item.user_id)));
    const { data: allSubs } = await admin
      .from('push_subscriptions')
      .select(SUBSCRIPTION_COLUMNS)
      .in('user_id', userIds);

    const subsByUser = new Map<string, SubscriptionRow[]>();
    (allSubs as SubscriptionRow[] | null)?.forEach((sub) => {
      if (!sub.user_id) return;
      const list = subsByUser.get(sub.user_id) ?? [];
      list.push(sub);
      subsByUser.set(sub.user_id, list);
    });

    const now = new Date().toISOString();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of queued as any[]) {
      const subs = subsByUser.get(item.user_id) ?? [];

      if (subs.length === 0) {
        await admin
          .from('notification_queue')
          .update({ status: 'skipped', processed_at: now, note: 'no devices' })
          .eq('id', item.id);
        skipped += 1;
        continue;
      }

      let anySent = false;
      for (const sub of subs) {
        const result = await sendOne(sub, {
          title: item.title,
          body: item.body,
          family: item.family,
          url: item.url ?? '/',
          id: String(item.id),
          tag: item.tag ?? `${item.family}-${item.id}`,
          lat: item.lat ?? undefined,
          lon: item.lon ?? undefined
        });
        await markSubscriptionResult(sub, result);
        if (result.ok) anySent = true;
      }

      await admin
        .from('notification_queue')
        .update({ status: anySent ? 'sent' : 'failed', processed_at: now })
        .eq('id', item.id);

      if (anySent) sent += 1;
      else failed += 1;
    }

    return res.json({ ok: true, processed: queued.length, sent, failed, skipped });
  });
};