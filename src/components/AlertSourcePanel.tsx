import React, { useEffect, useState } from 'react';
import { RadioTower, ExternalLink, CheckCircle2, AlertTriangle, HelpCircle, Loader2 } from 'lucide-react';
import { fetchAlertFeedStatus, type AlertFeedStatus } from '../services/weatherService';

/**
 * Who issues the warnings, and whether we are actually hearing them.
 *
 * Wandrlust does not decide what counts as a fire or flood warning. It relays
 * what the National Weather Service and Environment Canada publish, with their
 * name attached, and links back to the source.
 *
 * The status line matters as much as the list. A push pipeline that has
 * quietly stopped looks identical to a quiet week, and the difference is
 * somebody sleeping through a flash flood warning. So an unreachable feed, an
 * unconfigured deployment and an unknown state each say so out loud — this
 * panel never renders silence as "all clear".
 */
export const AlertSourcePanel: React.FC = () => {
  const [status, setStatus] = useState<AlertFeedStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const result = await fetchAlertFeedStatus(controller.signal);
      if (controller.signal.aborted) return;
      setStatus(result);
      setReachable(result !== null);
      setLoading(false);
    })();
    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-3 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
        <span className="text-[11px] text-slate-400">Checking the alert feed…</span>
      </div>
    );
  }

  const lastRun = status?.lastRun ?? null;
  const feedStates = lastRun ? Object.values(lastRun.feeds).map((f) => f.state) : [];
  const anyUnreachable = feedStates.includes('unreachable');

  /* Four honest states, in descending order of confidence. */
  const health: {
    tone: string; icon: React.ComponentType<{ className?: string }>; label: string; detail: string;
  } = !reachable
    ? {
        tone: 'text-slate-400 border-slate-700 bg-slate-900/60',
        icon: HelpCircle,
        label: 'Status unknown',
        detail: 'Could not reach the app server. Alerts may or may not be flowing.'
      }
    : !status?.configured
    ? {
        tone: 'text-amber-300 border-amber-600/40 bg-amber-950/30',
        icon: AlertTriangle,
        label: 'Not connected',
        detail:
          'This deployment has no database key, so nothing is pushed. Alerts still ' +
          'load live on the map when you have signal.'
      }
    : anyUnreachable
    ? {
        tone: 'text-amber-300 border-amber-600/40 bg-amber-950/30',
        icon: AlertTriangle,
        label: 'One feed is down',
        detail:
          'An agency feed did not answer on the last check. Treat the absence of an ' +
          'alert as no information, not as an all-clear.'
      }
    : {
        tone: 'text-emerald-300 border-emerald-600/40 bg-emerald-950/30',
        icon: CheckCircle2,
        label: 'Connected',
        detail: `Checked every ${status.intervalMinutes} minutes. Warnings in your area are pushed to your devices.`
      };

  const HealthIcon = health.icon;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <RadioTower className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-[11px] font-bold text-slate-200">Official alert feed</span>
      </div>

      <div className={`rounded-xl border px-2.5 py-2 ${health.tone}`}>
        <div className="flex items-center gap-1.5">
          <HealthIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[11px] font-bold">{health.label}</span>
        </div>
        <p className="text-[10px] opacity-90 leading-snug mt-1">{health.detail}</p>
      </div>

      {/* Who the warnings actually come from. */}
      <div className="space-y-1.5">
        {(status?.authorities ?? []).map((authority) => {
          const feed = lastRun?.feeds?.[authority.id];
          return (
            <div key={authority.id} className="rounded-xl bg-slate-900/60 border border-slate-800 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-slate-200 leading-snug">{authority.name}</p>
                  <p className="text-[10px] text-slate-500">{authority.scope}</p>
                </div>
                {feed && (
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 ${
                      feed.state === 'ok'
                        ? 'bg-emerald-600/20 text-emerald-300'
                        : feed.state === 'unreachable'
                        ? 'bg-amber-600/20 text-amber-300'
                        : 'bg-slate-700/60 text-slate-400'
                    }`}
                  >
                    {feed.state === 'ok' ? `${feed.received} live` : feed.state}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-slate-400 leading-snug mt-1">{authority.covers}</p>
              <a
                href={authority.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-300 hover:text-white mt-1.5"
              >
                Official warnings <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </div>
          );
        })}
      </div>

      {lastRun && (
        <p className="text-[9px] text-slate-500 leading-tight">
          Last checked {new Date(lastRun.finishedAt).toLocaleString()}
          {typeof status?.activeAlerts === 'number' && ` · ${status.activeAlerts} alerts in force`}
          {lastRun.error && ` · ${lastRun.error}`}
        </p>
      )}

      <p className="text-[9px] text-slate-500 leading-tight">
        Wandrlust relays these warnings, it does not issue them. The agency is always the
        authority — confirm with them before making a safety decision.
      </p>
    </div>
  );
};