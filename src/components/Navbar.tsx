import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Compass, Search, MapPin, Map as MapIcon, List, Bookmark, Plug, Unplug,
  Download, PlusCircle, BookOpen, X, Crosshair, MoreHorizontal,
  Users, Activity, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal
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
  onOpenSettings: () => void;
  onOpenReport: () => void;
  nearbyCount?: number;
  activeFilterCount?: number;
  savedCount: number;
}

/**
 * Icon buttons on the right-hand tool rail (desktop) and in the tool sheet
 * (mobile).
 *
 * `label` is the full tooltip — it has room to explain what Scout Mode is.
 * `short` is the one or two words that go under the icon on a phone, where
 * there is no hover and no room for a sentence.
 */
interface ToolButton {
  key: string;
  label: string;
  short: string;
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
  onOpenScout, onOpenSettings, onOpenReport, nearbyCount = 0,
  activeFilterCount = 0, savedCount
}) => {
  const [query, setQuery] = useState(filterState.searchQuery ?? '');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMobileTools, setShowMobileTools] = useState(false);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mobileToolsRef = useRef<HTMLDivElement>(null);

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

  // The mobile tool sheet closes on an outside tap or on Escape, like every
  // other transient surface in the app.
  useEffect(() => {
    if (!showMobileTools) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (mobileToolsRef.current && !mobileToolsRef.current.contains(event.target as Node)) {
        setShowMobileTools(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowMobileTools(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showMobileTools]);

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
      key: 'filters', label: 'Filter campsites', short: 'Filters', icon: SlidersHorizontal,
      iconClass: 'text-emerald-400', onClick: onOpenFilterDrawer,
      badge: activeFilterCount, badgeClass: 'bg-emerald-500'
    },
    {
      key: 'presence', label: 'Campers nearby', short: 'Nearby', icon: Users,
      iconClass: 'text-sky-400', onClick: onOpenPresence,
      badge: nearbyCount, badgeClass: 'bg-sky-500'
    },
    {
      key: 'scout', label: 'Scout Mode — map road surfaces as you drive', short: 'Scout',
      icon: Activity, iconClass: 'text-amber-400', onClick: onOpenScout
    },
    {
      key: 'report', label: 'Report a hazard, POI or site problem', short: 'Report',
      icon: AlertTriangle, iconClass: 'text-orange-400', onClick: onOpenReport
    },
    { key: 'settings', label: 'Settings', short: 'Settings', icon: SettingsIcon, iconClass: 'text-slate-400', onClick: onOpenSettings },
    { key: 'offline', label: 'Download offline maps', short: 'Offline maps', icon: Download, iconClass: 'text-teal-400', onClick: onOpenOfflineManager },
    { key: 'guide', label: 'Camping rules and safety', short: 'Guide', icon: BookOpen, iconClass: 'text-amber-400', onClick: onOpenGuideModal },
    { key: 'add', label: 'Submit a new free spot', short: 'Add a spot', icon: PlusCircle, iconClass: 'text-emerald-400', onClick: onOpenAddModal }
  ];

  // Collapsed onto the mobile "more" button, so a filter left on or campers
  // parked nearby is still visible without opening the sheet.
  const totalToolBadges = tools.reduce((sum, tool) => sum + (tool.badge ?? 0), 0);

  /*
   * The header sits above the map's own overlay controls (the layer and locate
   * buttons sit at z-1000 inside the map, later in the DOM) and below the modal
   * sheets at 1800. At an equal z-index the map controls won the tie and
   * punched holes through the header's own dropdowns.
   */
  return (
    <header className="sticky top-0 z-[1400] bg-slate-900/95 backdrop-blur-md border-b border-slate-800 text-slate-100 px-3 sm:px-6 py-2 sm:py-2.5 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-2 md:gap-3">
        {/* Brand */}
        <div className="flex items-center justify-between w-full md:w-auto gap-3">
          <button
            onClick={() => setActiveView('map')}
            className="flex items-center gap-2.5 no-press text-left"
          >
            <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-600 to-amber-600 flex items-center justify-center shadow-lg shadow-emerald-900/40 border border-emerald-400/30">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-['Outfit'] font-extrabold text-lg md:text-xl tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-300 bg-clip-text text-transparent">
                Wandrlust
              </span>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                BLM, National Forest &amp; Crown Land explorer
              </p>
            </div>
          </button>

          {/*
            Mobile controls.

            Everything on the desktop tool rail — profile, settings, filters,
            the lot — used to live inside a `hidden md:flex`, so on a phone the
            header was a logo and a search box and nothing else. There was no
            way to sign in, change a filter, or switch to the list. On a
            mobile-first app that is the whole app missing.

            Three controls stay on the bar itself — connection, account, and a
            tool sheet holding the rest — so the header stays one thumb tall.
          */}
          <div className="flex items-center gap-1.5 md:hidden">
            <button
              onClick={() => setIsOfflineMode(!isOfflineMode)}
              className={`p-2 rounded-lg border ${
                isOfflineMode
                  ? 'bg-slate-800 text-slate-400 border-slate-700'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
              }`}
              aria-label={isOfflineMode ? 'Go online' : 'Go offline'}
            >
              {isOfflineMode ? <Unplug className="w-4 h-4" /> : <Plug className="w-4 h-4" />}
            </button>

            <UserMenu onOpenAuth={onOpenAuth} />

            <div className="relative" ref={mobileToolsRef}>
              <button
                onClick={() => setShowMobileTools((open) => !open)}
                className="relative p-2 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-200"
                aria-label="More tools"
                aria-expanded={showMobileTools}
              >
                <MoreHorizontal className="w-4 h-4" />
                {totalToolBadges > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-bold flex items-center justify-center">
                    {totalToolBadges}
                  </span>
                )}
              </button>

              {showMobileTools && (
                <div className="absolute right-0 mt-2 w-[17rem] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-2 z-[1100] anim-in-down">
                  <div className="grid grid-cols-3 gap-1.5">
                    {tools.map(({ key, short, label, icon: Icon, iconClass, onClick, badge, badgeClass }) => (
                      <button
                        key={key}
                        onClick={() => { setShowMobileTools(false); onClick(); }}
                        aria-label={label}
                        className="relative flex flex-col items-center gap-1 px-1 py-2.5 rounded-xl bg-slate-800/70 hover:bg-slate-700 border border-slate-700/70"
                      >
                        <Icon className={`w-5 h-5 ${iconClass}`} />
                        <span className="w-full text-[10px] font-semibold text-slate-300 leading-tight text-center break-words">
                          {short}
                        </span>
                        {badge != null && badge > 0 && (
                          <span
                            className={`absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full ${badgeClass} text-slate-950 text-[9px] font-bold flex items-center justify-center`}
                          >
                            {badge}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
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

        {/*
          View switcher, mobile.

          Full width and its own row, because Map / List / Saved is the single
          most-used control in the app and on a phone it was not reachable at
          all — the desktop segmented control it lives in is inside the
          `hidden md:flex` block below.
        */}
        <div className="flex w-full md:hidden items-center p-1 bg-slate-950 border border-slate-800 rounded-xl">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold ${
                activeView === id
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
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

          <UserMenu onOpenAuth={onOpenAuth} />
        </div>
      </div>
    </header>
  );
};
