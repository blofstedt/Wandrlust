import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type {
  Campsite, FilterState, GeocodedLocation, CamperReview, AppView, LegalDocKind,
  DestinationLand, MapDestination, CellCoverage
} from './types';
import { CURATED_CAMPSITES } from './data/curatedCampsites';
import { fetchOverpassCampsites } from './services/overpass';
import {
  getSavedCampsites,
  toggleSaveCampsite,
  mergeSavedCampsites,
  getCustomCampsites,
  addCustomCampsite
} from './services/offlineStorage';
import { Navbar } from './components/Navbar';
import { MapComponent } from './components/MapComponent';
import { CampsiteCard } from './components/CampsiteCard';
import { CampsiteDetailModal } from './components/CampsiteDetailModal';
import { OfflineManagerModal } from './components/OfflineManagerModal';
import { AddCampsiteModal } from './components/AddCampsiteModal';
import { AddHereConfirm } from './components/AddHereConfirm';
import { CampingGuideModal } from './components/CampingGuideModal';
import { FilterDrawer } from './components/FilterDrawer';
import { AuthModal } from './components/AuthModal';
import { CampsiteBottomSheet } from './components/CampsiteBottomSheet';
import { PresencePanel } from './components/PresencePanel';
import { ScoutModePanel } from './components/ScoutModePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ReportPanel } from './components/ReportPanel';
import { LegalGate, LegalDocumentModal } from './components/LegalGate';
import { HazardReportCard } from './components/HazardReportCard';
import { AlertCard } from './components/AlertCard';
import { ErrorBoundary, EmptyState, useToast } from './components/ui/Feedback';
import { isWithinCoverage, COVERAGE_LABEL } from './config/coverage';
import {
  createDefaultFilters, DEFAULT_FILTERS, ALL_LAND_TYPES,
  ROAD_ACCESS_RANK, countActiveFilters
} from './config/filters';
import { distanceMiles } from './utils/geo';
import { bestCellSignal } from './utils/amenities';
import { openDirections } from './utils/handoff';
import { updateAlertLocation } from './services/pushService';
import {
  fetchCampsitesNear, fetchMyRigs, submitCampsite, fetchMySubmissionStates,
  saveCampsiteRemote, unsaveCampsiteRemote, fetchSavedCampsitesRemote,
  type HazardRecord, type NearbyCamper, type Rig
} from './services/dataService';
import { mergeCampsites } from './utils/mergeCampsites';
import { calculateRoute, type RouteResult } from './services/routingService';
import { fetchWeather, EMPTY_WEATHER, type WeatherSnapshot, type HazardAlert } from './services/weatherService';
import { fetchCellCoverage, UNKNOWN_COVERAGE } from './services/cellCoverageService';
import { useAuth } from './contexts/AuthContext';
import { Search, Bookmark, MapPinOff, SlidersHorizontal, Waves } from 'lucide-react';

/** Calgary, AB — the app's home coordinates. */
const HOME_CENTER: [number, number] = [51.0447, -114.0719];
const HOME_LABEL = 'Calgary, AB';

export default function App() {
  // Who's signed in. Drives the rig lookup and the friends list — both are
  // inert without a session, which is the correct behaviour, not a bug.
  const { user } = useAuth();
  const toast = useToast();

  // Navigation & view
  const [activeView, setActiveView] = useState<AppView>('map');
  const [isOfflineMode, setIsOfflineMode] = useState(false);

  // Map & location
  const [center, setCenter] = useState<[number, number]>(HOME_CENTER);
  const [zoom, setZoom] = useState(10);
  const [currentLocationName, setCurrentLocationName] = useState(HOME_LABEL);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  // Data
  const [campsites, setCampsites] = useState<Campsite[]>(CURATED_CAMPSITES);
  const [savedSites, setSavedSites] = useState<Campsite[]>([]);
  /**
   * How much of the saved list the account actually has.
   *
   * Shown to the camper rather than assumed, because "saved" meaning two
   * different things — on this phone, versus on your account — is precisely
   * the confusion that made the missing sync worth fixing.
   */
  const [savedSync, setSavedSync] =
    useState<'signed_out' | 'syncing' | 'synced' | 'unreachable'>('signed_out');
  const [selectedCampsite, setSelectedCampsite] = useState<Campsite | null>(null);
  const [detailModalSite, setDetailModalSite] = useState<Campsite | null>(null);
  const [sheetSite, setSheetSite] = useState<Campsite | null>(null);
  const [isSearchingSites, setIsSearchingSites] = useState(false);
  const [outOfCoverageNotice, setOutOfCoverageNotice] = useState<string | null>(null);
  const [pinRefusal, setPinRefusal] = useState<'water' | 'outside_coverage' | null>(null);
  const [nearbyCampers, setNearbyCampers] = useState<NearbyCamper[]>([]);

  /* ---------------------------------------------- Destination & routing */
  // Where the user wants to go: a pin they dropped, or a spot they tapped.
  const [destination, setDestination] = useState<MapDestination | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [selectedReport, setSelectedReport] = useState<HazardRecord | null>(null);
  /** An official warning (fire/flood/storm) tapped on the map. */
  const [selectedAlert, setSelectedAlert] = useState<HazardAlert | null>(null);

  /**
   * The rig, which exists only to make the route warnings specific to it.
   *
   * The app no longer drives you anywhere — the drive is handed to Apple or
   * Google Maps — but it still works out the route, because that is where the
   * numbers a camper actually needs come from: how long the drive is, what the
   * weather will be doing when you land, how far short of the spot the road
   * gives out, and whether your rig fits down what's left.
   */
  const [primaryRig, setPrimaryRig] = useState<Rig | null>(null);

  // Conditions at the destination, shared by every panel that asks about it.
  const [destWeather, setDestWeather] = useState<WeatherSnapshot>(EMPTY_WEATHER);
  const [destCoverage, setDestCoverage] = useState<CellCoverage>(UNKNOWN_COVERAGE);

  // Panels & modals
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isPresenceOpen, setIsPresenceOpen] = useState(false);
  const [isScoutOpen, setIsScoutOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isOfflineManagerOpen, setIsOfflineManagerOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  /**
   * Which point the submission form is about.
   *
   * Adding a spot always starts from somewhere real now — the pin on the map,
   * or the camper's own position — rather than from a blank latitude field,
   * so the form is handed a coordinate instead of guessing at the map centre.
   */
  const [addSpotAt, setAddSpotAt] = useState<[number, number] | null>(null);
  /** The "add the ground under your feet?" question, raised by the + button. */
  const [isAddHereOpen, setIsAddHereOpen] = useState(false);
  const [isGuideModalOpen, setIsGuideModalOpen] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDocKind | null>(null);

  const [filterState, setFilterState] = useState<FilterState>(() =>
    createDefaultFilters(HOME_LABEL)
  );

  // Restore saved and user-submitted sites on first load.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [saved, custom] = await Promise.all([
        getSavedCampsites(),
        getCustomCampsites()
      ]);
      if (cancelled) return;

      setSavedSites(saved);
      if (custom.length > 0) {
        setCampsites((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          return [...prev, ...custom.filter((c) => !ids.has(c.id))];
        });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  /**
   * Catch up on what happened to this user's own submissions.
   *
   * A spot submitted from this device is stored locally with whatever state it
   * had at the time — usually `pending_review`. It gets approved later, on
   * somebody else's schedule, and nothing would ever tell this browser. So one
   * query on sign-in reconciles the chips.
   *
   * Only possible because of the author-read policy in migration 10: before
   * it, the row-level security hid a user's own unpublished row from them, so
   * there was no way to ask.
   */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchMySubmissionStates().then((states) => {
      if (cancelled || states.size === 0) return;

      setCampsites((prev) => prev.map((site) => {
        const published = states.get(site.id);
        if (published === undefined) return site;

        const next: Campsite['submissionState'] = published ? 'published' : 'pending_review';
        if (site.submissionState === next && site.submittedByMe) return site;
        return { ...site, submissionState: next, submittedByMe: true };
      }));
    });

    return () => { cancelled = true; };
  }, [user]);

  const handleSelectLocation = useCallback(
    async (loc: GeocodedLocation) => {
      const label = loc.displayName.split(',')[0];
      setCenter([loc.lat, loc.lon]);
      setZoom(11);
      setCurrentLocationName(label);

      // Outside the supported region we still move the map, so the user can see
      // where they searched, but every data query is skipped.
      if (!isWithinCoverage(loc.lat, loc.lon)) {
        setOutOfCoverageNotice(label);
        return;
      }
      setOutOfCoverageNotice(null);

      // Keep the alert matcher's idea of where we are roughly current.
      updateAlertLocation(loc.lat, loc.lon);

      if (isOfflineMode) return;

      setIsSearchingSites(true);
      try {
        /**
         * Both registers at once: what other campers have contributed, and
         * what OpenStreetMap knows.
         *
         * Until now the app only ever asked Overpass. Everything submitted
         * through Wandrlust stayed in the submitter's own browser, so the
         * "community" half of a community app reached nobody. This is the
         * line that makes a shared spot actually shared.
         *
         * With no Supabase configured `fetchCampsitesNear` returns an empty
         * array and `mergeCampsites` collapses to what this did before —
         * the app still works with no keys at all.
         */
        const [shared, liveSites] = await Promise.all([
          fetchCampsitesNear(loc.lat, loc.lon, filterState.maxDistanceMiles),
          fetchOverpassCampsites(loc.lat, loc.lon, filterState.maxDistanceMiles)
        ]);

        setCampsites((prev) => mergeCampsites(prev, shared, liveSites));
      } catch (err) {
        console.warn('Campsite lookup failed:', err);
      } finally {
        setIsSearchingSites(false);
      }
    },
    [isOfflineMode, filterState.maxDistanceMiles]
  );

  const handleLocateUser = useCallback(() => {
    setIsLocating(true);

    const apply = (lat: number, lon: number, label: string) => {
      setUserLocation([lat, lon]);
      setCenter([lat, lon]);
      setZoom(12);
      setCurrentLocationName(label);
      setIsLocating(false);
      handleSelectLocation({
        displayName: label,
        city: label.split(',')[0],
        stateProvince: '',
        country: '',
        lat,
        lon
      });
    };

    if (!('geolocation' in navigator)) {
      apply(HOME_CENTER[0], HOME_CENTER[1], HOME_LABEL);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => apply(pos.coords.latitude, pos.coords.longitude, 'My current position'),
      (err) => {
        // Denied, or blocked inside an iframe. Fall back home rather than
        // leaving the user staring at a spinner.
        console.warn('Geolocation unavailable:', err.message);
        apply(HOME_CENTER[0], HOME_CENTER[1], HOME_LABEL);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, [handleSelectLocation]);

  // Stable identity: MapComponent rebuilds its marker cluster whenever this
  // changes, so an inline arrow here would rebuild every pin on every render.
  const handleSelectMapCampsite = useCallback((site: Campsite) => {
    setSelectedCampsite(site);
    setSelectedReport(null);
    setSelectedAlert(null);
    // A tapped pin becomes the destination, exactly like a dropped one. The
    // map draws no extra marker for it — the pin it already has lights up.
    setDestination({ latitude: site.latitude, longitude: site.longitude, campsite: site });
    /**
     * Deliberately does NOT recentre any more.
     *
     * It used to fly the map to the pin, which was already a little rude — you
     * tapped something you could see, so moving it was never necessary. It
     * became a bug once routes existed: with no geolocation the drive is
     * measured from `center`, so recentring on the destination made the origin
     * and the destination the same point and every route came back 0 km.
     */
  }, []);

  /* ------------------------------------------------------------------ */
  /* Picking somewhere to go                                             */
  /* ------------------------------------------------------------------ */

  /**
   * A tap on bare map. One pin at a time — tapping again moves it.
   *
   * Deliberately does not recentre. The user is looking at a specific patch of
   * ground and sliding it out from under their thumb to put it in the middle
   * of the screen is the opposite of helpful.
   */
  const handleDropDestination = useCallback(
    (lat: number, lon: number, land?: DestinationLand) => {
      setSelectedCampsite(null);
      setSelectedReport(null);
      setSelectedAlert(null);
      setPinRefusal(null);
      setDestination({ latitude: lat, longitude: lon, land });
    },
    []
  );

  /**
   * A pin was refused — in water, or outside the coverage area.
   *
   * Shows a short notice and clears it after a beat. The timer is held
   * in a ref and reset on each refusal, because tapping the water twice
   * is the normal way to meet this message and the naive version broke
   * exactly there: every refusal started its own timer, and the first
   * one to fire cleared whatever notice was on screen at the time. Tap,
   * tap, and the second warning vanished after a couple of hundred
   * milliseconds — long enough to flicker, too short to read.
   */
  const refusalTimer = useRef<number | null>(null);

  const handlePinRefused = useCallback((reason: 'water' | 'outside_coverage') => {
    setPinRefusal(reason);
    if (refusalTimer.current !== null) window.clearTimeout(refusalTimer.current);
    refusalTimer.current = window.setTimeout(() => {
      refusalTimer.current = null;
      setPinRefusal(null);
    }, 2400);
  }, []);

  useEffect(() => () => {
    if (refusalTimer.current !== null) window.clearTimeout(refusalTimer.current);
  }, []);

  /** Open the submission form on a specific coordinate. */
  const handleAddSpotAt = useCallback((latitude: number, longitude: number) => {
    setAddSpotAt([latitude, longitude]);
    setIsAddHereOpen(false);
    setIsAddModalOpen(true);
  }, []);

  const handleClearDestination = useCallback(() => {
    setDestination(null);
    setSelectedCampsite(null);
    setRoute(null);
  }, []);

  /**
   * Where a drive is measured from.
   *
   * The user's real position when we have one, otherwise wherever they last
   * searched — `center` only moves on a search or a locate, never on a pan or
   * a pin tap, so it is a stable "where I'm working from" rather than a live
   * viewport reading.
   *
   * The label names it either way, because "4h 20m" measured from a town you
   * looked up rather than the seat you're sitting in is a different number and
   * the user has to be able to tell which they're reading.
   */
  const origin: [number, number] = userLocation ?? center;

  /**
   * Work out the drive as soon as somewhere is picked.
   *
   * The app does not drive you there — that is handed off to the maps app on
   * the phone, which is also what puts it on CarPlay or Android Auto. The route
   * is still worked out here because it answers the questions that decide
   * whether to go at all: how far, how long, what the weather will be doing on
   * arrival, how much of the last stretch has no road in the data, and whether
   * your rig fits down it.
   */
  useEffect(() => {
    if (!destination) { setRoute(null); return; }

    let cancelled = false;
    setRoute(null);

    calculateRoute({
      from: origin,
      to: [destination.latitude, destination.longitude],
      rig: primaryRig
    }).then((result) => {
      if (cancelled) return;
      setRoute(result);
    });

    return () => { cancelled = true; };
    // `origin` is a fresh array each render, so it is spread into primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, origin[0], origin[1], primaryRig]);

  /**
   * Conditions at the destination, fetched once and shared.
   *
   * Lifted here rather than fetched per panel, so the destination sheet and the
   * campsite sheet make one request between them rather than one each.
   */
  useEffect(() => {
    if (!destination) {
      setDestWeather(EMPTY_WEATHER);
      setDestCoverage(UNKNOWN_COVERAGE);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    const { latitude, longitude } = destination;

    // Settled, not all — one failing must not hide the other, and neither of
    // these services rejects in the first place.
    Promise.allSettled([
      fetchWeather(latitude, longitude, controller.signal).then((w) => {
        if (!cancelled) setDestWeather(w);
      }),
      fetchCellCoverage(latitude, longitude, controller.signal).then((c) => {
        if (!cancelled) setDestCoverage(c);
      })
    ]);

    return () => { cancelled = true; controller.abort(); };
  }, [destination]);

  /**
   * Hand the drive to the phone's own maps app.
   *
   * This is the whole of "navigation" now, and deliberately so. Wandrlust used
   * to have a chase camera, a rotating map and a heads-up display, none of
   * which added up to turn-by-turn — there were never any maneuver
   * instructions, voice, or re-routing. Apple Maps and Google Maps do all of
   * that properly and, crucially, are already on CarPlay and Android Auto. One
   * link puts the drive on the car's screen with no native code on our side.
   *
   * What the app keeps is the part those two get wrong: the last few miles.
   * See `src/utils/handoff.ts`.
   */
  const handleOpenDirections = useCallback(() => {
    if (!destination) return;
    openDirections(destination.latitude, destination.longitude);
  }, [destination]);

  /**
   * Your rig, so the route can be checked against its dimensions.
   *
   * Keyed on the session rather than run once on mount: Supabase restores a
   * session asynchronously, so a mount-time read fires before there is a user
   * and comes back empty, and the route would then be planned as though you
   * were driving a car for the rest of the session.
   */
  useEffect(() => {
    if (!user) { setPrimaryRig(null); return; }
    let cancelled = false;
    fetchMyRigs().then((rigs) => {
      if (!cancelled) setPrimaryRig(rigs.find((r) => r.is_primary) ?? rigs[0] ?? null);
    });
    return () => { cancelled = true; };
  }, [user]);

  /**
   * Bookmark a spot — on this device, and on the account behind it.
   *
   * THE DEVICE WRITE COMES FIRST AND IS NEVER UNDONE, the same rule the add
   * form follows. A camper tapping the bookmark at a pullout with one bar is
   * keeping something they may need when the signal goes; losing it because an
   * insert failed would be the worst outcome this button has. The account write
   * is an enhancement layered on top and is allowed to fail.
   *
   * Silent on success — a toast on every bookmark tap is noise. It speaks up
   * only when the two copies have actually diverged, because a bookmark that
   * quietly never left the phone is the bug this replaced.
   */
  const handleToggleSave = useCallback(async (site: Campsite, e?: React.MouseEvent) => {
    e?.stopPropagation();

    const nowSaved = await toggleSaveCampsite(site);
    setSavedSites(await getSavedCampsites());

    // Signed out is not a failure, and the saved view already says the list
    // lives on this device only. Nothing to report.
    if (!user) return;

    if (nowSaved) {
      const result = await saveCampsiteRemote(site);
      if (!result.ok) toast.info('Saved on this device', result.message);
      return;
    }

    const result = await unsaveCampsiteRemote(site.id);
    if (!result.ok) {
      // Worth saying out loud: the merge on next sign-in only ever adds, so a
      // failed removal means this spot comes back rather than staying gone.
      toast.info('Removed from this device', `Still on your account — ${result.message}`);
    }
  }, [user, toast]);

  /**
   * Reconcile the saved list with the account, once per sign-in.
   *
   * Runs in three steps, in this order for a reason:
   *
   *   1. read what the account has,
   *   2. fold it into the device list — only ever adding, never removing,
   *   3. push up whatever the account had not seen.
   *
   * Step 3 is what carries across every spot bookmarked before this fix
   * shipped, or bookmarked while signed out. Those exist on one phone and
   * nowhere else, and the first sign-in after this change is the moment they
   * stop being one bad reinstall away from gone.
   *
   * A server that cannot be reached leaves the device list exactly as it was
   * and says so in the saved view. It never reads silence as "you saved
   * nothing" — see `fetchSavedCampsitesRemote` on why it returns null rather
   * than an empty array.
   */
  useEffect(() => {
    if (!user) { setSavedSync('signed_out'); return; }

    let cancelled = false;
    setSavedSync('syncing');

    (async () => {
      const remote = await fetchSavedCampsitesRemote();
      if (cancelled) return;

      if (remote === null) { setSavedSync('unreachable'); return; }

      const merged = await mergeSavedCampsites(remote);
      if (cancelled) return;

      setSavedSites(merged);
      setSavedSync('synced');

      const knownRemotely = new Set(remote.map((site) => site.id));
      // One at a time: the list is small, and a burst of parallel upserts on a
      // weak connection is how you turn a slow sync into a failed one.
      for (const site of merged) {
        if (cancelled) return;
        if (knownRemotely.has(site.id)) continue;
        await saveCampsiteRemote(site);
      }
    })();

    return () => { cancelled = true; };
  }, [user]);

  /**
   * Save the spot, then try to share it. In that order, always.
   *
   * THE LOCAL WRITE COMES FIRST AND IS NEVER UNDONE. A camper standing at a
   * pullout with one bar has just typed coordinates they may not be able to
   * recover; losing that because an insert failed, or because they were signed
   * out, would be the worst thing this form could do. So localforage gets it
   * unconditionally, and the server write is an enhancement on top that is
   * allowed to fail.
   *
   * What the share adds is other people seeing it — the row lands unpublished
   * and waits for review, which is what the chip on the card explains.
   */
  const handleAddCustomSite = useCallback(async (site: Campsite) => {
    await addCustomCampsite(site);

    const shared = await submitCampsite(site);
    const stored: Campsite = {
      ...site,
      submissionState: shared.ok ? 'pending_review' : 'local_only',
      submittedByMe: true
    };

    if (shared.ok) {
      toast.success(
        'Spot saved and sent for review',
        'Only you can see it until it is approved.'
      );
    } else {
      toast.info('Saved on this device', shared.message);
    }

    setCampsites((prev) => [stored, ...prev]);
    setSelectedCampsite(stored);
    // Selecting a pin and having it be the destination are the same state
    // everywhere else, so a newly added spot has to set both — otherwise the
    // pin draws highlighted with no panel beneath it explaining why.
    setDestination({
      latitude: stored.latitude,
      longitude: stored.longitude,
      campsite: stored
    });
    // Unlike tapping an existing pin, this one IS worth flying to: the user
    // typed coordinates and has no idea yet where they landed.
    setCenter([stored.latitude, stored.longitude]);
  }, [toast]);

  /**
   * Take the site's new rating from the server, rather than working it out.
   *
   * This used to append the review to React state and recompute the average
   * locally — which meant the figure on screen was this browser's opinion of
   * the average, drifting from the database the moment anybody else reviewed
   * the same spot, and vanishing entirely on reload. `refresh_campsite_rating`
   * owns the number; the modal asks it and passes the answer through here.
   */
  const handleRatingChange = useCallback(
    (siteId: string, rating: number, reviewCount: number) => {
      const apply = (site: Campsite): Campsite => ({ ...site, rating, reviewCount });

      setCampsites((prev) => prev.map((s) => (s.id === siteId ? apply(s) : s)));
      setDetailModalSite((prev) => (prev && prev.id === siteId ? apply(prev) : prev));
    },
    []
  );

  /**
   * Filter and sort in one pass.
   *
   * Distance is computed once per site and carried through, rather than being
   * recalculated inside both the filter predicate and the sort comparator
   * (which ran Haversine O(n log n) extra times on every keystroke).
   */
  const filteredCampsites = useMemo(() => {
    const [lat, lon] = center;

    const withDistance = campsites.map((site) => ({
      site,
      distance: distanceMiles(lat, lon, site.latitude, site.longitude)
    }));

    const matches = withDistance.filter(({ site, distance }) => {
      if (distance > filterState.maxDistanceMiles) return false;
      if (filterState.landTypes.length > 0 && !filterState.landTypes.includes(site.landType)) {
        return false;
      }

      /**
       * Requirements are only satisfied by a recorded fact.
       *
       * Every amenity is optional now, so each of these has to decide what an
       * unknown means. It means "does not qualify": asking for a site with
       * water and being shown one where nobody has ever checked is how someone
       * arrives somewhere dry expecting a creek. A filter that is switched off
       * still shows everything, so nothing is lost by being strict here.
       */
      const { amenities } = site;
      if (filterState.waterOnly && (!amenities.water || amenities.water === 'none')) return false;
      if (filterState.toiletOnly && (!amenities.toilet || amenities.toilet === 'none')) return false;
      if (filterState.petFriendlyOnly && amenities.petFriendly !== true) return false;

      if (filterState.cellSignalOnly) {
        const best = bestCellSignal(amenities);
        if (best === undefined || best < 2) return false;
      }

      if (
        filterState.rigLengthMinFt > 0 &&
        (amenities.maxRvLengthFeet ?? 0) < filterState.rigLengthMinFt
      ) {
        return false;
      }

      if (filterState.roadAccessMax !== 'all') {
        // An unrecorded road could be anything, including worse than asked for.
        if (!amenities.roadAccess) return false;
        if (ROAD_ACCESS_RANK[amenities.roadAccess] > ROAD_ACCESS_RANK[filterState.roadAccessMax]) {
          return false;
        }
      }

      return true;
    });

    matches.sort((a, b) => {
      switch (filterState.sortBy) {
        /**
         * Reviewed sites first, then everything unreviewed by distance.
         *
         * A bare `b.rating - a.rating` put every site with no reviews at 0,
         * tied with each other and below a genuine 1-star — so "highest rated"
         * returned an arbitrary order for a dataset where almost nothing has
         * been reviewed yet. An absent rating is not a bad rating.
         */
        case 'rating': {
          const aRated = a.site.reviewCount > 0;
          const bRated = b.site.reviewCount > 0;
          if (aRated !== bRated) return aRated ? -1 : 1;
          if (!aRated) return a.distance - b.distance;
          return b.site.rating - a.site.rating;
        }
        case 'name': return a.site.name.localeCompare(b.site.name);
        case 'stay_limit':
          return b.site.amenities.stayLimitDays - a.site.amenities.stayLimitDays;
        case 'distance':
        default: return a.distance - b.distance;
      }
    });

    return matches;
  }, [campsites, center, filterState]);

  const distanceById = useMemo(() => {
    const map = new Map<string, number>();
    filteredCampsites.forEach(({ site, distance }) => map.set(site.id, distance));
    return map;
  }, [filteredCampsites]);

  const visibleSites = useMemo(
    () => filteredCampsites.map((entry) => entry.site),
    [filteredCampsites]
  );

  /**
   * What the MAP draws pins for: every camper-submitted spot, filters or not.
   *
   * The list's filters answer "which of these would suit me"; a pin answers
   * "somebody camped here". Running the second through the first meant a spot
   * you had just submitted disappeared as soon as it fell outside the
   * distance slider, or the moment any amenity filter was on — because a spot
   * added in thirty seconds on a phone records almost nothing, and an
   * unrecorded fact does not satisfy a requirement. It looked like the
   * submission had been lost. Submitted pins now stay on the map; the list
   * still filters exactly as before.
   */
  const mapSites = useMemo(() => {
    const seen = new Set(visibleSites.map((site) => site.id));
    const extras = campsites.filter(
      (site) => site.source === 'user_submitted' && !seen.has(site.id)
    );
    return extras.length ? [...visibleSites, ...extras] : visibleSites;
  }, [visibleSites, campsites]);

  const activeFilterCount = useMemo(() => countActiveFilters(filterState), [filterState]);

  const resetFilters = useCallback(
    () => setFilterState((prev) => ({
      ...prev,
      ...DEFAULT_FILTERS,
      landTypes: [...ALL_LAND_TYPES]
    })),
    []
  );

  const savedIds = useMemo(() => new Set(savedSites.map((s) => s.id)), [savedSites]);

  const renderCard = (site: Campsite) => (
    <CampsiteCard
      key={site.id}
      campsite={site}
      isSelected={selectedCampsite?.id === site.id}
      isSaved={savedIds.has(site.id)}
      onSelect={setSelectedCampsite}
      onToggleSave={handleToggleSave}
      onOpenDetail={setDetailModalSite}
      distanceMiles={distanceById.get(site.id)}
    />
  );

  return (
    /**
     * Height is `100dvh`, not `100vh`.
     *
     * On a phone, `vh` is the viewport with the browser chrome hidden, which
     * is taller than what you can actually see while the address bar is
     * showing. The app was being laid out into a box bigger than the screen,
     * so the bottom ran off and the map, sized from a stale container, drew
     * its tiles offset from where the map actually was. `dvh` tracks the real
     * visible height as the chrome comes and goes.
     *
     * The padding is for display cut-outs: index.html sets `viewport-fit=cover`
     * so an installed app fills the whole screen, which means the notch and the
     * home indicator are ours to avoid.
     */
    <div
      className="h-[100dvh] bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-['Plus_Jakarta_Sans',sans-serif]
                 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]
                 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <div className="w-full h-full flex flex-col flex-1 min-h-0">
        <Navbar
          activeView={activeView}
          setActiveView={setActiveView}
          filterState={filterState}
          setFilterState={setFilterState}
          onSelectLocation={handleSelectLocation}
          onLocateUser={handleLocateUser}
          isLocating={isLocating}
          isOfflineMode={isOfflineMode}
          setIsOfflineMode={setIsOfflineMode}
          onOpenOfflineManager={() => setIsOfflineManagerOpen(true)}
          onOpenAddModal={() => setIsAddHereOpen(true)}
          onOpenGuideModal={() => setIsGuideModalOpen(true)}
          onOpenFilterDrawer={() => setIsFilterOpen(true)}
          onOpenAuth={() => setIsAuthOpen(true)}
          onOpenPresence={() => setIsPresenceOpen(true)}
          onOpenScout={() => setIsScoutOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenReport={() => setIsReportOpen(true)}
          nearbyCount={nearbyCampers.length}
          activeFilterCount={activeFilterCount}
          savedCount={savedSites.length}
        />

        <main id="main" className="flex-1 relative flex flex-col overflow-hidden min-h-0">
          {/* ---------------------------------------------------------- MAP */}
          {activeView === 'map' && (
            <div className="relative w-full h-full flex flex-col overflow-hidden">
              {/* The map gets the whole area. Everything it needs to say is an
                  overlay on top of it rather than a panel stealing height. */}
              <div className="flex-1 relative min-h-0">
                <ErrorBoundary fallbackLabel="The map failed to load">
                  <MapComponent
                    campsites={mapSites}
                    selectedCampsite={selectedCampsite}
                    onSelectCampsite={handleSelectMapCampsite}
                    center={center}
                    zoom={zoom}
                    userLocation={userLocation}
                    isOfflineMode={isOfflineMode}
                    onOpenDetailModal={setSheetSite}
                    onLocateUser={handleLocateUser}
                    isLocating={isLocating}
                    destination={destination}
                    onDropDestination={handleDropDestination}
                    onPinRefused={handlePinRefused}
                    onSelectHazardReport={(r) => { setSelectedReport(r); setSelectedAlert(null); }}
                    onSelectAlert={(a) => { setSelectedAlert(a); setSelectedReport(null); }}
                    weather={destWeather}
                    coverage={destCoverage}
                    route={route}
                    onOpenDirections={handleOpenDirections}
                    onClearDestination={handleClearDestination}
                    onAddSpotHere={handleAddSpotAt}
                  />
                </ErrorBoundary>

                {isSearchingSites && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/95 border border-emerald-500/50 text-emerald-300 px-4 py-2 rounded-full shadow-2xl backdrop-blur-md text-xs font-semibold flex items-center gap-2.5 anim-in-down">
                    <Search className="w-4 h-4 text-emerald-400 animate-[bounce_0.6s_infinite]" />
                    <span>Exploring public lands…</span>
                  </div>
                )}

                {outOfCoverageNotice && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] max-w-sm bg-slate-900/95 border border-slate-600 text-slate-200 px-3.5 py-2 rounded-2xl shadow-2xl backdrop-blur-md text-[11px] flex items-start gap-2 anim-in-up">
                    <MapPinOff className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>{outOfCoverageNotice}</strong> is outside our coverage.
                      Wandrlust currently supports {COVERAGE_LABEL}, so campsite and
                      boundary data is unavailable here.
                    </span>
                  </div>
                )}

                {/*
                  Pin-refused toast. Two cases:
                    'water' — the tap was in a lake, a bay, or the ocean.
                    'outside_coverage' — the tap was in the pannable
                       rectangle but outside the precise coverage
                       polygon (a sliver of northern Mexico is the
                       main one; the user cannot reach anywhere else
                       because of maxBounds).
                  Auto-clears after 2.4s; see handlePinRefused.
                */}
                {pinRefusal && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] max-w-sm bg-slate-900/95 border border-amber-500/60 text-slate-200 px-3.5 py-2 rounded-2xl shadow-2xl backdrop-blur-md text-[11px] flex items-start gap-2 anim-in-up">
                    {pinRefusal === 'water'
                      ? <Waves className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                      : <MapPinOff className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />}
                    <span>
                      {pinRefusal === 'water'
                        ? <>This spot is in <strong>water</strong>. Drop the pin on land — a campsite needs a place to pitch a tent.</>
                        : <>This spot is <strong>outside our coverage</strong>. Wandrlust currently supports {COVERAGE_LABEL}.</>}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --------------------------------------------------------- LIST */}
          {activeView === 'list' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4 scroll-soft">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="font-['Outfit'] font-bold text-xl text-slate-100">
                    Dispersed campsites near {currentLocationName}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {visibleSites.length} public land site
                    {visibleSites.length === 1 ? '' : 's'} within{' '}
                    {filterState.maxDistanceMiles} miles
                  </p>
                </div>
                <button
                  onClick={() => setIsFilterOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </button>
              </div>

              {visibleSites.length === 0 ? (
                <EmptyState
                  icon={SlidersHorizontal}
                  title="Nothing matches those filters"
                  description="Try widening the search radius, allowing more land types, or clearing the amenity requirements."
                  action={{ label: 'Reset filters', onClick: resetFilters }}
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {visibleSites.map(renderCard)}
                </div>
              )}
            </div>
          )}

          {/* -------------------------------------------------------- SAVED */}
          {activeView === 'saved' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4 scroll-soft">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="font-['Outfit'] font-bold text-xl text-slate-100 flex items-center gap-2">
                    <Bookmark className="w-5 h-5 text-amber-400" />
                    Saved offline ({savedSites.length})
                  </h2>
                  <p className="text-xs text-slate-400">
                    {savedSync === 'synced'
                      ? 'On this device and on your account, so they work with no cell service'
                      : savedSync === 'syncing'
                        ? 'Stored on this device — checking your account…'
                        : savedSync === 'unreachable'
                          ? "Stored on this device. Couldn't reach your account just now."
                          : 'Stored on this device only. Sign in to keep them on your account.'}
                  </p>
                </div>
                <button
                  onClick={() => setIsOfflineManagerOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-teal-600/30 text-teal-300 border border-teal-500/40 text-xs font-semibold"
                >
                  Manage map packs
                </button>
              </div>

              {savedSites.length === 0 ? (
                <EmptyState
                  icon={Bookmark}
                  title="No saved campsites yet"
                  description="Tap the bookmark on any campsite to keep its details, coordinates and photos on your device for the trip."
                  action={{ label: 'Explore the map', onClick: () => setActiveView('map') }}
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {savedSites.map(renderCard)}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ------------------------------------------------ Modals & panels */}
      {detailModalSite && (
        <CampsiteDetailModal
          campsite={detailModalSite}
          isSaved={savedIds.has(detailModalSite.id)}
          onClose={() => setDetailModalSite(null)}
          onToggleSave={handleToggleSave}
          onRatingChange={handleRatingChange}
          onRequireAuth={() => setIsAuthOpen(true)}
        />
      )}

      <OfflineManagerModal
        isOpen={isOfflineManagerOpen}
        onClose={() => setIsOfflineManagerOpen(false)}
        currentLocationName={currentLocationName}
        center={center}
        campsitesInView={visibleSites}
        isOfflineMode={isOfflineMode}
        setIsOfflineMode={setIsOfflineMode}
      />

      <AddCampsiteModal
        isOpen={isAddModalOpen}
        onClose={() => { setIsAddModalOpen(false); setAddSpotAt(null); }}
        onAdd={handleAddCustomSite}
        defaultCenter={addSpotAt ?? center}
      />

      <AddHereConfirm
        isOpen={isAddHereOpen}
        onClose={() => setIsAddHereOpen(false)}
        userLocation={userLocation}
        isLocating={isLocating}
        onLocateUser={handleLocateUser}
        onConfirm={handleAddSpotAt}
      />

      <CampingGuideModal isOpen={isGuideModalOpen} onClose={() => setIsGuideModalOpen(false)} />

      <FilterDrawer
        isOpen={isFilterOpen}
        onClose={() => setIsFilterOpen(false)}
        filterState={filterState}
        setFilterState={setFilterState}
        onReset={resetFilters}
        totalResultsCount={visibleSites.length}
      />

      <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} />

      <CampsiteBottomSheet
        campsite={sheetSite}
        isSaved={sheetSite ? savedIds.has(sheetSite.id) : false}
        onClose={() => setSheetSite(null)}
        onToggleSave={handleToggleSave}
        onRequireAuth={() => setIsAuthOpen(true)}
      />

      <HazardReportCard
        record={selectedReport}
        onClose={() => setSelectedReport(null)}
        onRequireAuth={() => setIsAuthOpen(true)}
      />
      <AlertCard alert={selectedAlert} onClose={() => setSelectedAlert(null)} />

      <PresencePanel
        isOpen={isPresenceOpen}
        onClose={() => setIsPresenceOpen(false)}
        center={center}
        onRequireAuth={() => setIsAuthOpen(true)}
        onCampersChange={setNearbyCampers}
      />

      <ScoutModePanel
        isOpen={isScoutOpen}
        onClose={() => setIsScoutOpen(false)}
        onRequireAuth={() => setIsAuthOpen(true)}
      />

      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onRequireAuth={() => setIsAuthOpen(true)}
        center={center}
        onOpenLegal={setLegalDoc}
      />

      <ReportPanel
        isOpen={isReportOpen}
        onClose={() => setIsReportOpen(false)}
        center={center}
        campsiteId={sheetSite?.id ?? selectedCampsite?.id ?? null}
        onRequireAuth={() => setIsAuthOpen(true)}
      />

      <LegalGate onOpenFullText={setLegalDoc} />
      <LegalDocumentModal kind={legalDoc} onClose={() => setLegalDoc(null)} />
    </div>
  );
}
