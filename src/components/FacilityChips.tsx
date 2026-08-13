import React from 'react';
import { Loader2 } from 'lucide-react';
import type { FacilityKind } from '../types';
import { FACILITY, SEARCHABLE_FACILITY_KINDS } from '../config/facilities';
import { haptic } from '../utils/animation';

/**
 * "WHERE'S THE NEAREST TOILET" — AS A ROW OF BUTTONS UNDER THE SEARCH.
 *
 * The search box finds a town. It has never been able to find a thing. A
 * camper wanting a dump station had exactly one route to one: open a spot,
 * read the chips on its pin, and hope the nearest one happened to be within
 * five kilometres of a campsite somebody had already logged. Facilities were
 * a property of a campsite rather than something on the map.
 *
 * These turn each kind into a layer. Tap Toilets and every toilet on screen
 * appears, from OpenStreetMap and from campers alike.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ROW REFUSES TO SAY
 * ---------------------------------------------------------------------------
 *
 * An empty answer is the dangerous one, and it gets the most words. When a
 * kind is switched on and nothing comes back, the row says NOBODY HAS MAPPED
 * ONE HERE — never "there are none". OpenStreetMap is volunteer-surveyed and
 * the emptiest country is the least surveyed, which is precisely where a
 * camper is standing when they need a tap. A camper who reads "no water" and
 * drives on with empty tanks has been lied to by a phrasing choice.
 *
 * Three other states each get their own sentence, because collapsing them
 * into silence is the same lie in a quieter voice:
 *
 *   zoomed too far out  the box is too big to ask about — say so, don't
 *                       return an empty map and let it read as "none".
 *   lookup failed       "couldn't check", which is not "nothing here".
 *   capped              what is drawn is a sample, not the set.
 */

export type FacilityLookupState =
  | { status: 'idle' }
  | { status: 'zoomed-out' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'done'; count: number; truncated: boolean };

interface FacilityChipsProps {
  /** Which kinds are switched on. */
  active: FacilityKind[];
  onToggle: (kind: FacilityKind) => void;
  /** Clears every kind at once. Only rendered when something is on. */
  onClearAll: () => void;
  state: FacilityLookupState;
}

/** The sentence under the row, for whatever the layer is currently doing. */
const statusLine = (
  state: FacilityLookupState, active: FacilityKind[]
): { text: string; tone: 'quiet' | 'warn' } | null => {
  if (active.length === 0) return null;

  // "Toilets", or "toilets and water", or "3 kinds" — named while it is
  // short enough to read, counted once it is not.
  const names = active.map((kind) => FACILITY[kind].plural.toLowerCase());
  const subject = names.length === 1
    ? names[0]
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.length} kinds`;

  switch (state.status) {
    case 'zoomed-out':
      return { text: `Zoom in to look for ${subject} around here.`, tone: 'quiet' };
    case 'loading':
      return { text: `Looking for ${subject}…`, tone: 'quiet' };
    case 'failed':
      return { text: `Couldn't check for ${subject} just now.`, tone: 'warn' };
    case 'done':
      if (state.count === 0) {
        return {
          // The load-bearing sentence in this component.
          text: `Nobody has mapped ${subject} in this view. That is not the same as there being none.`,
          tone: 'warn'
        };
      }
      return {
        text: state.truncated
          ? `Showing the first ${state.count} — there are more than fit on screen.`
          : `${state.count} on the map. Tap one to see where it came from.`,
        tone: 'quiet'
      };
    default:
      return null;
  }
};

export const FacilityChips: React.FC<FacilityChipsProps> = ({
  active, onToggle, onClearAll, state
}) => {
  const activeSet = new Set(active);
  const status = statusLine(state, active);

  return (
    <div className="w-full">
      {/*
        Horizontally scrollable rather than wrapped. A wrapped row grows to
        three lines on a phone and shoves the map off the screen, and the map
        is the thing the camper came for.
      */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto scroll-soft pb-1 -mx-1 px-1"
        role="group"
        aria-label="Find facilities on the map"
      >
        {SEARCHABLE_FACILITY_KINDS.map((kind) => {
          const spec = FACILITY[kind];
          const on = activeSet.has(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => { haptic('tap'); onToggle(kind); }}
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${
                on
                  ? 'text-slate-950 border-transparent shadow-md'
                  : 'bg-slate-950/80 border-slate-700/80 text-slate-300 hover:text-slate-100 hover:border-slate-600'
              }`}
              /* The chip wears the kind's own colour when it is on, so the
                 button and the pins it just turned on are the same thing. */
              style={on ? { backgroundColor: spec.color } : undefined}
            >
              <span aria-hidden="true">{spec.glyph}</span>
              {spec.plural}
            </button>
          );
        })}
      </div>

      {status && (
        <div className="flex items-start gap-2 mt-1 px-0.5">
          {state.status === 'loading' && (
            <Loader2 className="w-3 h-3 text-slate-400 animate-spin shrink-0 mt-0.5" />
          )}
          <p
            className={`text-[10px] leading-snug flex-1 ${
              status.tone === 'warn' ? 'text-amber-300/90' : 'text-slate-400'
            }`}
          >
            {status.text}
          </p>
          <button
            type="button"
            onClick={() => { haptic('tap'); onClearAll(); }}
            className="shrink-0 text-[10px] font-bold text-slate-400 hover:text-slate-200 underline underline-offset-2"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
};
