import React, { useEffect, useState, useCallback } from 'react';
import {
  X, MapPin, Star, Navigation, Bookmark, Signal, Droplet,
  Flame, Dog, Clock, ShieldCheck, Loader2, CheckCircle2,
  ChevronUp, Camera, ThermometerSun, Copy, Check, Flag, Trash2
} from 'lucide-react';
import type { Campsite, SpotRemovalState } from '../types';
import {
  ROAD_ACCESS_LABEL, WATER_LABEL, UNKNOWN_LABEL, bestCellSignal
} from '../utils/amenities';
import {
  getCampsiteDisplayImage, getCloseSatelliteImageUrl, getStreetViewUrl
} from '../utils/imageUtils';
import { getDirectionsUrl, directionsAppName } from '../utils/handoff';
import { fetchWeather, WeatherSnapshot, EMPTY_WEATHER, summarise } from '../services/weatherService';
import { fetchCellCoverage, UNKNOWN_COVERAGE } from '../services/cellCoverageService';
import type { CellCoverage } from '../types';
import {
  fetchRulesAtPoint, fetchHazardsAtPoint, checkIn,
  fetchCampsiteRemovalState, removeMyCampsite,
  PointRules, PointHazard
} from '../services/dataService';
import { HazardAlertPanel } from './HazardAlertPanel';
import { CellCoverageCard } from './TripConditions';
import { NearbyFiresCard } from './NearbyFiresCard';
import { Admin1Line } from './Admin1Line';
import { SubmissionChip } from './SubmissionChip';
import { ReportContentSheet } from './ReportContentSheet';
import { useAuth } from '../contexts/AuthContext';
import { haptic } from '../utils/animation';

type Capacity = 'empty' | 'light' | 'busy' | 'full';

const CAPACITY_STYLE: Record<string, { label: string; className: string }> = {
  empty: { label: 'Empty', className: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40' },
  light: { label: 'A few rigs', className: 'bg-lime-600/20 text-lime-300 border-lime-500/40' },
  busy: { label: 'Busy', className: 'bg-amber-600/20 text-amber-300 border-amber-500/40' },
  full: { label: 'Full', className: 'bg-rose-600/20 text-rose-300 border-rose-500/40' },
  unknown: { label: 'Unknown', className: 'bg-slate-700/40 text-slate-400 border-slate-600' }
};

/** How much of the screen each snap point takes, as one source of truth. */
const SNAP_FRACTION = { peek: 0.26, half: 0.58, full: 0.92 } as const;
type Snap = keyof typeof SNAP_FRACTION;

interface CampsiteBottomSheetProps {
  campsite: Campsite | null;
  isSaved: boolean;
  onClose: () => void;
  onToggleSave: (site: Campsite) => void;
  onRequireAuth: () => void;
  /**
   * The camper took their own spot back down.
   *
   * Fired only after the removal has actually happened. The parent owns what
   * follows — dropping the pin from the map, deleting the device copy and
   * closing this drawer — because this component knows about one spot and the
   * spot now needs to disappear from four places.
   */
  onRemoved?: (site: Campsite) => void;
  /**
   * How many pixels of screen this drawer is covering, whenever that changes.
   *
   * The map is behind it and has to get the pin out from under it, which it
   * can only do against a real measurement — `vh` on a phone means one thing
   * with the browser's address bar showing and another without it.
   */
  onHeightChange?: (px: number) => void;
}

/**
 * Sliding detail drawer for a map pin.
 *
 * Replaces the full-screen modal: the map stays visible behind it, which
 * matters when comparing a pin against the surrounding terrain.
 *
 * Three snap points — peek, half, full — because the useful amount of detail
 * differs between "which of these three?" and "am I sleeping here tonight?".
 */
export const CampsiteBottomSheet: React.FC<CampsiteBottomSheetProps> = ({
  campsite, isSaved, onClose, onToggleSave, onRequireAuth, onRemoved, onHeightChange
}) => {
  const { user } = useAuth();
  const [snap, setSnap] = useState<Snap>('half');
  const [weather, setWeather] = useState<WeatherSnapshot>(EMPTY_WEATHER);
  const [rules, setRules] = useState<PointRules[]>([]);
  const [hazards, setHazards] = useState<PointHazard[]>([]);
  const [coverage, setCoverage] = useState<CellCoverage>(UNKNOWN_COVERAGE);
  const [loading, setLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  /** null until the server has answered. Nothing about removal is drawn before. */
  const [removal, setRemoval] = useState<SpotRemovalState | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Load everything context-dependent when the pin changes.
  useEffect(() => {
    if (!campsite) return;
    let cancelled = false;
    setLoading(true);
    setNotice(null);

    Promise.all([
      fetchWeather(campsite.latitude, campsite.longitude),
      fetchRulesAtPoint(campsite.latitude, campsite.longitude),
      fetchHazardsAtPoint(campsite.latitude, campsite.longitude),
      fetchCellCoverage(campsite.latitude, campsite.longitude)
    ]).then(([w, r, h, c]) => {
      if (cancelled) return;
      setWeather(w);
      setRules(r);
      setHazards(h);
      setCoverage(c);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [campsite]);

  /**
   * Ask whether this spot is still the camper's to take down.
   *
   * Separate from the conditions load above because it asks a different kind
   * of question and only for spots this camper added. Asked up front so the
   * button is never drawn on a spot that would refuse it — a remove button
   * that errors is worse than no button, because by the time the error is read
   * the camper has already decided the spot is gone.
   */
  useEffect(() => {
    setRemoval(null);
    setConfirmingRemove(false);
    if (!campsite?.submittedByMe) return;

    let cancelled = false;
    fetchCampsiteRemovalState(campsite.id).then((state) => {
      if (!cancelled) setRemoval(state);
    });

    return () => { cancelled = true; };
  }, [campsite]);

  /**
   * Take it down.
   *
   * A spot that never reached the server comes back `removed: false` and that
   * is still a success — the device copy was the only copy, and the parent is
   * about to delete it. Either way the parent is told exactly once, after the
   * server has agreed.
   */
  const handleRemove = useCallback(async () => {
    if (!campsite) return;

    setRemoving(true);
    const result = await removeMyCampsite(campsite.id);
    setRemoving(false);

    if (!result.ok) {
      // Somebody engaged with the spot between the check and the tap. Say what
      // the server said, and stop offering something it will not do.
      setConfirmingRemove(false);
      setRemoval({
        exists: true, mine: true, removable: false, others: 0,
        message: result.message
      });
      return;
    }

    haptic('success');
    onRemoved?.(campsite);
  }, [campsite, onRemoved]);

  /** Tell the map how much of itself is behind this drawer. */
  useEffect(() => {
    if (!onHeightChange) return;
    if (!campsite) { onHeightChange(0); return; }
    const report = () => onHeightChange(window.innerHeight * SNAP_FRACTION[snap]);
    report();
    window.addEventListener('resize', report);
    return () => {
      window.removeEventListener('resize', report);
      onHeightChange(0);
    };
  }, [campsite, snap, onHeightChange]);

  const handleCheckIn = useCallback(
    async (capacity: Capacity) => {
      if (!campsite) return;
      if (!user) { onRequireAuth(); return; }
      setCheckingIn(true);
      haptic('success');
      const result = await checkIn(campsite, capacity);
      setNotice(result.message);
      setCheckingIn(false);
    },
    [campsite, user, onRequireAuth]
  );

  if (!campsite) return null;

  const coords = `${campsite.latitude.toFixed(5)}, ${campsite.longitude.toFixed(5)}`;
  // Was `(campsite as any).capacity_status`. The field is `capacityStatus`,
  // and the cast is what hid it — every pin has shown "Unknown" regardless of
  // how many people had checked in.
  const capacityKey = campsite.capacityStatus ?? 'unknown';
  const capacity = CAPACITY_STYLE[capacityKey] ?? CAPACITY_STYLE.unknown;

  const amenities = campsite.amenities;
  const bestSignal = bestCellSignal(amenities);

  /**
   * Two ways a spot the camper added is still theirs to remove: the server
   * says nobody else has touched it, or the server has never heard of it at
   * all — added with no account or no signal, so the copy on this phone is the
   * only copy in existence. `removal === null` means the answer is not back
   * yet and nothing is offered.
   */
  const canRemove = removal !== null && (removal.removable || !removal.exists);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[1500]"
      style={{
        // Off the same fractions the map is told about, so what it moves out
        // from under is exactly what is on screen.
        height: `${SNAP_FRACTION[snap] * 100}vh`,
        transition: 'height 320ms cubic-bezier(0.16, 1.36, 0.36, 1)'
      }}
    >
      <div className="h-full mx-auto max-w-2xl bg-slate-900 border-t border-x border-slate-700 rounded-t-3xl shadow-2xl flex flex-col overflow-hidden anim-sheet-up">
        {/* Drag handle cycles the snap points */}
        <button
          onClick={() => setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek')}
          className="w-full pt-2.5 pb-1.5 flex flex-col items-center gap-1 shrink-0 hover:bg-slate-800/40 no-press"
          aria-label="Resize panel"
        >
          <div className="w-10 h-1 rounded-full bg-slate-600" />
          {snap === 'peek' && <ChevronUp className="w-3 h-3 text-slate-500 animate-pulse" />}
        </button>

        <div className="px-4 pb-3 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[9px] font-bold text-slate-300 uppercase tracking-wide">
                  {campsite.landType.replace('_', ' ')}
                </span>
                <span className={`px-1.5 py-0.5 rounded border text-[9px] font-bold ${capacity.className}`}>
                  {capacity.label}
                </span>
                {hazards.some((h) => h.kind === 'fire_ban') && (
                  <span className="px-1.5 py-0.5 rounded bg-orange-600 text-white text-[9px] font-bold flex items-center gap-1 anim-pulse-danger">
                    <Flame className="w-2.5 h-2.5" />
                    FIRE BAN
                  </span>
                )}
              </div>
              <h2 className="text-base font-bold text-slate-100 truncate">{campsite.name}</h2>
              <p className="text-[11px] text-slate-400 truncate">
                {campsite.address.nearestCity}
                {campsite.address.stateProvince && `, ${campsite.address.stateProvince}`}
              </p>
              {/*
                Country + state/province confirmed from the dataset,
                not from the address field. The address can say
                "Yellowstone NP" with no state, or have a stale
                province; the admin-1 lookup is authoritative and
                matches what the on-map state lines draw. Renders
                nothing if the point is outside US+CA — a Mexican or
                ocean tap is a quiet line, not a "we don't know"
                message.
              */}
              <Admin1Line
                latitude={campsite.latitude}
                longitude={campsite.longitude}
              />
              {/* The full version with its explanation — this sheet has the
                  room the card doesn't. */}
              <div className="mt-1.5">
                <SubmissionChip
                  state={campsite.submissionState}
                  submittedByMe={campsite.submittedByMe}
                  withDetail
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Quiet on purpose. Reporting is a rare, deliberate act, not a
                  primary action competing with Save. */}
              <button
                onClick={() => { haptic('tap'); setIsReporting(true); }}
                className="p-2 rounded-xl border bg-slate-800 border-slate-700 text-slate-500 hover:text-rose-300"
                aria-label="Report this spot"
                title="Report this spot"
              >
                <Flag className="w-4 h-4" />
              </button>
              <button
                onClick={() => { haptic('tap'); onToggleSave(campsite); }}
                className={`p-2 rounded-xl border ${
                  isSaved
                    ? 'bg-amber-500 text-slate-950 border-amber-400'
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'
                }`}
                aria-label={isSaved ? 'Saved' : 'Save'}
              >
                <Bookmark className="w-4 h-4" fill={isSaved ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-2.5 text-[11px] text-slate-400 flex-wrap">
            <span className="flex items-center gap-1">
              <Star className="w-3 h-3 text-amber-400" />
              {campsite.rating > 0 ? campsite.rating.toFixed(1) : '—'}
            </span>
            {bestSignal !== undefined && (
              <span className="flex items-center gap-1"><Signal className="w-3 h-3" />{bestSignal} bars</span>
            )}
            {amenities.stayLimitDays !== undefined && (
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{amenities.stayLimitDays}d</span>
            )}
            {weather.periods.length > 0 && (
              <span className="flex items-center gap-1 text-sky-300">
                <ThermometerSun className="w-3 h-3" />
                {summarise(weather)}
              </span>
            )}
          </div>
        </div>

        {snap !== 'peek' && (
          <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4 scroll-soft">
            {loading && (
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading conditions…
              </div>
            )}

            {/* Hazards first: safety before scenery */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Conditions &amp; alerts
              </h3>
              <HazardAlertPanel alerts={weather.alerts} pointHazards={hazards} compact />
            </section>

            {/*
              Active fire proximity. Same component the destination
              sheet uses — a saved campsite is a pin too, and the
              user who is opening this card deserves the same
              "fire X km away" line. The card renders nothing if
              there are no fires in range, so a quiet area is a
              quiet section, not a "no fires found" message.
            */}
            <NearbyFiresCard
              latitude={campsite.latitude}
              longitude={campsite.longitude}
            />

            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Are you here? Report capacity
              </h3>
              <div className="grid grid-cols-4 gap-1.5">
                {(['empty', 'light', 'busy', 'full'] as Capacity[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => handleCheckIn(c)}
                    disabled={checkingIn}
                    className={`px-2 py-2 rounded-xl border text-[10px] font-bold disabled:opacity-50 ${CAPACITY_STYLE[c].className}`}
                  >
                    {CAPACITY_STYLE[c].label}
                  </button>
                ))}
              </div>
              {notice && (
                <p className="text-[10px] text-emerald-300 mt-1.5 flex items-center gap-1 anim-in-up">
                  <CheckCircle2 className="w-3 h-3" />
                  {notice}
                </p>
              )}
              <p className="text-[9px] text-slate-500 mt-1">
                Checking in earns points and keeps capacity current for everyone else.
              </p>
            </section>

            <section>
              <div className="relative rounded-xl overflow-hidden bg-slate-800 aspect-video">
                <img
                  src={getCampsiteDisplayImage(campsite)}
                  alt={campsite.name}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = getCloseSatelliteImageUrl(
                      campsite.latitude, campsite.longitude
                    );
                  }}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                <a
                  href={getStreetViewUrl(campsite.latitude, campsite.longitude)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn absolute bottom-2 right-2 px-2 py-1 rounded-lg bg-slate-950/80 backdrop-blur-sm text-cyan-300 text-[10px] font-bold flex items-center gap-1 border border-cyan-500/40"
                >
                  <Camera className="w-2.5 h-2.5" />
                  Street View
                </a>
              </div>
            </section>

            {rules.length > 0 && (
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  Local rules
                </h3>
                {rules.slice(0, 2).map((r, i) => (
                  <div key={i} className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3 mb-2">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-xs font-bold text-slate-200">{r.land_name}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      {r.stay_limit_days && (
                        <div>
                          <span className="text-slate-500">Stay limit</span>
                          <p className="text-slate-200 font-semibold">{r.stay_limit_days} days</p>
                        </div>
                      )}
                      <div>
                        <span className="text-slate-500">Permit</span>
                        <p className="text-slate-200 font-semibold">
                          {r.permit_required ? r.permit_name ?? 'Required' : 'Not required'}
                        </p>
                      </div>
                    </div>
                    {r.leave_no_trace && (
                      <p className="text-[10px] text-slate-400 mt-2 leading-snug">{r.leave_no_trace}</p>
                    )}
                    <p className="text-[9px] text-slate-500 mt-2 pt-2 border-t border-slate-700/60">
                      {r.attribution}
                    </p>
                  </div>
                ))}
              </section>
            )}

            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Amenities
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {[
                  // Unknown reads as unknown, never as an absence.
                  { icon: Droplet, label: 'Water',
                    value: amenities.water ? WATER_LABEL[amenities.water] : UNKNOWN_LABEL },
                  { icon: Navigation, label: 'Road',
                    value: amenities.roadAccess ? ROAD_ACCESS_LABEL[amenities.roadAccess] : UNKNOWN_LABEL },
                  { icon: Flame, label: 'Fires',
                    value: amenities.fireRing === undefined
                      ? UNKNOWN_LABEL : amenities.fireRing ? 'Ring present' : 'None' },
                  { icon: Dog, label: 'Pets',
                    value: amenities.petFriendly === undefined
                      ? UNKNOWN_LABEL : amenities.petFriendly ? 'Allowed' : 'Not allowed' }
                ].map(({ icon: Icon, label, value }, i) => (
                  <div
                    key={label}
                    data-stagger={i}
                    className="rounded-xl bg-slate-800/50 border border-slate-700/60 px-2.5 py-2 anim-in-up"
                  >
                    <div className="flex items-center gap-1.5 text-slate-500">
                      <Icon className="w-3 h-3" />
                      <span className="text-[9px] uppercase tracking-wide font-bold">{label}</span>
                    </div>
                    <p className="text-[11px] text-slate-200 font-semibold capitalize mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/*
              Approximated coverage, alongside — not instead of — the recorded
              `cellSignal` amenity in the row above. They answer different
              questions: that one is what a camper who stood here reported,
              this one is where the towers are. Neither replaces the other, and
              a site usually has only one of them.
            */}
            <CellCoverageCard coverage={coverage} isLoading={loading} />

            {weather.periods.length > 0 && (
              <section>
                {/*
                  Renamed from "Forecast on arrival", which it never was — this
                  is the plain multi-period forecast for the site with no travel
                  time applied to it. The arrival-time version lives in the
                  destination sheet, where a route exists to work it out from.
                */}
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  Forecast here
                </h3>
                <div className="flex gap-2 overflow-x-auto pb-1 scroll-soft">
                  {weather.periods.slice(0, 6).map((p, i) => (
                    <div
                      key={p.startTime}
                      data-stagger={Math.min(i, 8)}
                      className="shrink-0 w-24 rounded-xl bg-slate-800/50 border border-slate-700/60 p-2 text-center anim-in-up"
                    >
                      <p className="text-[10px] font-bold text-slate-300 truncate">{p.name}</p>
                      <p className="text-lg font-bold text-slate-100 my-0.5">{p.temperature}°</p>
                      <p className="text-[9px] text-slate-400 leading-tight line-clamp-2">{p.shortForecast}</p>
                      {p.precipProbability != null && p.precipProbability > 0 && (
                        <p className="text-[9px] text-sky-400 mt-0.5">{p.precipProbability}% precip</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {weather.note && <p className="text-[10px] text-slate-500 italic">{weather.note}</p>}

            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">About</h3>
              <p className="text-[12px] text-slate-300 leading-relaxed">{campsite.description}</p>
            </section>

            <section className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(coords);
                  setCopied(true);
                  haptic('tap');
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-slate-700"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : coords}
              </button>
              <a
                href={getDirectionsUrl(campsite.latitude, campsite.longitude)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5"
                title={`Open in ${directionsAppName()}`}
              >
                <Navigation className="w-3.5 h-3.5" />
                Directions
              </a>
            </section>

            {/*
              ------------------------------------------------------------
              THE ONE THAT UNDOES A SUBMISSION
              ------------------------------------------------------------

              Only for the camper who added this spot, and only while it is
              still only theirs. Somebody pins a pullout from the side of the
              road, gets home and realises it was a driveway — until now the
              only route off the map was the report flow, which is built for
              enforcement and would have turned the pin red with a warning on
              a place where nothing happened.

              Once anybody else has reviewed, checked in, saved or
              photographed it, the section says so plainly instead of
              disappearing. A control that silently vanishes reads as a bug;
              a sentence explaining that other campers are using the spot now
              reads as the truth, which is what it is.
            */}
            {campsite.submittedByMe && removal !== null && (
              <section className="pt-3 border-t border-slate-800 anim-in-up">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  You added this spot
                </h3>

                {canRemove ? (
                  confirmingRemove ? (
                    <div className="rounded-xl border border-rose-800/60 bg-rose-950/30 p-3 anim-in-up">
                      <p className="text-[11px] text-rose-100 leading-snug">
                        Take it off the map for good? Nobody else has used this
                        one, so nothing of anybody else&apos;s goes with it — but
                        it cannot be undone.
                      </p>
                      <div className="flex gap-2 mt-2.5">
                        <button
                          onClick={() => { haptic('tap'); setConfirmingRemove(false); }}
                          disabled={removing}
                          className="flex-1 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-[11px] font-bold disabled:opacity-50"
                        >
                          Keep it
                        </button>
                        <button
                          onClick={handleRemove}
                          disabled={removing}
                          className="flex-1 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                        >
                          {removing
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                          Remove it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => { haptic('tap'); setConfirmingRemove(true); }}
                        className="w-full px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 hover:border-rose-600/60 hover:text-rose-200 text-[11px] font-bold flex items-center justify-center gap-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove this spot
                      </button>
                      <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                        {removal.exists
                          ? 'Nobody else has reviewed, saved or checked in here, so it is still yours to take down.'
                          : 'This one is saved on your device only, so removing it affects nobody else.'}
                      </p>
                    </>
                  )
                ) : (
                  <p className="text-[10px] text-slate-500 leading-snug">
                    {removal.message ||
                      'Other campers are using this spot now, so it stays on the map.'}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      <ReportContentSheet
        isOpen={isReporting}
        onClose={() => setIsReporting(false)}
        targetKind="campsite"
        targetId={campsite.id}
        targetLabel={campsite.name}
        isSignedIn={Boolean(user)}
        onRequireAuth={onRequireAuth}
      />
    </div>
  );
};
