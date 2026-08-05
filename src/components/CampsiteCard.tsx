import React from 'react';
import { MapPin, Star, Wifi, Droplet, Truck, Bookmark, ChevronRight, ExternalLink } from 'lucide-react';
import type { Campsite, LandType } from '../types';
import {
  getCampsiteDisplayImage, getCloseSatelliteImageUrl, getStreetViewUrl
} from '../utils/imageUtils';

const LAND_TYPE_STYLE: Record<LandType, string> = {
  blm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  usfs: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  state_forest: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  crown_land: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  dispersed: 'bg-violet-500/20 text-violet-300 border-violet-500/40'
};

interface CampsiteCardProps {
  campsite: Campsite;
  isSelected?: boolean;
  isSaved?: boolean;
  onSelect: (site: Campsite) => void;
  onToggleSave: (site: Campsite, e: React.MouseEvent) => void;
  onOpenDetail: (site: Campsite) => void;
  distanceMiles?: number;
}

export const CampsiteCard: React.FC<CampsiteCardProps> = ({
  campsite, isSelected, isSaved, onSelect, onToggleSave, onOpenDetail, distanceMiles
}) => {
  const bestSignal = Math.max(
    campsite.amenities.cellSignal.verizon,
    campsite.amenities.cellSignal.att,
    campsite.amenities.cellSignal.tmobile
  );

  return (
    <article
      onClick={() => onSelect(campsite)}
      className={`group liftable relative bg-slate-900/90 border rounded-2xl p-4 cursor-pointer overflow-hidden ${
        isSelected
          ? 'border-emerald-500 ring-2 ring-emerald-500/40 shadow-xl shadow-emerald-950/40 bg-slate-800/90'
          : 'border-slate-800 hover:border-slate-700 shadow-lg'
      }`}
    >
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Thumbnail */}
        <div className="relative w-full sm:w-36 h-36 rounded-xl overflow-hidden shrink-0 bg-slate-950">
          <img
            src={getCampsiteDisplayImage(campsite)}
            alt={campsite.name}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src =
                getCloseSatelliteImageUrl(campsite.latitude, campsite.longitude);
            }}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />

          <a
            href={getStreetViewUrl(campsite.latitude, campsite.longitude)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="btn absolute top-2 left-2 px-1.5 py-1 rounded-md bg-slate-950/80 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-950/80 text-[10px] font-bold flex items-center gap-1 backdrop-blur-md"
            title="Open Street View at these coordinates"
          >
            <ExternalLink className="w-3 h-3" />
            Street View
          </a>

          <button
            onClick={(e) => onToggleSave(campsite, e)}
            className={`absolute top-2 right-2 p-2 rounded-full backdrop-blur-md border ${
              isSaved
                ? 'bg-amber-500 text-slate-950 border-amber-300 shadow-md'
                : 'bg-slate-950/70 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-950'
            }`}
            aria-label={isSaved ? 'Remove from saved' : 'Save for offline'}
          >
            <Bookmark className="w-3.5 h-3.5" fill={isSaved ? 'currentColor' : 'none'} />
          </button>

          <span
            className={`absolute bottom-2 left-2 px-2 py-0.5 rounded text-[10px] font-black uppercase border tracking-wider ${LAND_TYPE_STYLE[campsite.landType]}`}
          >
            {campsite.landType.replace('_', ' ')}
          </span>
        </div>

        {/* Details */}
        <div className="flex-1 flex flex-col justify-between min-w-0">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-['Outfit'] font-bold text-base sm:text-lg text-slate-100 group-hover:text-emerald-300 transition-colors line-clamp-1">
                  {campsite.name}
                </h3>
                <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5 flex-wrap">
                  <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">
                    {campsite.address.nearestCity}
                    {campsite.address.stateProvince && `, ${campsite.address.stateProvince}`}
                  </span>
                  {distanceMiles !== undefined && (
                    <>
                      <span>•</span>
                      <span className="text-emerald-400 font-medium">
                        {distanceMiles.toFixed(1)} mi away
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-amber-400 font-bold text-xs shrink-0">
                {campsite.reviewCount > 0 ? (
                  <>
                    <Star className="w-3.5 h-3.5 fill-current" />
                    <span>{campsite.rating.toFixed(1)} ({campsite.reviewCount})</span>
                  </>
                ) : (
                  <span className="text-emerald-400 text-[10px] font-extrabold uppercase tracking-wide">
                    Public site
                  </span>
                )}
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-300 line-clamp-2 leading-relaxed">
              {campsite.description}
            </p>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-300">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 font-semibold text-[11px] border border-emerald-800/50">
                {campsite.amenities.stayLimitDays}-day limit
              </span>

              <span className="flex items-center gap-1 text-[11px] text-slate-400">
                <Wifi className="w-3.5 h-3.5 text-teal-400" />
                {bestSignal} bars
              </span>

              <span className="flex items-center gap-1 text-[11px] text-slate-400 capitalize">
                <Truck className="w-3.5 h-3.5 text-amber-400" />
                {campsite.amenities.roadAccess.replace('_', ' ')}
              </span>

              {campsite.amenities.water !== 'none' && (
                <span className="flex items-center gap-1 text-[11px] text-sky-400 capitalize">
                  <Droplet className="w-3.5 h-3.5" />
                  {campsite.amenities.water.replace('_', ' ')}
                </span>
              )}
            </div>

            <button
              onClick={(e) => { e.stopPropagation(); onOpenDetail(campsite); }}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
            >
              Full info
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};
