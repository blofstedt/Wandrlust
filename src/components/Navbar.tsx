import React, { useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import {
  Search, MapPin, Map as MapIcon, List, Bookmark, Wifi, WifiOff,
  Download, PlusCircle, BookOpen, X, Crosshair,
  Users, Activity, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal
} from 'lucide-react';
import type { AppView, FacilityKind, FilterState, GeocodedLocation } from '../types';
import { useLocationSearch } from '../utils/useLocationSearch';
import { UserMenu } from './UserMenu';
import { SearchPanelBody } from './SearchPanelBody';
import { FacilityChips, type FacilityLookupState } from './FacilityChips';
import { Sheet } from './ui/Sheet';
import { BrandMark } from './ui/BrandMark';
import { ConnectionStatus } from './ui/ConnectionStatus';

interface NavbarProps {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
  onSelectLocation: (loc: GeocodedLocation) => void;
  onLocateUser: () => void;
  isLocating: boolean;
  /**
   * Whether the device believes it has a connection.
   *
   * READ ONLY, AND DELIBERATELY SO. This used to be a switch: a plug icon
   * the camper flipped to "go offline". Nobody ever flipped it — a phone in
   * a canyon is offline whether or not anyone told the app so — and a switch
   * that is off while the connection is fine, or on while it is gone, is the
   * app stating something untrue about the world. Now it only reports.
   */
  isOnline: boolean;
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
  onLocateUser, isLocating, isOnline, onOpenOfflineManager,
  onOpenAddModal, onOpenGuideModal, onOpenFilterDrawer, onOpenAuth, onOpenPresence,
  onOpenScout, onOpenSettings, onOpenReport, nearbyCount = 0,
  activeFilterCount = 0, savedCount,
  facilityKinds, onToggleFacilityKind, onClearFacilityKinds, facilityState,
  searchOpen, setSearchOpen
}) => {
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

  /*
   * The debounce, the request ticket and the Enter key all live in
   * `useLocationSearch` now, because the map has a search box of its own down
   * in its control stack and one copy of that logic is enough. See the note at
   * the top of that file.
   */
  const search = useLocationSearch({
    searchQuery: filterState.searchQuery,
    onQueryCommitted: useCallback(
      (label: string) => setFilterState((prev) => ({ ...prev, searchQuery: label })),
      [setFilterState]
    ),
    onSelectLocation,
    onPicked: useCallback(() => setSearchOpen(false), [setSearchOpen])
  });
  const {
    query, suggestions, isSearching, showDropdown, setShowDropdown,
    highlighted, setHighlighted, handleInputChange,
    handleKeyDown: handleSearchKeyDown, handleSelect, clearSearch
  } = search;

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
      }
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    document.addEventListener('touchstart', onPointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside);
      document.removeEventListener('touchstart', onPointerDownOutside);
    };
  }, [setShowDropdown]);

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

            Down to one on the map, and that one is not a control: the
            connection light only reports whether the phone has a network.
            Everything you TOUCH while camping has left the header. The view
            switcher and the tools went to the bottom tab bar; search, the
            facility layers and the account button now ride in the map's own
            control stack at bottom right, beside layers and locate, where a
            thumb already is.

            The account button comes BACK to the header on the list and the
            saved views, because there is no map down there to hold it and a
            control you cannot reach at all is worse than one you have to
            stretch for.
          */}
          <div className="flex items-center gap-1.5 md:hidden">
            <ConnectionStatus isOnline={isOnline} />

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

          <ConnectionStatus isOnline={isOnline} variant="pill" />

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

      IT IS A DOCKED CARD NOW, NOT A DRAWER. Full width and welded to the
      bottom edge, it read as a new screen rather than a layer: it covered
      the tab bar, so the map you were about to search had gone, and the
      field itself looked cut off by the edge of the phone. Docked, it floats
      clear of both edges with the map still visible around it, which is the
      truth of the thing — you have not left the map, you are pointing it
      somewhere.
    */}
    <Sheet
      isOpen={searchOpen}
      onClose={() => setSearchOpen(false)}
      variant="dock"
      liftAboveKeyboard
      autoFocus={false}
      title="Search"
      subtitle="Go somewhere, or show what is around you"
    >
      <SearchPanelBody
        search={search}
        inputRef={sheetInputRef}
        onLocateUser={onLocateUser}
        isLocating={isLocating}
        onClose={() => setSearchOpen(false)}
        showFacilities={activeView === 'map'}
        facilityKinds={facilityKinds}
        onToggleFacilityKind={onToggleFacilityKind}
        onClearFacilityKinds={onClearFacilityKinds}
        facilityState={facilityState}
      />
    </Sheet>
    </>
  );
});

Navbar.displayName = 'Navbar';
