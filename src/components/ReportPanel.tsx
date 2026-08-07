import React, { useState } from 'react';
import { AlertTriangle, Loader2, Check, MapPin } from 'lucide-react';
import { reportHazard, submitPoi, reportBurnedSite } from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';
import { HAZARD_REPORT_KINDS, hazardReportStyle } from '../config/hazardReports';

type Mode = 'hazard' | 'poi' | 'burn';

/**
 * Built from the same table the map draws, so the icon you see beside a kind
 * here is the icon your report will wear once it's on the map.
 */
const HAZARD_KINDS = HAZARD_REPORT_KINDS.map((id) => ({
  id,
  label: `${hazardReportStyle(id).emoji} ${hazardReportStyle(id).label}`
}));

const POI_KINDS = [
  { id: 'potable_water', label: 'Potable water' }, { id: 'dump_station', label: 'Dump station' },
  { id: 'propane', label: 'Propane' }, { id: 'fuel', label: 'Fuel' },
  { id: 'shower', label: 'Shower' }, { id: 'laundry', label: 'Laundry' },
  { id: 'trash', label: 'Trash' }, { id: 'air_compressor', label: 'Air' },
  { id: 'other', label: 'Other' }
];

/**
 * Neutral reason codes. These describe the SITE's condition, not people —
 * "enforcement_contact" records that someone was asked to move on, which is
 * useful trip information, without turning the app into a surveillance tool.
 */
const BURN_REASONS = [
  { id: 'physical_barrier', label: 'Gated or blocked' },
  { id: 'posted_closure', label: 'Posted closed' },
  { id: 'enforcement_contact', label: 'Asked to move on' },
  { id: 'environmental_hazard', label: 'Hazard / damage' },
  { id: 'overcrowded', label: 'Overcrowded' },
  { id: 'private_property', label: 'Actually private' },
  { id: 'access_road_impassable', label: 'Road impassable' },
  { id: 'other', label: 'Other' }
];

interface ReportPanelProps {
  isOpen: boolean;
  onClose: () => void;
  center: [number, number];
  campsiteId?: string | null;
  onRequireAuth: () => void;
}

export const ReportPanel: React.FC<ReportPanelProps> = ({
  isOpen, onClose, center, campsiteId, onRequireAuth
}) => {
  const { user } = useAuth();
  const [mode, setMode] = useState<Mode>('hazard');
  const [kind, setKind] = useState('washout');
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    if (!user) { onRequireAuth(); return; }
    setBusy(true);
    setNotice(null);

    let result;
    if (mode === 'hazard') {
      result = await reportHazard(kind, center[0], center[1], detail);
    } else if (mode === 'poi') {
      if (!name.trim()) { setBusy(false); setNotice('Give it a name'); return; }
      result = await submitPoi({ kind, name: name.trim(), lat: center[0], lon: center[1], detail });
    } else {
      if (!campsiteId) { setBusy(false); setNotice('Open a campsite first to report it'); return; }
      result = await reportBurnedSite(campsiteId, kind, detail);
    }

    setNotice(result.message);
    setBusy(false);
    if (result.ok) { setDetail(''); setName(''); }
  };

  if (!isOpen) return null;
  const kinds = mode === 'hazard' ? HAZARD_KINDS : mode === 'poi' ? POI_KINDS : BURN_REASONS;

  return (
    <div className="fixed inset-0 z-[1800] flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4 anim-backdrop">
      <div className="w-full sm:max-w-md bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[88vh] flex flex-col anim-sheet-up sm:anim-expand">
        <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-bold text-slate-100">Report</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm font-bold px-2" aria-label="Close">✕</button>
        </div>

        <div className="flex border-b border-slate-800 shrink-0">
          {([['hazard', 'Road hazard'], ['poi', 'Add a POI'], ['burn', 'Site problem']] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setKind(m === 'hazard' ? 'washout' : m === 'poi' ? 'potable_water' : 'physical_barrier');
                setNotice(null);
              }}
              className={`flex-1 px-2 py-2 text-[11px] font-bold ${
                mode === m ? 'text-amber-400 border-b-2 border-amber-500' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 scroll-soft">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <MapPin className="w-3 h-3" />
            {center[0].toFixed(5)}, {center[1].toFixed(5)}
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {kinds.map((k, i) => (
              <button
                key={k.id}
                data-stagger={Math.min(i, 8)}
                onClick={() => setKind(k.id)}
                className={`px-2 py-2 rounded-xl border text-[10px] font-semibold anim-in-up ${
                  kind === k.id ? 'bg-amber-950/60 border-amber-500/60 text-amber-200' : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>

          {mode === 'poi' && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name — e.g. 'Ranger station spigot'"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
            />
          )}

          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={3}
            placeholder={
              mode === 'hazard' ? 'What should other drivers know? How bad, and can a 2WD get through?'
              : mode === 'poi' ? 'Hours, cost, access notes'
              : 'What changed about this site?'
            }
            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
          />

          <button
            onClick={submit}
            disabled={busy}
            className="w-full px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Submit report
          </button>

          {notice && <p className="text-[11px] text-emerald-300 text-center anim-in-up">{notice}</p>}

          <p className="text-[10px] text-slate-500 leading-snug">
            {mode === 'hazard'
              ? 'Reports earn points. If three other campers confirm yours, you get an early-reporter bonus.'
              : mode === 'poi'
              ? 'New POIs stay pending until five net upvotes promote them. Three consecutive downvotes prune them.'
              : 'Site reports are aggregated by area. Several independent reports in one region raise a zone alert for everyone heading there.'}
          </p>
        </div>
      </div>
    </div>
  );
};