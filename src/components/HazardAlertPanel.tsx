import React, { useState } from 'react';
import {
  Flame, Waves, CloudLightning, Snowflake, Thermometer, Wind, Info,
  ChevronDown, ChevronUp, ExternalLink, AlertTriangle
} from 'lucide-react';
import {
  HazardAlert, HazardFamily, HAZARD_STYLE, isActionable, sortAlerts
} from '../services/weatherService';
import type { PointHazard } from '../services/dataService';

const FAMILY_ICON: Record<HazardFamily, React.ComponentType<{ className?: string }>> = {
  fire: Flame, flood: Waves, storm: CloudLightning,
  winter: Snowflake, heat: Thermometer, wind: Wind, other: Info
};

const SEVERITY_STYLE: Record<string, string> = {
  extreme: 'bg-red-600 text-white',
  severe: 'bg-orange-600 text-white',
  moderate: 'bg-amber-500 text-slate-950',
  minor: 'bg-slate-600 text-slate-100',
  unknown: 'bg-slate-700 text-slate-300'
};

interface HazardAlertPanelProps {
  alerts: HazardAlert[];
  /** Agency fire bans etc. from hazards_at_point() — not weather forecasts. */
  pointHazards?: PointHazard[];
  compact?: boolean;
}

/**
 * Fire / flood / storm alerts.
 *
 * Two distinct things, deliberately separated:
 *   - Weather alerts (NWS / ECCC): forecasts and warnings.
 *   - Fire restrictions: legal prohibitions issued by land managers.
 *
 * A Red Flag Warning says conditions are dangerous. A Stage 2 ban says a fire
 * is illegal. Campers need both, and conflating them is how people end up with
 * an illegal campfire.
 */
export const HazardAlertPanel: React.FC<HazardAlertPanelProps> = ({
  alerts, pointHazards = [], compact = false
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fireBans = pointHazards.filter((h) => h.kind === 'fire_ban');
  const sorted = sortAlerts(alerts);
  const actionable = sorted.filter(isActionable);
  const informational = sorted.filter((a) => !isActionable(a));

  if (sorted.length === 0 && fireBans.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 flex items-center gap-2">
        <Info className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <span className="text-[11px] text-slate-400">
          No active weather alerts or fire restrictions here.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Fire restrictions first — they are legal, not advisory. */}
      {fireBans.map((ban, i) => (
        <div
          key={`ban-${i}`}
          data-stagger={Math.min(i, 8)}
          className="rounded-xl border border-orange-600/60 bg-orange-950/60 p-3 anim-in-up"
        >
          <div className="flex items-start gap-2">
            <Flame className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-orange-200">{ban.title}</span>
                {ban.stage && (
                  <span className="px-1.5 py-0.5 rounded bg-orange-600 text-white text-[9px] font-bold uppercase tracking-wide">
                    {ban.stage.replace('_', ' ')}
                  </span>
                )}
              </div>
              {ban.detail && (
                <p className="text-[11px] text-orange-200/80 mt-1 leading-snug">{ban.detail}</p>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                {ban.authority && <span className="text-[10px] text-orange-300/70">{ban.authority}</span>}
                {ban.source_url && (
                  <a
                    href={ban.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-orange-300 hover:text-orange-200 font-semibold flex items-center gap-0.5"
                  >
                    Official notice <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
              <p className="text-[10px] text-orange-300/60 mt-1.5 italic">
                This is a legal restriction, not a forecast. Confirm with the managing
                agency before any fire.
              </p>
            </div>
          </div>
        </div>
      ))}

      {actionable.map((alert, idx) => {
        const style = HAZARD_STYLE[alert.family];
        const Icon = FAMILY_ICON[alert.family];
        const isOpen = expandedId === alert.id;

        return (
          <div
            key={alert.id}
            data-stagger={Math.min(fireBans.length + idx, 8)}
            className={`rounded-xl border ${style.border} ${style.bg} overflow-hidden anim-in-up`}
          >
            <button onClick={() => setExpandedId(isOpen ? null : alert.id)} className="w-full p-3 text-left">
              <div className="flex items-start gap-2">
                <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: style.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-slate-100">{alert.event}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${SEVERITY_STYLE[alert.severity]}`}>
                      {alert.severity}
                    </span>
                  </div>
                  {!compact && (
                    <p className="text-[11px] text-slate-300 mt-1 leading-snug line-clamp-2">
                      {alert.headline}
                    </p>
                  )}
                  <p className="text-[10px] text-slate-400 mt-1 truncate">{alert.areaDescription}</p>
                </div>
                {isOpen ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                )}
              </div>
            </button>

            {isOpen && (
              <div className="px-3 pb-3 pt-0 space-y-2 anim-in-up">
                {alert.instruction && (
                  <div className="p-2 rounded-lg bg-slate-950/60 border border-slate-700/60">
                    <div className="flex items-center gap-1.5 mb-1">
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                      <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wide">
                        What to do
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-200 leading-snug whitespace-pre-line">
                      {alert.instruction}
                    </p>
                  </div>
                )}
                <p className="text-[11px] text-slate-300 leading-snug whitespace-pre-line max-h-48 overflow-y-auto scroll-soft">
                  {alert.description}
                </p>
                <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1 border-t border-slate-700/60">
                  <span>{alert.sender}</span>
                  {alert.expires && <span>Until {new Date(alert.expires).toLocaleString()}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {informational.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200 font-semibold flex items-center gap-1.5 px-1">
            <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-moook" />
            {informational.length} more advisor{informational.length === 1 ? 'y' : 'ies'}
          </summary>
          <div className="mt-2 space-y-1.5">
            {informational.map((alert) => {
              const style = HAZARD_STYLE[alert.family];
              const Icon = FAMILY_ICON[alert.family];
              return (
                <div key={alert.id} className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-2.5 py-2 flex items-center gap-2">
                  <Icon className="w-3 h-3 shrink-0" style={{ color: style.color }} />
                  <span className="text-[11px] text-slate-300 truncate flex-1">{alert.event}</span>
                  <span className="text-[9px] text-slate-500 shrink-0">{alert.severity}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <p className="text-[9px] text-slate-500 leading-tight px-1">
        Alerts from the National Weather Service and Environment Canada. Always confirm
        with official channels before making a safety decision.
      </p>
    </div>
  );
};
