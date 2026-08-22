import React, { useState, useEffect } from 'react';
import {
  Settings, Flame, Waves, CloudLightning, Bell, Eye, Ruler,
  Coffee, Loader2, Check, ExternalLink, Shield, FileText, RefreshCw
} from 'lucide-react';
import { fetchSettings, saveSettings, UserSettings } from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';
import { PushSettings } from './PushSettings';
import { AlertSourcePanel } from './AlertSourcePanel';
import type { LegalDocKind } from '../types';
import { checkForUpdate } from '../services/updateService';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onRequireAuth: () => void;
  center?: [number, number];
  onOpenLegal?: (kind: LegalDocKind) => void;
}

interface ToggleProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ComponentType<{ className?: string }>;
}

/**
 * Defined at module scope on purpose.
 *
 * This used to be declared inside SettingsPanel's body, which made it a brand
 * new component type on every render — React unmounted and remounted every
 * checkbox each time a setting changed, losing focus and replaying the tick
 * animation. Hoisting it fixes both.
 */
const Toggle: React.FC<ToggleProps> = ({ label, description, value, onChange, icon: Icon }) => (
  <label className="flex items-start gap-3 p-2.5 rounded-xl hover:bg-slate-800/50 cursor-pointer transition-moook">
    {Icon && <Icon className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />}
    <span className="flex-1 min-w-0">
      <span className="block text-xs font-semibold text-slate-200">{label}</span>
      {description && (
        <span className="block text-[12px] text-slate-500 leading-snug mt-0.5">{description}</span>
      )}
    </span>
    <input
      type="checkbox"
      checked={value}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-emerald-500 w-4 h-4 shrink-0 mt-0.5"
    />
  </label>
);

const LEGAL_LINKS: [LegalDocKind, string][] = [
  ['privacy_policy', 'Privacy Policy'],
  ['terms_of_service', 'Terms of Service'],
  ['safety_disclaimer', 'Safety Disclaimer']
];

/**
 * Settings.
 *
 * Note on the support link: it lives here and ONLY here. No purchase prompts
 * anywhere else in the app, and it buys nothing — not points, not tiers, not
 * stealth spots. The points economy stays closed; supporting the project and
 * progressing in the app are deliberately unconnected.
 */
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen, onClose, onRequireAuth, center, onOpenLegal
}) => {
  const { user } = useAuth();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * State for the manual update check. It lives up here with the other
   * hooks, above the `if (!isOpen) return null` below, because a hook
   * called after an early return runs on some renders and not others —
   * React matches hooks by call order, so closing the panel would shift
   * every hook after it by one.
   */
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'up-to-date' | 'error'>('idle');

  useEffect(() => {
    if (!isOpen || !user) return;
    let cancelled = false;
    fetchSettings().then((s) => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; };
  }, [isOpen, user]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  const patch = async (changes: Partial<UserSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...changes });
    setBusy(true);
    await saveSettings(changes);
    setBusy(false);
    setSaved(true);
  };

  if (!isOpen) return null;

  /**
   * A manual update check, with three states. The button is here, not in the
   * chrome on the map, because tapping it is a settings concern, not a map
   * one — and the result matters more when the user is looking at it.
   *
   * On an installed mobile PWA, the automatic background check is heavily
   * throttled by the OS and may not surface an update for hours. This
   * button bypasses the throttle, so a user who suspects a fix has shipped
   * can get the update pill in seconds instead of waiting for the next
   * background refresh window.
   */
  const handleCheckUpdate = async () => {
    setUpdateState('checking');
    try {
      await checkForUpdate();
      // 'up-to-date' is the message either way. If a worker is waiting, the
      // UpdatePrompt pill at the bottom of the screen surfaces it; if not,
      // the user knows they are current. There's no separate "update found"
      // message here because the pill handles it the same way it would for an
      // automatic check.
      setUpdateState('up-to-date');
    } catch {
      setUpdateState('error');
    }
    setTimeout(() => setUpdateState((s) => (s === 'idle' ? s : 'idle')), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-[1800] flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4 anim-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-full sm:max-w-md bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[88vh] flex flex-col anim-sheet-up sm:anim-expand"
      >
        <header className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-slate-300" />
            <h2 className="text-sm font-bold text-slate-100">Settings</h2>
            {busy && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
            {saved && <Check className="w-3 h-3 text-emerald-400 anim-pop" />}
          </div>
          <button
            onClick={onClose}
            className="tap-safe text-slate-500 hover:text-slate-200 text-sm font-bold px-2"
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3 space-y-4 scroll-soft">
          {/* Shown to everyone, signed in or not: a manual "check for
              updates" is the only way to force a fresh check on an installed
              mobile PWA, where the OS throttles the background poll. The
              automatic path catches most updates; this is the escape hatch. */}
          <section>
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-2">
              App
            </h3>
            <button
              onClick={handleCheckUpdate}
              disabled={updateState === 'checking'}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-slate-800/50 text-left disabled:opacity-50"
            >
              {updateState === 'checking' ? (
                <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
              ) : updateState === 'up-to-date' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : updateState === 'error' ? (
                <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
              )}
              <span className="text-xs text-slate-300 flex-1">
                {updateState === 'checking'
                  ? 'Checking for updates…'
                  : updateState === 'up-to-date'
                  ? 'You are on the latest version'
                  : updateState === 'error'
                  ? 'Could not check — try again later'
                  : 'Check for updates'}
              </span>
            </button>
          </section>

          {/* Shown whether or not anyone is signed in: a camper needs to know
              who issues the warnings and whether we are still hearing them,
              and that is not a per-account preference. */}
          <section>
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-2">
              Where alerts come from
            </h3>
            <AlertSourcePanel />
          </section>

          {!user ? (
            <div className="text-center py-6">
              <p className="text-xs text-slate-400 mb-3">Sign in to save your preferences.</p>
              <button
                onClick={onRequireAuth}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-bold text-xs"
              >
                Sign in
              </button>
            </div>
          ) : !settings ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
            </div>
          ) : (
            <>
              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-2">
                  Notifications
                </h3>
                <PushSettings center={center} />
              </section>

              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-1">
                  Safety alerts
                </h3>

                <Toggle
                  icon={Flame}
                  label="Fire alerts"
                  description="Red flag warnings, fire weather watches, and agency fire bans."
                  value={settings.notify_fire_alerts}
                  onChange={(v) => patch({ notify_fire_alerts: v })}
                />
                <Toggle
                  icon={Waves}
                  label="Flood alerts"
                  description="Flash flood and flood warnings near you."
                  value={settings.notify_flood_alerts}
                  onChange={(v) => patch({ notify_flood_alerts: v })}
                />
                <Toggle
                  icon={CloudLightning}
                  label="Storm alerts"
                  description="Severe thunderstorm, tornado and winter storm warnings."
                  value={settings.notify_storm_alerts}
                  onChange={(v) => patch({ notify_storm_alerts: v })}
                />
                <Toggle
                  icon={Bell}
                  label="Zone heat alerts"
                  description="When several campers report problems in an area you're heading to."
                  value={settings.notify_zone_heat}
                  onChange={(v) => patch({ notify_zone_heat: v })}
                />

                <div className="px-2.5 pt-2">
                  <div className="flex justify-between text-[12px] text-slate-400 mb-1">
                    <label htmlFor="alert-radius">Alert radius</label>
                    <span className="font-bold text-slate-200">{settings.alert_radius_km} km</span>
                  </div>
                  <input
                    id="alert-radius"
                    type="range"
                    min={10}
                    max={500}
                    step={10}
                    value={settings.alert_radius_km}
                    onChange={(e) => patch({ alert_radius_km: Number(e.target.value) })}
                    className="w-full accent-emerald-500"
                  />
                </div>
              </section>

              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-1">
                  Privacy
                </h3>
                <Toggle
                  icon={Eye}
                  label="Share my position by default"
                  description="Off means Ghost mode. You can still share per session."
                  value={settings.share_presence}
                  onChange={(v) => patch({ share_presence: v })}
                />
                <Toggle
                  icon={Shield}
                  label="Contribute road data"
                  description="Uploads anonymised road-surface readings while Scout Mode runs."
                  value={settings.share_telemetry}
                  onChange={(v) => patch({ share_telemetry: v })}
                />
              </section>

              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-1">
                  Display
                </h3>
                <Toggle
                  icon={Ruler}
                  label="Metric units"
                  description="Kilometres and Celsius. Off for miles and Fahrenheit."
                  value={settings.use_metric}
                  onChange={(v) => patch({ use_metric: v })}
                />
              </section>

              {onOpenLegal && (
                <section>
                  <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-1">
                    Legal
                  </h3>
                  {LEGAL_LINKS.map(([kind, label]) => (
                    <button
                      key={kind}
                      onClick={() => onOpenLegal(kind)}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-slate-800/50 text-left"
                    >
                      <FileText className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-xs text-slate-300 flex-1">{label}</span>
                      <ExternalLink className="w-3 h-3 text-slate-500" />
                    </button>
                  ))}
                </section>
              )}

              <section className="pt-2 border-t border-slate-800">
                <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/60">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Coffee className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-xs font-bold text-slate-200">Support Wandrlust</span>
                  </div>
                  <p className="text-[12px] text-slate-400 leading-snug mb-2.5">
                    Wandrlust is free and has no ads. If it&apos;s useful to you, you can buy
                    the project a coffee. It buys you nothing in the app — no points, no
                    tiers, no stealth spots. Those are earned by contributing, and that
                    isn&apos;t for sale.
                  </p>
                  <a
                    href="https://buymeacoffee.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold"
                  >
                    <Coffee className="w-3 h-3" />
                    Buy me a coffee
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
