import React, { useState } from 'react';
import {
  X, Navigation, Loader2, ShieldCheck, Flame, Copy, Check, Eye,
  ChevronUp, TriangleAlert, MapPin
} from 'lucide-react';
import type { CellCoverage, MapDestination } from '../types';
import type { WeatherSnapshot } from '../services/weatherService';
import type { RouteResult } from '../services/routingService';
import { CellCoverageCard, ArrivalWeatherCard } from './TripConditions';
import { haptic } from '../utils/animation';

/**
 * What's at the place you just picked.
 *
 * Opens for both kinds of destination: a pin the user dropped on bare map, and
 * an existing camper-submitted spot they tapped. They get the same treatment —
 * land, signal, weather, and a way to drive there — because from the driver's
 * seat they are the same question.
 *
 * NOT built on ui/Sheet, and that is deliberate rather than an oversight. That
 * primitive is a modal: it lays a backdrop over everything and traps focus,
 * which is right for a form and wrong here. The entire interaction this panel
 * belongs to is "tap somewhere else to move the pin", so the map underneath
 * has to stay both visible and clickable. It follows CampsiteBottomSheet's
 * shape instead, which is the established pattern for panels over the map.
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
  onNavigate: () => void;
  /** Only offered for a real campsite; a bare point has no detail page. */
  onOpenDetail?: () => void;
}

export const DestinationSheet: React.FC<DestinationSheetProps> = ({
  destination, route, isRouting, originLabel, weather, coverage,
  isLoadingConditions, onClose, onNavigate, onOpenDetail
}) => {
  const [snap, setSnap] = useState<'peek' | 'half' | 'full'>('half');
  const [copied, setCopied] = useState(false);

  if (!destination) return null;

  const site = destination.campsite;
  const land = destination.land;
  const coords = `${destination.latitude.toFixed(5)}, ${destination.longitude.toFixed(5)}`;
  const heightClass = snap === 'peek' ? 'h-[24vh]' : snap === 'half' ? 'h-[58vh]' : 'h-[92vh]';

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-[1500] ${heightClass}`}
      style={{ transition: 'height 320ms cubic-bezier(0.16, 1.36, 0.36, 1)' }}
    >
      <div className="h-full mx-auto max-w-2xl bg-slate-900 border-t border-x border-slate-700 rounded-t-3xl shadow-2xl flex flex-col overflow-hidden anim-sheet-up">
        <button
          onClick={() => setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek')}
          className="w-full pt-2.5 pb-1.5 flex flex-col items-center gap-1 shrink-0 hover:bg-slate-800/40 no-press"
          aria-label="Resize panel"
        >
          <div className="w-10 h-1 rounded-full bg-slate-600" />
          {snap === 'peek' && <ChevronUp className="w-3 h-3 text-slate-500 animate-pulse" />}
        </button>

        {/* ------------------------------------------------------- header */}
        <div className="px-4 pb-3 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
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

              <h2 className="text-base font-bold text-slate-100 truncate">
                {site ? site.name : land?.name ?? 'This spot'}
              </h2>
              <p className="text-[11px] text-slate-400 truncate">{coords}</p>
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Drive summary, sized to be readable in the peek snap. */}
          <div className="mt-2.5 flex items-center gap-3 text-[11px] text-slate-400 flex-wrap">
            {isRouting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Working out the drive…
              </span>
            ) : route?.ok ? (
              <>
                <span className="text-slate-200 font-semibold">
                  {route.distanceKm} km
                </span>
                <span>
                  ~{Math.floor(route.durationMin / 60)}h {route.durationMin % 60}m from{' '}
                  {originLabel}
                </span>
              </>
            ) : (
              <span className="italic">{route?.message ?? 'No route worked out yet'}</span>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------- body */}
        {snap !== 'peek' && (
          <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4 scroll-soft">
            {/*
              The land, and what it permits.

              Read from the boundary polygon already on screen, which is why
              its absence means "no polygon covers this point in the data we
              have loaded" — never "this isn't public land". The app has no
              coverage at all for most of Canada, and a blank here over
              Saskatchewan means nothing about Saskatchewan.
            */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                The land here
              </h3>

              {land ? (
                <div className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-xs font-bold text-slate-200">{land.name}</span>
                  </div>
                  <p className="text-[10px] text-slate-400">{land.designation}</p>

                  <div className="grid grid-cols-2 gap-2 text-[11px] mt-2">
                    {land.stayLimitDays != null && (
                      <div>
                        <span className="text-slate-500">Stay limit</span>
                        <p className="text-slate-200 font-semibold">{land.stayLimitDays} days</p>
                      </div>
                    )}
                    {land.permitRequired !== undefined && (
                      <div>
                        <span className="text-slate-500">Permit</span>
                        <p className="text-slate-200 font-semibold">
                          {land.permitRequired
                            ? land.permitName ?? 'Required'
                            : 'Not required'}
                        </p>
                        {land.permitRequired && land.permitUrl && (
                          <a
                            href={land.permitUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-sky-400 underline"
                          >
                            Get it here
                          </a>
                        )}
                      </div>
                    )}
                    {land.campfirePolicy && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Fires</span>
                        <p className="text-slate-200 font-semibold">{land.campfirePolicy}</p>
                      </div>
                    )}
                  </div>

                  {land.stayLimitDays == null && land.permitRequired === undefined && (
                    <p className="text-[10px] text-slate-400 leading-snug mt-2">
                      No camping rules recorded for this parcel. That does not mean
                      there are none — check with{' '}
                      {land.attribution ?? 'the managing agency'} before you stay.
                    </p>
                  )}

                  <p className="text-[9px] text-slate-500 mt-2 pt-2 border-t border-slate-700/60 leading-snug">
                    Approximate boundary — not permission to camp.
                    {land.attribution ? ` ${land.attribution}` : ''}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5 leading-snug">
                  No mapped parcel covers this point. That means we have no data
                  here, not that the land is private or closed. Zoom in to load
                  boundaries, and check with the local land manager either way.
                </p>
              )}
            </section>

            <CellCoverageCard coverage={coverage} isLoading={isLoadingConditions} />

            <ArrivalWeatherCard
              weather={weather}
              travelMinutes={route?.ok ? route.durationMin : null}
              originLabel={originLabel}
              isLoading={isLoadingConditions}
            />

            {/* Anything the routing engine wants to say about your rig. */}
            {route?.ok && route.warnings.length > 0 && (
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  About this route
                </h3>
                <div className="space-y-1.5">
                  {route.warnings.map((w, i) => (
                    <div
                      key={i}
                      data-stagger={Math.min(i, 6)}
                      className={`rounded-xl border px-3 py-2 flex items-start gap-2 anim-in-up ${
                        w.severity === 'critical'
                          ? 'bg-rose-950/50 border-rose-600/50'
                          : w.severity === 'caution'
                          ? 'bg-amber-950/40 border-amber-600/40'
                          : 'bg-slate-800/50 border-slate-700/60'
                      }`}
                    >
                      <TriangleAlert
                        className={`w-3.5 h-3.5 shrink-0 mt-px ${
                          w.severity === 'critical'
                            ? 'text-rose-400'
                            : w.severity === 'caution'
                            ? 'text-amber-400'
                            : 'text-slate-400'
                        }`}
                      />
                      <p className="text-[10px] text-slate-200 leading-snug">{w.message}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-slate-500 mt-1.5">
                  Route from {route.provider}.
                </p>
              </section>
            )}

            <section className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(coords);
                  setCopied(true);
                  haptic('tap');
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex-1 px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-slate-700"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : coords}
              </button>
              {onOpenDetail && (
                <button
                  onClick={onOpenDetail}
                  className="px-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 hover:bg-slate-700"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Details
                </button>
              )}
            </section>
          </div>
        )}

        {/* --------------------------------------------------- navigate */}
        <div className="px-4 pb-4 pt-2 border-t border-slate-800 shrink-0 bg-slate-900">
          <button
            onClick={() => { haptic('success'); onNavigate(); }}
            disabled={isRouting || !route?.ok}
            className="w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:bg-emerald-600 shadow-lg shadow-emerald-950/50"
          >
            {isRouting
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Navigation className="w-4 h-4" />}
            {isRouting ? 'Finding a route…' : 'Navigate here'}
          </button>
        </div>
      </div>
    </div>
  );
};
