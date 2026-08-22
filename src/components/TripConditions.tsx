import React from 'react';
import { Signal, ThermometerSun, Clock, Loader2, CloudOff, RadioTower } from 'lucide-react';
import type { CellCoverage, SignalStrength, CellTechnology } from '../types';
import type { WeatherSnapshot } from '../services/weatherService';
import { forecastOnArrival } from '../services/weatherService';

/**
 * The two things a camper asks about a spot before committing to the drive:
 * can I get a signal, and what will it be doing when I get there.
 *
 * Both are shared between the dropped-pin sheet and the campsite sheet, and
 * both are built around the same rule: an absence of data is rendered as an
 * absence, in words, and never as a zero.
 */

/* ------------------------------------------------------------------ */
/* Cell coverage                                                       */
/* ------------------------------------------------------------------ */

/**
 * Five bars, of which the lit ones are an estimate.
 *
 * Deliberately drawn in a muted colour rather than the confident green a
 * phone's status bar uses — these are not your phone's bars, they are a guess
 * about where the nearest tower is, and they should not look like a reading.
 */
const Bars: React.FC<{ bars: number }> = ({ bars }) => (
  <span className="flex items-end gap-[2px] h-3.5" aria-hidden="true">
    {[1, 2, 3, 4, 5].map((n) => (
      <span
        key={n}
        className={`w-1 rounded-sm ${n <= bars ? 'bg-sky-400' : 'bg-slate-700'}`}
        style={{ height: `${4 + n * 2}px` }}
      />
    ))}
  </span>
);

/**
 * The estimate in words.
 *
 * Every one of these is hedged — "likely", "probably", "expect" — because the
 * number behind it is a distance to a mast, not a reading off a phone. Colour
 * is muted for the same reason: a confident green here would look like a
 * measurement, and the one thing this must never do is look like a
 * measurement.
 */
const STRENGTH_COPY: Record<SignalStrength, { label: string; className: string }> = {
  strong: { label: 'Strong signal likely', className: 'text-emerald-300' },
  good: { label: 'Usable signal likely', className: 'text-sky-300' },
  weak: { label: 'Weak signal at best', className: 'text-amber-300' },
  none: { label: 'Probably no signal', className: 'text-rose-300' }
};

const TechnologyChip: React.FC<{ technology: CellTechnology }> = ({ technology }) => (
  <span className="px-1.5 py-px rounded bg-slate-700/70 border border-slate-600/60 text-[11px] font-bold text-slate-200 tracking-wide">
    {technology}
  </span>
);

export const CellCoverageCard: React.FC<{
  coverage: CellCoverage | null;
  isLoading?: boolean;
}> = ({ coverage, isLoading }) => {
  const overall = coverage?.overall;

  return (
    <section>
      <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
        <Signal className="w-3 h-3" />
        Cell signal
      </h3>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Checking coverage…
        </div>
      )}

      {!isLoading && coverage && (
        <>
          {/*
            The headline answer, for the camper who does not care whose tower
            it is. Built from every transmitter found, named or not, because
            most surveyed masts record no operator and "can I call for help"
            is the question that actually decides the trip.
          */}
          {overall && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5 mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Bars bars={overall.bars} />
                <span className={`text-xs font-bold ${STRENGTH_COPY[overall.strength].className}`}>
                  {STRENGTH_COPY[overall.strength].label}
                </span>
                {overall.technology && <TechnologyChip technology={overall.technology} />}
              </div>
              <p className="text-[12px] text-slate-400 mt-1.5 flex items-center gap-1.5">
                <RadioTower className="w-3 h-3 shrink-0" />
                Nearest mast {overall.nearestTowerKm} km away
                {overall.towerCount > 1 && ` · ${overall.towerCount} within range`}
              </p>
            </div>
          )}

          {/*
            No per-carrier breakdown, deliberately.

            It used to list Rogers / Telus / Bell / etc., and for almost every
            spot in the app most of those rows read "no data for this carrier"
            — because the survey data records an operator on only a fraction of
            masts. Four rows of nothing, under a headline that already answered
            the question, is noise dressed as detail. The overall estimate
            above is built from every transmitter found, named or not, which is
            the honest resolution of this data.
          */}

          {!overall && (
            <p className="text-xs text-slate-400 rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5">
              {coverage.note ?? 'No coverage information for this point.'}
            </p>
          )}

          {/* The caveat travels with the numbers, always, in every branch. */}
          {coverage.basis && overall && (
            <p className="text-[11px] text-slate-500 leading-tight mt-1.5">{coverage.basis}</p>
          )}
          {coverage.note && overall && (
            <p className="text-[11px] text-slate-500 leading-tight mt-1">{coverage.note}</p>
          )}
        </>
      )}
    </section>
  );
};
