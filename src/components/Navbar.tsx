import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import {
  Search, MapPin, Map as MapIcon, List, Bookmark, Wifi, WifiOff,
  Download, PlusCircle, BookOpen, X,
  Users, Activity, Settings as SettingsIcon, AlertTriangle, SlidersHorizontal
} from 'lucide-react';
import type { AppView, FacilityKind, FilterState, GeocodedLocation } from '../types';
import { useLocationSearch } from '../utils/useLocationSearch';
import { buildAppSearch, matchAppSearch, type AppSearchEntry } from '../config/appSearch';
import { haptic } from '../utils/animation';
import { UserMenu } from './UserMenu';
import { BrandMark } from './ui/BrandMark';
import { ConnectionStatus } from './ui/ConnectionStatus';

interface NavbarProps {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  filterState: FilterState;
  setFilterState: React.Dispatch<React.SetStateAction<FilterState>>;
  onSelectLocation: (loc: GeocodedLocation) => void;
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
   * The facility layers switched on, and the way to switch one on.
   *
   * The header does not draw them any more — that is the arc in the map's own
   * control stack — but the search box answers for them ("showers", "propane")
   * and has to know which are already lit, so a row can say "already on"
   * rather than offering to start something that is running.
   *
   * They are a DISPLAY layer, not a filter: they add pins to the map and
   * never change which campsites are shown. "Find me a toilet" and "only show
   * me campsites with a toilet" are different questions, and the one time
   * they lived in the same drawer people reliably reached for the wrong one.
   */
  facilityKinds: FacilityKind[];
  onToggleFacilityKind: (kind: FacilityKind) => void;
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
  isOnline, onOpenOfflineManager,
  onOpenAddModal, onOpenGuideModal, onOpenFilterDrawer, onOpenAuth, onOpenPresence,
  onOpenScout, onOpenSettings, onOpenReport, nearbyCount = 0,
  activeFilterCount = 0, savedCount,
  facilityKinds, onToggleFacilityKind
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  /*
   * The debounce, the request ticket and the Enter key live in
   * `useLocationSearch`. There is one box in the app now — this one — but the
   * fiddly half of a search field is still worth keeping somewhere it can be
   * read on its own.
   */
  const search = useLocationSearch({
    searchQuery: filterState.searchQuery,
    onQueryCommitted: useCallback(
      (label: string) => setFilterState((prev) => ({ ...prev, searchQuery: label })),
      [setFilterState]
    ),
    onSelectLocation,
    onPicked: useCallback(() => setDismissed(true), [])
  });

  const {
    query, suggestions, isSearching, showDropdown, setShowDropdown,
    highlighted, setHighlighted, searchedFor, handleInputChange,
    handleKeyDown: handleSearchKeyDown, handleSelect, clearSearch
  } = search;

  /**
   * WHAT THE BOX CAN ANSWER BESIDES "WHERE IS…".
   *
   * The index is rebuilt whenever what it reports changes — which facility
   * layers are on, chiefly, because a row that is already doing its job says
   * so instead of offering to start. Everything it calls is a handler this
   * component was already given; see `config/appSearch.ts`.
   */
  const appEntries = useMemo(
    () => buildAppSearch({
      setActiveView,
      toggleFacility: onToggleFacilityKind,
      activeFacilities: facilityKinds,
      setLandTypes: (types) => setFilterState((prev) => ({ ...prev, landTypes: types })),
      openFilters: onOpenFilterDrawer,
      openPresence: onOpenPresence,
      openScout: onOpenScout,
      openReport: onOpenReport,
      openSettings: onOpenSettings,
      openOffline: onOpenOfflineManager,
      openGuide: onOpenGuideModal,
      openAddHere: onOpenAddModal
    }),
    [
      setActiveView, onToggleFacilityKind, facilityKinds, setFilterState,
      onOpenFilterDrawer, onOpenPresence, onOpenScout, onOpenReport,
      onOpenSettings, onOpenOfflineManager, onOpenGuideModal, onOpenAddModal
    ]
  );

  const appResults = useMemo(
    () => matchAppSearch(appEntries, query), [appEntries, query]
  );

  /*
    `dismissed` is the third state this list needs and did not have.

    The geocoder's own `showDropdown` says "an answer arrived"; it cannot say
    "the camper put the list away", and the app rows are not the geocoder's to
    speak for at all — they are there the instant two letters are typed,
    before any request has been made. So: the list is up whenever there is
    anything to show and nobody has dismissed it, and typing brings it back.
  */
  const [dismissed, setDismissed] = useState(true);

  const trimmed = query.trim();
  const nothingFound =
    !isSearching && suggestions.length === 0 && appResults.length === 0 &&
    searchedFor === trimmed && trimmed.length >= 2;
  const resultsOpen =
    !dismissed &&
    (appResults.length > 0 || (showDropdown && suggestions.length > 0) || nothingFound);

  /** Do the thing, then put the list away and take the keyboard with it. */
  const runAppResult = useCallback((entry: AppSearchEntry) => {
    haptic('tap');
    setDismissed(true);
    setShowDropdown(false);
    entry.run();
  }, [setShowDropdown]);

  /**
   * Enter, with two kinds of answer on screen.
   *
   * An exact app match is what somebody typing "propane" meant, so Enter
   * takes it — unless they have arrowed into the list of places, in which
   * case they have said which answer they want and it is not this one.
   * Everything else falls through to the geocoder's own handler, which knows
   * how to search before its own debounce has fired.
   */
  const handleUniversalKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') { setDismissed(true); }
      if (e.key === 'Enter' && highlighted < 0 && appResults.length > 0) {
        e.preventDefault();
        runAppResult(appResults[0]);
        return;
      }
      handleSearchKeyDown(e);
    },
    [appResults, highlighted, runAppResult, handleSearchKeyDown]
  );

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
        setDismissed(true);
      }
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    document.addEventListener('touchstart', onPointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside);
      document.removeEventListener('touchstart', onPointerDownOutside);
    };
  }, [setShowDropdown]);


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

  /**
   * ON THE MAP, ON A PHONE, THIS STOPS BEING A BAR.
   *
   * A bar across the top of a map is a bar across the top of the thing you
   * came to look at. It cost about a sixth of the screen, and — sitting in
   * the exact place a browser puts its address bar, in a slightly different
   * shade to the shell behind it — it made an installed app look like a web
   * page in Safari. Which is what it was told, twice.
   *
   * So on the map view the header leaves the layout entirely: it is
   * positioned over the map, it has no background, no border and no shadow,
   * and the map runs edge to edge behind it, all the way to the top of the
   * screen. What is left up there is the search field alone, floating as a
   * rounded pill, and the connection light beside it — the way every maps
   * app on a phone does it.
   *
   * Two things this must not do, both of which it did in some draft:
   *
   *  - SWALLOW TAPS. The header still spans the full width, so it is
   *    `pointer-events-none` and only the search and the light take input.
   *    An invisible strip across the top eating taps meant for the ground is
   *    a bug this codebase has fixed more than once.
   *  - LEAVE THE CLOCK UNREADABLE. With no bar behind it, the phone's status
   *    bar sits directly on the map, and a map is often pale. A soft scrim
   *    fades from the top edge so white text stays legible over snow or
   *    desert without drawing a hard line anybody would read as chrome.
   *
   * The map's own overlays have to start below all this — see
   * `--map-overlay-top` in index.css.
   *
   * Everywhere else — the list, saved, tools, and every screen wide enough
   * for a real header — the ordinary bar is right and comes back unchanged.
   */
  const overMap = activeView === 'map';

  const headerClass = overMap
    ? [
        'absolute inset-x-0 top-0 z-[1400] pointer-events-none text-slate-100',
        'px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]',
        'md:static md:pointer-events-auto md:bg-slate-900/95 md:backdrop-blur-md',
        'md:border-b md:border-slate-800 md:shadow-xl',
        'md:px-6 md:pb-2.5 md:pt-[calc(0.625rem+env(safe-area-inset-top))]'
      ].join(' ')
    : [
        'sticky top-0 z-[1400] bg-slate-900/95 backdrop-blur-md',
        'border-b border-slate-800 text-slate-100 shadow-xl',
        'px-3 sm:px-6 pb-2 sm:pb-2.5',
        'pt-[calc(0.5rem+env(safe-area-inset-top))] sm:pt-[calc(0.625rem+env(safe-area-inset-top))]'
      ].join(' ');

  const rowClass = overMap
    ? 'max-w-7xl mx-auto flex items-center gap-2 md:flex-wrap md:justify-between md:gap-3'
    : 'max-w-7xl mx-auto flex flex-col md:flex-row md:flex-wrap items-center justify-between gap-2 md:gap-3';

  /*
   * Over the map the brand is hidden and only the connection light is left,
   * so this block sits beside the search rather than on a row above it.
   *
   * On the LEFT, deliberately. The right-hand edge of the map belongs to the
   * map's own control stack — account, support, layers, locate, zoom — which
   * is a full-height bottom-aligned column. Put the light on that side and
   * the two share an edge, which is fine on a tall phone and collides the
   * moment the viewport is short (a phone in landscape). The left edge has
   * nothing in it.
   */
  const brandBlockClass = overMap
    ? 'flex items-center gap-3 pointer-events-auto md:w-auto md:justify-between'
    : 'flex items-center justify-between w-full md:w-auto gap-3';

  const searchWrapClass = overMap
    ? 'flex-1 min-w-0 pointer-events-auto md:flex-1 md:min-w-[16rem] md:max-w-md'
    : 'w-full md:flex-1 md:min-w-[16rem] md:max-w-md';

  return (
    <>
    {/*
      Wherever this IS still a bar, it owns the status-bar area itself:
      `env(safe-area-inset-top)` goes into its own top padding rather than
      into the app shell around it, so its background runs up behind the
      clock and the battery. Padding the shell instead left a blank strip
      above the header — a second bar, exactly where a browser draws its
      address bar. On a screen with no cut-out the inset is zero and this is
      just `py-2`.
    */}
    <header className={headerClass}>
      {/*
        The scrim, phone-and-map only. It keeps the phone's clock readable
        where the map underneath is pale, and fades out rather than ending on
        an edge — an edge is the very thing that reads as browser chrome.
      */}
      {overMap && (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 -z-10 h-[calc(100%+2rem)] pointer-events-none bg-gradient-to-b from-slate-950/90 via-slate-950/50 to-transparent md:hidden"
        />
      )}

      <div className={rowClass}>
        {/* Brand */}
        <div className={brandBlockClass}>
          <button
            onClick={() => setActiveView('map')}
            className={`${overMap ? 'hidden md:flex' : 'flex'} items-center gap-2.5 no-press text-left`}
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
          THE SEARCH BOX, AT THE TOP, ON EVERY SIZE OF SCREEN — AND IT ANSWERS
          FOR THE APP AS WELL AS FOR THE WORLD.

          It used to be two different things. A desktop had a box up here; a
          phone had a grey chip that opened a card down at thumb level, and
          inside that card sat the facility chips, which meant raising a
          keyboard to press a button that has nothing to do with typing.

          One box now, in the place every browser and every app puts one, and
          it takes words for both halves of what this app can do: a town, and
          also "showers", "propane", "offline maps", "crown land". What it
          finds inside the app is listed FIRST, because those answers are
          exact and instant, and nobody types "settings" hoping for a village.
          See `config/appSearch.ts`.

          There is no "use my current location" button in the field any more.
          It was a second control wedged into a text box — which is what the
          × was colliding with — and the map already has a locate button of
          its own, in the stack where a thumb is.
        */}
        <div className={searchWrapClass} ref={dropdownRef}>
          <div className="relative w-full">
            <div className="relative flex items-center">
              {/*
                `z-10` so the glyph sits ON the field rather than under it.
                The input is painted after this icon and carries a
                translucent background, which over the map is only 85%
                opaque — enough to wash a slate-400 magnifier out to a smudge.
              */}
              <Search
                className={`absolute left-3.5 z-10 w-4 h-4 pointer-events-none ${
                  isSearching ? 'text-emerald-400 animate-[bounce_0.6s_infinite]' : 'text-slate-400'
                }`}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => { setDismissed(false); handleInputChange(e); }}
                onKeyDown={handleUniversalKeyDown}
                onFocus={() => setDismissed(false)}
                placeholder="Search places, or anything in the app…"
                aria-label="Search places, or anything in the app"
                // Tells a phone keyboard to show "Go" rather than a newline key.
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={resultsOpen}
                aria-controls="app-search-results"
                aria-autocomplete="list"
                aria-activedescendant={
                  highlighted >= 0 ? `location-suggestion-${highlighted}` : undefined
                }
                /*
                  `pr-11` leaves exactly the width of the × plus its margin.
                  The × used to sit at `right-10` because a locate button had
                  the corner, and carried `tap-safe` — whose `position:
                  relative` fights the `absolute` that was placing it. Between
                  them the button ended up half outside the field's rounded
                  edge, which is what "the x is cut off" was. It is a plain
                  absolutely-positioned 36px target now, inset from the edge.
                */
                className={`w-full border pl-10 pr-11 py-2 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 ${
                  overMap
                    ? // Floating over the map: a pill that reads as a control
                      // sitting ON the map, not as a strip cut out of it.
                      'rounded-full bg-slate-900/85 backdrop-blur-md border-slate-700/70 shadow-xl md:rounded-xl md:bg-slate-950/90 md:shadow-inner'
                    : 'rounded-xl bg-slate-950/90 border-slate-700/80 shadow-inner'
                }`}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => { clearSearch(); setDismissed(false); }}
                  className="absolute right-1.5 w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-slate-800/80"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {resultsOpen && (
              <div className="absolute top-full left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[1050] anim-in-down">
                <div
                  id="app-search-results"
                  className="max-h-[min(24rem,60vh)] overflow-y-auto scroll-soft"
                >
                  {/*
                    IN THE APP — and each row says whether it moves the map.
                    A layer draws on the ground already on screen; it does not
                    go looking for a shower in the next province, and a row
                    that implied it would would be promising a journey it is
                    not about to make.
                  */}
                  {appResults.length > 0 && (
                    <>
                      <p className="p-1.5 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
                        In the app
                      </p>
                      <ul className="divide-y divide-slate-800/50">
                        {appResults.map((entry) => {
                          const Icon = entry.icon;
                          return (
                            <li key={entry.id}>
                              <button
                                type="button"
                                onClick={() => runAppResult(entry)}
                                className="w-full p-2.5 text-left flex items-start gap-2.5 hover:bg-slate-800/80"
                              >
                                <span
                                  className={`w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center ${
                                    entry.isOn
                                      ? 'bg-slate-100 border-slate-100 text-slate-900'
                                      : 'bg-slate-950/80 border-slate-700 text-slate-300'
                                  }`}
                                >
                                  <Icon className="w-4 h-4" />
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-xs font-bold text-slate-100">
                                    {entry.title}
                                  </span>
                                  <span className="block text-xs text-slate-400 leading-snug">
                                    {entry.detail}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}

                  {suggestions.length > 0 && (
                    <>
                      <p className="p-1.5 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider border-y border-slate-800">
                        Places
                      </p>
                      <ul role="listbox" className="divide-y divide-slate-800/50">
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
                    </>
                  )}

                  {/*
                    An empty answer is not proof the place does not exist — the
                    geocoder returns nothing both when it found nothing and
                    when it could not be reached at all. Saying "no such place"
                    would be this app inventing a fact out of a failure.
                  */}
                  {nothingFound && (
                    <p className="px-3 py-2.5 text-xs text-slate-400 leading-snug">
                      Nothing came back for “{query.trim()}”. Either there is no
                      place by that name, or the lookup could not be reached
                      just now. You can also close this and tap the spot on the
                      map.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
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

    </>
  );
});

Navbar.displayName = 'Navbar';
