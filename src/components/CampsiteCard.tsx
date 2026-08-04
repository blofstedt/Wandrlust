import React from 'react';
import { Campsite, LandType } from '../types';
import { getCampsiteDisplayImage, getCloseSatelliteImageUrl, getStreetViewUrl } from '../utils/imageUtils';
import {
  MapPin,
  Star,
  Wifi,
  Droplet,
  Truck,
  Bookmark,
  ChevronRight,
  ShieldCheck,
  Flame,
  Dog,
  ExternalLink
} from 'lucide-react';

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
  campsite,
  isSelected,
  isSaved,
  onSelect,
  onToggleSave,
  onOpenDetail,
  distanceMiles
}) => {
  const getLandTypeStyle = (type: LandType) => {
    switch (type) {
      case 'blm':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'usfs':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      case 'state_forest':
      case 'crown_land':
        return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
      case 'dispersed':
      default:
        return 'bg-violet-500/20 text-violet-300 border-violet-500/40';
    }
  };

  const totalCellBars = Math.max(
    campsite.amenities.cellSignal.verizon,
    campsite.amenities.cellSignal.att,
    campsite.amenities.cellSignal.tmobile
  );

  return (
    <div
      onClick={() => onSelect(campsite)}
      className={`group relative bg-slate-900/90 border rounded-2xl p-4 transition-all duration-300 cursor-pointer overflow-hidden ${
        isSelected
          ? 'border-emerald-500 ring-2 ring-emerald-500/40 shadow-xl shadow-emerald-950/40 bg-slate-800/90'
          : 'border-slate-800 hover:border-slate-700 hover:bg-slate-800/60 shadow-lg'
      }`}
    >
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Campsite Thumbnail */}
        <div className="relative w-full sm:w-36 h-36 rounded-xl overflow-hidden shrink-0 bg-slate-950">
          <img
            src={getCampsiteDisplayImage(campsite)}
            alt={campsite.name}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = getCloseSatelliteImageUrl(campsite.latitude, campsite.longitude);
            }}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
          <a
            href={getStreetViewUrl(campsite.latitude, campsite.longitude)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-2 left-2 px-1.5 py-1 rounded-md bg-slate-950/80 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-950/80 text-[10px] font-bold flex items-center gap-1 backdrop-blur-md transition-all"
            title="Open Street View at GPS Location"
          >
            <ExternalLink className="w-3 h-3 text-cyan-400" />
            Street View
          </a>

          <button
            onClick={(e) => onToggleSave(campsite, e)}
            className={`absolute top-2 right-2 p-2 rounded-full backdrop-blur-md border transition-all ${
              isSaved
                ? 'bg-amber-500 text-slate-950 border-amber-300 shadow-md'
                : 'bg-slate-950/70 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-950'
            }`}
            title={isSaved ? 'Saved for offline access' : 'Save spot'}
          >
            <Bookmark className="w-3.5 h-3.5 fill-current" />
          </button>

          <div className="absolute bottom-2 left-2">
            <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border tracking-wider ${getLandTypeStyle(campsite.landType)}`}>
              {campsite.landType.replace('_', ' ')}
            </span>
          </div>
        </div>

        {/* Campsite Details */}
        <div className="flex-1 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-['Outfit'] font-bold text-base sm:text-lg text-slate-100 group-hover:text-emerald-300 transition-colors line-clamp-1">
                  {campsite.name}
                </h3>
                <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5">
                  <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>
                    {campsite.address.nearestCity}, {campsite.address.stateProvince}
                  </span>
                  {distanceMiles !== undefined && (
                    <>
                      <span>•</span>
                      <span className="text-emerald-400 font-medium">{distanceMiles.toFixed(1)} mi away</span>
                    </>
                  )}
                </div>
              </div>

              {/* Rating / Verified Status */}
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-amber-400 font-bold text-xs shrink-0">
                {campsite.reviews && campsite.reviews.length > 0 ? (
                  <>
                    <Star className="w-3.5 h-3.5 fill-current text-amber-400" />
                    <span>
                      {(campsite.reviews.reduce((acc, r) => acc + r.rating, 0) / campsite.reviews.length).toFixed(1)} ({campsite.reviews.length})
                    </span>
                  </>
                ) : (
                  <span className="text-emerald-400 text-[10px] font-extrabold uppercase tracking-wide">Public Site</span>
                )}
              </div>
            </div>

            {/* Description preview */}
            <p className="mt-2 text-xs text-slate-300 line-clamp-2 leading-relaxed">
              {campsite.description}
            </p>
          </div>

          {/* Key Amenities Badges */}
          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-300">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Stay Limit Badge */}
              <span className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 font-semibold text-[11px] border border-emerald-800/50">
                {campsite.amenities.stayLimitDays}-Day Limit
              </span>

              {/* Cell Signal */}
              <span className="flex items-center gap-1 text-[11px] text-slate-400">
                <Wifi className="w-3.5 h-3.5 text-teal-400" />
                <span>{totalCellBars} bars LTE</span>
              </span>

              {/* Road Access */}
              <span className="flex items-center gap-1 text-[11px] text-slate-400">
                <Truck className="w-3.5 h-3.5 text-amber-400" />
                <span className="capitalize">{campsite.amenities.roadAccess.replace('_', ' ')}</span>
              </span>

              {/* Water */}
              {campsite.amenities.water !== 'none' && (
                <span className="flex items-center gap-1 text-[11px] text-sky-400" title={`Water: ${campsite.amenities.water}`}>
                  <Droplet className="w-3.5 h-3.5" />
                  <span className="capitalize">{campsite.amenities.water.replace('_', ' ')}</span>
                </span>
              )}
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetail(campsite);
              }}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
            >
              Full Info
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


