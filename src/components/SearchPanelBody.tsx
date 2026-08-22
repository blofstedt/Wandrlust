import React from 'react';
import { Search, MapPin, X, Crosshair } from 'lucide-react';
import type { FacilityKind } from '../types';
import type { LocationSearch } from '../utils/useLocationSearch';
import { FacilityChips, type FacilityLookupState } from './FacilityChips';

/**
 * The inside of the search panel — field, "use my location", results, and the
 * facility layers.
 *
 * ONE BODY, TWO CONTAINERS. On the map it sits in the card docked at the
 * bottom right, beside layers and the account; on the list and saved views,
 * where there is no map to dock to, it sits in the sheet the header chip
 * opens. Same controls in both, because it is the same question.
 *
 * The machinery — debounce, request ticket, the Enter key — is in
 * `useLocationSearch`; the caller owns an instance and hands it here, which is
 * what lets each container close itself when a result is picked.
 */
interface SearchPanelBodyProps {
  search: LocationSearch;
  inputRef?: React.RefObject<HTMLInputElement>;
  onLocateUser: () => void;
  isLocating: boolean;
  /** Closes whichever container this is sitting in. */
  onClose: () => void;
  /**
   * The facility layers, shown only where they mean something — they put pins
   * on the map, so they are only offered when the map is what you are looking
   * at.
   */
  showFacilities?: boolean;
  facilityKinds?: FacilityKind[];
  onToggleFacilityKind?: (kind: FacilityKind) => void;
  onClearFacilityKinds?: () => void;
  facilityState?: FacilityLookupState;
}

export const SearchPanelBody: React.FC<SearchPanelBodyProps> = ({
  search, inputRef, onLocateUser, isLocating, onClose,
  showFacilities = false, facilityKinds = [], onToggleFacilityKind,
  onClearFacilityKinds, facilityState
}) => {
  const {
    query, suggestions, isSearching, searchedFor,
    handleInputChange, handleKeyDown, handleSelect, clearSearch
  } = search;

  return (
    /*
      `p-3.5`, not `p-3`. At three the field ran within twelve pixels of the
      card's edges and read as clipped rather than inset — the screenshot that
      started this looked like the search box had been cut off by the screen. A
      card has an edge you can see, so what is inside it needs room to sit away
      from that edge.
    */
    <div className="p-3.5 space-y-3">
      <div className="relative flex items-center">
        <Search
          className={`absolute left-3.5 w-4 h-4 pointer-events-none ${
            isSearching ? 'text-emerald-400 animate-[bounce_0.6s_infinite]' : 'text-slate-400'
          }`}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
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
            onClick={() => { clearSearch(); inputRef?.current?.focus(); }}
            className="tap-safe absolute right-3 text-slate-400 hover:text-slate-200"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/*
        The other way of answering "where am I looking" — here as well as on
        the map, because this panel is where somebody has come to move the map
        and their own position is the commonest destination of all.
      */}
      <button
        type="button"
        onClick={() => { onClose(); onLocateUser(); }}
        disabled={isLocating}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-emerald-950/60 border border-emerald-600/40 text-emerald-200 text-sm font-bold disabled:opacity-50"
      >
        <Crosshair className="w-4 h-4 shrink-0" />
        {isLocating ? 'Finding you…' : 'Use my current location'}
      </button>

      {suggestions.length > 0 && (
        <ul className="divide-y divide-slate-800/60 rounded-xl border border-slate-800 overflow-hidden">
          {suggestions.map((loc, idx) => (
            <li key={`panel-${loc.lat},${loc.lon},${idx}`}>
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
        THE FACILITY LAYERS, IN THE SAME PANEL AS THE SEARCH.

        They were a second row of chips at the top of a phone screen, scrolling
        sideways over the map, and half of them were off the right edge in the
        screenshot that started this. Down here they get full width, a thumb
        can reach them, and they sit under the one control a camper opens to
        ask "what is near me" — which is the same question the search box is
        for, aimed at a thing instead of a town.

        The panel stays open when one is tapped. Turning on toilets and water
        is two taps, and a panel that shut after the first would make it four.
      */}
      {showFacilities && onToggleFacilityKind && onClearFacilityKinds && facilityState && (
        <div className="pt-1 pb-1 border-t border-slate-800">
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
  );
};
