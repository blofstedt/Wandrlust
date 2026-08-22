import React, { useEffect } from 'react';
import { SlidersHorizontal, X, Check, RefreshCw } from 'lucide-react';
import type { FilterState, LandType, RoadAccess } from '../types';
import {
  DISTANCE_MIN_MILES, DISTANCE_MAX_MILES, ROAD_ACCESS_LABEL
} from '../config/filters';

interface FilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
  onReset: () => void;
  totalResultsCount: number;
}

const LAND_TYPE_OPTIONS: { id: LandType; label: string; desc: string }[] = [
  { id: 'blm', label: 'BLM land', desc: 'Bureau of Land Management' },
  { id: 'usfs', label: 'National forest', desc: 'USFS dispersed' },
  { id: 'state_forest', label: 'State lands', desc: 'State recreation' },
  { id: 'crown_land', label: 'Crown land', desc: 'Canadian public land' },
  { id: 'dispersed', label: 'Other free spots', desc: 'Community reported' }
];

const AMENITY_OPTIONS: { key: keyof FilterState; label: string }[] = [
  { key: 'cellSignalOnly', label: '📶 Cell signal (2+ bars)' },
  { key: 'waterOnly', label: '💧 Water on site' },
  { key: 'toiletOnly', label: '🚻 Toilet on site' },
  { key: 'petFriendlyOnly', label: '🐶 Pet friendly' }
];

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  isOpen, onClose, filterState, setFilterState, onReset, totalResultsCount
}) => {
  // Escape closes the drawer, matching every other panel in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggleLandType = (type: LandType) =>
    setFilterState((prev) => ({
      ...prev,
      landTypes: prev.landTypes.includes(type)
        ? prev.landTypes.filter((t) => t !== type)
        : [...prev.landTypes, type]
    }));

  return (
    <div
      className="fixed inset-0 z-[2500] bg-slate-950/70 backdrop-blur-sm flex justify-end anim-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter campsites"
        className="w-full max-w-md bg-slate-900 border-l border-slate-700 h-full overflow-y-auto p-5 text-slate-100 flex flex-col justify-between shadow-2xl scroll-soft anim-in-right"
      >
        <div>
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-5 h-5 text-emerald-400" />
              <h2 className="font-['Outfit'] font-bold text-lg">Filter campsites</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 tap-safe rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
              aria-label="Close filters"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="py-5 space-y-6 text-xs">
            {/* Sort */}
            <div>
              <label
                htmlFor="filter-sort"
                className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2"
              >
                Sort results by
              </label>
              <select
                id="filter-sort"
                value={filterState.sortBy}
                onChange={(e) =>
                  setFilterState((prev) => ({ ...prev, sortBy: e.target.value as FilterState['sortBy'] }))
                }
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="distance">Nearest first</option>
                <option value="rating">Highest rated</option>
                <option value="stay_limit">Longest stay limit</option>
                <option value="name">A–Z</option>
              </select>
            </div>

            {/* Land type */}
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Land ownership
              </span>
              <div className="grid grid-cols-2 gap-2">
                {LAND_TYPE_OPTIONS.map((item, i) => {
                  const checked = filterState.landTypes.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-stagger={Math.min(i, 8)}
                      aria-pressed={checked}
                      onClick={() => toggleLandType(item.id)}
                      className={`p-2.5 rounded-xl border text-left anim-in-up ${
                        checked
                          ? 'bg-emerald-950/70 border-emerald-500/80 text-emerald-200'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span className="flex items-center justify-between font-bold">
                        {item.label}
                        {checked && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </span>
                      <span className="block text-[12px] text-slate-400 mt-0.5">{item.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Radius */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label
                  htmlFor="filter-radius"
                  className="text-xs font-bold text-slate-400 uppercase tracking-wider"
                >
                  Search radius
                </label>
                <span className="font-bold text-emerald-400">
                  {filterState.maxDistanceMiles} miles
                </span>
              </div>
              <input
                id="filter-radius"
                type="range"
                min={DISTANCE_MIN_MILES}
                max={DISTANCE_MAX_MILES}
                step={5}
                value={filterState.maxDistanceMiles}
                onChange={(e) =>
                  setFilterState((prev) => ({ ...prev, maxDistanceMiles: Number(e.target.value) }))
                }
                className="w-full accent-emerald-500"
              />
            </div>

            {/* Road access */}
            <div>
              <label
                htmlFor="filter-road"
                className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2"
              >
                Roughest road you'll drive
              </label>
              <select
                id="filter-road"
                value={filterState.roadAccessMax}
                onChange={(e) =>
                  setFilterState((prev) => ({
                    ...prev,
                    roadAccessMax: e.target.value as RoadAccess | 'all'
                  }))
                }
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {(['all', 'paved', 'gravel', 'high_clearance', '4x4_only'] as const).map((id) => (
                  <option key={id} value={id}>{ROAD_ACCESS_LABEL[id]}</option>
                ))}
              </select>
              <p className="text-[12px] text-slate-500 mt-1">
                Hides sites whose access road is rougher than this.
              </p>
            </div>

            {/* Amenities */}
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Must have
              </span>
              <div className="space-y-2">
                {AMENITY_OPTIONS.map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer hover:border-slate-700"
                  >
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={Boolean(filterState[key])}
                      onChange={(e) =>
                        setFilterState((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                      className="accent-emerald-500 w-4 h-4"
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* Rig length */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label
                  htmlFor="filter-rig"
                  className="text-xs font-bold text-slate-400 uppercase tracking-wider"
                >
                  Minimum rig space
                </label>
                <span className="font-bold text-amber-400">
                  {filterState.rigLengthMinFt > 0 ? `${filterState.rigLengthMinFt} ft+` : 'Any size'}
                </span>
              </div>
              <input
                id="filter-rig"
                type="range"
                min={0}
                max={45}
                step={5}
                value={filterState.rigLengthMinFt}
                onChange={(e) =>
                  setFilterState((prev) => ({ ...prev, rigLengthMinFt: Number(e.target.value) }))
                }
                className="w-full accent-amber-500"
              />
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <button
            onClick={onReset}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reset
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-950"
          >
            Show {totalResultsCount} site{totalResultsCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
};
