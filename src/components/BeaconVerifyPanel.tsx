import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clock, Loader2, AlertTriangle, MapPin, ShieldAlert, Star, Moon, Radar
} from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { DwellRecorder, clearStoredArrival } from '../services/beaconService';
import {
  submitBeaconVerification, reportBeaconSpot, submitSpotVisit
} from '../services/dataService';
import {
  BEACON_TAKEDOWN_OPTIONS, DWELL_EXPLAINER, DWELL_MINUTES_REQUIRED,
  GEOFENCE_METRES, beaconTierStyle, nextTierHint
} from '../config/beacon';
import { SPOT_SCALE_FIELDS, scaleLabel } from '../config/spotReport';
import { SpotReportSheet, type SpotReportSubmission } from './SpotReportSheet';
import type { BeaconSpot, BeaconDwellState, BeaconOutcome } from '../types';

interface BeaconVerifyPanelProps {
  isOpen: boolean;
  onClose: () => void;
  spot: BeaconSpot | null;
  onRequireAuth: () => void;
  /** Fired after anything that changes the spot, so the map layer refetches. */
  onSpotWithdrawn: (spotId: string) => void;
}

/**
 * What a camper sees when they tap a Beacon spot.
 *
 * ---------------------------------------------------------------------------
 * THE WARNING COMES FIRST
 * ---------------------------------------------------------------------------
 *
 * On a flagged spot, the first thing in this sheet is what happened to the
 * camper who got knocked on, in their own words. Not the tier name, not the
 * conditions, not a button. That spot is red precisely because somebody was
 * woken up at 3am, and the entire reason it is still drawn on the map instead
 * of quietly deleted is so the next person reads that sentence before they
 * decide anything.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO CONTRIBUTE, HONESTLY LABELLED
 * ---------------------------------------------------------------------------
 *
 * A quick report needs a photo and a position within 150 m. An overnight vouch
 * needs the four-hour dwell as well. Both move the spot up the ladder, and the
 * sheet does not pretend they are the same act — the second one is described
 * as the stronger thing it is, and `DWELL_EXPLAINER` still says exactly what
 * the app can and cannot observe while the tab is closed.
 */
export const BeaconVerifyPanel: React.FC<BeaconVerifyPanelProps> = ({
  isOpen, onClose, spot, onRequireAuth, onSpotWithdrawn
}) => {
  const { user } = useAuth();
  const toast = useToast();

  const recorderRef = useRef<DwellRecorder | null>(null);
  const [dwell, setDwell] = useState<BeaconDwellState | null>(null);
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportIsOvernight, setReportIsOvernight] = useState(false);

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

    const recorder = new DwellRecorder({ spotId: spot.id, onUpdate: setDwell });
    recorderRef.current = recorder;

    const started = await recorder.start();
    if (!started.ok) {
      toast.error('Could not start the check-in', started.message);
      return;
    }
    setTracking(true);
  }, [spot, user, onRequireAuth, toast]);

  const openReport = (overnight: boolean) => {
    if (!user) { onRequireAuth(); return; }
    setReportIsOvernight(overnight);
    setReportOpen(true);
  };

  /**
   * One submit handler for both paths.
   *
   * The overnight path goes through `beacon_submit_verification`, which is
   * still the only thing that can assert a four-hour stay; the quick path goes
   * through `beacon_submit_visit`. They write the same report either way, so
   * a spot does not end up with richer data depending on which button was
   * pressed.
   */
  const handleSubmit = useCallback(
    async (submission: SpotReportSubmission) => {
      if (!spot) return { ok: false, message: 'That spot is no longer on the map.' };

      const { coords } = submission.position;

      if (reportIsOvernight) {
        const photoPath = submission.report.photoPaths?.[0] ?? '';
        const result = await submitBeaconVerification(
          spot.id,
          coords.latitude,
          coords.longitude,
          coords.accuracy,
          photoPath,
          {
            // The only answer the database acts on. Everything else about how
            // the night went now lives in the report itself.
            signs_restricted: submission.report.gotKnocked === true,
            // Sent only when the camper actually answered it — see the note on
            // BeaconVerificationAnswers about storing silence as a denial.
            ground_flat: submission.report.levelGround != null
              ? submission.report.levelGround >= 1
              : undefined,
            note: submission.report.comment
          },
          submission.report
        );

        if (result.ok) {
          // The stay is logged and closed out. Leaving the arrival behind means
          // the next sheet opens showing a clock that has been running for
          // eleven hours at a spot the camper left this morning.
          await clearStoredArrival(spot.id);
          void recorderRef.current?.stop();
          setTracking(false);
          onSpotWithdrawn(spot.id);
        }

        return { ok: result.ok, message: result.message };
      }

      const result = await submitSpotVisit(
        spot.id,
        coords.latitude,
        coords.longitude,
        coords.accuracy,
        submission.report,
        submission.clientFlags
      );

      // Not a withdrawal any more — the callback's job is "the spot changed,
      // go and refetch", which is true of every accepted report.
      if (result.ok) onSpotWithdrawn(spot.id);

      return { ok: result.ok, message: result.message };
    },
    [spot, reportIsOvernight, onSpotWithdrawn]
  );

  const takeDown = async (outcome: BeaconOutcome) => {
    if (!spot) return;
    if (!user) { onRequireAuth(); return; }

    setBusy(true);
    const result = await reportBeaconSpot(spot.id, outcome);
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
  const flagged = spot.tier === 'flagged';
  const hint = nextTierHint(spot.tier, spot.verifyCount);

  return (
    <>
      <Sheet
        isOpen={isOpen && !reportOpen}
        onClose={onClose}
        title={spot.label}
        subtitle={`${style.emoji} ${style.label}`}
        icon={flagged
          ? <ShieldAlert className="w-4 h-4 text-red-400" />
          : <Clock className="w-4 h-4 text-sky-400" />}
      >
        <div className="p-4 space-y-3">
          {/* ---- The warning, before anything else ---- */}
          {flagged && (
            <div className="rounded-2xl border border-red-700/60 bg-red-950/40 p-3 anim-in-up">
              <p className="text-[11px] font-bold text-red-200 flex items-center gap-1.5 mb-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                Somebody got a knock here
              </p>

              {spot.knock?.comment ? (
                <p className="text-xs text-red-100 leading-snug italic">
                  “{spot.knock.comment}”
                </p>
              ) : (
                <p className="text-xs text-red-100/80 leading-snug">
                  The camper who reported it did not leave a note.
                </p>
              )}

              <p className="text-[10px] text-red-300/80 mt-2 leading-snug">
                {spot.knock && spot.knock.count > 1
                  ? `${spot.knock.count} campers have reported being moved on here. `
                  : ''}
                This spot is still on the map on purpose — so you see this before
                you park, rather than finding the same empty pullout and parking
                here anyway.
              </p>
            </div>
          )}

          {/* ---- The tier, in its own words ---- */}
          <div
            className="rounded-2xl border p-3"
            style={{ borderColor: style.ring, background: style.colorSoft }}
          >
            <p className="text-[11px] text-slate-200 leading-snug">{style.meaning}</p>
            {spot.landBasis && (
              <p className="text-[10px] text-slate-400 mt-1 leading-snug">{spot.landBasis}</p>
            )}
            {hint && (
              <p className="text-[10px] text-slate-400 mt-1.5 font-semibold">{hint}</p>
            )}
          </div>

          {/* ---- What campers said ---- */}
          <SpotConditionsCard spot={spot} />

          {/* ---- Report on it ---- */}
          {!tracking && (
            <>
              <button
                onClick={() => openReport(false)}
                className="w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2"
              >
                <Star className="w-4 h-4" />
                {spot.verifyCount === 0 ? 'Be the first to report on it' : 'Report on this spot'}
              </button>
              <p className="text-[10px] text-slate-500 text-center leading-snug -mt-1">
                A photo and being here is all it takes. About thirty seconds.
              </p>

              <button
                onClick={startTracking}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-700 text-slate-200 hover:border-sky-600/60 font-bold text-[11px] flex items-center justify-center gap-2"
              >
                <Moon className="w-3.5 h-3.5" />
                I&apos;m staying the night here
              </button>
              <p className="text-[10px] text-slate-500 leading-snug">{DWELL_EXPLAINER}</p>
            </>
          )}

          {/* ---- The overnight clock ---- */}
          {tracking && (
            <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-3">
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

              <button
                onClick={() => openReport(ready)}
                className="mt-3 w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2"
              >
                <Star className="w-3.5 h-3.5" />
                {ready ? 'Vouch for this spot' : 'Report on it now anyway'}
              </button>

              {!ready && (
                <p className="text-[10px] text-slate-500 mt-1.5 text-center leading-snug">
                  You can file a normal report right now. Staying the full four
                  hours makes it an overnight vouch instead.
                </p>
              )}
            </div>
          )}

          {/* ---- Takedowns ---- */}
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
                  {busy ? <Loader2 className="w-3 h-3 animate-spin mx-auto" />
                        : <>{option.emoji} {option.label}</>}
                </button>
              ))}
            </div>
            {/*
              The honest description of what each button now does. Three of
              them turn the pin red and leave it up; only "gone" removes it,
              because only "gone" means there is nothing left to warn anybody
              about.
            */}
            <p className="text-[10px] text-slate-500 mt-2 leading-snug">
              The first three turn this spot red for everyone and leave it on the
              map with your note, so the next camper is warned instead of
              finding it themselves. “Gated, gone or unusable” takes it off
              entirely — there is nothing there to warn about.
            </p>
          </div>
        </div>
      </Sheet>

      <SpotReportSheet
        isOpen={reportOpen}
        onClose={() => { setReportOpen(false); onClose(); }}
        mode="report"
        at={[spot.latitude, spot.longitude]}
        existingName={spot.label}
        onRequireAuth={onRequireAuth}
        onSubmit={handleSubmit}
        overnight={reportIsOvernight}
      />
    </>
  );
};

/* ------------------------------------------------------------------ */

/**
 * The averaged answers, showing only what somebody actually answered.
 *
 * A field nobody has answered is omitted entirely rather than rendered as a
 * zero or as "unknown" — a list of eight "unknown" rows is noise, and a zero
 * would be a lie. When nothing at all has been answered the card does not
 * render, and the tier line above it has already said nobody has been here.
 */
const SpotConditionsCard: React.FC<{ spot: BeaconSpot }> = ({ spot }) => {
  const conditions = spot.conditions;
  if (!conditions || conditions.sampleSize === 0) return null;

  const rows = SPOT_SCALE_FIELDS
    .map((field) => ({
      field,
      label: scaleLabel(field.key, conditions[field.key])
    }))
    .filter((row) => row.label !== null);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-3">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
        <Radar className="w-3 h-3" />
        What {conditions.sampleSize} camper{conditions.sampleSize === 1 ? '' : 's'} said
      </p>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {rows.map(({ field, label }, i) => (
          <div
            key={field.key}
            data-stagger={Math.min(i, 8)}
            className="flex items-baseline justify-between gap-2 anim-in-up"
          >
            <span className="text-[10px] text-slate-400 truncate">
              {field.emoji} {field.question.replace(/\?$/, '')}
            </span>
            <span className="text-[10px] font-bold text-slate-200 shrink-0 text-right">
              {label}
            </span>
          </div>
        ))}
      </div>

      {typeof conditions.cellBars === 'number' && (
        <p className="text-[10px] text-slate-400 mt-2 pt-2 border-t border-slate-700/60">
          Signal around {Math.round(conditions.cellBars)}/5 — an estimate from tower
          positions, not a reading anybody took.
        </p>
      )}

      {/* The permanent caveat on averaged data. Two campers agreeing is not a
          survey, and the sample size is shown rather than smoothed over. */}
      {conditions.sampleSize < 3 && (
        <p className="text-[10px] text-slate-500 mt-2 leading-snug">
          That is {conditions.sampleSize === 1 ? 'one camper' : 'a couple of campers'} —
          treat it as a hint, not a description.
        </p>
      )}
    </div>
  );
};
