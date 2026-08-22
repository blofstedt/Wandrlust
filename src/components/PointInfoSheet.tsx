import React, { useEffect, useState } from 'react';
import { X, ChevronUp, MapPin, Copy, Check, ArrowRight } from 'lucide-react';
import type { DestinationLand } from '../types';
import type { MarkerDot } from '../utils/amenityDots';
import { Admin1Line } from './Admin1Line';
import { landRules } from '../config/landRules';
import { haptic } from '../utils/animation';

/**
 * EVERYTHING KNOWN ABOUT ONE POINT, AS A CARD RATHER THAN AS EXPANDING PILLS.
 *
 * The "i" under a dropped pin used to unfurl every chip in place: each short
 * label grew into its full hedged sentence, on the map, above the pin. That
 * only worked when the pin happened to be sitting in the middle of an empty
 * screen at a close zoom. Zoomed out, or with the pin near an edge, the stack
 * ran off the top of the screen or across the terrain the camper was reading,
 * and there was nowhere for it to go.
 *
 * A card at the bottom of the screen has no such limit — it reads the same at
 * any zoom, it scrolls, and it is the same shape as the card a submitted spot
 * opens, so the "i" means one thing everywhere.
 *
 * WHAT IT WILL NOT CLAIM. Nothing on this card was checked on the ground.
 * Every line is the full, hedged wording the chip carried, never the short
 * label — the short label exists because a chip is read at a glance, and this
 * is the place where the caveat that got trimmed off is put back.
 */

/** How much of the screen each snap point takes. */
const SNAP_FRACTION = { peek: 0.3, half: 0.56, full: 0.9 } as const;
type Snap = keyof typeof SNAP_FRACTION;

interface PointInfoSheetProps {
  isOpen: boolean;
  /** Every fact the pin is wearing, hazards first — the pin's own chip order. */
  dots: MarkerDot[];
  latitude: number;
  longitude: number;
  /** The parcel the boundary layer matched under this point, when there is one. */
  land?: DestinationLand;
  onClose: () => void;
  /**
   * Take the camera to the thing this line is about — the same tour the chip
   * on the pin runs. Only offered for the lines that have somewhere to go.
   */
  onShowOnMap: (dot: MarkerDot) => void;
  /**
   * How many pixels of screen the card is covering, whenever that changes.
   * The map uses it to keep the pin centred in the strip that is left.
   */
  onHeightChange: (px: number) => void;
}

export const PointInfoSheet: React.FC<PointInfoSheetProps> = ({
  isOpen, dots, latitude, longitude, land, onClose, onShowOnMap, onHeightChange
}) => {
  const [snap, setSnap] = useState<Snap>('half');
  const [copied, setCopied] = useState(false);

  // Every card opens at the same height, however the last one was left.
  useEffect(() => { if (isOpen) setSnap('half'); }, [isOpen]);

  /**
   * Tell the map how much it has lost, in pixels rather than in `vh`.
   *
   * The map centres the pin in what is left, and it can only do that against a
   * real measurement — `vh` on a phone means one thing with the browser's
   * address bar showing and another without it.
   */
  useEffect(() => {
    if (!isOpen) { onHeightChange(0); return; }
    const report = () => onHeightChange(window.innerHeight * SNAP_FRACTION[snap]);
    report();
    window.addEventListener('resize', report);
    return () => {
      window.removeEventListener('resize', report);
      onHeightChange(0);
    };
  }, [isOpen, snap, onHeightChange]);

  if (!isOpen) return null;

  const coords = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[1500]"
      style={{
        height: `${SNAP_FRACTION[snap] * 100}vh`,
        transition: 'height 320ms cubic-bezier(0.16, 1.36, 0.36, 1)'
      }}
    >
      <div className="h-full mx-auto max-w-2xl bg-slate-900 border-t border-x border-slate-700 rounded-t-3xl shadow-2xl flex flex-col overflow-hidden anim-sheet-up">
        {/* Drag handle cycles the snap points, exactly as a spot's card does. */}
        <button
          type="button"
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
              <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[11px] font-bold text-slate-300 uppercase tracking-wide">
                Point you picked
              </span>
              <h2 className="text-base font-bold text-slate-100 truncate mt-1">
                {land?.name ?? 'This spot'}
              </h2>
              {/*
                The designation, not a verdict. "National Forest" is what the
                parcel is called; whether you may sleep on it is a separate
                question this card does not answer.
              */}
              {land?.designation && (
                <p className="text-xs text-slate-400 truncate">{land.designation}</p>
              )}
              <Admin1Line latitude={latitude} longitude={longitude} />
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-2 tap-safe rounded-xl bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2 scroll-soft">
          {/*
            THE RULES, WHERE THERE IS ROOM TO READ THEM.

            The same bullets the land chip's tour puts in a bubble for ten
            seconds — the stay limit, the permit, the fire ban — except here
            they stay put. The card is the long-form version of the chips, and
            a card that showed less about the land than the bubble did would
            send a camper back to the map to re-tap a pill.

            The basis line is not decoration and is not optional: where these
            are the agency's general rules rather than a record for this exact
            parcel, that is the condition on showing them at all.
          */}
          {land && (() => {
            const card = landRules(land);
            return (
              <section className="rounded-xl border border-violet-900/50 bg-violet-950/25 px-3 py-2.5">
                <h3 className="text-[12px] font-bold uppercase tracking-wider text-violet-300 mb-1.5">
                  Camping rules on this land
                </h3>
                <ul className="space-y-1">
                  {card.rules.map((rule) => (
                    <li key={rule} className="flex gap-1.5 text-xs text-slate-200 leading-snug">
                      <span aria-hidden="true" className="text-violet-400 shrink-0">•</span>
                      <span>{rule}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-slate-400 leading-snug mt-2 pt-2 border-t border-violet-900/50">
                  {card.basis ? `${card.basis}. ` : ''}
                  The boundary this came from is approximate — its edge can be
                  hundreds of metres out.
                  {land.attribution ? ` ${land.attribution}.` : ''}
                </p>
              </section>
            );
          })()}

          {dots.length === 0 ? (
            <p className="text-xs text-slate-400 leading-snug">
              Nothing has come back about this point yet. That is not the same
              as nothing being here — the weather, warnings and nearby
              facilities are still being looked up, and any of them can come
              back empty.
            </p>
          ) : (
            <>
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 pt-0.5">
                What is known here
              </h3>

              {dots.map((dot, i) => {
                const travels = Boolean(dot.action) || Boolean(dot.facility);
                return (
                  <div
                    key={dot.key}
                    data-stagger={Math.min(i, 8)}
                    className={`rounded-xl border px-3 py-2.5 anim-in-up ${
                      dot.tone === 'bad'
                        ? 'bg-rose-950/30 border-rose-900/50'
                        : 'bg-slate-800/50 border-slate-700/60'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className="w-2 h-2 rounded-full shrink-0 mt-1.5"
                        style={{
                          background: dot.hollow ? 'transparent' : dot.color,
                          boxShadow: dot.hollow ? `inset 0 0 0 2px ${dot.color}` : 'none'
                        }}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          <span aria-hidden="true">{dot.glyph}</span>
                          {dot.label}
                        </p>
                        {/*
                          The whole sentence, never the chip's short label. This
                          is the wording that carries the hedge — which reading
                          of "under control" an agency meant, that a signal
                          estimate is a distance to a mast, that a boundary edge
                          can be hundreds of metres out.
                        */}
                        {dot.full && dot.full !== dot.label && (
                          <p className="text-xs text-slate-300 leading-snug mt-1">
                            {dot.full}
                          </p>
                        )}
                        {travels && (
                          <button
                            type="button"
                            onClick={() => { haptic('tap'); onShowOnMap(dot); }}
                            className="mt-2 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-[12px] font-bold text-slate-200 hover:text-white hover:border-slate-500 flex items-center gap-1.5"
                          >
                            Show me on the map
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(coords);
              setCopied(true);
              haptic('tap');
              setTimeout(() => setCopied(false), 2000);
            }}
            className="w-full mt-2 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-slate-700"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : coords}
          </button>

          <p className="text-[12px] text-slate-500 leading-snug flex items-start gap-1.5 pt-1">
            <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              Nobody has stood here for Wandrlust. Everything above is read off
              public feeds and boundary data at these coordinates, and an empty
              answer means nothing came back rather than nothing being there.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
};
