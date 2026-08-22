import React, { useCallback, useEffect, useState } from 'react';
import { Check, Crosshair, Loader2, MapPin, Plus, AlertTriangle } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { SkeletonLine } from './ui/Feedback';
import type { FacilityKind, MapFacility } from '../types';
import { FACILITY, ADDABLE_FACILITY_KINDS } from '../config/facilities';
import { fetchFacilitiesInView } from '../services/nearbyAmenityService';
import { fetchPoisNear, submitPoi, votePoi } from '../services/dataService';
import { mergeFacilities, poiToMapFacility } from '../utils/mergeFacilities';
import { facilityKindFromDb } from '../config/facilities';
import { distanceKm } from '../utils/geo';
import { haptic } from '../utils/animation';

/**
 * ADDING A TOILET, A TAP, OR A DUMP STATION.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 *
 * A tab called "Add a POI", buried behind the Report button, which dropped
 * the thing at whatever the map happened to be centred on — with no crosshair
 * drawn, so there was nothing to aim — and then demanded a name for a vault
 * toilet that has not got one. Nothing anywhere in the app ever drew the
 * result. The table had zero rows in it, which is exactly what that flow
 * deserved.
 *
 * ---------------------------------------------------------------------------
 * THE DUPLICATE CHECK COMES FIRST, AND IT NEVER BLOCKS
 * ---------------------------------------------------------------------------
 *
 * The first thing on this sheet is what is ALREADY mapped within a few
 * hundred metres, from OpenStreetMap and from other campers, before a single
 * question is asked. Tapping one of them says "yes, that's it" and confirms
 * the existing record instead of making a second one.
 *
 * But it is a prompt, never a gate. Two toilets eighty metres apart at
 * opposite ends of a campground are two toilets, and an app that refuses the
 * second one because it found the first has deleted something real. Same rule
 * the campsite merge is built on: showing one thing twice is untidy, hiding
 * one is the failure that matters. So "Add it anyway" is always there.
 *
 * And when the check FAILS, it says so. "Couldn't check what's already here"
 * is a different fact from "nothing is here", and an empty list rendered
 * silently would be read as the second one.
 */

/** How far out "already here?" looks. Walking distance, not driving. */
const NEARBY_RADIUS_KM = 0.3;

type CheckState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'done'; nearby: (MapFacility & { distanceKm: number })[] };

interface AddFacilitySheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Where the facility goes — from a tapped map pin, or the phone's fix. */
  at: [number, number] | null;
  /** True when `at` came from the browser's geolocation rather than a tap. */
  fromGps?: boolean;
  isSignedIn: boolean;
  onRequireAuth: () => void;
  /**
   * Fired after anything lands, carrying the kind involved.
   *
   * The kind matters: the map only draws layers the camper has switched on,
   * so adding a toilet with no chips selected would put a pin in the database
   * and leave the screen unchanged, which reads as a lost submission. App
   * switches that kind on.
   */
  onSaved: (kind: FacilityKind) => void;
}

export const AddFacilitySheet: React.FC<AddFacilitySheetProps> = ({
  isOpen, onClose, at, fromGps = false, isSignedIn, onRequireAuth, onSaved
}) => {
  const [kind, setKind] = useState<FacilityKind>('toilet');
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [fee, setFee] = useState<boolean | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set once the camper has seen the list and chosen to add anyway. */
  const [past, setPast] = useState(false);

  const lat = at?.[0] ?? null;
  const lon = at?.[1] ?? null;

  // Every sheet opens clean. A kind left over from the last one is a wrong
  // answer nobody typed.
  useEffect(() => {
    if (!isOpen) return;
    setKind('toilet');
    setName('');
    setDetail('');
    setFee(null);
    setNotice(null);
    setPast(false);
  }, [isOpen]);

  /**
   * What is already here.
   *
   * Both sources, merged the same way the map merges them, so a toilet that
   * is in OpenStreetMap AND logged by a camper shows as one row rather than
   * as two things to compare.
   */
  const runCheck = useCallback(async (signal?: AbortSignal) => {
    if (lat === null || lon === null) return;
    setCheck({ status: 'loading' });

    // ~0.3 km either side of the point, as a box, because that is the shape
    // the viewport query takes.
    const pad = NEARBY_RADIUS_KM / 111;
    const [osm, pois] = await Promise.all([
      fetchFacilitiesInView(
        { south: lat - pad, west: lon - pad, north: lat + pad, east: lon + pad },
        ADDABLE_FACILITY_KINDS,
        signal
      ),
      fetchPoisNear(lat, lon, NEARBY_RADIUS_KM)
    ]);
    if (signal?.aborted) return;

    const camperAdded = pois
      .map((row) => {
        const rowKind = facilityKindFromDb(row.kind);
        return rowKind ? poiToMapFacility(row, rowKind) : null;
      })
      .filter((f): f is MapFacility => f !== null);

    const nearby = mergeFacilities(camperAdded, osm.facilities)
      .map((f) => ({ ...f, distanceKm: distanceKm(lat, lon, f.latitude, f.longitude) }))
      .filter((f) => f.distanceKm <= NEARBY_RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 8);

    /* A total Overpass failure with no camper rows either is "couldn't
       check". If camper rows DID arrive, the list is partial rather than
       unknown, and showing it beats showing nothing. */
    if (!osm.ok && camperAdded.length === 0) {
      setCheck({ status: 'failed' });
      return;
    }
    setCheck({ status: 'done', nearby });
  }, [lat, lon]);

  useEffect(() => {
    if (!isOpen || lat === null || lon === null) return;
    const controller = new AbortController();
    void runCheck(controller.signal);
    return () => controller.abort();
  }, [isOpen, lat, lon, runCheck]);

  /** "Yes, that's the one" — confirm what is there instead of adding another. */
  const confirmExisting = async (facility: MapFacility) => {
    haptic('tap');
    if (!facility.poiId) {
      // An OpenStreetMap node with no row of ours to vote on. Nothing to
      // write, and nothing worth pretending to write.
      setNotice('That one is already on the map, straight from OpenStreetMap.');
      return;
    }
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    const result = await votePoi(facility.poiId, true);
    setBusy(false);
    setNotice(result.message);
    if (result.ok) { haptic('success'); onSaved(facility.kind); }
  };

  const submit = async () => {
    if (lat === null || lon === null) { setNotice('No location for this yet.'); return; }
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    setNotice(null);
    const result = await submitPoi({
      kind: FACILITY[kind].dbKind ?? 'other',
      lat,
      lon,
      name: name.trim() || undefined,
      detail: detail.trim() || undefined,
      isFree: fee === null ? undefined : !fee
    });
    setBusy(false);
    setNotice(result.message);

    if (result.ok) {
      haptic('success');
      onSaved(kind);
      // Left open on a duplicate so the camper can see what happened and
      // correct the kind if they picked the wrong one; closed on a clean add.
      if (!result.data?.duplicate) setTimeout(onClose, 900);
    }
  };

  const nearbyCount = check.status === 'done' ? check.nearby.length : 0;
  const showForm = past || (check.status === 'done' && nearbyCount === 0);

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title="Add a facility"
      subtitle="A toilet, tap, dump station or laundry other campers can use."
      icon={<Plus className="w-5 h-5 text-emerald-400" />}
    >
      <div className="space-y-3 text-xs text-slate-300">
        {/* Where it goes, shown before anything is asked. */}
        {lat !== null && lon !== null ? (
          <div>
            <p className="flex items-center gap-2 font-mono text-xs text-slate-200 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2">
              <Crosshair className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              {lat.toFixed(5)}, {lon.toFixed(5)}
            </p>
            <p className="text-[12px] text-slate-500 leading-snug mt-1">
              {fromGps
                ? 'That is your phone’s fix, as good as it managed — it may be a few dozen metres off.'
                : 'That is where you tapped the map. Close the sheet and tap again to move it.'}
            </p>
          </div>
        ) : (
          <p className="text-xs text-amber-300/90 leading-snug">
            Nothing has been located yet. Tap the map to place a pin, then add
            the facility from the card that opens.
          </p>
        )}

        {/* ---- The duplicate check ---- */}
        {!showForm && (
          <div className="rounded-xl border border-slate-700/70 bg-slate-950/60 p-3 space-y-2">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400">
              Already here?
            </h3>

            {check.status === 'loading' && (
              <div className="space-y-1.5">
                <SkeletonLine className="w-3/4" />
                <SkeletonLine className="w-1/2" />
                <p className="text-[12px] text-slate-500">
                  Checking what is already mapped nearby…
                </p>
              </div>
            )}

            {check.status === 'failed' && (
              <p className="text-xs text-amber-300/90 leading-snug flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                {/*
                  Not "nothing here". The check failed; what is on the ground
                  is exactly as unknown as it was before we asked.
                */}
                <span>
                  Couldn&apos;t check what is already here. That is not the same
                  as there being nothing — have a look at the map before you add.
                </span>
              </p>
            )}

            {check.status === 'done' && nearbyCount > 0 && (
              <>
                <p className="text-xs text-slate-400 leading-snug">
                  {nearbyCount === 1 ? 'One thing is' : `${nearbyCount} things are`} already
                  mapped within {Math.round(NEARBY_RADIUS_KM * 1000)} m. If yours is one
                  of them, tap it to confirm it rather than adding a second pin.
                </p>
                <ul className="space-y-1.5">
                  {check.nearby.map((facility) => (
                    <li key={facility.id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmExisting(facility)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-slate-900 border border-slate-700 hover:border-slate-500 text-left disabled:opacity-60"
                      >
                        <span
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0"
                          style={{ background: `${FACILITY[facility.kind].color}22` }}
                          aria-hidden="true"
                        >
                          {FACILITY[facility.kind].glyph}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-bold text-slate-100 truncate">
                            {facility.name ?? FACILITY[facility.kind].label}
                          </span>
                          <span className="block text-[12px] text-slate-400 truncate">
                            {Math.round(facility.distanceKm * 1000)} m away ·{' '}
                            {facility.fromOsm ? 'OpenStreetMap' : 'added by a camper'}
                          </span>
                        </span>
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/*
              Always available, in every state including the failed one. This
              is the line between a prompt and a gate, and it stays on the
              prompt side: the camper is standing there and we are not.
            */}
            <button
              type="button"
              onClick={() => { haptic('tap'); setPast(true); }}
              className="w-full py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold hover:bg-slate-700"
            >
              {nearbyCount > 0 ? 'None of these — add a new one' : 'Add one here'}
            </button>
          </div>
        )}

        {/* ---- The form ---- */}
        {showForm && (
          <>
            <div>
              <p className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                What is it?
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ADDABLE_FACILITY_KINDS.map((k) => {
                  const spec = FACILITY[k];
                  const on = k === kind;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => { haptic('tap'); setKind(k); }}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-bold ${
                        on
                          ? 'text-slate-950 border-transparent shadow-md'
                          : 'bg-slate-950/80 border-slate-700/80 text-slate-300 hover:border-slate-600'
                      }`}
                      style={on ? { backgroundColor: spec.color } : undefined}
                    >
                      <span aria-hidden="true">{spec.glyph}</span>
                      {spec.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label
                htmlFor="facility-name"
                className="block text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-1"
              >
                Name <span className="normal-case font-normal">(optional)</span>
              </label>
              <input
                id="facility-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Leave blank if it hasn't got a name"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              />
              {/*
                The old form made this required, which meant the honest answer
                for most pit toilets was to invent something.
              */}
              <p className="text-[12px] text-slate-500 mt-1">
                Most pit toilets have no name. Blank is a fine answer.
              </p>
            </div>

            <div>
              <label
                htmlFor="facility-detail"
                className="block text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-1"
              >
                Anything worth knowing <span className="normal-case font-normal">(optional)</span>
              </label>
              <textarea
                id="facility-detail"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={300}
                rows={2}
                placeholder="Behind the ranger hut. Locked out of season."
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 resize-none"
              />
            </div>

            <div>
              <p className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                Does it cost anything?
              </p>
              {/*
                Three states, and the third is the default. An unanswered
                question is not a "no" — a facility nobody has priced must not
                read as free on somebody else's screen.
              */}
              <div className="flex gap-1.5">
                {([[false, 'Free'], [true, 'Costs money'], [null, "Don't know"]] as const).map(
                  ([value, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={fee === value}
                      onClick={() => { haptic('tap'); setFee(value); }}
                      className={`flex-1 py-2 rounded-lg border text-xs font-bold ${
                        fee === value
                          ? 'bg-emerald-600 border-emerald-500 text-white'
                          : 'bg-slate-950/80 border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {label}
                    </button>
                  )
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || lat === null}
              className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {busy ? 'Adding…' : `Add this ${FACILITY[kind].label.toLowerCase()}`}
            </button>

            <p className="text-[12px] text-slate-500 leading-snug flex items-start gap-1.5">
              <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                It goes on the map straight away, drawn hollow and labelled as
                unconfirmed until another camper agrees it is there. Nobody
                checks these before they appear — that is why the pin says who
                said so.
              </span>
            </p>
          </>
        )}

        {notice && (
          <p className="text-xs text-slate-200 bg-slate-800/70 border border-slate-700 rounded-xl px-3 py-2 leading-snug">
            {notice}
          </p>
        )}
      </div>
    </Sheet>
  );
};
