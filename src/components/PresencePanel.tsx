import React, { useState, useEffect, useCallback } from 'react';
import { Users, EyeOff, Radio, Loader2, Check, Ghost, UserCheck, Globe } from 'lucide-react';
import {
  publishPresence, goGhost, fetchNearbyCampers,
  NearbyCamper, PresenceStatus, VisibilityMode, RigType
} from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';
// Shared with the map, which draws the same avatars on the navigation layer.
import { RIG_AVATAR, UNKNOWN_RIG_EMOJI } from '../config/rigs';


const STATUS_STYLE: Record<PresenceStatus, { label: string; className: string }> = {
  in_transit: { label: 'On the move', className: 'bg-sky-600/20 text-sky-300 border-sky-500/40' },
  scouting: { label: 'Scouting', className: 'bg-amber-600/20 text-amber-300 border-amber-500/40' },
  parked: { label: 'Parked', className: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40' },
  offline: { label: 'Offline', className: 'bg-slate-700/40 text-slate-400 border-slate-600' }
};

const VISIBILITY_OPTIONS: {
  id: VisibilityMode; label: string; description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'ghost', label: 'Ghost', description: 'Nobody sees you. Default, and always available.', icon: Ghost },
  { id: 'friends', label: 'Friends', description: 'Only accepted friends see your approximate position.', icon: UserCheck },
  { id: 'public', label: 'Public', description: 'Any signed-in camper sees your approximate position.', icon: Globe }
];

interface PresencePanelProps {
  isOpen: boolean;
  onClose: () => void;
  center: [number, number];
  onRequireAuth: () => void;
  onCampersChange?: (campers: NearbyCamper[]) => void;
}

/**
 * Camper presence — the "Camp Waze" social layer.
 *
 * PRIVACY MODEL, because this is the part that matters:
 *   - Ghost is the default. You are invisible until you opt in.
 *   - Positions shared with others are snapped to a ~1 km grid server-side.
 *     Nobody ever receives your exact coordinates, even in Public mode.
 *   - Presence rows expire after four hours. This is a live layer, not a
 *     location history, and there is no table storing where you have been.
 */
export const PresencePanel: React.FC<PresencePanelProps> = ({
  isOpen, onClose, center, onRequireAuth, onCampersChange
}) => {
  const { user, profile } = useAuth();
  const [visibility, setVisibility] = useState<VisibilityMode>('ghost');
  const [status, setStatus] = useState<PresenceStatus>('parked');
  const [rigType, setRigType] = useState<RigType>('van');
  const [note, setNote] = useState('');
  const [campers, setCampers] = useState<NearbyCamper[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (profile?.default_visibility) setVisibility(profile.default_visibility);
  }, [profile]);

  const refresh = useCallback(async () => {
    const list = await fetchNearbyCampers(center[0], center[1], 80);
    setCampers(list);
    onCampersChange?.(list);
  }, [center, onCampersChange]);

  useEffect(() => {
    if (!isOpen) return;
    refresh();
    // Presence is ephemeral; poll while the panel is open.
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [isOpen, refresh]);

  const handleShare = async () => {
    if (!user) { onRequireAuth(); return; }
    setBusy(true);
    setNotice(null);

    const result = visibility === 'ghost'
      ? await goGhost()
      : await publishPresence(center[0], center[1], status, visibility, rigType, note || null);

    setNotice(result.message);
    setBusy(false);
    if (result.ok) refresh();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1800] flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4 anim-backdrop">
      <div className="w-full sm:max-w-md bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[88vh] flex flex-col anim-sheet-up sm:anim-expand">
        <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-100">Campers nearby</h2>
          </div>
          <button onClick={onClose} className="tap-safe text-slate-500 hover:text-slate-200 text-sm font-bold px-2" aria-label="Close">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-soft">
          <section>
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Who can see you</h3>
            <div className="space-y-1.5">
              {VISIBILITY_OPTIONS.map((opt, i) => {
                const Icon = opt.icon;
                const active = visibility === opt.id;
                return (
                  <button
                    key={opt.id}
                    data-stagger={i}
                    onClick={() => setVisibility(opt.id)}
                    className={`w-full text-left p-2.5 rounded-xl border anim-in-up ${
                      active ? 'bg-emerald-950/60 border-emerald-500/60' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`w-3.5 h-3.5 ${active ? 'text-emerald-400' : 'text-slate-400'}`} />
                      <span className={`text-xs font-bold ${active ? 'text-emerald-200' : 'text-slate-300'}`}>{opt.label}</span>
                      {active && <Check className="w-3 h-3 text-emerald-400 ml-auto" />}
                    </div>
                    <p className="text-[12px] text-slate-400 mt-0.5 leading-snug">{opt.description}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 mt-2 leading-tight">
              Even in Public, your position is rounded to about a kilometre before anyone
              else sees it. Exact coordinates never leave your device.
            </p>
          </section>

          {visibility !== 'ghost' && (
            <>
              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Your status</h3>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['in_transit', 'scouting', 'parked'] as PresenceStatus[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(s)}
                      className={`px-2 py-2 rounded-xl border text-[12px] font-bold ${
                        status === s ? STATUS_STYLE[s].className : 'bg-slate-800/50 text-slate-400 border-slate-700'
                      }`}
                    >
                      {STATUS_STYLE[s].label}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Your rig</h3>
                <div className="grid grid-cols-4 gap-1.5">
                  {(Object.keys(RIG_AVATAR) as RigType[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRigType(r)}
                      title={RIG_AVATAR[r].label}
                      className={`aspect-square rounded-xl border flex flex-col items-center justify-center gap-0.5 ${
                        rigType === r ? 'bg-emerald-950/60 border-emerald-500/60 scale-105' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                      }`}
                    >
                      <span className="text-lg leading-none">{RIG_AVATAR[r].emoji}</span>
                      <span className="text-[10px] text-slate-400 leading-none text-center px-0.5">{RIG_AVATAR[r].label}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, 140))}
                  placeholder="Optional note — 'coffee's on', 'road is rough past the cattle guard'"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </section>
            </>
          )}

          <button
            onClick={handleShare}
            disabled={busy}
            className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : visibility === 'ghost' ? <EyeOff className="w-3.5 h-3.5" />
              : <Radio className="w-3.5 h-3.5" />}
            {visibility === 'ghost' ? 'Go invisible' : 'Share my position'}
          </button>

          {notice && <p className="text-xs text-emerald-300 text-center anim-in-up">{notice}</p>}

          <section>
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              {campers.length} camper{campers.length === 1 ? '' : 's'} within 80 km
            </h3>
            {campers.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">
                Nobody sharing their position nearby right now.
              </p>
            ) : (
              <div className="space-y-1.5">
                {campers.map((c, i) => (
                  <div
                    key={c.user_id}
                    data-stagger={Math.min(i, 8)}
                    className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-800/50 border border-slate-700 anim-in-up"
                  >
                    <span className="text-lg leading-none">{c.rig_type ? RIG_AVATAR[c.rig_type].emoji : UNKNOWN_RIG_EMOJI}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-200 truncate">{c.handle}</p>
                      {c.note && <p className="text-[12px] text-slate-400 truncate">{c.note}</p>}
                    </div>
                    <span className={`px-1.5 py-0.5 rounded border text-[11px] font-bold shrink-0 ${STATUS_STYLE[c.status].className}`}>
                      {STATUS_STYLE[c.status].label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
