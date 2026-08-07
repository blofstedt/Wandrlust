import React, { useState, useEffect, useRef } from 'react';
import { Activity, Play, Square, Smartphone, AlertTriangle, Coins, Loader2, CheckCircle2, Gauge } from 'lucide-react';
import { ScoutRecorder, ScoutBatch, SurfaceQuality, SURFACE_LABEL, SURFACE_COLOR, isMotionSupported } from '../services/scoutMode';
import { uploadTelemetryBatch } from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';

interface ScoutModePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onRequireAuth: () => void;
}

/**
 * Scout Mode — passive road-surface mapping.
 *
 * Runs the accelerometer in the background while you drive and uploads
 * one-minute batches. Points are paid server-side, and only for batches that
 * pass the dash-mount and speed gates — otherwise the dataset fills up with
 * people picking their phone off the passenger seat.
 */
export const ScoutModePanel: React.FC<ScoutModePanelProps> = ({ isOpen, onClose, onRequireAuth }) => {
  const { user } = useAuth();
  const recorderRef = useRef<ScoutRecorder | null>(null);

  const [running, setRunning] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [speedKph, setSpeedKph] = useState(0);
  const [surface, setSurface] = useState<SurfaceQuality | null>(null);
  const [samples, setSamples] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Tear the recorder down if the component unmounts mid-session.
  useEffect(() => () => { recorderRef.current?.stop(); }, []);

  const handleBatch = async (batch: ScoutBatch) => {
    setDistanceM((d) => d + batch.distanceM);

    if (!batch.dashMounted) { setRejected((r) => r + 1); return; }

    const result = await uploadTelemetryBatch({
      recordedAt: batch.recordedAt,
      path: batch.path,
      sampleHz: batch.sampleHz,
      meanSpeedKph: batch.meanSpeedKph,
      verticalVariance: batch.verticalVariance,
      dashMounted: batch.dashMounted
    });

    if (result.ok) setUploaded((u) => u + 1);
    else setRejected((r) => r + 1);
  };

  const start = async () => {
    if (!user) { onRequireAuth(); return; }
    setStarting(true);
    setError(null);

    const recorder = new ScoutRecorder({
      batchSeconds: 60,
      onBatch: handleBatch,
      onStatus: (s) => {
        setRunning(s.running);
        setMounted(s.mounted);
        setSpeedKph(s.speedKph);
        setSurface(s.surface);
        setSamples(s.samples);
      }
    });

    const result = await recorder.start();
    setStarting(false);
    if (!result.ok) { setError(result.message); return; }
    recorderRef.current = recorder;
    setRunning(true);
  };

  const stop = async () => {
    await recorderRef.current?.stop();
    recorderRef.current = null;
    setRunning(false);
  };

  if (!isOpen) return null;
  const supported = isMotionSupported();

  return (
    <div className="fixed inset-0 z-[1800] flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4 anim-backdrop">
      <div className="w-full sm:max-w-md bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[88vh] flex flex-col anim-sheet-up sm:anim-expand">
        <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-bold text-slate-100">Scout Mode</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm font-bold px-2" aria-label="Close">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-soft">
          <p className="text-[11px] text-slate-400 leading-snug">
            Maps road surfaces automatically while you drive, using your phone&apos;s motion
            sensors. Mount the phone, start a session, and forget about it — you earn
            points for roads nobody has mapped yet.
          </p>

          {!supported && (
            <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-700/50 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200">
                This device has no motion sensors. Scout Mode needs a phone or tablet.
              </p>
            </div>
          )}

          {running && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 space-y-3 anim-in-up">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Recording</span>
                <span className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
              </div>

              {/* Mount check — the thing that gates everything */}
              <div className={`p-2 rounded-lg border flex items-center gap-2 ${
                mounted ? 'bg-emerald-950/50 border-emerald-700/50' : 'bg-amber-950/50 border-amber-700/50'
              }`}>
                <Smartphone className={`w-3.5 h-3.5 ${mounted ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span className={`text-[11px] font-semibold ${mounted ? 'text-emerald-200' : 'text-amber-200'}`}>
                  {mounted ? 'Phone is mounted' : 'Phone is moving too much'}
                </span>
              </div>
              {!mounted && (
                <p className="text-[10px] text-amber-300/80 leading-snug -mt-1.5">
                  Data isn&apos;t being recorded. Secure the phone in a dash or vent mount so
                  movement reflects the road, not your hands.
                </p>
              )}

              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[9px] uppercase tracking-wide text-slate-500">Speed</p>
                  <p className="text-sm font-bold text-slate-100">{speedKph}</p>
                  <p className="text-[9px] text-slate-500">km/h</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wide text-slate-500">Samples</p>
                  <p className="text-sm font-bold text-slate-100">{samples}</p>
                  <p className="text-[9px] text-slate-500">buffered</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wide text-slate-500">Distance</p>
                  <p className="text-sm font-bold text-slate-100">{(distanceM / 1000).toFixed(1)}</p>
                  <p className="text-[9px] text-slate-500">km</p>
                </div>
              </div>

              {surface && (
                <div className="flex items-center gap-2 pt-2 border-t border-slate-700">
                  <Gauge className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-[11px] text-slate-400">Surface right now:</span>
                  <span
                    className="text-[11px] font-bold px-2 py-0.5 rounded"
                    style={{ backgroundColor: `${SURFACE_COLOR[surface]}22`, color: SURFACE_COLOR[surface] }}
                  >
                    {SURFACE_LABEL[surface]}
                  </span>
                </div>
              )}
            </div>
          )}

          {(uploaded > 0 || rejected > 0) && (
            <div className="flex gap-2">
              <div className="flex-1 rounded-xl bg-emerald-950/40 border border-emerald-700/40 p-2.5 text-center">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mx-auto mb-1" />
                <p className="text-sm font-bold text-emerald-200">{uploaded}</p>
                <p className="text-[9px] text-emerald-300/70">batches uploaded</p>
              </div>
              <div className="flex-1 rounded-xl bg-slate-800/50 border border-slate-700 p-2.5 text-center">
                <AlertTriangle className="w-3.5 h-3.5 text-slate-400 mx-auto mb-1" />
                <p className="text-sm font-bold text-slate-300">{rejected}</p>
                <p className="text-[9px] text-slate-500">filtered out</p>
              </div>
            </div>
          )}

          {error && (
            <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-700/50">
              <p className="text-[11px] text-rose-200">{error}</p>
            </div>
          )}

          <button
            onClick={running ? stop : start}
            disabled={!supported || starting}
            className={`w-full px-4 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 ${
              running ? 'bg-rose-600 hover:bg-rose-500 text-white' : 'bg-amber-600 hover:bg-amber-500 text-white'
            }`}
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : running ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {running ? 'Stop scouting' : 'Start Scout Mode'}
          </button>

          <div className="rounded-xl bg-slate-800/40 border border-slate-700/60 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Coins className="w-3 h-3 text-amber-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                How points work here
              </span>
            </div>
            <p className="text-[10px] text-slate-400 leading-snug">
              5 points per accepted batch, up to 6 a day. Batches only count when the phone
              is mounted, you&apos;re moving above 5 km/h, and the segment is at least 200 m.
              Rejected batches are still stored so the filter can be improved — they just
              don&apos;t pay.
            </p>
            <p className="text-[10px] text-slate-500 leading-snug">
              Uses GPS and motion sensors continuously, so expect noticeable battery drain.
              Best run while plugged in.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};