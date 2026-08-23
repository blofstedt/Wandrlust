import React, { useEffect, useState } from 'react';
import { Check, Loader2, MessageSquarePlus, ThumbsDown } from 'lucide-react';
import type { PendingFacilityCheck } from '../utils/facilityCheck';
import { FACILITY } from '../config/facilities';
import { votePoi, addPoiNote } from '../services/dataService';
import { Sheet } from './ui/Sheet';
import { haptic } from '../utils/animation';

/**
 * THE QUESTION, ASKED WHEN THE CAMPER HAS BEEN AND COME BACK.
 *
 * The facility card used to carry "It's there" and "Not there", which is the
 * card you read BEFORE you go — the one moment nobody can answer. This is the
 * same question at the only moment it is worth asking: the app was handed to
 * Google Maps, some time passed, and now it is being looked at again. See
 * `utils/facilityCheck.ts` for the two windows that decide when.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT COLLECT
 * ---------------------------------------------------------------------------
 *
 * A VOTE only where there is something to vote on. Most pins on this layer are
 * OpenStreetMap nodes and have no row of ours behind them; inventing one to
 * hold a vote would quietly fork the record. Those pins get the note and a line
 * saying why, rather than two buttons that could only fail.
 *
 * A NOTE always. "Behind the yellow wall, at the back" is the single most
 * useful thing a camper can leave and the hardest for any dataset to hold, and
 * it does not depend on which source drew the pin. It is also not a vote and
 * never counts as one — writing down where a thing is is not the same as
 * saying you found it there today.
 *
 * NOTHING is collected by default. Dismissing is a real answer: a camper who
 * did not get there, or got there and did not look, has nothing to say, and an
 * app that keeps asking until it gets an answer teaches people to tap whatever
 * makes it go away.
 */

interface FacilityCheckSheetProps {
  pending: PendingFacilityCheck | null;
  onClose: () => void;
  isSignedIn: boolean;
  onRequireAuth: () => void;
  /** Fired after anything lands, so the layer redraws with it. */
  onRecorded: () => void;
}

export const FacilityCheckSheet: React.FC<FacilityCheckSheetProps> = ({
  pending, onClose, isSignedIn, onRequireAuth, onRecorded
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState('');

  /* A new question starts clean — a notice about the last facility must not
     greet the next one. */
  useEffect(() => {
    setNotice(null);
    setWriting(false);
    setBody('');
  }, [pending?.id]);

  if (!pending) return null;

  const spec = FACILITY[pending.kind];
  const what = pending.name ?? spec.label.toLowerCase();

  const vote = async (isUpvote: boolean) => {
    if (!pending.poiId) return;
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    const result = await votePoi(pending.poiId, isUpvote);
    setBusy(false);

    if (!result.ok) { setNotice(result.message); return; }
    haptic(isUpvote ? 'success' : 'warning');
    onRecorded();
    /* The answer landed; there is nothing else to say about it. Leaving the
       sheet up with a tick in it makes somebody dismiss a finished job. */
    onClose();
  };

  const saveNote = async () => {
    if (!isSignedIn) { onRequireAuth(); return; }

    setBusy(true);
    const result = await addPoiNote({
      poiId: pending.poiId ?? null,
      /* An OSM pin's id IS the key a note hangs on. See migration 25. */
      osmId: pending.poiId ? null : pending.id,
      lat: pending.latitude,
      lon: pending.longitude,
      body
    });
    setBusy(false);

    if (!result.ok) { setNotice(result.message); return; }
    haptic('success');
    onRecorded();
    onClose();
  };

  return (
    <Sheet
      isOpen
      onClose={onClose}
      variant="dock"
      icon={<span aria-hidden="true">{spec.glyph}</span>}
      title={`Did you find the ${what}?`}
      subtitle="You went there a little while ago. Whatever you say here is what the next camper sees."
    >
      <div className="p-4 space-y-2.5">
        {pending.poiId ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void vote(true)}
              className="flex-1 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-slate-100 text-sm font-bold flex items-center justify-center gap-2 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              It was there
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void vote(false)}
              className="flex-1 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-slate-100 text-sm font-bold flex items-center justify-center gap-2 hover:border-rose-600 hover:text-rose-300 disabled:opacity-60"
            >
              <ThumbsDown className="w-4 h-4" />
              It wasn&apos;t
            </button>
          </div>
        ) : (
          /* No row of ours, nothing to vote on — said plainly rather than
             offered as a button that could only fail. */
          <p className="text-xs text-slate-400 leading-snug">
            This one comes straight from OpenStreetMap, so there is nothing here
            to confirm or retire. A note is worth more anyway.
          </p>
        )}

        {!writing ? (
          <button
            type="button"
            onClick={() => { haptic('tap'); setWriting(true); }}
            className="w-full py-3 rounded-xl bg-slate-800/50 border border-slate-700/60 text-slate-200 text-sm font-bold flex items-center justify-center gap-2 hover:border-slate-500"
          >
            <MessageSquarePlus className="w-4 h-4 text-emerald-400" />
            Leave a note about finding it
          </button>
        ) : (
          <div className="space-y-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 400))}
              rows={3}
              autoFocus
              placeholder="You have to look behind the yellow wall, it's way at the back."
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                {400 - body.length} left. Directions, not a review.
              </span>
              <button
                type="button"
                disabled={busy || body.trim().length < 2}
                onClick={() => void saveNote()}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50 flex items-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Save note
              </button>
            </div>
          </div>
        )}

        {notice && (
          <p className="text-xs text-slate-200 bg-slate-800/70 border border-slate-700 rounded-lg px-2.5 py-1.5 leading-snug">
            {notice}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-200"
        >
          Not now
        </button>
      </div>
    </Sheet>
  );
};

FacilityCheckSheet.displayName = 'FacilityCheckSheet';
