import React, { useState, useEffect, useCallback } from 'react';
import {
  Bell, BellOff, Loader2, Check, AlertTriangle, Smartphone, Send, Info
} from 'lucide-react';
import {
  getPushStatus, subscribeToPush, unsubscribeFromPush,
  sendTestNotification, PushStatus, updateAlertLocation
} from '../services/pushService';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

/**
 * Push notification controls.
 *
 * Drop this into SettingsPanel above the existing alert toggles — those
 * toggles decide WHICH alerts you get; this decides whether any can be
 * delivered at all.
 *
 * We never prompt for permission on mount. A cold prompt gets denied most of
 * the time, and denial is sticky until the user digs through browser settings
 * — meaning one badly-timed prompt permanently disables fire alerts for that
 * person. So: explain first, then ask on an explicit tap.
 */
interface PushSettingsProps {
  /** Current map centre, used to seed the alert targeting location. */
  center?: [number, number];
}

export const PushSettings: React.FC<PushSettingsProps> = ({ center }) => {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getPushStatus());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    setNotice(null);

    const result = await subscribeToPush();
    setStatus(result.status);
    setNotice({ ok: result.ok, text: result.message });

    if (result.ok) {
      // Flag it server-side and seed a coarse location so the matcher has
      // something to work with immediately.
      if (supabase && user) {
        await supabase
          .from('user_settings')
          .upsert({ user_id: user.id, push_enabled: true }, { onConflict: 'user_id' });
      }
      if (center) await updateAlertLocation(center[0], center[1]);
    }

    setBusy(false);
  };

  const disable = async () => {
    setBusy(true);
    const result = await unsubscribeFromPush();
    setStatus(result.status);
    setNotice({ ok: result.ok, text: result.message });

    if (result.ok && supabase && user) {
      await supabase
        .from('user_settings')
        .upsert({ user_id: user.id, push_enabled: false }, { onConflict: 'user_id' });
    }
    setBusy(false);
  };

  const test = async () => {
    const ok = await sendTestNotification();
    setNotice({
      ok,
      text: ok ? 'Test sent — check your notifications.' : 'Could not send a test.'
    });
  };

  if (!status) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
      </div>
    );
  }

  /* --- Unsupported platforms get an explanation, not a dead button --- */

  if (status.support === 'ios-needs-install') {
    return (
      <div className="rounded-xl border border-sky-700/50 bg-sky-950/40 p-3">
        <div className="flex items-start gap-2">
          <Smartphone className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-sky-200 mb-1">
              Add Wandrlust to your Home Screen first
            </p>
            <p className="text-[11px] text-sky-100/80 leading-snug">
              On iPhone and iPad, Safari only delivers alerts to installed apps. Tap
              Share, then <strong>Add to Home Screen</strong>, and open it from there —
              alerts will be available.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status.support === 'insecure-context') {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 flex items-start gap-2">
        <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        <p className="text-[11px] text-slate-300">
          Alerts need a secure (HTTPS) connection. They&apos;ll work once this is
          deployed.
        </p>
      </div>
    );
  }

  if (status.support === 'unsupported') {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 flex items-start gap-2">
        <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        <p className="text-[11px] text-slate-300">
          This browser doesn&apos;t support push notifications. Alerts will still show
          in the app while it&apos;s open.
        </p>
      </div>
    );
  }

  /* --- Blocked at browser level --- */

  if (status.permission === 'denied') {
    return (
      <div className="rounded-xl border border-amber-700/50 bg-amber-950/40 p-3">
        <div className="flex items-start gap-2">
          <BellOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-amber-200 mb-1">Alerts are blocked</p>
            <p className="text-[11px] text-amber-100/80 leading-snug">
              Your browser is blocking notifications for this site. To turn them back
              on, open the padlock icon in the address bar and allow notifications.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* --- The normal path --- */

  const enabled = status.subscribed && status.permission === 'granted';

  return (
    <div className="space-y-2.5">
      <div
        className={`rounded-xl border p-3 transition-moook ${
          enabled
            ? 'border-emerald-700/50 bg-emerald-950/40'
            : 'border-slate-700 bg-slate-800/50'
        }`}
      >
        <div className="flex items-start gap-2.5">
          {enabled ? (
            <Bell className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <BellOff className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <p
              className={`text-xs font-bold ${
                enabled ? 'text-emerald-200' : 'text-slate-200'
              }`}
            >
              {enabled ? 'Alerts are on for this device' : 'Turn on safety alerts'}
            </p>
            <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
              {enabled
                ? 'You’ll get fire, flood and storm warnings for where you are, even when the app is closed.'
                : 'Get fire, flood and storm warnings for your area — including when the app is closed.'}
            </p>
          </div>
        </div>

        <div className="flex gap-2 mt-3">
          <button
            onClick={enabled ? disable : enable}
            disabled={busy || !user}
            className={`flex-1 px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-moook ${
              enabled
                ? 'bg-slate-800 text-slate-300 border border-slate-700'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            } disabled:opacity-50`}
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : enabled ? (
              <BellOff className="w-3.5 h-3.5" />
            ) : (
              <Bell className="w-3.5 h-3.5" />
            )}
            {enabled ? 'Turn off' : 'Turn on alerts'}
          </button>

          {enabled && (
            <button
              onClick={test}
              className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-bold flex items-center gap-1.5 transition-moook"
            >
              <Send className="w-3 h-3" />
              Test
            </button>
          )}
        </div>

        {!user && (
          <p className="text-[10px] text-slate-500 mt-2">Sign in to enable alerts.</p>
        )}
      </div>

      {notice && (
        <p
          className={`text-[11px] flex items-start gap-1.5 ${
            notice.ok ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          {notice.ok ? (
            <Check className="w-3 h-3 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          )}
          {notice.text}
        </p>
      )}

      {/* The honest caveat. Someone might plan around these alerts. */}
      <div className="rounded-xl bg-slate-800/40 border border-slate-700/60 p-2.5">
        <p className="text-[10px] text-slate-400 leading-snug">
          <strong className="text-slate-300">Never rely on alerts alone.</strong> No
          signal, a dead battery, or a push service outage all mean a warning never
          arrives. Carry a satellite communicator if a missed alert would matter.
        </p>
      </div>
    </div>
  );
};