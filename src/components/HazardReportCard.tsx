import React, { useState } from 'react';
import { X, ThumbsUp, ThumbsDown, Loader2, Clock } from 'lucide-react';
import type { HazardRecord } from '../services/dataService';
import { confirmHazard } from '../services/dataService';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { haptic } from '../utils/animation';

/**
 * One camper's hazard report, opened from its icon on the map.
 *
 * The whole design problem here is standing: this is one person's account of a
 * road, and the app must neither dismiss it nor dress it up. So the card leads
 * with who says so and how many people agree, before it says what they say —
 * and a report with no confirmations is labelled "unconfirmed", not "false".
 * Most reports have nobody behind them simply because nobody else has driven
 * that road since.
 *
 * Confirming or disputing is the one action offered, because that is the only
 * thing another camper can usefully contribute.
 */

interface HazardReportCardProps {
  record: HazardRecord | null;
  onClose: () => void;
  onRequireAuth: () => void;
}

const relativeAge = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'in the last hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

export const HazardReportCard: React.FC<HazardReportCardProps> = ({
  record, onClose, onRequireAuth
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!record) return null;

  const style = hazardReportStyle(record.kind);
  const confirmed = reportStanding(record.confirms, record.disputes) === 'confirmed';

  const vote = async (agrees: boolean) => {
    setBusy(true);
    haptic('tap');
    const result = await confirmHazard(record.id, agrees);
    setBusy(false);
    if (!result.ok && /sign in/i.test(result.message)) { onRequireAuth(); return; }
    setNotice(result.message);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1500] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-md rounded-2xl bg-slate-900/97 backdrop-blur-md border border-slate-700 shadow-2xl overflow-hidden anim-sheet-up">
        <div className="flex items-start gap-3 p-3.5">
          <span
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0 border-2 border-slate-950"
            style={{ background: style.color }}
            aria-hidden="true"
          >
            {style.emoji}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-slate-100">{style.label}</h2>
              <span
                className={`px-1.5 py-0.5 rounded border text-[9px] font-bold ${
                  confirmed
                    ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-slate-700/40 text-slate-400 border-slate-600'
                }`}
              >
                {confirmed ? 'CONFIRMED BY CAMPERS' : 'UNCONFIRMED'}
              </span>
            </div>

            {/* Standing before content. A camper's word, quantified. */}
            <p className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <Clock className="w-2.5 h-2.5" />
              Reported {relativeAge(record.created_at)}
              <span>·</span>
              {record.confirms} confirmed
              {record.disputes > 0 && `, ${record.disputes} disputed`}
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {record.detail && (
          <p className="px-3.5 pb-2 text-[12px] text-slate-200 leading-relaxed">
            “{record.detail}”
          </p>
        )}

        <p className="px-3.5 pb-3 text-[9px] text-slate-500 leading-snug">
          One camper's account of this spot, not an official closure. Conditions
          change fast on unpaved roads — treat it as a heads-up and judge the
          road when you get there.
        </p>

        <div className="flex border-t border-slate-800">
          <button
            onClick={() => vote(true)}
            disabled={busy}
            className="flex-1 px-3 py-2.5 text-[11px] font-bold text-emerald-300 hover:bg-emerald-950/40 flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ThumbsUp className="w-3.5 h-3.5" />}
            Still there
          </button>
          <button
            onClick={() => vote(false)}
            disabled={busy}
            className="flex-1 px-3 py-2.5 text-[11px] font-bold text-slate-400 hover:bg-slate-800 border-l border-slate-800 flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <ThumbsDown className="w-3.5 h-3.5" />
            Clear now
          </button>
        </div>

        {notice && (
          <p className="px-3.5 py-2 text-[11px] text-emerald-300 text-center border-t border-slate-800 anim-in-up">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
};