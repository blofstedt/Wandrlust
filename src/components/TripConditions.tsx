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

/** Short form for the per-carrier rows, where the carrier name carries context. */
const STRENGTH_SHORT: Record<SignalStrength, string> = {
  strong: 'Strong',
  good: 'Usable',
  weak: 'Weak',
  none: 'Likely none'
};

const TechnologyChip: React.FC<{ technology: CellTechnology }> = ({ technology }) => (
  <span className="px-1.5 py-px rounded bg-slate-700/70 border border-slate-600/60 text-[9px] font-bold text-slate-200 tracking-wide">
    {technology}
  </span>
);

export const CellCoverageCard: React.FC<{
  coverage: CellCoverage | null;
  isLoading?: boolean;
}> = ({ coverage, isLoading }) => {
  const overall = coverage?.overall;
  const named = coverage?.carriers.filter((c) => typeof c.bars === 'number').length ?? 0;

  return (
    <section>
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
        <Signal className="w-3 h-3" />
        Cell signal
      </h3>

      {isLoading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-400 py-2">
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
              <p className="text-[10px] text-slate-400 mt-1.5 flex items-center gap-1.5">
                <RadioTower className="w-3 h-3 shrink-0" />
                Nearest mast {overall.nearestTowerKm} km away
                {overall.towerCount > 1 && ` · ${overall.towerCount} within range`}
              </p>
            </div>
          )}

          {coverage.carriers.length > 0 && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 divide-y divide-slate-700/50">
              {coverage.carriers.map((c) => (
                <div key={c.carrier} className="flex items-center gap-2.5 px-3 py-2">
                  <span className="text-[11px] font-semibold text-slate-200 w-20 shrink-0">
                    {c.label}
                  </span>

                  {typeof c.bars === 'number' && c.strength ? (
                    <>
                      <Bars bars={c.bars} />
                      {c.technology && <TechnologyChip technology={c.technology} />}
                      <span className="text-[10px] text-slate-400 ml-auto text-right">
                        {STRENGTH_SHORT[c.strength]}
                        {c.nearestTowerKm != null && (
                          <span className="block text-slate-500">
                            nearest {c.nearestTowerKm} km
                          </span>
                        )}
                      </span>
                    </>
                  ) : (
                    /* The distinction the whole file exists for: nothing is
                       known about this carrier here, which is not the same as
                       this carrier having no coverage here. */
                    <span className="text-[10px] text-slate-500 ml-auto italic">
                      No data for this carrier
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {!overall && coverage.carriers.length === 0 && (
            <p className="text-[11px] text-slate-400 rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5">
              {coverage.note ?? 'No coverage information for this point.'}
            </p>
          )}

          {/* The caveat travels with the numbers, always, in every branch. */}
          {coverage.basis && (overall || named > 0) && (
            <p className="text-[9px] text-slate-500 leading-tight mt-1.5">{coverage.basis}</p>
          )}
          {coverage.note && (overall || coverage.carriers.length > 0) && (
            <p className="text-[9px] text-slate-500 leading-tight mt-1">{coverage.note}</p>
          )}
        </>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Weather now, and weather when you get there                         */
/* ------------------------------------------------------------------ */

const clockTime = (date: Date): string =>
  date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const ArrivalWeatherCard: React.FC<{
  weather: WeatherSnapshot;
  /** Driving time in minutes, or null when no route has been worked out. */
  travelMinutes: number | null;
  /** Where the drive is measured from, named so the estimate can be judged. */
  originLabel: string;
  isLoading?: boolean;
}> = ({ weather, travelMinutes, originLabel, isLoading }) => {
  const now = weather.periods[0] ?? null;
  const arrival = travelMinutes != null ? forecastOnArrival(weather, travelMinutes) : null;

  // Same period both ends means the drive is short enough that "on arrival" is
  // just "now" — which is worth saying rather than printing the same numbers
  // twice under two different headings as though they were two forecasts.
  const arrivalIsNow = arrival?.isNow ?? false;

  // Hourly data makes "when you arrive" a genuinely different answer from
  // "right now". Twelve-hour blocks usually don't, and the caption below has
  // to say which one the reader is looking at.
  const hourly = weather.resolution === 'hourly';

  return (
    <section>
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
        <ThermometerSun className="w-3 h-3" />
        Weather
      </h3>

      {isLoading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-400 py-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading forecast…
        </div>
      )}

      {!isLoading && !now && (
        <p className="text-[11px] text-slate-400 rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5 flex items-center gap-2">
          <CloudOff className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          {weather.note ?? 'No forecast available for this point.'}
        </p>
      )}

      {!isLoading && now && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-2.5">
            <p className="text-[9px] uppercase tracking-wide font-bold text-slate-500">Right now</p>
            <p className="text-xl font-bold text-slate-100 leading-tight mt-0.5">
              {now.temperature}°{now.temperatureUnit}
            </p>
            <p className="text-[10px] text-slate-300 leading-snug">{now.shortForecast}</p>
            {now.windSpeed && (
              <p className="text-[9px] text-slate-500 mt-0.5">Wind {now.windSpeed}</p>
            )}
          </div>

          <div className="rounded-xl border border-emerald-700/40 bg-emerald-950/30 p-2.5">
            <p className="text-[9px] uppercase tracking-wide font-bold text-emerald-400/90 flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              When you arrive
            </p>

            {arrival == null ? (
              <p className="text-[10px] text-slate-400 leading-snug mt-1">
                Work out a route to see this — the arrival forecast needs a driving time.
              </p>
            ) : arrival.period == null ? (
              <p className="text-[10px] text-slate-400 leading-snug mt-1">
                {arrival.note} You'd get in around {clockTime(arrival.arrivesAt)}.
              </p>
            ) : (
              <>
                <p className="text-xl font-bold text-slate-100 leading-tight mt-0.5">
                  {arrival.period.temperature}°{arrival.period.temperatureUnit}
                </p>
                <p className="text-[10px] text-slate-300 leading-snug">
                  {arrival.period.shortForecast}
                </p>
                <p className="text-[9px] text-emerald-300/80 mt-0.5">
                  ~{clockTime(arrival.arrivesAt)} · {arrival.period.name}
                </p>
                {arrival.period.precipProbability != null &&
                  arrival.period.precipProbability > 0 && (
                    <p className="text-[9px] text-sky-400">
                      {arrival.period.precipProbability}% precip
                    </p>
                  )}
              </>
            )}
          </div>
        </div>
      )}

      {/*
        Where the arrival time came from, and how coarse it is.

        The forecast is published in twelve-hour blocks, so on a short drive
        "when you arrive" and "right now" genuinely are the same prediction.
        Saying so is better than implying we resolved something we didn't.
      */}
      {!isLoading && now && arrival?.period && (
        <p className="text-[9px] text-slate-500 leading-tight mt-1.5">
          {arrivalIsNow
            ? `Short enough drive that you arrive inside the current forecast slot — same conditions. Driving time from ${originLabel}.`
            : hourly
            ? `The forecast hour your arrival falls in. Driving time from ${originLabel}, so a slow road moves it.`
            : `This source only publishes twelve-hour blocks, so this is the block your arrival falls in rather than an hour-by-hour prediction. Driving time from ${originLabel}.`}
        </p>
      )}
    </section>
  );
};