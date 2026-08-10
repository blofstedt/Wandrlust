import React, { useState, useEffect, useRef } from 'react';
import {
  X, Navigation, Loader2, ShieldCheck, Copy, Check, Eye, ChevronLeft,
  TriangleAlert, MapPin, Signal, ThermometerSun, Flame, PlusCircle
} from 'lucide-react';
import type { CellCoverage, MapDestination } from '../types';
import type { WeatherSnapshot } from '../services/weatherService';
import type { RouteResult } from '../services/routingService';
import { forecastOnArrival } from '../services/weatherService';
import { HazardAlertPanel } from './HazardAlertPanel';
import { NearbyFiresTile } from './NearbyFiresCard';
import { Admin1Line } from './Admin1Line';
import { haptic } from '../utils/animation';
import { directionsAppName } from '../utils/handoff';

/**
 * What's at the place you just picked.
 *
 * Opens for both kinds of destination: a pin the user dropped on bare map, and
 * an existing camper-submitted spot they tapped. They get the same treatment —
 * land, signal, weather, and a way to drive there — because from the driver's
 * seat they are the same question.
 *
 * HALF THE SCREEN, NO SCROLLING. This used to be a resizable stack of sections
 * that ran to three or four screenfuls, so reading the signal estimate meant
 * scrolling past a paragraph about boundary accuracy, and the map — the thing
 * the panel is describing — was hidden while you did it. It is now a fixed
 * half-height panel laid out as a grid of tiles, each one headline-first: the
 * answer in a few words, the hedging underneath it in small type. The rows
 * share whatever height the panel has, so it fits a small phone and a desktop
 * without a scrollbar either way.
 *
 * Nothing that qualifies a number was dropped to make it fit. What got cut is
 * repetition — the same caveat restated in three sections — and long-form
 * detail that already has a home: the warning list opens on top of the grid
 * when tapped, and everything about the site itself is behind "Details".
 *
 * SIX CELLS, THREE ROWS, HARD CEILING. The first cut of this grid let tiles
 * accumulate — warnings, fires, signal, now, arrival, land, road — which on a
 * phone came to four rows sharing about 250 px, and text was cut off inside
 * the tiles. So the count is capped by design rather than by luck: the two
 * weather tiles are one tile with both temperatures in it, and the road
 * warning moved up beside the drive time it belongs to. Worst case is now
 * warnings + fire + signal + weather + land = three rows; the common case,
 * with nothing wrong anywhere, is two big ones.
 *
 * NOT built on ui/Sheet, and that is deliberate rather than an oversight. That
 * primitive is a modal: it lays a backdrop over everything and traps focus,
 * which is right for a form and wrong here. The entire interaction this panel
 * belongs to is "tap somewhere else to move the pin", so the map underneath
 * has to stay both visible and clickable.
 */

interface DestinationSheetProps {
  destination: MapDestination | null;
  /** The route worked out for this destination, when there is one. */
  route: RouteResult | null;
  isRouting: boolean;
  /** Where the drive is measured from — "your location" or the map centre. */
  originLabel: string;
  /**
   * Conditions at the destination, fetched by App.
   *
   * Lifted rather than fetched here because the navigation HUD needs the same
   * two answers, and a panel that unmounts the moment you set off is the wrong
   * owner of data that has to survive that.
   */
  weather: WeatherSnapshot;
  coverage: CellCoverage;
  isLoadingConditions: boolean;
  onClose: () => void;
  /** Hands the drive to Apple or Google Maps. See `src/utils/handoff.ts`. */
  onOpenDirections: () => void;
  /** Only offered for a real campsite; a bare point has no detail page. */
  onOpenDetail?: () => void;
  /**
   * Submit this exact point as a campsite.
   *
   * Only passed for a pin the camper dropped on bare map, because that is the
   * only case where the point is not already a spot. This is where adding a
   * spot now starts: the form is seeded with the coordinates of the pin in
   * front of them, instead of asking them to type a latitude.
   */
  onAddSpotHere?: () => void;
  /**
   * How much of the screen this panel is covering, 0–1.
   *
   * Reported upward so the map can move the pin into the strip that is still
   * visible. Without it the panel opens directly over the spot you just
   * tapped, and the first thing the app does after you pick somewhere is hide
   * it from you.
   */
  onCoverageFractionChange?: (fraction: number) => void;
}

/**
 * How much of the screen the panel takes.
 *
 * One number, not a set of snaps: the grid is built to fit exactly this, and
 * the map keeps the other half. Kept here as a fraction as well as a class
 * because the map needs the same figure to work out where to park the pin,
 * and a class string it would have to parse is how the two drift apart.
 */
const SHEET_FRACTION = 0.5;

/** One cell of the bento. Headline first, hedge underneath, never scrolls. */
const Tile: React.FC<{
  icon: React.ReactNode;
  label: string;
  tone?: 'plain' | 'warn' | 'danger';
  span?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ icon, label, tone = 'plain', span, onClick, children }) => {
  const toneClass =
    tone === 'danger'
      ? 'border-rose-600/50 bg-rose-950/30'
      : tone === 'warn'
      ? 'border-amber-600/50 bg-amber-950/25'
      : 'border-slate-700/60 bg-slate-800/50';

  const body = (
    <>
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1 shrink-0 min-w-0">
        <span className="shrink-0 flex">{icon}</span>
        <span className="truncate">{label}</span>
      </p>
      <div className="min-h-0 overflow-hidden mt-0.5">{children}</div>
    </>
  );

  const className = `rounded-xl border ${toneClass} px-2.5 py-1.5 flex flex-col min-h-0 min-w-0 ${
    span ? 'col-span-2' : ''
  }`;

  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} text-left hover:bg-slate-800`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
};

/** Five bars, of which the lit ones are an estimate, not a reading. */
const Bars: React.FC<{ bars: number }> = ({ bars }) => (
  <span className="flex items-end gap-[2px] h-3" aria-hidden="true">
    {[1, 2, 3, 4, 5].map((n) => (
      <span
        key={n}
        className={`w-1 rounded-sm ${n <= bars ? 'bg-sky-400' : 'bg-slate-700'}`}
        style={{ height: `${3 + n * 2}px` }}
      />
    ))}
  </span>
);

/**
 * Every one of these is hedged — "likely", "at best" — because the number
 * behind it is a distance to a mast, not a reading off a phone.
 */
const STRENGTH_COPY: Record<string, { label: string; className: string }> = {
  strong: { label: 'Strong signal likely', className: 'text-emerald-300' },
  good: { label: 'Usable signal likely', className: 'text-sky-300' },
  weak: { label: 'Weak signal at best', className: 'text-amber-300' },
  none: { label: 'Probably no signal', className: 'text-rose-300' }
};

const clockTime = (date: Date): string =>
  date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const DestinationSheet: React.FC<DestinationSheetProps> = ({
  destination, route, isRouting, originLabel, weather, coverage,
  isLoadingConditions, onClose, onOpenDirections, onOpenDetail, onAddSpotHere,
  onCoverageFractionChange
}) => {
  const [copied, setCopied] = useState(false);
  /** The one thing that opens on top of the grid: the full warning list. */
  const [showWarnings, setShowWarnings] = useState(false);

  const open = Boolean(destination);
  const fraction = open ? SHEET_FRACTION : 0;

  /**
   * Tell the map how much room it has left, whenever that changes.
   *
   * From an effect rather than inline, so the parent is never asked to
   * re-render during this one's render.
   */
  useEffect(() => {
    onCoverageFractionChange?.(fraction);
  }, [fraction, onCoverageFractionChange]);

  /**
   * Hand the map back its whole viewport when this panel goes away.
   *
   * App unmounts this outright when a campsite sheet or a hazard card takes
   * over the bottom edge, so the effect above never gets to report the panel
   * shrinking to nothing. Without this the map would keep parking pins around
   * a panel that is no longer there.
   */
  const reportRef = useRef(onCoverageFractionChange);
  reportRef.current = onCoverageFractionChange;
  useEffect(() => () => reportRef.current?.(0), []);

  // Close the warning list when the pin moves, so the next spot opens on its
  // own summary rather than on the last spot's drill-down.
  useEffect(() => { setShowWarnings(false); }, [destination]);

  // Hooks first, then the early return — the panel closing must not change how
  // many hooks this component runs.
  if (!destination) return null;

  const site = destination.campsite;
  const land = destination.land;
  const coords = `${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`;

  const alerts = weather.alerts;
  const overall = coverage.overall;
  const now = weather.periods[0] ?? null;
  const arrival = route?.ok ? forecastOnArrival(weather, route.durationMin) : null;
  const routeWarnings = route?.ok ? route.warnings : [];
  const worstRouteWarning =
    routeWarnings.find((w) => w.severity === 'critical') ?? routeWarnings[0] ?? null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1500] h-[50vh]">
      <div className="relative h-full mx-auto max-w-2xl bg-slate-900 border-t border-x border-slate-700 rounded-t-3xl shadow-2xl flex flex-col overflow-hidden anim-sheet-up">
        <div className="pt-2.5 pb-1 flex justify-center shrink-0">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>

        {/* ------------------------------------------------------- header */}
        <div className="px-4 pb-2 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-[9px] font-bold text-rose-200 uppercase tracking-wide flex items-center gap-1">
                  <MapPin className="w-2.5 h-2.5" />
                  {site ? 'Camper spot' : 'Your pin'}
                </span>
                {land?.fireBanActive && (
                  <span className="px-1.5 py-0.5 rounded bg-orange-600 text-white text-[9px] font-bold flex items-center gap-1 anim-pulse-danger">
                    <Flame className="w-2.5 h-2.5" />
                    FIRE BAN
                  </span>
                )}
              </div>

              <h2 className="text-base font-bold text-slate-100 truncate mt-0.5">
                {site ? site.name : land?.name ?? 'This spot'}
              </h2>
              {/* Country and province, small: reference, not the headline.
                  The coordinates are on the copy button in the footer rather
                  than repeated here — a line of digits twice over was costing
                  the grid a row it could not spare. */}
              <Admin1Line
                latitude={destination.latitude}
                longitude={destination.longitude}
              />
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-400 flex-wrap">
            {isRouting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Working out the drive…
              </span>
            ) : route?.ok ? (
              <>
                <span className="text-slate-200 font-semibold">{route.distanceKm} km</span>
                <span>
                  ~{route.durationMin >= 60
                    ? `${Math.floor(route.durationMin / 60)}h ${route.durationMin % 60}m`
                    : `${route.durationMin}m`}{' '}
                  from {originLabel}
                </span>
                {/* The shortfall belongs beside the drive time — it changes
                    whether the trip is even on. */}
                {route.gapToDestinationKm > 0.15 && (
                  <span className="text-amber-300 font-semibold">
                    · last{' '}
                    {route.gapToDestinationKm < 1
                      ? `${Math.round(route.gapToDestinationKm * 1000)} m`
                      : `${route.gapToDestinationKm.toFixed(1)} km`}{' '}
                    unrouted
                  </span>
                )}
              </>
            ) : (
              <span className="italic">{route?.message ?? 'No route worked out yet'}</span>
            )}
          </div>

          {/*
            What the road does, beside how long it takes.

            This was a tile of its own, which cost the grid a whole row for one
            sentence about the drive — and the drive is what the line above is
            already about. Only the worst warning is shown; the rest are on the
            route itself, which is drawn on the map.
          */}
          {worstRouteWarning && (
            <p
              className={`mt-1 text-[10px] leading-tight flex items-start gap-1.5 ${
                worstRouteWarning.severity === 'critical' ? 'text-rose-300' : 'text-amber-300'
              }`}
            >
              <TriangleAlert className="w-3 h-3 shrink-0 mt-px" />
              <span className="line-clamp-2">
                {worstRouteWarning.message}
                {routeWarnings.length > 1 && ` (+${routeWarnings.length - 1} more)`}
              </span>
            </p>
          )}
        </div>

        {/* --------------------------------------------------------- bento */}
        {/*
          `auto-rows-fr` is what makes the no-scrolling promise keepable: the
          rows divide whatever height is left rather than each claiming their
          content's height, and every tile clips its own overflow. A phone in
          landscape gets shorter tiles, not a scrollbar.
        */}
        <div className="flex-1 min-h-0 px-4 pb-2 grid grid-cols-2 auto-rows-fr gap-2 overflow-hidden">
          {alerts.length > 0 && (
            <Tile
              icon={<TriangleAlert className="w-3 h-3" />}
              label={`${alerts.length} official warning${alerts.length === 1 ? '' : 's'}`}
              tone="danger"
              span
              onClick={() => setShowWarnings(true)}
            >
              <p className="text-[11px] font-bold text-rose-100 leading-tight line-clamp-2">
                {alerts.map((a) => a.event).join(' · ')}
              </p>
              <p className="text-[9px] text-rose-300/80 mt-0.5">Tap to read them</p>
            </Tile>
          )}

          <NearbyFiresTile
            latitude={destination.latitude}
            longitude={destination.longitude}
          />

          <Tile icon={<Signal className="w-3 h-3" />} label="Cell signal">
            {isLoadingConditions ? (
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Checking…
              </p>
            ) : overall ? (
              <>
                <div className="flex items-center gap-1.5">
                  <Bars bars={overall.bars} />
                  <span
                    className={`text-[11px] font-bold leading-tight ${
                      STRENGTH_COPY[overall.strength].className
                    }`}
                  >
                    {STRENGTH_COPY[overall.strength].label}
                  </span>
                </div>
                {/* Distance to the nearest mast is the whole basis of the
                    estimate, so it stays on the tile with it. */}
                <p className="text-[9px] text-slate-500 leading-tight mt-0.5">
                  Nearest mast {overall.nearestTowerKm} km · straight-line guess,
                  terrain ignored
                </p>
              </>
            ) : (
              <p className="text-[10px] text-slate-400 leading-snug">
                {coverage.note ?? 'No coverage information for this point.'}
              </p>
            )}
          </Tile>

          {/*
            Now and on arrival in one tile, because they are the same question
            asked twice and reading them side by side is how you tell whether
            the drive is worth starting. Two tiles for this was a row of the
            grid spent on a duplicated layout.
          */}
          <Tile icon={<ThermometerSun className="w-3 h-3" />} label="Weather">
            {isLoadingConditions ? (
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading…
              </p>
            ) : now ? (
              <>
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="text-lg font-bold text-slate-100 leading-none shrink-0">
                    {now.temperature}°{now.temperatureUnit}
                  </span>
                  <span className="text-[10px] text-slate-300 leading-tight truncate">
                    {now.shortForecast}
                  </span>
                </div>
                {arrival?.period ? (
                  <p className="text-[10px] text-slate-400 leading-tight mt-0.5 truncate">
                    <span className="text-emerald-300/90 font-semibold">
                      {arrival.period.temperature}°{arrival.period.temperatureUnit}
                    </span>{' '}
                    when you get in, ~{clockTime(arrival.arrivesAt)}
                  </p>
                ) : (
                  <p className="text-[9px] text-slate-500 leading-tight mt-0.5 line-clamp-2">
                    {arrival
                      ? `${arrival.note} You'd get in around ${clockTime(arrival.arrivesAt)}.`
                      : 'Arrival forecast needs a driving time.'}
                  </p>
                )}
                {now.windSpeed && (
                  <p className="text-[9px] text-slate-500 truncate">Wind {now.windSpeed}</p>
                )}
              </>
            ) : (
              <p className="text-[10px] text-slate-400 leading-snug line-clamp-3">
                {weather.note ?? 'No forecast for this point.'}
              </p>
            )}
          </Tile>

          {/*
            The land, and what it permits.

            Read from the boundary polygon already on screen, which is why its
            absence means "no polygon covers this point in the data we have
            loaded" — never "this isn't public land".
          */}
          <Tile icon={<ShieldCheck className="w-3 h-3" />} label="The land here">
            {land ? (
              <>
                <p className="text-[11px] font-bold text-slate-100 leading-tight line-clamp-2">
                  {land.name}
                </p>
                <p className="text-[9px] text-slate-400 leading-tight line-clamp-1">
                  {[
                    land.designation,
                    land.stayLimitDays != null ? `${land.stayLimitDays}-day limit` : null,
                    land.permitRequired === undefined
                      ? null
                      : land.permitRequired
                      ? land.permitName ?? 'Permit required'
                      : 'No permit'
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="text-[9px] text-slate-500 leading-tight mt-0.5 line-clamp-2">
                  Approximate edge — not permission to camp.
                </p>
              </>
            ) : (
              <p className="text-[10px] text-slate-400 leading-snug line-clamp-4">
                No mapped parcel here. That is missing data, not private or
                closed land — check with the local land manager.
              </p>
            )}
          </Tile>
        </div>

        {/* ------------------------------------------------------- actions */}
        {/*
          One row, not two. The coordinates live on the copy button — it is
          the only place they are needed and it doubles as the label — which
          buys the grid above about forty pixels of tile height.
        */}
        <div className="px-4 pb-3 pt-1.5 border-t border-slate-800 shrink-0 bg-slate-900 flex items-stretch gap-1.5">
          <button
            onClick={() => {
              navigator.clipboard.writeText(coords);
              setCopied(true);
              haptic('tap');
              setTimeout(() => setCopied(false), 2000);
            }}
            className="min-w-0 flex-1 px-2 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-bold flex items-center justify-center gap-1.5 hover:bg-slate-700"
            aria-label="Copy the coordinates"
          >
            {copied ? <Check className="w-3 h-3 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
            <span className="truncate">{copied ? 'Copied' : coords}</span>
          </button>

          {/*
            The way a spot gets added.

            It used to be a menu item that opened an empty form, so the first
            thing it asked for was a latitude — which nobody knows, and which
            the app was already showing on screen. Here the coordinates are
            the pin you are looking at, and the button only exists for a bare
            dropped pin: a spot that is already on the map cannot be added
            again.
          */}
          {onAddSpotHere && (
            <button
              onClick={() => { haptic('tap'); onAddSpotHere(); }}
              className="px-3 py-2 rounded-xl bg-slate-800 border border-emerald-600/60 text-emerald-300 text-[10px] font-bold flex items-center gap-1.5 hover:bg-slate-700 shrink-0"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              Add spot
            </button>
          )}

          {onOpenDetail && (
            <button
              onClick={onOpenDetail}
              className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-bold flex items-center gap-1.5 hover:bg-slate-700 shrink-0"
            >
              <Eye className="w-3 h-3" />
              Details
            </button>
          )}

          {/*
            NOT disabled while the route is still being worked out, and not
            disabled when there is no route at all — this button opens the
            phone's maps app with a coordinate, which our routing engine has no
            say in. A camper who can see the pin can always set off towards it.
          */}
          <button
            onClick={() => { haptic('success'); onOpenDirections(); }}
            className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-950/50 shrink-0"
          >
            <Navigation className="w-4 h-4 shrink-0" />
            <span className="whitespace-nowrap">{directionsAppName()}</span>
          </button>
        </div>

        {/*
          The warning list, over the grid rather than inside it.

          Warnings are the one thing here that can run long and must not be
          summarised away, so they get the whole panel when asked for. This is
          the only place in the sheet that scrolls, and only after a tap.
        */}
        {showWarnings && alerts.length > 0 && (
          <div className="absolute inset-0 bg-slate-900 rounded-t-3xl flex flex-col anim-in-up">
            <div className="px-4 py-3 flex items-center gap-2 border-b border-slate-800 shrink-0">
              <button
                onClick={() => setShowWarnings(false)}
                className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white"
                aria-label="Back to the spot"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Active warnings here
              </h3>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 scroll-soft">
              <HazardAlertPanel alerts={alerts} compact />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
