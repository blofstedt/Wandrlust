import React from 'react';
import type { FacilityKind } from '../types';
import { FACILITY, SEARCHABLE_FACILITY_KINDS } from '../config/facilities';
import { haptic } from '../utils/animation';

/**
 * "WHERE'S THE NEAREST TOILET" — AS THE SAME CARD EVERY OTHER MAP CONTROL OPENS.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THIS HAD TO BE, IN THE ORDER THEY WERE LEARNED
 * ---------------------------------------------------------------------------
 *
 * It started as chips: a row across the top of the phone with half of them off
 * the right-hand edge behind a sideways scroll nobody finds, then the same row
 * inside the search card, which meant raising a keyboard to press a button that
 * has nothing to do with typing. Both spent a permanent strip of the map on a
 * control used for two seconds at a time.
 *
 * Then it fanned out of the magnifier on arcs. That fixed the strip and the
 * keyboard and put every target the same short reach from a thumb, but it could
 * not fix READING: nine unlabelled symbols scattered on a curve, in no order,
 * over the middle of the map. Colour helps — a camper learns blue-is-water from
 * the pins — but a drop falling into a drain still has to be decoded, and that
 * is not something to ask of somebody at dusk with an empty water tank.
 *
 * So it is named tiles now, in the SAME CARD, at the same size, in the same
 * place as the layer menu and the account panel: `ui/MapPanel`, docked at the
 * bottom of the map above the control stack. Three controls in one row of
 * chrome opening three different shapes in three different places is how this
 * app looked before that card existed, and a fourth shape of its own is how it
 * would start looking that way again.
 *
 * WHAT DOES NOT MATCH THE REST OF THE APP IS THE COLOUR, deliberately. Every
 * other panel in Wandrlust is slate with one emerald accent. These nine are the
 * exception because the colour is not decoration: it is the same colour the
 * pins wear on the map, so the tile you press and the pins that appear are
 * visibly the same thing. `config/facilities.ts` is the single source of both,
 * which is what stops them drifting apart.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PANEL REFUSES TO SAY
 * ---------------------------------------------------------------------------
 *
 * Nothing, here — this is only the switch. The sentence that matters, the one
 * that says NOBODY HAS MAPPED ONE HERE rather than "there are none", is
 * `facilityNotice` in `MapComponent`, in the map's own notice column, because
 * that is a statement about the map and it has to stay on screen long after
 * this card has closed.
 */

interface FacilityPickerProps {
  active: FacilityKind[];
  onToggle: (kind: FacilityKind) => void;
  onClearAll: () => void;
  /** Closes the card this is sitting in. */
  onDone: () => void;
}

export const FacilityPicker: React.FC<FacilityPickerProps> = ({
  active, onToggle, onClearAll, onDone
}) => {
  const activeSet = new Set(active);

  return (
    <div className="p-2.5">
      <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold pb-2">
        Show on the map
      </p>

      <div className="grid grid-cols-3 gap-y-2.5 gap-x-1">
        {SEARCHABLE_FACILITY_KINDS.map((kind) => {
          const spec = FACILITY[kind];
          const Icon = spec.icon;
          const on = activeSet.has(kind);

          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => { haptic('tap'); onToggle(kind); onDone(); }}
              className="flex flex-col items-center gap-1 rounded-xl py-1"
            >
              {/* Off, the tile is its outline and its symbol; on, it fills.
                  Same colour either way, and the same one its pins carry. */}
              <span
                className="w-11 h-11 rounded-full border-2 flex items-center justify-center shadow-lg"
                style={{
                  color: on ? '#020617' : spec.color,
                  backgroundColor: on ? spec.color : 'rgba(2,6,23,0.75)',
                  borderColor: spec.color
                }}
              >
                <Icon className="w-5 h-5" strokeWidth={on ? 2.4 : 2.1} />
              </span>
              <span
                className={`text-[11px] font-bold leading-none text-center ${
                  on ? 'text-slate-100' : 'text-slate-400'
                }`}
              >
                {spec.plural}
              </span>
            </button>
          );
        })}
      </div>

      {/*
        Only when there is something to clear. A permanent "clear" under a grid
        of nine is a tenth control that does nothing nine times out of ten — and
        its absence is itself a useful signal that no layer is on.
      */}
      {active.length > 0 && (
        <button
          type="button"
          onClick={() => { haptic('tap'); onClearAll(); onDone(); }}
          className="mt-2.5 w-full py-2 rounded-xl border border-slate-700 bg-slate-950/80 text-[12px] font-bold text-slate-300 hover:text-slate-100 hover:border-slate-500"
        >
          Turn {active.length === 1 ? 'it' : 'them all'} off
        </button>
      )}

      <p className="text-[11px] text-slate-500 leading-snug pt-2 px-0.5">
        Drawn on the piece of map you are looking at. Mapped by volunteers and
        by campers — an empty result means nobody has mapped one here, not that
        there is none.
      </p>
    </div>
  );
};

FacilityPicker.displayName = 'FacilityPicker';
