import React from 'react';
import {
  Navigation, X, Crosshair, Users, TriangleAlert, Signal, ThermometerSun,
  SatelliteDish
} from 'lucide-react';
import type { CellCoverage, MapDestination } from '../types';
import type { RouteResult } from '../services/routingService';
import type { WeatherSnapshot } from '../services/weatherService';
import { forecastOnArrival } from '../services/weatherService';
import { bestCarrier } from '../services/cellCoverageService';

/**
 * The heads-up display for navigation mode.
 *
 * Everything here is sized to be read in a glance from a driver's seat, which
 * is why it is three numbers and a stop button rather than a panel. Detail
 * lives in the destination sheet, which you read before you set off.
 *
 * WHAT THIS IS NOT: turn-by-turn. There are no manoeuvre instructions, no
 * voice, and no re-routing when you leave the line. The route comes from a
 * single request to a routing engine and then sits there. Pretending
 * otherwise on a forest road with no signal would be genuinely dangerous, so
 * the panel says what it is, out loud, on screen.
 */

interface NavigationPanelProps {
  destination: MapDestination;
  route: RouteResult;
  weather: WeatherSnapshot;
  coverage: CellCoverage;
  /** Other campers currently drawn on the map. */
  camperCount: number;
  friendCount: number;
  /** False once the user has dragged the map away from the vehicle. */
  isFollowing: boolean;
  /** False while the GPS has no fix — the camper shown is the last known spot. */
  hasPositionFix: boolean;
  onExit: () => void;
  onRecentre: () => void;
}

const clockTime = (date: Date): string =>
  date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const NavigationPanel: React.FC<NavigationPanelProps> = ({
  destination, route, weather, coverage, camperCount, friendCount,
  isFollowing, hasPositionFix, onExit, onRecentre
}) => {
  const hours = Math.floor(route.durationMin / 60);
  const minutes = route.durationMin % 60;
  const arrival = forecastOnArrival(weather, route.durationMin);
  const signal = bestCarrier(coverage);

  const name =
    destination.campsite?.name ?? destination.land?.name ?? 'Your pin';

  const critical = route.warnings.filter((w) => w.severity === 'critical');

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1400] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-events-none">
      <div className="mx-auto max-w-2xl space-y-2">
        {/*
          The last stretch nobody routed.

          Given its own block above everything else because it is the single
          thing most likely to strand a camper: the route line simply stops,
          and if the panel didn't say why, the obvious reading is "arrived".
        */}
        {route.gapToDestinationKm > 0.15 && (
          <div className="pointer-events-auto rounded-2xl bg-amber-950/90 backdrop-blur-md border border-amber-600/60 px-3 py-2 shadow-2xl anim-in-up">
            <p className="text-[11px] font-bold text-amber-200 flex items-center gap-1.5">
              <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
              Route stops {route.gapToDestinationKm < 1
                ? `${Math.round(route.gapToDestinationKm * 1000)} m`
                : `${route.gapToDestinationKm.toFixed(1)} km`} short
            </p>
            <p className="text-[10px] text-amber-100/80 leading-snug mt-0.5">
              The dashed amber line is the remaining distance in a straight line,
              not a road. {route.routesTracks
                ? 'Even with forest tracks included, nothing is mapped for that last bit.'
                : 'This engine ignores unpaved tracks, so a real road may well exist.'}
            </p>
          </div>
        )}

        {/*
          No fix. Said plainly, because the alternative is a camper watching a
          stationary icon and concluding the app has crashed — or worse,
          trusting a position that stopped updating ten minutes ago.
        */}
        {!hasPositionFix && (
          <div className="pointer-events-auto rounded-2xl bg-slate-800/95 backdrop-blur-md border border-slate-600 px-3 py-2 shadow-2xl anim-in-up">
            <p className="text-[11px] font-bold text-slate-200 flex items-center gap-1.5">
              <SatelliteDish className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              No GPS fix right now
            </p>
            <p className="text-[10px] text-slate-400 leading-snug mt-0.5">
              Your camper is drawn at the last position we had. The route is
              still good. This usually clears itself under open sky.
            </p>
          </div>
        )}

        {critical.length > 0 && (
          <div className="pointer-events-auto rounded-2xl bg-rose-950/90 backdrop-blur-md border border-rose-600/60 px-3 py-2 shadow-2xl anim-in-up">
            {critical.map((w, i) => (
              <p key={i} className="text-[10px] text-rose-100 leading-snug flex items-start gap-1.5">
                <TriangleAlert className="w-3 h-3 shrink-0 mt-px text-rose-400" />
                {w.message}
              </p>
            ))}
          </div>
        )}

        <div className="pointer-events-auto rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/70 shadow-2xl overflow-hidden anim-in-up">
          <div className="flex items-stretch">
            {/* ------------------------------------------ the big numbers */}
            <div className="flex-1 min-w-0 px-4 py-3">
              <div className="flex items-center gap-2 mb-0.5">
                <Navigation className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">
                  Navigating
                </span>
              </div>

              <p className="text-base font-bold text-slate-100 truncate leading-tight">{name}</p>

              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-bold text-slate-100 leading-none">
                  {hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}
                </span>
                <span className="text-xs text-slate-400">{route.distanceKm} km</span>
                <span className="text-xs text-slate-400">
                  · arrive ~{clockTime(new Date(Date.now() + route.durationMin * 60_000))}
                </span>
              </div>
            </div>

            {/* ----------------------------------------------- the buttons */}
            <div className="flex flex-col border-l border-slate-700/70">
              {/* Lit while the camera is locked behind the vehicle, so the
                  button doubles as the indicator for whether it still is. */}
              <button
                onClick={onRecentre}
                className={`flex-1 px-3.5 flex items-center justify-center ${
                  isFollowing
                    ? 'text-emerald-400 bg-emerald-950/40'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/70 anim-pulse'
                }`}
                aria-label={isFollowing ? 'Camera is following you' : 'Recentre on me'}
                aria-pressed={isFollowing}
              >
                <Crosshair className="w-4 h-4" />
              </button>
              <button
                onClick={onExit}
                className="flex-1 px-3.5 text-rose-300 hover:text-white hover:bg-rose-900/50 border-t border-slate-700/70 flex items-center justify-center"
                aria-label="Stop navigating"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* -------------------------------------- conditions on arrival */}
          <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-800 text-[10px] text-slate-400 flex-wrap">
            {arrival.period ? (
              <span className="flex items-center gap-1 text-sky-300">
                <ThermometerSun className="w-3 h-3" />
                {arrival.period.temperature}°{arrival.period.temperatureUnit} on arrival,{' '}
                {arrival.period.shortForecast}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <ThermometerSun className="w-3 h-3" />
                {arrival.note ?? 'No arrival forecast'}
              </span>
            )}

            <span className="flex items-center gap-1">
              <Signal className="w-3 h-3" />
              {signal
                ? `~${signal.bars} bar${signal.bars === 1 ? '' : 's'} ${signal.label} there`
                : 'Signal unknown there'}
            </span>

            {camperCount > 0 && (
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {camperCount} camper{camperCount === 1 ? '' : 's'} around
                {friendCount > 0 && `, ${friendCount} named`}
              </span>
            )}
          </div>

          <p className="px-4 pb-2 text-[9px] text-slate-500 leading-tight">
            This is a route line, not turn-by-turn. It will not re-route if you
            leave it and it does not know about closures or seasonal gates.
            Other campers are drawn about a kilometre off their real position,
            and only friends are named.
          </p>
        </div>
      </div>
    </div>
  );
};
