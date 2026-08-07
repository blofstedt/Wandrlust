import React from 'react';
import { X, Clock } from 'lucide-react';
import type { HazardAlert } from '../services/weatherService';
import { HAZARD_STYLE } from '../services/weatherService';

/**
 * One official warning, opened from its icon on the map.
 *
 * This is the card the PRECISE hazards (fire, flood, storm) open when tapped —
 * the diffuse clouds can't be tapped at all, by design, so this only ever shows
 * a place-based warning. It relays exactly what the agency published: the event,
 * its severity, where it applies, the description and any instruction, and who
 * issued it. Nothing is reworded, and no severity is invented.
 */
interface AlertCardProps {
  alert: HazardAlert | null;
  onClose: () => void;
}

export const AlertCard: React.FC<AlertCardProps> = ({ alert, onClose }) => {
  if (!alert) return null;

  const style = HAZARD_STYLE[alert.family] ?? HAZARD_STYLE.other;
  const until = alert.expires
    ? new Date(alert.expires).toLocaleString([], {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit'
      })
    : null;

  // ECCC often repeats the event name into the headline; only show it when it
  // actually says something new.
  const headline =
    alert.headline &&
    alert.headline.trim().toLowerCase() !== alert.event.trim().toLowerCase()
      ? alert.headline
      : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1500] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-md rounded-2xl bg-slate-900/97 backdrop-blur-md border border-slate-700 shadow-2xl overflow-hidden anim-sheet-up">
        <div className="flex items-start gap-3 p-3.5">
          <span
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0 border-2 border-slate-950"
            style={{ background: style.color }}
            aria-hidden="true"
          >
            {style.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-slate-100 capitalize">{alert.event}</h2>
              <span className="px-1.5 py-0.5 rounded border border-slate-600 text-slate-300 text-[9px] font-bold uppercase tracking-wide">
                {alert.severity}
              </span>
            </div>
            {alert.areaDescription && (
              <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{alert.areaDescription}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {headline && (
          <p className="px-3.5 pb-1.5 text-[12px] text-slate-200 leading-relaxed">{headline}</p>
        )}

        {alert.description && (
          <p className="px-3.5 pb-2 text-[11px] text-slate-300 leading-relaxed max-h-44 overflow-y-auto scroll-soft whitespace-pre-line">
            {alert.description}
          </p>
        )}

        {alert.instruction && (
          <div className="mx-3.5 mb-2 p-2 rounded-lg bg-amber-950/40 border border-amber-700/40">
            <p className="text-[11px] text-amber-100 leading-snug whitespace-pre-line">
              {alert.instruction}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-t border-slate-800 text-[10px] text-slate-500">
          <span className="truncate">{alert.sender}</span>
          {until && (
            <span className="flex items-center gap-1 shrink-0">
              <Clock className="w-2.5 h-2.5" /> Until {until}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
