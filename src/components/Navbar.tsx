import React, { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import {
  Search, MapPin, Map as MapIcon, List, Bookmark, Plug, Unplug,
  Download, PlusCircle, BookOpen, X, Crosshair,
  Users, Activity, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal
} from 'lucide-react';
import type { AppView, FacilityKind, FilterState, GeocodedLocation } from '../types';
import { geocodeSearch } from '../services/nominatim';
import { UserMenu } from './UserMenu';
import { FacilityChips, type FacilityLookupState } from './FacilityChips';
import { Sheet } from './ui/Sheet';
import { BrandMark } from './ui/BrandMark';

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

  /**
   * The facility layers switched on, and how the last lookup went.
   *
   * These are a DISPLAY layer, not a filter: they add pins to the map and
   * never change which campsites are shown. That is why they live beside the
   * search rather than inside the filter drawer — "find me a toilet" and
   * "only show me campsites with a toilet" are different questions, and
   * putting them in the same place taught people the wrong one.
   */
  facilityKinds: FacilityKind[];
  onToggleFacilityKind: (kind: FacilityKind) => void;
  onClearFacilityKinds: () => void;
  facilityState: FacilityLookupState;

  /**
   * The search sheet is opened from OUTSIDE this component now.
   *
   * On the map its trigger is the magnifier in the map's own bottom-right
   * control stack, beside layers and locate, because that is where a thumb
   * is. The sheet itself still lives here — it owns the geocoder, the
   * debounce and the request-ticket logic, and splitting those from the
   * desktop input that shares them would mean two copies of the same
   * race-condition fix. So App holds the flag and this holds the machinery.
   */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
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

/** Memoised: it sits above every view and does not care about most of what
 *  changes below it. */
export const Navbar: React.FC<NavbarProps> = React.memo(({
  activeView, setActiveView, filterState, setFilterState, onSelectLocation,
  onLocateUser, isLocating, isOfflineMode, setIsOfflineMode, onOpenOfflineManager,
  onOpenAddModal, onOpenGuideModal, onOpenFilterDrawer, onOpenAuth, onOpenPresence,
  onOpenScout, onOpenSettings, onOpenReport, nearbyCount = 0,
  activeFilterCount = 0, savedCount,
  facilityKinds, onToggleFacilityKind, onClearFacilityKinds, facilityState,
  searchOpen, setSearchOpen
}) => {
  const [query, setQuery] = useState(filterState.searchQuery ?? '');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  /** Arrow-key position in the dropdown. -1 is "nothing picked yet". */
  const [highlighted, setHighlighted] = useState(-1);
  /**
   * The exact text the suggestions on screen were looked up for.
   *
   * Needed to tell "we asked and got nothing" apart from "nobody has asked
   * yet" — the phone's search sheet opens with the last place already in the
   * box, and without this it greeted you with "nothing came back for Calgary"
   * about a search that had never run.
   */
  const [searchedFor, setSearchedFor] = useState<string | null>(null);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * THE PHONE SEARCHES FROM THE BOTTOM.
   *
   * The search box has to live at the top of a desktop window and is the
   * worst possible place for it on a phone: it is the one control a camper
   * uses at every stop, and it sat in the strip a hand holding the phone
   * cannot reach without shuffling its grip. Worse, tapping it there raises
   * a keyboard that then covers half the screen the results are trying to
   * use.
   *
   * On a phone the header keeps a chip saying where the map is looking, and
   * pressing it opens the real search as a sheet that sits ON TOP of the
   * keyboard: field, suggestions and thumb all in the same half of the
   * screen. The desktop box is untouched.
   */
  const sheetInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setQuery(filterState.searchQuery); }, [filterState.searchQuery]);

  // Clear any in-flight debounce if the nav unmounts mid-typing.
  useEffect(() => () => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
  }, []);

  /*
   * `touchstart` as well as `mousedown`, like the tool sheet below.
   *
   * iOS only synthesises mouse events for elements it considers clickable, so
   * the usual way of dismissing this — tapping the map — often produced no
   * mousedown at all and the suggestions just sat there over the map.
   */
  useEffect(() => {
    const onPointerDownOutside = (event: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
        setHighlighted(-1);
      }
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    document.addEventListener('touchstart', onPointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside);
      document.removeEventListener('touchstart', onPointerDownOutside);
    };
  }, []);


  /**
   * Which search the answers on screen belong to.
   *
   * Every request takes a ticket and only the latest one is allowed to write
   * to state. Without this, two geocodes can be in flight at once — the
   * debounce only cancels timers that have not fired yet, not requests
   * already gone — and whichever answered LAST won. A cached query resolves
   * instantly while a cold one takes a second, so typing "ban" then "banff"
   * could leave you looking at results for "ban".
   *
   * Bumping it also cancels: the clear button and picking a result both
   * invalidate whatever is outstanding, which is what stops a dropdown
   * reopening itself over a search box the camper has just emptied.
   */
  const searchSeq = useRef(0);

  /** Abandon anything pending, timer or in-flight request. */
  const cancelPendingSearch = useCallback(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = null;
    searchSeq.current += 1;
    setIsSearching(false);
  }, []);

  const runSearch = useCallback(async (value: string): Promise<GeocodedLocation[]> => {
    const ticket = searchSeq.current;
    const results = await geocodeSearch(value);
    // Superseded while we were waiting. Drop it on the floor.
    if (ticket !== searchSeq.current) return results;

    setSuggestions(results);
    setSearchedFor(value);
    setHighlighted(-1);
    setIsSearching(false);
    setShowDropdown(results.length > 0);
    return results;
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    cancelPendingSearch();

    if (value.trim().length < 2) {
      setSuggestions([]);
      setSearchedFor(null);
      setShowDropdown(false);
      return;
    }

    setIsSearching(true);
    // Nominatim asks for no more than one request a second; 400 ms of quiet
    // typing keeps us comfortably inside that.
    searchTimeout.current = setTimeout(() => { void runSearch(value); }, 400);
  }, [cancelPendingSearch, runSearch]);

  const handleSelect = useCallback((loc: GeocodedLocation) => {
    const label = loc.displayName.split(',')[0];
    cancelPendingSearch();
    setQuery(label);
    setShowDropdown(false);
    setHighlighted(-1);
    setFilterState((prev) => ({ ...prev, searchQuery: label }));
    setSearchOpen(false);
    onSelectLocation(loc);
  }, [cancelPendingSearch, setFilterState, onSelectLocation]);

  /**
   * The keyboard, which this box used to ignore entirely.
   *
   * Enter did NOTHING — no form, no handler — so on a phone the Go key on the
   * keyboard was inert, which on the app's single most-used control reads as
   * the search being broken. Enter now searches: it takes the highlighted
   * result, or the first one, or if the debounce has not even fired yet it
   * runs the lookup there and then and goes to the top hit.
   */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const open = showDropdown && suggestions.length > 0;

    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      // Stop it reaching a Sheet behind us and closing that too.
      e.stopPropagation();
      setShowDropdown(false);
      setHighlighted(-1);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((prev) => {
        const next = prev + step;
        if (next < 0) return suggestions.length - 1;
        if (next >= suggestions.length) return 0;
        return next;
      });
      return;
    }

    if (e.key !== 'Enter') return;
    e.preventDefault();

    if (open) {
      handleSelect(suggestions[highlighted >= 0 ? highlighted : 0]);
      return;
    }

    // Pressed before the debounce fired. Don't make them wait and press again.
    const value = query.trim();
    if (value.length < 2) return;
    cancelPendingSearch();
    setIsSearching(true);
    void runSearch(value).then((results) => {
      if (results.length > 0) handleSelect(results[0]);
    });
  };

  /**
   * Open the phone's search sheet AND put the caret in it, in one press.
   *
   * `flushSync` is the load-bearing part. iOS only raises the keyboard for a
   * `focus()` that happens inside the tap that asked for it, and React would
   * otherwise mount the sheet after this handler has finished — leaving the
   * field on screen, ready, and requiring a second tap to type into. Flushing
   * the render makes the input exist while the gesture is still running.
   */
  const openSearchSheet = () => {
    flushSync(() => setSearchOpen(true));
    // `select` rather than `focus`: the box opens holding the last place
    // searched, and somebody opening it again is almost always going
    // somewhere else. Typing replaces it instead of appending to it.
    sheetInputRef.current?.select();
  };

  /** Empty the box and forget the search, wherever it was pressed. */
  const clearSearch = useCallback(() => {
    // Cancels the pending lookup too. Without that, a debounce already in
    // flight landed a moment later and popped the suggestions back up over an
    // empty box.
    cancelPendingSearch();
    setQuery('');
    setSuggestions([]);
    setSearchedFor(null);
    setShowDropdown(false);
    setHighlighted(-1);
    setFilterState((prev) => ({ ...prev, searchQuery: '' }));
  }, [cancelPendingSearch, setFilterState]);

  const views: {
    id: AppView;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'map', label: 'Map', icon: MapIcon },
    { id: 'list', label: 'List', icon: List },
    { id: 'saved', label: 'Saved', icon: Bookmark, badge: savedCount }
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
    /* Adds the ground under your feet, after asking. Adding somewhere else
       starts on the map: drop a pin, and its card has the button. */
    { key: 'add', label: 'Submit the spot you are standing in', short: 'Add here', icon: PlusCircle, iconClass: 'text-emerald-400', onClick: onOpenAddModal }
  ];


  /*
   * The header sits above the map's own overlay controls (the layer and locate
   * buttons sit at z-1000 inside the map, later in the DOM) and below the modal
   * sheets at 1800. At an equal z-index the map controls won the tie and
   * punched holes through the header's own dropdowns.
   */
  return (
    <>
    <header className="sticky top-0 z-[1400] bg-slate-900/95 backdrop-blur-md border-b border-slate-800 text-slate-100 px-3 sm:px-6 py-2 sm:py-2.5 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:flex-wrap items-center justify-between gap-2 md:gap-3">
        {/* Brand */}
        <div className="flex items-center justify-between w-full md:w-auto gap-3">
          <button
            onClick={() => setActiveView('map')}
            className="flex items-center gap-2.5 no-press text-left"
          >
            {/* The app's own icon, not an approximation of it. Same geometry
                the home-screen tile is baked from — see ui/BrandMark.tsx. */}
            <BrandMark
              size={38}
              className="shrink-0 rounded-xl shadow-lg shadow-emerald-900/40 md:w-[42px] md:h-[42px]"
            />
            <div>
              <span className="font-['Outfit'] font-extrabold text-lg md:text-xl tracking-tight bg-gradient-to-r from-emerald-400 via-teal-200 to-amber-300 bg-clip-text text-transparent">
                Wandrlust
              </span>
              <p className="text-xs text-slate-400 hidden xl:block whitespace-nowrap">
                BLM, National Forest &amp; Crown Land explorer
              </p>
            </div>
          </button>

          {/*
            Mobile controls.

            Down to one on the map. Online/offline is a rarely-flipped state
            switch and can live up here; everything you TOUCH while camping
            has left the header. The view switcher and the tools went to the
            bottom tab bar; search, the facility layers and the account
            button now ride in the map's own control stack at bottom right,
            beside layers and locate, where a thumb already is.

            The account button comes BACK to the header on the list and the
            saved views, because there is no map down there to hold it and a
            control you cannot reach at all is worse than one you have to
            stretch for.
          */}
          <div className="flex items-center gap-1.5 md:hidden">
            <button
              onClick={() => setIsOfflineMode(!isOfflineMode)}
              className={`p-2 tap-safe rounded-lg border ${
                isOfflineMode
                  ? 'bg-slate-800 text-slate-400 border-slate-700'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
              }`}
              aria-label={isOfflineMode ? 'Go online' : 'Go offline'}
            >
              {isOfflineMode ? <Unplug className="w-4 h-4" /> : <Plug className="w-4 h-4" />}
            </button>

            {activeView !== 'map' && <UserMenu onOpenAuth={onOpenAuth} />}
          </div>
        </div>

        {/*
          Search, and under it the facility row.

          They share a wrapper so the chips sit at exactly the width of the
          input on every breakpoint — the geocode dropdown below is absolutely
          positioned, so nothing else has ever occupied this space.

          ON THE PHONE'S MAP VIEW THIS WHOLE BLOCK IS GONE. Search moved into
          the map's bottom-right stack as a magnifier, and the facility chips
          went with it into the sheet it opens — they are two halves of one
          question ("what is around here?") and were two separate rows of
          header eating the top of the map. A desktop keeps both exactly
          where they were.
        */}
        <div className={`${
          activeView === 'map' ? 'hidden md:block' : 'w-full'
        } md:flex-1 md:min-w-[16rem] md:max-w-md space-y-1.5`}>
        {/*
          The list and saved views keep a chip that says where the map is
          looking, and opens the real thing down at thumb level. It is
          deliberately a label rather than a field — a field here invites a
          tap that raises the keyboard over the results.
        */}
        <div className="md:hidden flex items-center gap-1.5">
          <button
            type="button"
            onClick={openSearchSheet}
            className="flex-1 min-w-0 flex items-center gap-2.5 bg-slate-950/90 border border-slate-700/80 rounded-xl px-3.5 py-2 text-left shadow-inner"
            aria-label="Search for a location"
          >
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <span
              className={`flex-1 min-w-0 truncate text-sm ${
                filterState.searchQuery ? 'text-slate-100 font-semibold' : 'text-slate-400'
              }`}
            >
              {filterState.searchQuery || 'Search a city, state or province…'}
            </span>
          </button>
          {filterState.searchQuery && (
            <button
              type="button"
              onClick={clearSearch}
              className="tap-safe p-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-slate-400 hover:text-slate-100"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="relative w-full hidden md:block" ref={dropdownRef}>
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
              onKeyDown={handleSearchKeyDown}
              onFocus={() => query.trim().length >= 2 && suggestions.length > 0 && setShowDropdown(true)}
              placeholder="Search a city, state or province…"
              aria-label="Search for a location"
              // Tells a phone keyboard to show "Go" rather than a newline key,
              // now that pressing it actually does something.
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={showDropdown && suggestions.length > 0}
              aria-controls="location-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={
                highlighted >= 0 ? `location-suggestion-${highlighted}` : undefined
              }
              className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl pl-10 pr-20 py-2 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 shadow-inner"
            />
            {query && (
              <button
                onClick={clearSearch}
                className="tap-safe absolute right-10 text-slate-400 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onLocateUser}
              disabled={isLocating}
              className="absolute right-2 p-1.5 tap-safe rounded-lg bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/50 border border-emerald-500/30 flex items-center justify-center"
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
              <p className="p-1.5 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
                Locations
              </p>
              <ul
                id="location-suggestions"
                role="listbox"
                className="max-h-60 overflow-y-auto divide-y divide-slate-800/50 scroll-soft"
              >
                {suggestions.map((loc, idx) => (
                  <li key={`${loc.lat},${loc.lon},${idx}`}>
                    <button
                      id={`location-suggestion-${idx}`}
                      role="option"
                      aria-selected={idx === highlighted}
                      onClick={() => handleSelect(loc)}
                      onMouseEnter={() => setHighlighted(idx)}
                      className={`w-full p-2.5 text-left flex items-start gap-2.5 text-xs text-slate-200 ${
                        idx === highlighted ? 'bg-slate-800/80' : 'hover:bg-slate-800/80'
                      }`}
                    >
                      <MapPin className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="block font-semibold text-slate-100 truncate">
                          {loc.displayName.split(',')[0]}
                        </span>
                        <span className="block text-xs text-slate-400 truncate">
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
          Only on the map. On the list and the saved views there is no map for
          a pin to land on, so a row of buttons that quietly does nothing would
          be worse than no row at all.
        */}
        {/* Desktop only — the phone's copy lives in the search sheet. */}
        {activeView === 'map' && (
          <div className="hidden md:block">
            <FacilityChips
              active={facilityKinds}
              onToggle={onToggleFacilityKind}
              onClearAll={onClearFacilityKinds}
              state={facilityState}
            />
          </div>
        )}
        </div>

        {/*
          Views, connection and the tool rail.

          `w-full` puts these on their own row on a desktop, deliberately.
          Brand, search, the three views, the online pill, eight tools and
          the account menu do not fit across 1280px — which is what
          `max-w-7xl` caps this at no matter how wide the monitor is — and
          when they were asked to, the account button was simply clipped off
          the right-hand edge and there was no way to sign in. Two honest
          rows beat one row with a button missing from it.
        */}
        <div className="hidden md:flex items-center gap-2 w-full justify-end">
          <div className="flex items-center p-1 bg-slate-950 border border-slate-800 rounded-xl">
            {views.map(({ id, label, icon: Icon, badge }) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap ${
                  activeView === id
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {badge != null && badge > 0 && (
                  <span className="min-w-[17px] h-[17px] px-1 rounded-full bg-amber-500 text-slate-950 text-[11px] font-extrabold flex items-center justify-center">
                    {badge}
                  </span>
                )}
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
              className="relative p-2 tap-safe rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              <Icon className={`w-4 h-4 ${iconClass}`} />
              {badge != null && badge > 0 && (
                <span
                  className={`absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full ${badgeClass} text-slate-950 text-[12px] font-bold flex items-center justify-center anim-pop`}
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

    {/*
      THE SEARCH, WHERE A THUMB IS.

      `liftAboveKeyboard` holds this panel's bottom edge at the top of the
      keyboard, so the field and every suggestion stay visible while typing
      instead of the results being buried under the keys. `autoFocus={false}`
      is the other half of that: the panel would otherwise grab focus for its
      close button and shut the keyboard the opening tap just raised.

      Phones only — a desktop keeps the box in the header, where there is no
      keyboard eating the screen and a mouse does not care how far it travels.
    */}
    <Sheet
      isOpen={searchOpen}
      onClose={() => setSearchOpen(false)}
      liftAboveKeyboard
      autoFocus={false}
      title="Search"
      subtitle="Go somewhere, or show what is around you"
    >
      <div className="p-3 space-y-2.5">
        <div className="relative flex items-center">
          <Search
            className={`absolute left-3.5 w-4 h-4 pointer-events-none ${
              isSearching ? 'text-emerald-400 animate-[bounce_0.6s_infinite]' : 'text-slate-400'
            }`}
          />
          <input
            ref={sheetInputRef}
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search a city, state or province…"
            aria-label="Search for a location"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl pl-10 pr-11 py-2.5 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 shadow-inner"
          />
          {query && (
            <button
              type="button"
              onClick={() => { clearSearch(); sheetInputRef.current?.focus(); }}
              className="tap-safe absolute right-3 text-slate-400 hover:text-slate-200"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/*
          The other way of answering "where am I looking" — here as well as on
          the map, because this sheet is where somebody has come to move the
          map and their own position is the commonest destination of all.
        */}
        <button
          type="button"
          onClick={() => { setSearchOpen(false); onLocateUser(); }}
          disabled={isLocating}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-emerald-950/60 border border-emerald-600/40 text-emerald-200 text-sm font-bold disabled:opacity-50"
        >
          <Crosshair className="w-4 h-4 shrink-0" />
          {isLocating ? 'Finding you…' : 'Use my current location'}
        </button>

        {suggestions.length > 0 && (
          <ul className="divide-y divide-slate-800/60 rounded-xl border border-slate-800 overflow-hidden">
            {suggestions.map((loc, idx) => (
              <li key={`sheet-${loc.lat},${loc.lon},${idx}`}>
                <button
                  type="button"
                  onClick={() => handleSelect(loc)}
                  className="w-full p-3 text-left flex items-start gap-2.5 bg-slate-800/40 hover:bg-slate-800"
                >
                  <MapPin className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-slate-100 truncate">
                      {loc.displayName.split(',')[0]}
                    </span>
                    <span className="block text-xs text-slate-400 truncate">
                      {loc.displayName}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/*
          An empty answer is not proof the place does not exist — the geocoder
          returns nothing both when it found nothing and when it could not be
          reached at all. Saying "no such place" would be this app inventing a
          fact out of a failure, so it says both.
        */}
        {!isSearching && suggestions.length === 0 && searchedFor === query.trim() && (
          <p className="px-1 py-2 text-xs text-slate-400 leading-snug">
            Nothing came back for “{query.trim()}”. Either there is no place by
            that name, or the lookup could not be reached just now. You can also
            close this and tap the spot on the map.
          </p>
        )}

        {/*
          THE FACILITY LAYERS, IN THE SAME SHEET AS THE SEARCH.

          Phones only — the desktop keeps them under the header's box. They
          were a second row of chips at the top of a phone screen, scrolling
          sideways over the map, and half of them were off the right edge in
          the screenshot that started this. Down here they get full width, a
          thumb can reach them, and they sit under the one control a camper
          opens to ask "what is near me" — which is the same question the
          search box is for, aimed at a thing instead of a town.

          The sheet stays open when one is tapped. Turning on toilets and
          water is two taps, and a sheet that shut after the first would make
          it four.
        */}
        {activeView === 'map' && (
          <div className="md:hidden pt-1 pb-1 border-t border-slate-800">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 pt-2 pb-1.5">
              Show on the map
            </p>
            <FacilityChips
              active={facilityKinds}
              onToggle={onToggleFacilityKind}
              onClearAll={onClearFacilityKinds}
              state={facilityState}
              layout="wrap"
            />
          </div>
        )}
      </div>
    </Sheet>
    </>
  );
});

Navbar.displayName = 'Navbar';
