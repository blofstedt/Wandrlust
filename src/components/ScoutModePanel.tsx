import React, { useState, useEffect, useRef } from 'react';
import {
  Activity, Play, Square, Smartphone, AlertTriangle, Coins, Loader2,
  CheckCircle2, Gauge, Ruler, Trash2
} from 'lucide-react';
import {
  ScoutRecorder, ScoutBatch, ScoutCalibration, isMotionSupported
} from '../services/scoutMode';
import {
  saveTrace, getCalibration, setCalibration, clearCalibration,
  scoutSummary, clearTraces, type ScoutSummary
} from '../services/scoutTraceStore';
import { roughnessColor, roughnessLabel } from '../config/scoutRoughness';
import { uploadTelemetryBatch } from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';
import { Sheet } from './ui/Sheet';

interface ScoutModePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onRequireAuth: () => void;
}

/**
 * Scout Mode — passive road-roughness recording.
 *
 * Runs the accelerometer while you drive, scores the ride about once a
 * second, and draws the result on your own map as a line that fades from
 * straw to crimson as the road gets worse. See `services/scoutMode.ts` for
 * what is measured and `config/scoutRoughness.ts` for what the drawing means.
 *
 * ---------------------------------------------------------------------------
 * IT IS ON THE MAP NOW, AND IT IS YOURS
 * ---------------------------------------------------------------------------
 *
 * This panel used to carry a paragraph headed "Not on the map yet", because
 * the chain ended one link short: the recorder worked, the batch uploaded,
 * points were paid, and nothing anywhere read the result. Not one metre
 * recorded here had ever been drawn for anybody.
 *
 * What changed is not that the crowd arrived — there is no crowd. It is that
 * the drive is kept on the phone that recorded it and drawn immediately, so
 * the feature is worth something to ONE person on their first drive instead
 * of being worth nothing until thousands of people have used it. Batches
 * still upload for the pooled version later; nothing on the map waits for it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ASKS FOR A CALIBRATION DRIVE
 * ---------------------------------------------------------------------------
 *
 * A stiff pickup and a soft van record the same road differently, and no
 * absolute threshold is right for both. One minute on a road you know is
 * smooth gives the app your vehicle's own floor, and everything after that
 * means "rougher than my own smooth road" — which is a real statement about
 * a road for one driver, with no crowd required.
 *
 * Skipping it is allowed. The app then uses a default baseline and says
 * "uncalibrated" everywhere the number is shown, because a guess wearing the
 * same colours as a measurement is the thing this codebase does not ship.
 */
export const ScoutModePanel: React.FC<ScoutModePanelProps> = ({ isOpen, onClose, onRequireAuth }) => {
  const { user } = useAuth();
  const recorderRef = useRef<ScoutRecorder | null>(null);

  const [running, setRunning] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [speedKph, setSpeedKph] = useState(0);
  const [roughness, setRoughness] = useState<number | null>(null);
  const [samples, setSamples] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [calibration, setCal] = useState<ScoutCalibration | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [summary, setSummary] = useState<ScoutSummary | null>(null);

  /** Read once when the sheet opens; refreshed as drives are stored. */
  const refresh = async () => {
    setCal(await getCalibration());
    setSummary(await scoutSummary());
  };

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen]);

  // Tear the recorder down if the component unmounts mid-session.
  useEffect(() => () => { recorderRef.current?.stop(); }, []);

  /* ------------------------------------------------------------------ */
  /* Recording                                                           */
  /* ------------------------------------------------------------------ */

  const handleBatch = async (batch: ScoutBatch) => {
    setDistanceM((d) => d + batch.distanceM);

    if (!batch.dashMounted) { setRejected((r) => r + 1); return; }

    /*
     * KEPT ON THIS PHONE FIRST, UPLOADED SECOND.
     *
     * The drive is drawn from local storage, so it must survive a dead
     * connection, a signed-out camper and a Supabase that is not there. An
     * upload that fails costs the pooled dataset a minute of driving; it must
     * never cost the camper the road they just drove.
     */
    const stored = await saveTrace(batch);
    if (stored) void refresh();

    const result = await uploadTelemetryBatch({
      recordedAt: batch.recordedAt,
      path: batch.path,
      sampleHz: batch.sampleHz,
      meanSpeedKph: batch.meanSpeedKph,
      // Deviations are mean-centred, so RMS² is exactly the variance the
      // column has always held. Same number, honestly named at both ends.
      verticalVariance: Number((batch.verticalRms ** 2).toFixed(4)),
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
      calibration,
      onBatch: handleBatch,
      onStatus: (s) => {
        setRunning(s.running);
        setMounted(s.mounted);
        setSpeedKph(s.speedKph);
        setRoughness(s.roughness);
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
    void refresh();
  };

  /* ------------------------------------------------------------------ */
  /* Calibration                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * One minute on a road the camper says is smooth.
   *
   * The batch is NOT stored as a trace — it is a measurement of the vehicle,
   * not of a road, and drawing it would put a straw line on a stretch of
   * asphalt nobody needs to know about.
   */
  const startCalibration = async () => {
    setStarting(true);
    setError(null);

    const recorder = new ScoutRecorder({
      batchSeconds: 60,
      onBatch: async (batch) => {
        if (!batch.dashMounted) {
          setError(
            batch.rejectReason ??
              'That minute did not qualify. Mount the phone and keep moving above 5 km/h.'
          );
          return;
        }

        await setCalibration({
          baseline: batch.rawRoughness,
          recordedAt: batch.recordedAt,
          distanceM: batch.distanceM,
          meanSpeedKph: batch.meanSpeedKph
        });

        await recorderRef.current?.stop();
        recorderRef.current = null;
        setCalibrating(false);
        void refresh();
      },
      onStatus: (s) => {
        setMounted(s.mounted);
        setSpeedKph(s.speedKph);
        setSamples(s.samples);
      }
    });

    const result = await recorder.start();
    setStarting(false);
    if (!result.ok) { setError(result.message); return; }
    recorderRef.current = recorder;
    setCalibrating(true);
  };

  const cancelCalibration = async () => {
    await recorderRef.current?.stop();
    recorderRef.current = null;
    setCalibrating(false);
  };

  if (!isOpen) return null;
  const supported = isMotionSupported();
  const busy = running || calibrating;

  return (
    <Sheet
      isOpen
      onClose={onClose}
      variant="dialog"
      icon={<Activity className="w-4 h-4 text-amber-400" />}
      title="Scout Mode"
      subtitle="Record how rough a road is as you drive it"
    >
      <div className="p-4 space-y-4 scroll-soft">
        <p className="text-xs text-slate-400 leading-snug">
          Records how rough a road is while you drive it, using your phone&apos;s motion
          sensors, and draws it on your map. Mount the phone, start a session, and
          forget about it.
        </p>

        {/*
          WHAT IT KNOWS AND WHAT IT DOES NOT.

          It measures the ride. It cannot tell dirt from gravel — no
          accelerometer can — and the backroads layer already answers that
          from OpenStreetMap. Saying so here stops the colours being read as
          a claim about the surface.
        */}
        <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/60">
          <p className="text-[12px] text-slate-300 leading-snug">
            <span className="font-bold text-slate-200">Roughness, not surface.</span>{' '}
            A phone can feel how hard a road hits; it cannot tell dirt from gravel.
            What it records is the ride — and only on the roads you personally drive.
            Turn on <span className="font-semibold text-slate-200">Roads I&apos;ve driven</span>{' '}
            in the map&apos;s layer menu to see it.
          </p>
        </div>

        {!supported && (
          <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-700/50 flex gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200">
              This device has no motion sensors. Scout Mode needs a phone or tablet.
            </p>
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/* Calibration                                                 */}
        {/* ---------------------------------------------------------- */}
        {supported && !running && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-[12px] font-bold uppercase tracking-wider text-slate-400">
                Your vehicle&apos;s baseline
              </span>
            </div>

            {calibrating ? (
              <>
                <p className="text-[12px] text-slate-300 leading-snug">
                  Keep driving the smooth road for a minute. {speedKph} km/h,{' '}
                  {mounted ? 'phone mounted' : 'phone not steady yet'}.
                </p>
                <button
                  onClick={cancelCalibration}
                  className="w-full h-9 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold text-xs"
                >
                  Cancel
                </button>
              </>
            ) : calibration ? (
              <>
                <p className="text-[12px] text-slate-300 leading-snug">
                  Calibrated on {new Date(calibration.recordedAt).toLocaleDateString()} at{' '}
                  {Math.round(calibration.meanSpeedKph)} km/h. Roughness is measured against
                  your own smooth road.
                </p>
                <button
                  onClick={async () => { await clearCalibration(); void refresh(); }}
                  className="w-full h-9 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold text-xs"
                >
                  Redo it (new vehicle, new suspension)
                </button>
              </>
            ) : (
              <>
                <p className="text-[12px] text-amber-200/90 leading-snug">
                  <span className="font-bold text-amber-100">Not calibrated.</span> Colours
                  are using a default that assumes an average vehicle, so they will be
                  wrong for yours in one direction or the other. One minute on a road you
                  know is smooth fixes it.
                </p>
                <button
                  onClick={startCalibration}
                  disabled={starting}
                  className="w-full h-9 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-xs flex items-center justify-center gap-1.5"
                >
                  {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ruler className="w-3.5 h-3.5" />}
                  Calibrate on a smooth road
                </button>
              </>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/* Live session                                                */}
        {/* ---------------------------------------------------------- */}
        {running && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 space-y-3 anim-in-up">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase tracking-wider text-slate-400">Recording</span>
              <span className="flex items-center gap-1.5 text-[12px] font-bold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            </div>

            {/* Mount check — the thing that gates everything */}
            <div className={`p-2 rounded-lg border flex items-center gap-2 ${
              mounted ? 'bg-emerald-950/50 border-emerald-700/50' : 'bg-amber-950/50 border-amber-700/50'
            }`}>
              <Smartphone className={`w-3.5 h-3.5 ${mounted ? 'text-emerald-400' : 'text-amber-400'}`} />
              <span className={`text-xs font-semibold ${mounted ? 'text-emerald-200' : 'text-amber-200'}`}>
                {mounted ? 'Phone is mounted' : 'Phone is moving too much'}
              </span>
            </div>
            {!mounted && (
              <p className="text-[12px] text-amber-300/80 leading-snug -mt-1.5">
                Nothing is being recorded. Secure the phone in a dash or vent mount so
                movement reflects the road, not your hands.
              </p>
            )}

            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Speed</p>
                <p className="text-sm font-bold text-slate-100">{speedKph}</p>
                <p className="text-[11px] text-slate-500">km/h</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Samples</p>
                <p className="text-sm font-bold text-slate-100">{samples}</p>
                <p className="text-[11px] text-slate-500">buffered</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Distance</p>
                <p className="text-sm font-bold text-slate-100">{(distanceM / 1000).toFixed(1)}</p>
                <p className="text-[11px] text-slate-500">km</p>
              </div>
            </div>

            {roughness !== null && (
              <div className="flex items-center gap-2 pt-2 border-t border-slate-700">
                <Gauge className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-400">Ride right now:</span>
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded"
                  style={{
                    backgroundColor: `${roughnessColor(roughness)}22`,
                    color: roughnessColor(roughness)
                  }}
                >
                  {roughnessLabel(roughness)}
                </span>
                {!calibration && (
                  <span className="text-[11px] text-slate-500">uncalibrated</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/* What this phone holds                                       */}
        {/* ---------------------------------------------------------- */}
        {summary && summary.traces > 0 && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-2">
            <p className="text-[12px] text-slate-300 leading-snug">
              <span className="font-bold text-slate-200">
                About {summary.distanceKm} km
              </span>{' '}
              of road recorded on this phone, across {summary.traces}{' '}
              {summary.traces === 1 ? 'drive' : 'drives'}. It draws on the map straight
              away and works with no signal.
            </p>
            <button
              onClick={async () => { await clearTraces(); void refresh(); }}
              disabled={busy}
              className="w-full h-9 rounded-xl bg-rose-950/50 hover:bg-rose-900/50 disabled:opacity-40 text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Erase my recorded roads
            </button>
          </div>
        )}

        {(uploaded > 0 || rejected > 0) && (
          <div className="flex gap-2">
            <div className="flex-1 rounded-xl bg-emerald-950/40 border border-emerald-700/40 p-2.5 text-center">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mx-auto mb-1" />
              <p className="text-sm font-bold text-emerald-200">{uploaded}</p>
              <p className="text-[11px] text-emerald-300/70">minutes uploaded</p>
            </div>
            <div className="flex-1 rounded-xl bg-slate-800/50 border border-slate-700 p-2.5 text-center">
              <AlertTriangle className="w-3.5 h-3.5 text-slate-400 mx-auto mb-1" />
              <p className="text-sm font-bold text-slate-300">{rejected}</p>
              <p className="text-[11px] text-slate-500">filtered out</p>
            </div>
          </div>
        )}

        {error && (
          <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-700/50">
            <p className="text-xs text-rose-200">{error}</p>
          </div>
        )}

        <button
          onClick={running ? stop : start}
          disabled={!supported || starting || calibrating}
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
            <span className="text-[12px] font-bold uppercase tracking-wider text-slate-400">
              How points work here
            </span>
          </div>
          <p className="text-[12px] text-slate-400 leading-snug">
            5 points per accepted minute, up to 6 a day. A minute only counts when the
            phone is mounted, you&apos;re moving above 5 km/h, and you covered at least
            200 m. Rejected minutes are still uploaded so the filter can be improved —
            they just don&apos;t pay, and they aren&apos;t drawn.
          </p>
          <p className="text-[12px] text-slate-500 leading-snug">
            Pooling everybody&apos;s drives into one shared picture of a road is not built
            yet. What you see on your map is your own driving.
          </p>
          <p className="text-[12px] text-slate-500 leading-snug">
            Uses GPS and motion sensors continuously, so expect noticeable battery drain.
            Best run while plugged in.
          </p>
        </div>
      </div>
    </Sheet>
  );
};
