import React, { useState, useEffect, useRef } from 'react';
import {
  Compass,
  Search,
  MapPin,
  Map as MapIcon,
  List,
  Bookmark,
  Plug,
  Unplug,
  Download,
  PlusCircle,
  BookOpen,
  X,
  Smartphone,
  Monitor,
  Crosshair
} from 'lucide-react';
import { GeocodedLocation, FilterState } from '../types';
import { geocodeSearch } from '../services/nominatim';
import { UserMenu } from './UserMenu';
import { Users, Activity, Home, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal } from 'lucide-react';

interface NavbarProps {
  activeView: 'map' | 'list' | 'saved';
  setActiveView: (view: 'map' | 'list' | 'saved') => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
  currentLocationName: string;
  onSelectLocation: (loc: GeocodedLocation) => void;
  onLocateUser: () => void;
  isLocating: boolean;
  isOfflineMode: boolean;
  setIsOfflineMode: (offline: boolean) => void;
  onOpenOfflineManager: () => void;
  onOpenAddModal: () => void;
  onOpenGuideModal: () => void;
  onOpenFilterDrawer: () => void;
  onOpenAuth: () => void;
  onOpenPresence: () => void;
  onOpenScout: () => void;
  onOpenHost: () => void;
  onOpenSettings: () => void;
  onOpenReport: () => void;
  nearbyCount?: number;
  activeFilterCount?: number;
  isMobileFrame: boolean;
  setIsMobileFrame: (val: boolean) => void;
  savedCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView,
  setActiveView,
  filterState,
  setFilterState,
  currentLocationName,
  onSelectLocation,
  onLocateUser,
  isLocating,
  isOfflineMode,
  setIsOfflineMode,
  onOpenOfflineManager,
  onOpenAddModal,
  onOpenGuideModal,
  onOpenFilterDrawer,
  onOpenAuth,
  onOpenPresence,
  onOpenScout,
  onOpenHost,
  onOpenSettings,
  onOpenReport,
  nearbyCount = 0,
  activeFilterCount = 0,
  isMobileFrame,
  setIsMobileFrame,
  savedCount
}) => {
  const [query, setQuery] = useState(filterState.searchQuery || '');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(filterState.searchQuery);
  }, [filterState.searchQuery]);

  // Handle Search Input Debounce
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (val.trim().length >= 2) {
      setIsSearching(true);
      searchTimeoutRef.current = setTimeout(async () => {
        const results = await geocodeSearch(val);
        setSuggestions(results);
        setIsSearching(false);
        setShowDropdown(true);
      }, 400);
    } else {
      setSuggestions([]);
      setShowDropdown(false);
      setIsSearching(false);
    }
  };

  const handleSelect = (loc: GeocodedLocation) => {
    setQuery(loc.displayName.split(',')[0]);
    setShowDropdown(false);
    setFilterState((prev) => ({ ...prev, searchQuery: loc.displayName.split(',')[0] }));
    onSelectLocation(loc);
  };

  // Quick Preset Locations
  const POPULAR_PRESETS = [
    { name: 'Moab, UT', lat: 38.5733, lon: -109.5498, city: 'Moab', state: 'Utah' },
    { name: 'Jackson, WY', lat: 43.4799, lon: -110.7624, city: 'Jackson', state: 'Wyoming' },
    { name: 'Sedona, AZ', lat: 34.8697, lon: -111.761, city: 'Sedona', state: 'Arizona' },
    { name: 'Bozeman, MT', lat: 45.677, lon: -111.0386, city: 'Bozeman', state: 'Montana' },
    { name: 'Bend, OR', lat: 44.0582, lon: -121.3153, city: 'Bend', state: 'Oregon' }
  ];

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-[1000] bg-slate-900/95 backdrop-blur-md border-b border-slate-800 text-slate-100 px-3 sm:px-6 py-2.5 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Top Bar: Brand & Mode Controls */}
        <div className="flex items-center justify-between w-full md:w-auto gap-3">
          <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => setActiveView('map')}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-600 to-amber-600 flex items-center justify-center shadow-lg shadow-emerald-900/40 border border-emerald-400/30">
              <Compass className="w-5 h-5 text-white animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-['Outfit'] font-extrabold text-xl tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-300 bg-clip-text text-transparent">
                  Wandrlust
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                BLM & National Forest Dispersed Explorer
              </p>
            </div>
          </div>

          {/* Quick Action Buttons (Mobile) */}
          <div className="flex items-center gap-2 md:hidden">
            <button
              onClick={() => setIsOfflineMode(!isOfflineMode)}
              className={`p-2 rounded-lg text-xs font-semibold flex items-center gap-1 border transition-all ${
                isOfflineMode
                  ? 'bg-slate-800 text-slate-400 border-slate-700'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
              }`}
              title={isOfflineMode ? 'Network disconnected (Offline)' : 'Network connected (Online)'}
            >
              {isOfflineMode ? <Unplug className="w-4 h-4 text-slate-400" /> : <Plug className="w-4 h-4 text-emerald-400" />}
            </button>
          </div>
        </div>

        {/* Address Search Bar */}
        <div className="relative w-full md:max-w-md" ref={dropdownRef}>
          <div className="relative flex items-center">
            <Search className={`absolute left-3.5 w-4 h-4 text-slate-400 pointer-events-none transition-all ${isSearching ? 'text-emerald-400 animate-[bounce_0.6s_infinite]' : ''}`} />
            <input
              type="text"
              value={query}
              onChange={handleInputChange}
              onFocus={() => query.trim().length >= 2 && setShowDropdown(true)}
              placeholder="Search city, state, province, or country..."
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl pl-10 pr-20 py-2 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 shadow-inner transition-all cursor-text"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery('');
                  setFilterState((prev) => ({ ...prev, searchQuery: '' }));
                }}
                className="absolute right-10 text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onLocateUser}
              disabled={isLocating}
              className="absolute right-2 p-1.5 rounded-lg bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 transition-all border border-emerald-500/30 relative flex items-center justify-center overflow-hidden"
              title="Use my current GPS location"
            >
              {isLocating && (
                <span className="absolute inset-0 rounded-lg border-2 border-emerald-400 border-t-transparent animate-[spin_2.5s_linear_infinite]" />
              )}
              <Crosshair className={`w-3.5 h-3.5 relative z-10 text-emerald-300 ${isLocating ? 'animate-pulse' : ''}`} />
            </button>
          </div>

          {/* Autocomplete Dropdown */}
          {showDropdown && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[1050]">
              <div className="p-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-3 border-b border-slate-800">
                Address & Location Results
              </div>
              <ul className="max-h-60 overflow-y-auto divide-y divide-slate-800/50">
                {suggestions.map((loc, idx) => (
                  <li
                    key={idx}
                    onClick={() => handleSelect(loc)}
                    className="p-2.5 hover:bg-slate-800/80 cursor-pointer transition-colors flex items-start gap-2.5 text-xs text-slate-200"
                  >
                    <MapPin className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-slate-100">{loc.displayName.split(',')[0]}</div>
                      <div className="text-[11px] text-slate-400 line-clamp-1">{loc.displayName}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Right Navigation & Tools */}
        <div className="hidden md:flex items-center gap-2">
          {/* Views Toggle */}
          <div className="flex items-center p-1 bg-slate-950 border border-slate-800 rounded-xl">
            <button
              onClick={() => setActiveView('map')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeView === 'map'
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              Map
            </button>
            <button
              onClick={() => setActiveView('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeView === 'list'
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              List
            </button>
            <button
              onClick={() => setActiveView('saved')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeView === 'saved'
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              Saved ({savedCount})
            </button>
          </div>

          {/* Network Connection Toggle (Plug) */}
          <button
            onClick={() => setIsOfflineMode(!isOfflineMode)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-all ${
              isOfflineMode
                ? 'bg-slate-800 text-slate-400 border-slate-700 shadow-inner'
                : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50 shadow-md shadow-emerald-950/40'
            }`}
            title={isOfflineMode ? 'Network unplugged (Click to connect)' : 'Network plugged in & active'}
          >
            {isOfflineMode ? (
              <>
                <Unplug className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-slate-400">Offline</span>
              </>
            ) : (
              <>
                <Plug className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400/20" />
                <span>Online</span>
              </>
            )}
          </button>

          {/* Filters */}
          <button
            onClick={onOpenFilterDrawer}
            className="relative p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Filter campsites"
          >
            <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-bold flex items-center justify-center anim-pop">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Campers nearby */}
          <button
            onClick={onOpenPresence}
            className="relative p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Campers nearby"
          >
            <Users className="w-4 h-4 text-sky-400" />
            {nearbyCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-slate-950 text-[10px] font-bold flex items-center justify-center">
                {nearbyCount}
              </span>
            )}
          </button>

          {/* Scout Mode */}
          <button
            onClick={onOpenScout}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Scout Mode — map road surfaces while you drive"
          >
            <Activity className="w-4 h-4 text-amber-400" />
          </button>

          {/* Report */}
          <button
            onClick={onOpenReport}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Report a hazard, POI, or site problem"
          >
            <AlertTriangle className="w-4 h-4 text-orange-400" />
          </button>

          {/* Host */}
          <button
            onClick={onOpenHost}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Host — list your property"
          >
            <Home className="w-4 h-4 text-emerald-400" />
          </button>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4 text-slate-400" />
          </button>

          {/* Offline Manager */}
          <button
            onClick={onOpenOfflineManager}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all"
            title="Download & Manage Offline Maps"
          >
            <Download className="w-4 h-4 text-teal-400" />
          </button>

          {/* Guide Modal */}
          <button
            onClick={onOpenGuideModal}
            className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all"
            title="BLM & USFS Camping Rules & Safety"
          >
            <BookOpen className="w-4 h-4 text-amber-400" />
          </button>

          {/* Add Site Modal */}
          <button
            onClick={onOpenAddModal}
            className="p-2 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-500/40 transition-all"
            title="Submit a New Free Spot"
          >
            <PlusCircle className="w-4 h-4 text-emerald-400" />
          </button>

          {/* Native Mobile Frame Toggle */}
          <button
            onClick={() => setIsMobileFrame(!isMobileFrame)}
            className={`p-2 rounded-xl border transition-all ${
              isMobileFrame
                ? 'bg-indigo-600/30 text-indigo-300 border-indigo-500/50'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
            title={isMobileFrame ? 'Switch to Wide Screen View' : 'Switch to Mobile App View'}
          >
            {isMobileFrame ? <Monitor className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
          </button>

          {/* Account */}
          <UserMenu onOpenAuth={onOpenAuth} />
        </div>
      </div>
    </header>
  );
};


