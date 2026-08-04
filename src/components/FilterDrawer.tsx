import React from 'react';
import { FilterState, LandType, RoadAccess } from '../types';
import { SlidersHorizontal, X, Check, RefreshCw } from 'lucide-react';

interface FilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
  onReset: () => void;
  totalResultsCount: number;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  isOpen,
  onClose,
  filterState,
  setFilterState,
  onReset,
  totalResultsCount
}) => {
  if (!isOpen) return null;

  const toggleLandType = (type: LandType) => {
    setFilterState((prev) => {
      const exists = prev.landTypes.includes(type);
      if (exists) {
        return { ...prev, landTypes: prev.landTypes.filter((t) => t !== type) };
      } else {
        return { ...prev, landTypes: [...prev.landTypes, type] };
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[2500] bg-slate-950/70 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-md bg-slate-900 border-l border-slate-700 h-full overflow-y-auto p-5 text-slate-100 flex flex-col justify-between shadow-2xl animate-in slide-in-from-right duration-300">
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-5 h-5 text-emerald-400" />
              <h2 className="font-['Outfit'] font-bold text-lg">Filter Campsites</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="py-5 space-y-6 text-xs">
            {/* Sort By */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Sort Results By
              </label>
              <select
                value={filterState.sortBy}
                onChange={(e) =>
                  setFilterState((prev) => ({ ...prev, sortBy: e.target.value as FilterState['sortBy'] }))
                }
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="distance">Nearest Distance</option>
                <option value="rating">Highest Rating</option>
                <option value="stay_limit">Longest Stay Limit</option>
                <option value="name">Alphabetical</option>
              </select>
            </div>

            {/* Land Type Filter */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Land Ownership & Designation
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'blm', label: 'BLM Land', desc: 'Bureau of Land Management' },
                  { id: 'usfs', label: 'National Forest', desc: 'USFS Dispersed' },
                  { id: 'state_forest', label: 'State Lands', desc: 'State Recreation' },
                  { id: 'crown_land', label: 'Crown Land', desc: 'Canada Public Land' }
                ].map((item) => {
                  const isChecked = filterState.landTypes.includes(item.id as LandType);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleLandType(item.id as LandType)}
                      className={`p-2.5 rounded-xl border text-left transition-all ${
                        isChecked
                          ? 'bg-emerald-950/70 border-emerald-500/80 text-emerald-200'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold">{item.label}</span>
                        {isChecked && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">{item.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Radius Filter */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                  Search Radius (Miles)
                </label>
                <span className="font-bold text-emerald-400">{filterState.maxDistanceMiles} miles</span>
              </div>
              <input
                type="range"
                min={5}
                max={150}
                step={5}
                value={filterState.maxDistanceMiles}
                onChange={(e) =>
                  setFilterState((prev) => ({ ...prev, maxDistanceMiles: Number(e.target.value) }))
                }
                className="w-full accent-emerald-500"
              />
            </div>

            {/* Amenity Switches */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Required Amenities
              </label>
              <div className="space-y-2">
                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer">
                  <span>📶 Verified Cell Signal (2+ Bars)</span>
                  <input
                    type="checkbox"
                    checked={filterState.cellSignalOnly}
                    onChange={(e) => setFilterState((prev) => ({ ...prev, cellSignalOnly: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer">
                  <span>💧 On-site Water (Potable or Stream)</span>
                  <input
                    type="checkbox"
                    checked={filterState.waterOnly}
                    onChange={(e) => setFilterState((prev) => ({ ...prev, waterOnly: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer">
                  <span>🚻 Toilet On-Site (Vault / Pack-Out)</span>
                  <input
                    type="checkbox"
                    checked={filterState.toiletOnly}
                    onChange={(e) => setFilterState((prev) => ({ ...prev, toiletOnly: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 cursor-pointer">
                  <span>🐶 Dog / Pet Friendly</span>
                  <input
                    type="checkbox"
                    checked={filterState.petFriendlyOnly}
                    onChange={(e) => setFilterState((prev) => ({ ...prev, petFriendlyOnly: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4"
                  />
                </label>
              </div>
            </div>

            {/* Minimum RV Length */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                  Minimum RV / Rig Clearance
                </label>
                <span className="font-bold text-amber-400">
                  {filterState.rigLengthMinFt > 0 ? `${filterState.rigLengthMinFt}ft+ Rig` : 'Any Rig Size'}
                </span>
              </div>
              <input
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

        {/* Footer Actions */}
        <div className="pt-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <button
            onClick={onReset}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reset All
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs text-center shadow-lg shadow-emerald-950"
          >
            Show {totalResultsCount} Matching Sites
          </button>
        </div>
      </div>
    </div>
  );
};


