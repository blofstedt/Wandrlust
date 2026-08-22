import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeocodedLocation } from '../types';
import { geocodeSearch } from '../services/nominatim';

/**
 * THE PLACE SEARCH, AS ONE IMPLEMENTATION.
 *
 * This used to live inside `Navbar`, which was fine while the header held the
 * only search box in the app. It doesn't any more: the phone searches from the
 * map's own control stack, in a card docked at the bottom of the screen, while
 * the desktop keeps its box in the header. Two boxes, and the fiddly half of a
 * search box — the debounce, the request ticket, the Enter key that has to
 * work before the debounce has fired — is exactly the half you do not want two
 * copies of.
 *
 * So the machinery lives here and each box calls it. They hold separate state
 * because they are never on screen together (one is `md:hidden`, the other
 * `hidden md:block`), and both write the chosen place back to the same filter,
 * so whichever one you used, the app agrees about where you are looking.
 */
export interface LocationSearch {
  query: string;
  suggestions: GeocodedLocation[];
  isSearching: boolean;
  /** Whether the desktop's floating suggestion list is showing. */
  showDropdown: boolean;
  setShowDropdown: (open: boolean) => void;
  /** Arrow-key position in the dropdown. -1 is "nothing picked yet". */
  highlighted: number;
  /** The mouse moving over a suggestion takes the keyboard's place in the list. */
  setHighlighted: (index: number) => void;
  /**
   * The exact text the suggestions on screen were looked up for.
   *
   * Needed to tell "we asked and got nothing" apart from "nobody has asked
   * yet" — the phone's search card opens with the last place already in the
   * box, and without this it greeted you with "nothing came back for Calgary"
   * about a search that had never run.
   */
  searchedFor: string | null;
  handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleSelect: (loc: GeocodedLocation) => void;
  clearSearch: () => void;
}

interface Options {
  /** The place the app currently believes it is looking at. */
  searchQuery: string;
  /** Records the chosen place, so every box agrees on it. */
  onQueryCommitted: (label: string) => void;
  /** Moves the map. */
  onSelectLocation: (loc: GeocodedLocation) => void;
  /** Called after a result is picked — the caller closes its own panel. */
  onPicked?: () => void;
}

export const useLocationSearch = ({
  searchQuery, onQueryCommitted, onSelectLocation, onPicked
}: Options): LocationSearch => {
  const [query, setQuery] = useState(searchQuery ?? '');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setQuery(searchQuery); }, [searchQuery]);

  // Clear any in-flight debounce if the box unmounts mid-typing.
  useEffect(() => () => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
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
    onQueryCommitted(label);
    onPicked?.();
    onSelectLocation(loc);
  }, [cancelPendingSearch, onQueryCommitted, onPicked, onSelectLocation]);

  /**
   * The keyboard, which this box used to ignore entirely.
   *
   * Enter did NOTHING — no form, no handler — so on a phone the Go key on the
   * keyboard was inert, which on the app's single most-used control reads as
   * the search being broken. Enter now searches: it takes the highlighted
   * result, or the first one, or if the debounce has not even fired yet it
   * runs the lookup there and then and goes to the top hit.
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const open = showDropdown && suggestions.length > 0;

    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      // Stop it reaching the panel behind us and closing that too.
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
  }, [
    showDropdown, suggestions, highlighted, query,
    cancelPendingSearch, runSearch, handleSelect
  ]);

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
    onQueryCommitted('');
  }, [cancelPendingSearch, onQueryCommitted]);

  return {
    query, suggestions, isSearching, showDropdown, setShowDropdown,
    highlighted, setHighlighted, searchedFor,
    handleInputChange, handleKeyDown, handleSelect, clearSearch
  };
};
