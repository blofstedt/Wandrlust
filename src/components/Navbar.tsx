import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Compass, Search, MapPin, Map as MapIcon, List, Bookmark, Plug, Unplug,
  Download, PlusCircle, BookOpen, X, Smartphone, Monitor, Crosshair,
  Users, Activity, Home, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal
} from 'lucide-react';
import type { AppView, FilterState, GeocodedLocation } from '../types';
import { geocodeSearch } from '../services/nominatim';
import { UserMenu } from './UserMenu';

interface NavbarProps {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
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

/** Icon buttons on the right-hand tool rail. */
interface ToolButton {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  onClick: () => void;
  badge?: number;
  badgeClass?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView, setActiveView, filterState, setFilterState, onSelectLocation,
  onLocateUser, isLocating, isOfflineMode, setIsOfflineMode, onOpenOfflineManager,
  onOpenAddModal, onOpenGuideModal, onOpenFilterDrawer, onOpenAuth, onOpenPresence,
  onOpenScout, onOpenHost, onOpenSettings, onOpenReport, nearbyCount = 0,
  activeFilterCount = 0, isMobileFrame, setIsMobileFrame, savedCount
}) => {
  const [query, setQuery] = useState(filterState.searchQuery ?? '');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(filterState.searchQuery); }, [filterState.searchQuery]);

  // Clear any in-flight debounce if the nav unmounts mid-typing.
  useEffect(() => () => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
  }, []);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (value.trim().length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    // Nominatim asks for no more than one request a second; 400 ms of quiet
    // typing keeps us comfortably inside that.
    searchTimeout.current = setTimeout(async () => {
      const results = await geocodeSearch(value);
      setSuggestions(results);
      setIsSearching(false);
      setShowDropdown(true);
    }, 400);
  }, []);

  const handleSelect = (loc: GeocodedLocation) => {
    const label = loc.displayName.split(',')[0];
    setQuery(label);
    setShowDropdown(false);
    setFilterState((prev) => ({ ...prev, searchQuery: label }));
    onSelectLocation(loc);
  };

  const views: { id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'map', label: 'Map', icon: MapIcon },
    { id: 'list', label: 'List', icon: List },
    { id: 'saved', label: `Saved (${savedCount})`, icon: Bookmark }
  ];

  const tools: ToolButton[] = [
    {
      key: 'filters', label: 'Filter campsites', icon: SlidersHorizontal,
      iconClass: 'text-emerald-400', onClick: onOpenFilterDrawer,
      badge: activeFilterCount, badgeClass: 'bg-emerald-500'
    },
    {
      key: 'presence', label: 'Campers nearby', icon: Users,
      iconClass: 'text-sky-400', onClick: onOpenPresence,
      badge: nearbyCount, badgeClass: 'bg-sky-500'
    },
    {
      key: 'scout', label: 'Scout Mode — map road surfaces as you drive',
      icon: Activity, iconClass: 'text-amber-400', onClick: onOpenScout
    },
    {
      key: 'report', label: 'Report a hazard, POI or site problem',
      icon: AlertTriangle, iconClass: 'text-orange-400', onClick: onOpenReport
    },
    { key: 'host', label: 'Host — list your property', icon: Home, iconClass: 'text-emerald-400', onClick: onOpenHost },
    { key: 'settings', label: 'Settings', icon: SettingsIcon, iconClass: 'text-slate-400', onClick: onOpenSettings },
    { key: 'offline', label: 'Download offline maps', icon: Download, iconClass: 'text-teal-400', onClick: onOpenOfflineManager },
    { key: 'guide', label: 'Camping rules and safety', icon: BookOpen, iconClass: 'text-amber-400', onClick: onOpenGuideModal },
    { key: 'add', label: 'Submit a new free spot', icon: PlusCircle, iconClass: 'text-emerald-400', onClick: onOpenAddModal }
  ];

  return (
    <header className="sticky top-0 z-[1000] bg-slate-900/95 backdrop-blur-md border-b border-slate-800 text-slate-100 px-3 sm:px-6 py-2.5 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center justify-between w-full md:w-auto gap-3">
          <button
            onClick={() => setActiveView('map')}
            className="flex items-center gap-2.5 no-press text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-600 to-amber-600 flex items-center justify-center shadow-lg shadow-emerald-900/40 border border-emerald-400/30">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-['Outfit'] font-extrabold text-xl tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-300 bg-clip-text text-transparent">
                Wandrlust
              </span>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                BLM, National Forest &amp; Crown Land explorer
              </p>
            </div>
          </button>

          {/* Connection toggle, compact on mobile */}
          <button
            onClick={() => setIsOfflineMode(!isOfflineMode)}
            className={`md:hidden p-2 rounded-lg border ${
              isOfflineMode
                ? 'bg-slate-800 text-slate-400 border-slate-700'
                : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
            }`}
            aria-label={isOfflineMode ? 'Go online' : 'Go offline'}
          >
            {isOfflineMode ? <Unplug className="w-4 h-4" /> : <Plug className="w-4 h-4" />}
          </button>
        </div>

        {/* Search */}
        <div className="relative w-full md:max-w-md" ref={dropdownRef}>
          <div className="relative flex items-center">
            <Search
              className={`absolute left-3.5 w-4 h-4 pointer-events-none ${
                isSearching ? 'text-emerald-400 animate-[bounce_0.6s_infinite]' : 'text-slate-400'
              }`}
            />
            <input
              type="text"
              value={query}
              onChange={handleInputChange}
              onFocus={() => query.trim().length >= 2 && setShowDropdown(true)}
              placeholder="Search a city, state or province…"
              aria-label="Search for a location"
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl pl-10 pr-20 py-2 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 shadow-inner"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery('');
                  setSuggestions([]);
                  setShowDropdown(false);
                  setFilterState((prev) => ({ ...prev, searchQuery: '' }));
                }}
                className="absolute right-10 text-slate-400 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onLocateUser}
              disabled={isLocating}
              className="absolute right-2 p-1.5 rounded-lg bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 border border-emerald-500/30 flex items-center justify-center"
              aria-label="Use my current location"
            >
              {isLocating && (
                <span className="absolute inset-0 rounded-lg border-2 border-emerald-400 border-t-transparent animate-[spin_1.4s_linear_infinite]" />
              )}
              <Crosshair className="w-3.5 h-3.5 relative z-10" />
            </button>
          </div>

          {showDropdown && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[1050] anim-in-down">
              <p className="p-1.5 px-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
                Locations
              </p>
              <ul className="max-h-60 overflow-y-auto divide-y divide-slate-800/50 scroll-soft">
                {suggestions.map((loc, idx) => (
                  <li key={`${loc.lat},${loc.lon},${idx}`}>
                    <button
                      onClick={() => handleSelect(loc)}
                      className="w-full p-2.5 hover:bg-slate-800/80 text-left flex items-start gap-2.5 text-xs text-slate-200"
                    >
                      <MapPin className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="block font-semibold text-slate-100 truncate">
                          {loc.displayName.split(',')[0]}
                        </span>
                        <span className="block text-[11px] text-slate-400 truncate">
                          {loc.displayName}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Views + tools */}
        <div className="hidden md:flex items-center gap-2">
          <div className="flex items-center p-1 bg-slate-950 border border-slate-800 rounded-xl">
            {views.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${
                  activeView === id
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsOfflineMode(!isOfflineMode)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border ${
              isOfflineMode
                ? 'bg-slate-800 text-slate-400 border-slate-700 shadow-inner'
                : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50 shadow-md shadow-emerald-950/40'
            }`}
            title={isOfflineMode ? 'Offline — using saved data' : 'Online'}
          >
            {isOfflineMode ? <Unplug className="w-3.5 h-3.5" /> : <Plug className="w-3.5 h-3.5" />}
            {isOfflineMode ? 'Offline' : 'Online'}
          </button>

          {tools.map(({ key, label, icon: Icon, iconClass, onClick, badge, badgeClass }) => (
            <button
              key={key}
              onClick={onClick}
              title={label}
              aria-label={label}
              className="relative p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              <Icon className={`w-4 h-4 ${iconClass}`} />
              {badge != null && badge > 0 && (
                <span
                  className={`absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full ${badgeClass} text-slate-950 text-[10px] font-bold flex items-center justify-center anim-pop`}
                >
                  {badge}
                </span>
              )}
            </button>
          ))}

          <button
            onClick={() => setIsMobileFrame(!isMobileFrame)}
            className={`p-2 rounded-xl border ${
              isMobileFrame
                ? 'bg-indigo-600/30 text-indigo-300 border-indigo-500/50'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
            title={isMobileFrame ? 'Switch to full screen' : 'Preview as a phone app'}
            aria-label={isMobileFrame ? 'Switch to full screen' : 'Preview as a phone app'}
          >
            {isMobileFrame ? <Monitor className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
          </button>

          <UserMenu onOpenAuth={onOpenAuth} />
        </div>
      </div>
    </header>
  );
};
