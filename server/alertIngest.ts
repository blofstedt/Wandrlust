/**
 * The connection to the authorities.
 *
 *   GET  /api/alerts/status     is the feed live, when did it last sync
 *   POST /api/alerts/ingest     run one cycle now (shared secret required)
 *
 * WHAT THIS FIXES
 *
 * Migration 05 shipped a complete push pipeline: `queue_weather_alerts()`
 * matches live alert polygons against each camper's coarse location and their
 * fire/flood/storm preferences, writes `notification_queue` rows, and
 * /api/push/dispatch drains them to devices.
 *
 * Nothing ever wrote to `weather_alerts`. The matcher ran every ten minutes
 * against an empty table and matched nothing, so no camper has ever been
 * pushed a fire warning. This module is the missing half: it polls the NWS
 * and Environment Canada feeds, upserts what they publish, and then runs the
 * matcher and the dispatcher.
 *
 * DESIGN NOTES
 *
 *  - The agencies are authoritative, always. We cache what they publish and
 *    hand it back with their name on it. We never re-word a warning, never
 *    upgrade a severity, and never invent an alert.
 *  - Ingest is idempotent. Alerts are upserted on their agency id, so a
 *    re-run refreshes rather than duplicates.
 *  - A feed being unreachable is recorded as an outage and reported to the
 *    client. Silence from a broken feed must never render as "all clear".
 *  - Runs in-process on a timer so a deployment needs no external cron. The
 *    POST endpoint is there for a scheduler that would rather drive it.
 */
import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// `.js` is required under strict ESM on Vercel. See weatherRoutes.ts.
import {
  fetchNwsActiveAlerts, fetchEcccActiveAlerts, type NormalisedAlert
} from './alertSources.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISPATCH_SECRET = process.env.PUSH_DISPATCH_SECRET;

/** How often the in-process timer runs. Ten minutes matches the SQL matcher. */
const INGEST_INTERVAL_MS = Number(process.env.ALERT_INGEST_INTERVAL_MS ?? 10 * 60 * 1000);

const admin: SupabaseClient | null =
  SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;

export interface FeedResult {
  /** 'ok' | 'unreachable' | 'skipped' */
  state: 'ok' | 'unreachable' | 'skipped';
  received: number;
  stored: number;
}

export interface IngestReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  feeds: Record<'nws' | 'eccc', FeedResult>;
  queued: number | null;
  dispatched: number | null;
  purged: number | null;
  error: string | null;
}

let lastReport: IngestReport | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

/**
 * The agencies whose feeds this app reads.
 *
 * Surfaced to the client so a camper can see exactly who is behind the
 * warnings, and follow the link to the source when it matters.
 */
export const ALERT_AUTHORITIES = [
  {
    id: 'nws',
    name: 'US National Weather Service',
    scope: 'United States',
    covers: 'Red flag and fire weather, flood and flash flood, severe storms, winter, heat and wind.',
    url: 'https://www.weather.gov/'
  },
  {
    id: 'eccc',
    name: 'Environment and Climate Change Canada',
    scope: 'Canada',
    covers: 'Warnings, watches and advisories published through the ECCC public alert feed.',
    url: 'https://weather.gc.ca/warnings/index_e.html'
  }
] as const;

/**
 * A geometry the `weather_alerts` table will accept.
 *
 * The column is geometry(MultiPolygon, 4326), and PostGIS geometry input
 * parses WKT/EWKT — NOT GeoJSON. Handing PostgREST a GeoJSON object fails the
 * insert, so alerts are converted to EWKT the same way the rest of this
 * codebase writes geometry.
 *
 * NWS sends Polygon or MultiPolygon; anything else (a point, a line, nothing
 * at all) is stored without geometry rather than coerced into a shape the
 * agency did not draw. An alert with no polygon still lists — it just cannot
 * be matched against a location, which is the honest outcome.
 */
const ring = (coords: any[]): string | null => {
  if (!Array.isArray(coords) || coords.length < 4) return null;

  const pts = coords.filter(
    (c) => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
  );
  if (pts.length < 4) return null;

  // PostGIS requires closed rings. GeoJSON should already be closed; a feed
  // that forgets is repaired rather than dropped.
  const first = pts[0];
  const last = pts[pts.length - 1];
  const closed = first[0] === last[0] && first[1] === last[1] ? pts : [...pts, first];

  return `(${closed.map((c) => `${c[0].toFixed(6)} ${c[1].toFixed(6)}`).join(', ')})`;
};

const polygon = (rings: any[]): string | null => {
  if (!Array.isArray(rings)) return null;
  const parts = rings.map(ring).filter((r): r is string => r !== null);
  return parts.length > 0 ? `(${parts.join(', ')})` : null;
};

export const toMultiPolygonEwkt = (geometry: any): string | null => {
  if (!geometry?.type || !Array.isArray(geometry.coordinates)) return null;

  const polygons =
    geometry.type === 'MultiPolygon' ? geometry.coordinates
    : geometry.type === 'Polygon' ? [geometry.coordinates]
    : null;
  if (!polygons) return null;

  const parts = polygons.map(polygon).filter((p: string | null): p is string => p !== null);
  if (parts.length === 0) return null;

  return `SRID=4326;MULTIPOLYGON(${parts.join(', ')})`;
};

/** Severities the DB enum accepts. ECCC's derived values map straight across. */
const DB_SEVERITIES = new Set(['extreme', 'severe', 'moderate', 'minor', 'unknown']);

const toRow = (alert: NormalisedAlert) => ({
  id: alert.id,
  family: alert.family,
  event: alert.event,
  headline: alert.headline || alert.event,
  description: alert.description || null,
  instruction: alert.instruction,
  severity: DB_SEVERITIES.has(String(alert.severity)) ? String(alert.severity) : 'unknown',
  urgency: alert.urgency ?? null,
  area_description: alert.areaDescription || null,
  sender: alert.sender || null,
  geom: toMultiPolygonEwkt(alert.geometry),
  effective: alert.effective,
  expires: alert.expires,
  source: alert.source,
  fetched_at: new Date().toISOString()
});

const storeAlerts = async (client: SupabaseClient, alerts: NormalisedAlert[]): Promise<number> => {
  if (alerts.length === 0) return 0;

  // De-duplicate within the batch: upsert rejects a payload that names the
  // same primary key twice.
  const byId = new Map<string, ReturnType<typeof toRow>>();
  for (const alert of alerts) byId.set(alert.id, toRow(alert));
  const rows = [...byId.values()];

  let stored = 0;
  // Chunked so one oversized request cannot fail the whole cycle.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await client.from('weather_alerts').upsert(chunk, { onConflict: 'id' });
    if (error) {
      console.warn('[alerts] upsert failed:', error.message);
      continue;
    }
    stored += chunk.length;
  }
  return stored;
};

/**
 * Ask the dispatcher to drain whatever the matcher just queued.
 *
 * Best-effort by design: alerts are already stored and queued at this point,
 * so a dispatch failure delays delivery rather than losing it — the next
 * cycle picks the same rows up again.
 */
const dispatchQueued = async (baseUrl: string): Promise<number | null> => {
  if (!DISPATCH_SECRET) return null;
  try {
    const res = await fetch(`${baseUrl}/api/push/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DISPATCH_SECRET}`
      }
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return typeof body?.sent === 'number' ? body.sent : null;
  } catch {
    return null;
  }
};

/** One full cycle: poll both agencies, store, match, dispatch, purge. */
export const runIngest = async (baseUrl: string): Promise<IngestReport> => {
  const startedAt = new Date().toISOString();

  const report: IngestReport = {
    startedAt,
    finishedAt: startedAt,
    ok: false,
    feeds: {
      nws: { state: 'skipped', received: 0, stored: 0 },
      eccc: { state: 'skipped', received: 0, stored: 0 }
    },
    queued: null,
    dispatched: null,
    purged: null,
    error: null
  };

  if (!admin) {
    report.error = 'Supabase service role not configured; alerts cannot be stored.';
    report.finishedAt = new Date().toISOString();
    lastReport = report;
    return report;
  }

  if (running) {
    report.error = 'An ingest cycle is already running.';
    report.finishedAt = new Date().toISOString();
    return report;
  }
  running = true;

  try {
    const [nws, eccc] = await Promise.all([fetchNwsActiveAlerts(), fetchEcccActiveAlerts()]);

    if (nws === null) {
      report.feeds.nws = { state: 'unreachable', received: 0, stored: 0 };
    } else {
      report.feeds.nws = { state: 'ok', received: nws.length, stored: await storeAlerts(admin, nws) };
    }

    if (eccc === null) {
      report.feeds.eccc = { state: 'unreachable', received: 0, stored: 0 };
    } else {
      report.feeds.eccc = { state: 'ok', received: eccc.length, stored: await storeAlerts(admin, eccc) };
    }

    // Drop what the agencies have let expire before matching, so nobody is
    // notified about a warning that has already been lifted.
    const { data: purged } = await admin.rpc('purge_expired_alerts');
    report.purged = typeof purged === 'number' ? purged : null;

    const { data: queued, error: queueError } = await admin.rpc('queue_weather_alerts');
    if (queueError) report.error = queueError.message;
    report.queued = typeof queued === 'number' ? queued : null;

    report.dispatched = await dispatchQueued(baseUrl);

    report.ok = report.feeds.nws.state === 'ok' || report.feeds.eccc.state === 'ok';
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    running = false;
    report.finishedAt = new Date().toISOString();
    lastReport = report;
  }

  return report;
};

/**
 * Start the in-process poller.
 *
 * Deliberately in-process: the whole app is one Express process, and a fire
 * warning pipeline that only works if somebody remembers to configure an
 * external cron is a pipeline that does not work.
 */
export const startAlertIngest = (baseUrl: string): void => {
  if (!admin) {
    console.warn(
      '[alerts] SUPABASE_SERVICE_ROLE_KEY not set — official alert ingest is off. ' +
      'Live alerts still show on the map; nobody will be pushed one.'
    );
    return;
  }
  if (timer) return;

  // A short delay so the first cycle does not compete with server startup.
  setTimeout(() => { void runIngest(baseUrl); }, 15_000);
  timer = setInterval(() => { void runIngest(baseUrl); }, INGEST_INTERVAL_MS);
  // Do not hold the process open on this timer alone.
  timer.unref?.();

  console.log(
    `[alerts] Official alert ingest every ${Math.round(INGEST_INTERVAL_MS / 60000)} min ` +
    '(NWS + Environment Canada).'
  );
};

export const registerAlertRoutes = (app: Express): void => {
  /**
   * What the client shows in the "official alerts" panel: who we are
   * connected to, whether it is working, and when it last succeeded.
   */
  app.get('/api/alerts/status', async (_req: Request, res: Response) => {
    let activeAlerts: number | null = null;

    if (admin) {
      const { count } = await admin
        .from('weather_alerts')
        .select('id', { count: 'exact', head: true });
      activeAlerts = typeof count === 'number' ? count : null;
    }

    res.json({
      configured: Boolean(admin),
      pushDispatchConfigured: Boolean(DISPATCH_SECRET),
      intervalMinutes: Math.round(INGEST_INTERVAL_MS / 60000),
      authorities: ALERT_AUTHORITIES,
      activeAlerts,
      lastRun: lastReport
    });
  });

  /** Run a cycle on demand. Shared secret, since it hits both agencies. */
  app.post('/api/alerts/ingest', async (req: Request, res: Response) => {
    if (!DISPATCH_SECRET) {
      return res.status(503).json({ error: 'PUSH_DISPATCH_SECRET not configured' });
    }
    const supplied = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (supplied !== DISPATCH_SECRET) {
      return res.status(401).json({ error: 'invalid dispatch secret' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const report = await runIngest(baseUrl);
    return res.json(report);
  });
};