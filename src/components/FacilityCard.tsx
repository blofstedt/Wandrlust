import React, { useEffect, useState } from 'react';
import { Loader2, MessageSquarePlus, Navigation, X } from 'lucide-react';
import type { MapFacility } from '../types';
import { FACILITY, facilitySourceStyle } from '../config/facilities';
import { addPoiNote } from '../services/dataService';
import { openDirections, directionsAppName } from '../utils/handoff';
import { rememberFacilityHandoff } from '../utils/facilityCheck';
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
 * WHERE "IT'S THERE" AND "NOT THERE" WENT. They were here, on the card you read
 * BEFORE you go — the one moment nobody can answer the question. What that
 * collects is either silence or, worse, somebody pressing "it's there" to mean
 * "the pin is there", which is the map confirming itself. The question is asked
 * now when the camper comes back from being handed to Google Maps, which is the
 * first moment they know. See `FacilityCheckSheet`.
 *
 * What is here instead is what other campers have written about FINDING it —
 * behind the yellow wall, at the back — and a way to add your own. Those are
 * directions, not a verdict, and they never change the pin's standing.
 */

interface FacilityCardProps {
  facility: MapFacility | null;
  onClose: () => void;
  isSignedIn: boolean;
  onRequireAuth: () => void;
  /** Fired after a note lands, so the layer redraws carrying it. */
  onVoted: () => void;
}

export const FacilityCard: React.FC<FacilityCardProps> = ({
  facility, onClose, isSignedIn, onRequireAuth, onVoted
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');

  // A notice about the last facility must not greet the next one.
  useEffect(() => {
    setNotice(null);
    setWriting(false);
    setBody('');
  }, [facility?.id]);

  if (!facility) return null;

  const spec = FACILITY[facility.kind];
  const { meaning } = facilitySourceStyle(facility.fromOsm, facility.confirmations);
  const notes = facility.notes ?? [];

  const saveNote = async () => {
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    const result = await addPoiNote({
      poiId: facility.poiId ?? null,
      /* An OSM pin's own id is the key a note hangs on — see migration 25.
         A note is the one thing that works on both kinds of pin. */
      osmId: facility.poiId ? null : facility.id,
      lat: facility.latitude,
      lon: facility.longitude,
      body
    });
    setBusy(false);
    setNotice(result.message);
    if (result.ok) {
      haptic('success');
      setWriting(false);
      setBody('');
      onVoted();
    }
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
          {/*
            WHAT OTHER CAMPERS SAID ABOUT FINDING IT.

            The most useful sentence about a pit toilet is rarely that it
            exists — it is which side of the building the door is on. These are
            one camper's words each, attributed, and they are directions rather
            than a verdict: a note never moves the pin up or down the ladder.
          */}
          {notes.length > 0 && (
            <ul className="space-y-1.5">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="text-xs text-slate-200 leading-snug border-l-2 border-emerald-700/70 pl-2"
                >
                  “{note.body}”
                  <span className="block text-[11px] text-slate-500 mt-0.5">
                    — {note.authorName}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => { haptic('tap'); setWriting((open) => !open); }}
              className="flex-1 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:border-emerald-600 hover:text-emerald-300"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              {notes.length > 0 ? 'Add a note' : 'Leave a note'}
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                /* Remembered so the app can ask whether they found it once
                   they are back — which is the only moment they know. See
                   `utils/facilityCheck.ts`. */
                rememberFacilityHandoff(facility);
                openDirections(facility.latitude, facility.longitude);
              }}
              className="flex-1 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:border-slate-500"
              aria-label={`Open in ${directionsAppName()}`}
            >
              <Navigation className="w-3.5 h-3.5" />
              Take me there
            </button>
          </div>

          {writing && (
            <div className="space-y-1.5">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value.slice(0, 400))}
                rows={3}
                autoFocus
                placeholder="You have to look behind the yellow wall, it's way at the back."
                className="w-full bg-slate-950/90 border border-slate-700/80 rounded-lg px-2.5 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 resize-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  {400 - body.length} left. Directions, not a review.
                </span>
                <button
                  type="button"
                  disabled={busy || body.trim().length < 2}
                  onClick={() => void saveNote()}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          )}

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
