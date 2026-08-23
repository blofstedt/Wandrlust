import React, { useEffect, useState } from 'react';
import { Loader2, MessageSquarePlus, Navigation } from 'lucide-react';
import type { FacilityNote, MapFacility } from '../types';
import { FACILITY, facilitySourceStyle } from '../config/facilities';
import { addPoiNote } from '../services/dataService';
import { openDirections, directionsAppName } from '../utils/handoff';
import { rememberFacilityHandoff } from '../utils/facilityCheck';
import { checkStandingAt } from '../utils/atFacility';
import { haptic } from '../utils/animation';

/**
 * ONE FACILITY, AND WHERE THE CLAIM CAME FROM.
 *
 * A pin on a map is a promise, and the whole job of this card is to say exactly
 * how much of a promise this one is. Three sentences do the work:
 *
 *   what it is        the kind, and the name if anybody recorded one
 *   who says so       OpenStreetMap, a camper, or both — never blurred into an
 *                     anonymous "verified"
 *   what that is not  nobody has been sent to check it, and a mapped toilet can
 *                     be locked, gone, or seasonal
 *
 * WHERE "IT'S THERE" AND "NOT THERE" WENT. They were here, on the card you read
 * BEFORE you go — the one moment nobody can answer the question. What that
 * collects is either silence or, worse, somebody pressing "it's there" to mean
 * "the pin is there", which is the map confirming itself. The question is asked
 * now when the camper comes back from being handed to Google Maps, which is the
 * first moment they know. See `FacilityCheckSheet`.
 *
 * What is here instead is what other campers have written about FINDING it —
 * behind the yellow wall, at the back — and a way to add your own, which the
 * app only takes from somebody whose phone is actually there. See
 * `utils/atFacility.ts` for why that check exists and what it does not claim.
 *
 * THE CARD IS `ui/MapPanel`, like the layer menu and the facility picker: same
 * width, same place, same header, same box. This is the body and nothing more —
 * the panel around it lives in `MapComponent`.
 */

interface FacilityCardProps {
  facility: MapFacility;
  isSignedIn: boolean;
  onRequireAuth: () => void;
  /** Fired after a note lands, so the layer redraws carrying it. */
  onSaved: () => void;
}

export const FacilityCard: React.FC<FacilityCardProps> = ({
  facility, isSignedIn, onRequireAuth, onSaved
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');
  /* The note that was just written, shown straight away. The layer refetches
     behind this and will bring back the real row, but a camper who has just
     typed something has to see it land — waiting a viewport for your own
     words to appear reads as the save having failed. */
  const [justAdded, setJustAdded] = useState<FacilityNote[]>([]);

  // A notice about the last facility must not greet the next one.
  useEffect(() => {
    setNotice(null);
    setWriting(false);
    setBody('');
    setJustAdded([]);
  }, [facility.id]);

  const spec = FACILITY[facility.kind];
  const { meaning } = facilitySourceStyle(facility.fromOsm, facility.confirmations);
  const notes = [...(facility.notes ?? []), ...justAdded];

  /**
   * Take the fix BEFORE opening the box to type in.
   *
   * The other order — write the note, then be told you are 40 km away — is the
   * app taking somebody's words and throwing them away. If the answer is no, it
   * is no before a word is typed.
   */
  const startWriting = async () => {
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    setNotice('Checking you are at it…');
    const near = await checkStandingAt(facility.latitude, facility.longitude);
    setBusy(false);

    if (!near.ok) { setNotice(near.message); return; }
    setNotice(null);
    setWriting(true);
  };

  const saveNote = async () => {
    setBusy(true);
    const result = await addPoiNote({
      poiId: facility.poiId ?? null,
      /* An OSM pin's own id is the key a note hangs on — see migration 25. A
         note is the one thing that works on both kinds of pin. */
      osmId: facility.poiId ? null : facility.id,
      lat: facility.latitude,
      lon: facility.longitude,
      body
    });
    setBusy(false);
    setNotice(result.message);
    if (result.ok) {
      haptic('success');
      setJustAdded([{
        id: `pending-${Date.now()}`,
        body: body.trim(),
        authorName: 'You',
        createdAt: new Date().toISOString()
      }]);
      setWriting(false);
      setBody('');
      onSaved();
    }
  };

  return (
    /* The layer menu's body height, so every card opened from this stack is one
       box in one place. Only the notes scroll, because only the notes grow. */
    <div className="h-[260px] p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2.5 shrink-0">
        <span
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
          style={{ background: `${spec.color}22`, border: `1.5px solid ${spec.color}` }}
          aria-hidden="true"
        >
          {spec.glyph}
        </span>
        <div className="min-w-0">
          {/* When it has a name, the kind still has to be said — "Ranger
              Station" tells you nothing about whether there is a toilet. */}
          {facility.name && (
            <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
              {spec.label}
            </p>
          )}
          <p className="text-xs text-slate-300 leading-snug">{meaning}</p>
          {facility.fee !== undefined && (
            <p className="text-[12px] text-slate-400 mt-0.5">
              {facility.fee ? 'Charges a fee.' : 'Recorded as free.'}
            </p>
          )}
        </div>
      </div>

      {/*
        WHAT OTHER CAMPERS SAID ABOUT FINDING IT.

        The most useful sentence about a pit toilet is rarely that it exists —
        it is which side of the building the door is on. These are one camper's
        words each, attributed, and they are directions rather than a verdict: a
        note never moves the pin up or down the ladder.

        This is the part that scrolls, and the only part that can grow.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-soft space-y-1.5">
        {facility.detail && (
          <p className="text-xs text-slate-300 leading-snug border-l-2 border-slate-700 pl-2">
            “{facility.detail}”
          </p>
        )}

        {notes.map((note) => (
          <p
            key={note.id}
            className="text-xs text-slate-200 leading-snug border-l-2 border-emerald-700/70 pl-2"
          >
            “{note.body}”
            <span className="block text-[11px] text-slate-500 mt-0.5">
              — {note.authorName}
            </span>
          </p>
        ))}

        {notes.length === 0 && !facility.detail && (
          <p className="text-[12px] text-slate-500 leading-snug">
            Nobody has been sent to check this. It may be locked, seasonal or
            gone — and nobody has left directions for finding it yet.
          </p>
        )}

        {writing && (
          <div className="space-y-1.5 pt-1">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 400))}
              rows={3}
              autoFocus
              placeholder="Behind the yellow wall, right at the back."
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-lg px-2.5 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">{400 - body.length} left</span>
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
      </div>

      <div className="flex gap-1.5 shrink-0">
        {!writing && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void startWriting()}
            className="flex-1 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-60"
          >
            {busy
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <MessageSquarePlus className="w-3.5 h-3.5" />}
            {notes.length > 0 ? 'Add a note' : 'Leave a note'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            haptic('tap');
            /* Remembered so the app can ask whether they found it once they are
               back — which is the only moment they know. See
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
    </div>
  );
};

FacilityCard.displayName = 'FacilityCard';
