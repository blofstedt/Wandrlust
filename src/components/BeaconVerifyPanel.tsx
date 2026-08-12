import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Camera, Loader2, Check, AlertTriangle, MapPin } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { DwellRecorder, clearStoredArrival, positionTells } from '../services/beaconService';
import {
  submitBeaconVerification, reportBeaconSpot, uploadBeaconProof
} from '../services/dataService';
import {
  BEACON_QUESTIONS, BEACON_TAKEDOWN_OPTIONS, DWELL_EXPLAINER,
  DWELL_MINUTES_REQUIRED, GEOFENCE_METRES, beaconTierStyle
} from '../config/beacon';
import type { BeaconSpot, BeaconDwellState, BeaconOutcome } from '../types';

interface BeaconVerifyPanelProps {
  isOpen: boolean;
  onClose: () => void;
  spot: BeaconSpot | null;
  onRequireAuth: () => void;
  /** Fired after a takedown so the map can drop the pin immediately. */
  onSpotWithdrawn: (spotId: string) => void;
}

/**
 * Vouching for a spot you actually slept at.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST DESCRIPTION OF THE FOUR-HOUR CHECK
 * ---------------------------------------------------------------------------
 *
 * A browser cannot record your location with the tab closed. Not "does not by
 * default" — cannot. So this screen must never imply that it watched you for
 * four hours, because a camper who believes that will close the app, come back
 * to nothing logged, and rightly feel lied to.
 *
 * What actually happens: a ping when you say you have arrived, a ping whenever
 * the app is open, a ping when you bring it back to the foreground, and a ping
 * when you submit. The server checks the first and last are inside the same
 * 50 m circle and four hours apart. `DWELL_EXPLAINER` says that in a sentence
 * and it is shown before the timer starts, not after.
 *
 * The takedown buttons at the bottom need none of that. Somebody who has just
 * been woken up by an officer should not have to have been running a timer.
 */
export const BeaconVerifyPanel: React.FC<BeaconVerifyPanelProps> = ({
  isOpen, onClose, spot, onRequireAuth, onSpotWithdrawn
}) => {
  const { user } = useAuth();
  const toast = useToast();

  const recorderRef = useRef<DwellRecorder | null>(null);
  const [dwell, setDwell] = useState<BeaconDwellState | null>(null);
  const [tracking, setTracking] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Always stop the watch on unmount. A geolocation watch nobody stopped keeps
  // the GPS warm and flattens a battery overnight — the exact battery somebody
  // sleeping in a van needs in the morning.
  useEffect(() => () => { void recorderRef.current?.stop(); }, []);

  // Closing the sheet is not the same as leaving the spot, so tracking keeps
  // running; only unmount and an explicit stop end it.
  useEffect(() => {
    if (!spot) { void recorderRef.current?.stop(); recorderRef.current = null; }
  }, [spot]);

  const startTracking = useCallback(async () => {
    if (!spot) return;
    if (!user) { onRequireAuth(); return; }

    const recorder = new DwellRecorder({
      spotId: spot.id,
      onUpdate: setDwell
    });
    recorderRef.current = recorder;

    const started = await recorder.start();
    if (!started.ok) {
      toast.error('Could not start the check-in', started.message);
      return;
    }
    setTracking(true);
  }, [spot, user, onRequireAuth, toast]);

  const submit = async () => {
    if (!spot) return;
    if (!user) { onRequireAuth(); return; }

    const position = recorderRef.current?.currentPosition();
    if (!position) {
      toast.error('No location yet', 'Give it a moment to find you, then try again.');
      return;
    }
    if (!photo) {
      toast.error('A photo is required', 'It is the part nobody can fake from the couch.');
      return;
    }

    setBusy(true);

    const uploaded = await uploadBeaconProof(spot.id, photo);
    if (!uploaded.ok || !uploaded.data) {
      setBusy(false);
      toast.error('Photo did not upload', uploaded.message);
      return;
    }

    // Client-side spoof tells are a hint for the log, never a verdict — the
    // checks that decide anything run in `beacon_record_ping`.
    const tells = positionTells(position);
    if (tells.length > 0) {
      console.info('[beacon] position tells:', tells.join(', '));
    }

    const result = await submitBeaconVerification(
      spot.id,
      position.coords.latitude,
      position.coords.longitude,
      position.coords.accuracy,
      uploaded.data,
      {
        signs_restricted: answers.signs_restricted === true,
        ground_flat: answers.ground_flat === true,
        quiet_overnight: answers.quiet_overnight === true,
        note: note.trim() || undefined
      }
    );

    setBusy(false);

    if (result.ok) {
      toast.success('Thanks for checking in', result.message);
      await clearStoredArrival(spot.id);
      void recorderRef.current?.stop();
      setTracking(false);
      // A camper reporting restricted signs has just taken the spot down.
      if (answers.signs_restricted === true) onSpotWithdrawn(spot.id);
      onClose();
    } else {
      toast.warning('Not logged yet', result.message);
    }
  };

  const takeDown = async (outcome: BeaconOutcome) => {
    if (!spot) return;
    if (!user) { onRequireAuth(); return; }

    setBusy(true);
    const result = await reportBeaconSpot(spot.id, outcome, note.trim() || undefined);
    setBusy(false);

    if (result.ok) {
      toast.success('Reported', result.message);
      onSpotWithdrawn(spot.id);
      onClose();
    } else {
      toast.error('Could not send that', result.message);
    }
  };

  if (!spot) return null;

  const style = beaconTierStyle(spot.tier);
  const minutes = dwell?.dwellMinutes ?? 0;
  const progress = Math.min(100, (minutes / DWELL_MINUTES_REQUIRED) * 100);
  const ready = dwell?.ready === true;

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={spot.label}
      subtitle={`${style.emoji} ${style.label}`}
      icon={<Clock className="w-4 h-4 text-sky-400" />}
    >
      <div className="p-4 space-y-3">
        {!tracking ? (
          <>
            <p className="text-[11px] text-slate-300 leading-snug">{DWELL_EXPLAINER}</p>
            <button
              onClick={startTracking}
              className="w-full px-4 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-2"
            >
              <MapPin className="w-4 h-4" />
              I'm parked here
            </button>
          </>
        ) : (
          <>
            {/* The clock. Frame-based width transition, so it collapses under
                prefers-reduced-motion along with everything else. */}
            <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-xs font-bold text-slate-100">
                  {Math.floor(minutes / 60)}h {minutes % 60}m here
                </p>
                <p className="text-[10px] text-slate-400">
                  {ready ? 'Long enough' : `${DWELL_MINUTES_REQUIRED / 60}h needed`}
                </p>
              </div>
              <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-sky-500 transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {typeof dwell?.distanceM === 'number' && (
                <p className="text-[10px] text-slate-400 mt-1.5">
                  {dwell.distanceM} m from the spot — check-in needs you within {GEOFENCE_METRES} m.
                </p>
              )}
              {dwell && !dwell.ok && dwell.message && (
                <p className="text-[10px] text-amber-300 mt-1.5 leading-snug">{dwell.message}</p>
              )}
            </div>

            {/* The form. Always visible, so a camper knows what they will be
                asked before they have sat for four hours. */}
            <div className="space-y-1.5">
              {BEACON_QUESTIONS.map((q) => (
                <div key={q.key} className="rounded-xl border border-slate-700 bg-slate-800/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-200 font-semibold">{q.question}</p>
                    <div className="flex gap-1 shrink-0">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          onClick={() => setAnswers((a) => ({ ...a, [q.key]: value }))}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border ${
                            answers[q.key] === value
                              ? 'bg-sky-950/60 border-sky-500/60 text-sky-200'
                              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
                          }`}
                        >
                          {value ? 'Yes' : 'No'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {q.hint && answers[q.key] === true && (
                    <p className="text-[10px] text-amber-300 mt-1 anim-in-up">{q.hint}</p>
                  )}
                </div>
              ))}
            </div>

            <label className="block">
              <span className="sr-only">Photo of the spot</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <div
                className={`w-full px-3 py-2.5 rounded-xl border text-[11px] font-semibold flex items-center justify-center gap-2 cursor-pointer ${
                  photo
                    ? 'bg-emerald-950/40 border-emerald-600/50 text-emerald-200'
                    : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:border-slate-600'
                }`}
              >
                {photo ? <Check className="w-3.5 h-3.5" /> : <Camera className="w-3.5 h-3.5" />}
                {photo ? 'Photo attached' : 'Take a photo of the spot'}
              </div>
            </label>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything the next camper should know?"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
            />

            <button
              onClick={submit}
              disabled={busy || !ready || !photo}
              className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Vouch for this spot
            </button>

            {!ready && (
              <p className="text-[10px] text-slate-500 text-center">
                The button turns on once you have been here four hours.
              </p>
            )}
          </>
        )}

        {/*
          Takedowns need no timer, no photo and no dwell. Somebody who has just
          been woken up at 3am gets one tap and it is off the map.
        */}
        <div className="pt-2 border-t border-slate-800">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
              Went badly?
            </p>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {BEACON_TAKEDOWN_OPTIONS.map((option, i) => (
              <button
                key={option.outcome}
                data-stagger={Math.min(i, 8)}
                disabled={busy}
                onClick={() => takeDown(option.outcome)}
                className="px-2 py-2 rounded-xl border border-slate-700 bg-slate-800/50 text-slate-300 hover:border-red-600/60 hover:text-red-200 text-[10px] font-semibold anim-in-up disabled:opacity-50"
              >
                {option.emoji} {option.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-2 leading-snug">
            Any of these takes the spot off the map straight away, for everyone.
            It also teaches Beacon not to suggest places like it again.
          </p>
        </div>
      </div>
    </Sheet>
  );
};
