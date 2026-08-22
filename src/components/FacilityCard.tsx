import React, { useEffect, useState } from 'react';
import { Check, Loader2, Navigation, ThumbsDown, X } from 'lucide-react';
import type { MapFacility } from '../types';
import { FACILITY, facilitySourceStyle } from '../config/facilities';
import { votePoi } from '../services/dataService';
import { openDirections, directionsAppName } from '../utils/handoff';
import { haptic } from '../utils/animation';

/**
 * ONE FACILITY, AND WHERE THE CLAIM CAME FROM.
 *
 * A pin on a map is a promise, and the whole job of this card is to say
 * exactly how much of a promise this one is. Three sentences do the work:
 *
 *   what it is        the kind, and the name if anybody recorded one
 *   who says so       OpenStreetMap, a camper, or both — never blurred into
 *                     an anonymous "verified"
 *   what that is not  nobody has been sent to check it, and a mapped toilet
 *                     can be locked, gone, or seasonal
 *
 * The two buttons are the only way anything on this layer improves. Confirming
 * is what moves a camper's pin from hollow to solid; saying it is gone is what
 * eventually takes it off the map. Both are one tap and neither is destructive
 * on its own — three separate campers have to say a thing is gone before it is
 * pruned.
 */

interface FacilityCardProps {
  facility: MapFacility | null;
  onClose: () => void;
  isSignedIn: boolean;
  onRequireAuth: () => void;
  /** Fired after a vote lands, so the layer redraws with the new count. */
  onVoted: () => void;
}

export const FacilityCard: React.FC<FacilityCardProps> = ({
  facility, onClose, isSignedIn, onRequireAuth, onVoted
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A notice about the last facility must not greet the next one.
  useEffect(() => { setNotice(null); }, [facility?.id]);

  if (!facility) return null;

  const spec = FACILITY[facility.kind];
  const { meaning } = facilitySourceStyle(facility.fromOsm, facility.confirmations);

  const vote = async (isUpvote: boolean) => {
    if (!facility.poiId) {
      /* An OpenStreetMap node. There is no row of ours to attach a vote to,
         and inventing one would quietly fork the record — the honest fix is
         to correct it at the source, which is a thing anybody may do. */
      setNotice(
        'This one comes straight from OpenStreetMap, so there is nothing here to vote on. ' +
        'Anyone can correct it at openstreetmap.org.'
      );
      return;
    }
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    const result = await votePoi(facility.poiId, isUpvote);
    setBusy(false);
    setNotice(result.message);
    if (result.ok) { haptic(isUpvote ? 'success' : 'warning'); onVoted(); }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1600] p-3 pointer-events-none">
      <div className="mx-auto max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden anim-sheet-up pointer-events-auto">
        <div className="flex items-start gap-3 p-3.5">
          <span
            className="w-9 h-9 rounded-full flex items-center justify-center text-base shrink-0"
            style={{ background: `${spec.color}22`, border: `1.5px solid ${spec.color}` }}
            aria-hidden="true"
          >
            {spec.glyph}
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-slate-100 truncate">
              {facility.name ?? spec.label}
            </h2>
            {/* When it has a name, the kind still has to be said — "Ranger
                Station" tells you nothing about whether there is a toilet. */}
            {facility.name && (
              <p className="text-xs text-slate-400">{spec.label}</p>
            )}
            <p className="text-xs text-slate-300 leading-snug mt-1">{meaning}</p>

            {facility.detail && (
              <p className="text-xs text-slate-300 leading-snug mt-1.5 border-l-2 border-slate-700 pl-2">
                “{facility.detail}”
              </p>
            )}

            {facility.fee !== undefined && (
              <p className="text-[12px] text-slate-400 mt-1">
                {facility.fee ? 'Charges a fee.' : 'Recorded as free.'}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 tap-safe rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3.5 pb-3 space-y-2">
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void vote(true)}
              className="flex-1 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              It&apos;s there
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void vote(false)}
              className="flex-1 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:border-rose-600 hover:text-rose-300 disabled:opacity-60"
            >
              <ThumbsDown className="w-3.5 h-3.5" />
              Not there
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                openDirections(facility.latitude, facility.longitude);
              }}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 hover:border-slate-500"
              aria-label={`Open in ${directionsAppName()}`}
            >
              <Navigation className="w-3.5 h-3.5" />
            </button>
          </div>

          {notice && (
            <p className="text-xs text-slate-200 bg-slate-800/70 border border-slate-700 rounded-lg px-2.5 py-1.5 leading-snug">
              {notice}
            </p>
          )}

          {/*
            The caveat, on every one of these, every time. A toilet somebody
            mapped in 2019 can be locked, burnt down, or behind a gate that
            went up last spring, and this app has no way of knowing.
          */}
          <p className="text-[12px] text-slate-500 leading-snug">
            Nobody has been sent to check this. It may be locked, seasonal, or
            gone — and finding nothing mapped nearby only means nobody has
            mapped one, not that there is none.
          </p>
        </div>
      </div>
    </div>
  );
};
