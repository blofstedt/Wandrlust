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
  /**
   * `fill` is the phone's search card: ten equal buttons sharing the width,
   * so every kind is on screen at once and none of them is off the right-hand
   * edge.
   *
   * `fixed` is the desktop header, where the row is one item among many and
   * must not stretch to fill a 1280px bar.
   */
  layout?: 'fixed' | 'fill';
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
          // Covers both "more than we will draw" and "a wider view than we can
          // ask about at once". Either way the map is a sample, and a gap in
          // it is not evidence of anything.
          ? `${state.count} on the map — there are more here than fit in one look.`
          : `${state.count} on the map. Tap one to see where it came from.`,
        tone: 'quiet'
      };
    default:
      return null;
  }
};

export const FacilityChips: React.FC<FacilityChipsProps> = ({
  active, onToggle, onClearAll, state, layout = 'fixed'
}) => {
  const activeSet = new Set(active);
  const status = statusLine(state, active);

  return (
    <div className="w-full">
      {/*
        SYMBOLS, NOT WORDS, AND ALL OF THEM ON ONE LINE.

        With the name beside each icon the row was three lines deep in a card
        the width of a phone, or one line with six of the ten kinds parked off
        the right-hand edge behind a sideways scroll nobody discovers. A
        toilet, a shower and a fuel pump do not need to be captioned; what the
        row DOES need is for every kind to be visible at once, because the
        thing a camper is hunting is whichever one they are short of, and it
        was as likely to be the one out of sight as any other.

        Ten equal buttons is a keyboard's worth of targets across the same
        width, which is a proven size for a thumb.

        Monochrome on purpose. Ten emoji is ten art styles at ten weights
        arguing with each other and with the map behind them; one stroke
        weight in one colour reads as one control. Colour still means
        something in this app — it is how one pin is told from another — so it
        stays on the pins and out of the chrome.
      */}
      <div
        className={`flex items-stretch gap-1 ${layout === 'fill' ? '' : 'flex-wrap'}`}
        role="group"
        aria-label="Find facilities on the map"
      >
        {SEARCHABLE_FACILITY_KINDS.map((kind) => {
          const spec = FACILITY[kind];
          const Icon = spec.icon;
          const on = activeSet.has(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              aria-label={spec.label}
              title={spec.label}
              onClick={() => { haptic('tap'); onToggle(kind); }}
              className={`${
                layout === 'fill' ? 'flex-1 min-w-0' : 'w-10 shrink-0'
              } h-10 rounded-xl border flex items-center justify-center transition-colors duration-150 ${
                on
                  ? 'bg-slate-100 border-slate-100 text-slate-900 shadow-md'
                  : 'bg-slate-950/70 border-slate-700/70 text-slate-400 hover:text-slate-100 hover:border-slate-500'
              }`}
            >
              <Icon className="w-[18px] h-[18px]" strokeWidth={on ? 2.25 : 2} />
            </button>
          );
        })}
      </div>

      {/*
        The row has no captions now, so the line under it does that job: it
        names what is switched on, and when nothing is it says what the row is
        for rather than sitting there as ten unexplained symbols.
      */}
      {!status && (
        <p className="text-[12px] leading-snug text-slate-500 mt-1.5 px-0.5">
          Tap a symbol to put those on the map.
        </p>
      )}

      {status && (
        <div className="flex items-start gap-2 mt-1.5 px-0.5">
          {state.status === 'loading' && (
            <Loader2 className="w-3 h-3 text-slate-400 animate-spin shrink-0 mt-0.5" />
          )}
          <p
            className={`text-[12px] leading-snug flex-1 ${
              status.tone === 'warn' ? 'text-amber-300/90' : 'text-slate-400'
            }`}
          >
            {status.text}
          </p>
          <button
            type="button"
            onClick={() => { haptic('tap'); onClearAll(); }}
            className="shrink-0 text-[12px] font-bold text-slate-400 hover:text-slate-200 underline underline-offset-2"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
};
