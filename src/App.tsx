import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type {
  Campsite, FilterState, GeocodedLocation, AppView, LegalDocKind,
  DestinationLand, MapDestination, CellCoverage, BeaconSpot, FacilityKind,
  FacilityLookupState, MapFacility
} from './types';
import { CURATED_CAMPSITES } from './data/curatedCampsites';
import { fetchOverpassCampsites } from './services/overpass';
import {
  getSavedCampsites,
  toggleSaveCampsite,
  mergeSavedCampsites,
  getCustomCampsites,
  addCustomCampsite,
  deleteCustomCampsite,
  getOfflineCampsites
} from './services/offlineStorage';
import { Navbar } from './components/Navbar';
import { MapComponent } from './components/MapComponent';
import { CampsiteCard } from './components/CampsiteCard';
import { CampsiteDetailModal } from './components/CampsiteDetailModal';
import { OfflineManagerModal } from './components/OfflineManagerModal';
import { MapDataChoiceScreen } from './components/MapDataChoiceScreen';
import { shouldAskMapDataChoice } from './services/landOverlayService';
import { AddHereConfirm } from './components/AddHereConfirm';
import { AddFacilitySheet } from './components/AddFacilitySheet';
import { FacilityCheckSheet } from './components/FacilityCheckSheet';
import { CampingGuideModal } from './components/CampingGuideModal';
import { FilterDrawer } from './components/FilterDrawer';
import { AuthModal } from './components/AuthModal';
import { CampsiteBottomSheet } from './components/CampsiteBottomSheet';
import { PresencePanel } from './components/PresencePanel';
import { ScoutModePanel } from './components/ScoutModePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ReportPanel } from './components/ReportPanel';
import { BeaconPanel } from './components/BeaconPanel';
import { BeaconVerifyPanel } from './components/BeaconVerifyPanel';
import { SpotReportSheet, type SpotReportSubmission } from './components/SpotReportSheet';
import { createSpot } from './services/dataService';
import { flushPendingSpots } from './services/spotSync';
import { LegalGate, LegalDocumentModal } from './components/LegalGate';
import { HazardReportCard } from './components/HazardReportCard';
import { ErrorBoundary, EmptyState, useToast } from './components/ui/Feedback';
import { MobileTabBar } from './components/MobileTabBar';
import { ToolsView } from './components/ToolsView';
import { UpdatePrompt } from './components/UpdatePrompt';
import { isWithinCoverage, COVERAGE_LABEL } from './config/coverage';
import {
  createDefaultFilters, DEFAULT_FILTERS, ALL_LAND_TYPES,
  ROAD_ACCESS_RANK, countActiveFilters
} from './config/filters';
import { ROAD_ACCESS_BY_SCALE, RIG_FEET_BY_SCALE } from './config/spotReport';
import { newUserCampsiteId } from './utils/campsiteId';
import { distanceMiles, distanceKm } from './utils/geo';
import { bestCellSignal } from './utils/amenities';
import { openDirections } from './utils/handoff';
import { updateAlertLocation } from './services/pushService';
import {
  fetchCampsitesNear, fetchMyRigs, submitCampsite, fetchMySubmissionStates,
  saveCampsiteRemote, unsaveCampsiteRemote, fetchSavedCampsitesRemote,
  type HazardRecord, type NearbyCamper, type Rig
} from './services/dataService';
import { mergeCampsites } from './utils/mergeCampsites';
import {
  readFacilityCheck, clearFacilityCheck, type PendingFacilityCheck
} from './utils/facilityCheck';
import { calculateRoute, type RouteResult } from './services/routingService';
import { fetchWeather, EMPTY_WEATHER, type WeatherSnapshot } from './services/weatherService';
import { fetchCellCoverage, UNKNOWN_COVERAGE } from './services/cellCoverageService';
import { useAuth } from './contexts/AuthContext';
import {
  Bookmark, MapPinOff, SlidersHorizontal, Waves
} from 'lucide-react';
import { useOnlineStatus } from './utils/useOnlineStatus';
import { haptic } from './utils/animation';

/** Calgary, AB — the app's home coordinates. */
const HOME_CENTER: [number, number] = [51.0447, -114.0719];
const HOME_LABEL = 'Calgary, AB';

/**
 * How far the camper has to actually move before the drive is worked out
 * again.
 *
 * A live GPS fix wanders tens of metres while the phone lies still, and the
 * blue dot's watch reports every one of those wanders. A quarter of a
 * kilometre is far wider than that wander and far narrower than anything this
 * route claims — it changes no drive time, and it does not move where the
 * mapped road gives out.
 */
const ROUTE_ORIGIN_MOVE_KM = 0.25;

export default function App() {
  // Who's signed in. Drives the rig lookup and the friends list — both are
  // inert without a session, which is the correct behaviour, not a bug.
  const { user } = useAuth();
  const toast = useToast();

  // Navigation & view
  const [activeView, setActiveView] = useState<AppView>('map');

  /**
   * Offline is OBSERVED now, not chosen.
   *
   * It used to be a switch in the header that nobody ever touched, and which
   * could be left in either wrong position — "Online" showing green with no
   * bars, or the whole app refusing to fetch anything on a perfect
   * connection. The device already knows, so the device answers, and the
   * only thing on screen is a light that reports it. See
   * utils/useOnlineStatus for exactly how much `navigator.onLine` is worth.
   */
  const isOnline = useOnlineStatus();
  const isOfflineMode = !isOnline;

  /**
   * Whether to ask which map data this device should carry.
   *
   * Starts false rather than true: the chooser is a blocking screen, and
   * flashing it up for the moment it takes storage to answer would show a
   * returning camper a decision they made weeks ago. It appears only once
   * `shouldAskMapDataChoice` has confirmed both that nobody has chosen AND
   * that there is something to choose between.
   */
  const [askMapData, setAskMapData] = useState(false);

  useEffect(() => {
    let cancelled = false;
    shouldAskMapDataChoice().then((ask) => {
      if (!cancelled) setAskMapData(ask);
    });
    return () => { cancelled = true; };
  }, []);

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
  /**
   * How much of the screen the spot drawer is covering, in pixels.
   *
   * Passed down to the map so it can lift the open pin into the strip of map
   * left above the drawer, and put the view back when the drawer closes.
   */
  const [sheetPx, setSheetPx] = useState(0);
  const [isSearchingSites, setIsSearchingSites] = useState(false);
  const [outOfCoverageNotice, setOutOfCoverageNotice] = useState<string | null>(null);
  const [pinRefusal, setPinRefusal] = useState<'water' | 'outside_coverage' | null>(null);
  const [nearbyCampers, setNearbyCampers] = useState<NearbyCamper[]>([]);

  /* ---------------------------------------------- Destination & routing */
  // Where the user wants to go: a pin they dropped, or a spot they tapped.
  const [destination, setDestination] = useState<MapDestination | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [selectedReport, setSelectedReport] = useState<HazardRecord | null>(null);

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

  /**
   * Beacon.
   *
   * `beaconAt` is where the beacon was dropped; `beaconSpot` is the one a
   * camper tapped on the map to check in at. They are separate because the two
   * are different questions — "what is around here?" and "how did this one go?"
   * — and a camper can have the second open having never asked the first.
   *
   * `beaconRefreshKey` is bumped by ANYTHING that changes what the map should
   * be drawing — a finished scan, a new spot, a report, a takedown. The layer
   * otherwise only reloads after a 10 km pan, which is how sending a beacon
   * used to leave the map looking empty while the leads sat in the database.
   *
   */
  const [isBeaconOpen, setIsBeaconOpen] = useState(false);
  const [beaconAt, setBeaconAt] = useState<[number, number] | null>(null);
  const [beaconSpot, setBeaconSpot] = useState<BeaconSpot | null>(null);
  const [beaconRefreshKey, setBeaconRefreshKey] = useState(0);

  /**
   * THERE IS NO LONGER A "WHERE SHOULD IT LOOK?" QUESTION.
   *
   * There used to be a pill across the top of the map that opened one — your
   * own position, or a piece of ground you point at — and then a second mode
   * where the map waited for that tap. Both are gone. A beacon is now offered
   * in exactly one place: under the marker, beside the two other things you
   * can do with the ground you have just pointed at. The pin IS the answer to
   * "where should it look?", so the app stopped asking it, and the top of the
   * screen stopped carrying a second copy of a button that already sits under
   * the camper's thumb.
   */
  const [legalDoc, setLegalDoc] = useState<LegalDocKind | null>(null);

  /**
   * Facilities — the chips under the search, and adding one.
   *
   * `facilityKinds` is a DISPLAY layer and deliberately not part of
   * `filterState`. "Find me a toilet" and "only show campsites that have a
   * toilet" are different questions with different answers, and the one time
   * they lived in the same drawer people reliably reached for the wrong one.
   * Nothing here touches `filteredCampsites`.
   *
   * `facilityRefreshKey` exists for the same reason `beaconRefreshKey` does:
   * without it a camper adds a dump station, the sheet says "added", and the
   * map shows nothing until they pan far enough to trip a reload.
   */
  const [facilityKinds, setFacilityKinds] = useState<FacilityKind[]>([]);

  const [facilityState, setFacilityState] = useState<FacilityLookupState>({ status: 'idle' });
  const [facilityRefreshKey, setFacilityRefreshKey] = useState(0);
  const [isAddFacilityOpen, setIsAddFacilityOpen] = useState(false);
  const [addFacilityAt, setAddFacilityAt] = useState<[number, number] | null>(null);
  const [addFacilityFromGps, setAddFacilityFromGps] = useState(false);
  const [selectedFacility, setSelectedFacility] = useState<MapFacility | null>(null);

  const [filterState, setFilterState] = useState<FilterState>(() =>
    createDefaultFilters(HOME_LABEL)
  );

  // Restore saved and user-submitted sites on first load.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [saved, custom, packed] = await Promise.all([
        getSavedCampsites(),
        getCustomCampsites(),
        getOfflineCampsites()
      ]);
      if (cancelled) return;

      setSavedSites(saved);

      /**
       * Spots that came down with a map pack go on the MAP, not in Saved.
       *
       * They are the one category of spot this device holds that the camper
       * neither submitted nor bookmarked, and they are here because a pack was
       * downloaded for the area. They are added at the back so that anything
       * the server has to say about the same spot wins — a cached record is a
       * photograph of how things were on the day the pack came down.
       */
      if (packed.length > 0) {
        setCampsites((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          return [...prev, ...packed.filter((p) => !ids.has(p.id))];
        });
      }

      if (custom.length > 0) {
        setCampsites((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          return [
            ...prev,
            ...custom
              .filter((c) => !ids.has(c.id))
              /**
               * EVERY SPOT IN THIS LIST IS ONE OF THIS DEVICE'S OWN, WAITING
               * TO GO UP. THAT IS WHAT THE LIST IS NOW — see `spotSync`.
               *
               * Nothing gets in here except by somebody tapping "add" in this
               * app, and nothing stays once the server has accepted it. So
               * `submittedByMe` is a fact about these records rather than a
               * guess, and `local_only` is the state they are actually in.
               * Both are restated on load because the spots written before this
               * was fixed carry neither, which left them undeletable — the flag
               * is what draws the whole removal section.
               *
               * Neither decides anything on its own. Whether a spot can come
               * down is still the server's answer (`campsite_removal_state`),
               * so one that other campers have since used, or one added here
               * while signed into another account, gets the sentence explaining
               * why rather than a button that would be refused.
               */
              .map((c) => ({
                ...c,
                submittedByMe: true,
                submissionState: c.submissionState ?? 'local_only'
              }))
          ];
        });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  /**
   * EMPTY THE OUTBOX WHENEVER THERE IS A CHANCE OF IT WORKING.
   *
   * A spot only sits on the device because it could not be shared — no signal,
   * no account, a server having a bad minute. All three of those end without
   * the camper doing anything in particular, and none of them fires an event
   * that says "your spot can go up now". So this listens for the three moments
   * that are worth another try:
   *
   *   the app opening      — the failure may have been hours ago
   *   the radio returning  — the `online` event, which is what it is for
   *   signing in           — the commonest reason a share is refused
   *
   * `flushPendingSpots` deletes the device copy only after the server has taken
   * it, so a run that half-succeeds leaves the rest queued for the next one.
   * Silent by design: an upload the camper did not ask for, of a spot they
   * already believe is saved, does not need a toast. What it does need is for
   * the chip on the pin to stop saying "on this device", which is what
   * restating the uploaded records does.
   */
  useEffect(() => {
    let cancelled = false;

    const flush = async () => {
      const { uploaded } = await flushPendingSpots();
      if (cancelled || uploaded.length === 0) return;

      const byId = new Map(uploaded.map((site) => [site.id, site]));
      setCampsites((prev) => {
        /**
         * Both this and the restore-from-device effect run on mount, in no
         * fixed order. If the upload wins the race it has already deleted the
         * device copy the other one was about to read, so an uploaded spot can
         * be missing from the list entirely rather than merely stale — and it
         * would then not reappear until the camper happened to search near it.
         * Anything not already here is added rather than assumed present.
         */
        const known = new Set(prev.map((site) => site.id));
        const updated = prev.map((site) => byId.get(site.id) ?? site);
        const missing = uploaded.filter((site) => !known.has(site.id));
        return missing.length > 0 ? [...missing, ...updated] : updated;
      });
    };

    void flush();
    window.addEventListener('online', flush);
    return () => {
      cancelled = true;
      window.removeEventListener('online', flush);
    };
  }, [user]);

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

  /**
   * Which search is the current one.
   *
   * Two searches in quick succession are two independent fetches, and the
   * first can land second — Overpass is slower for some boxes than others.
   * Without this the older, slower answer overwrites the newer one and the
   * list shows results for a place the user has already moved on from.
   */
  const searchSeq = useRef(0);

  const handleSelectLocation = useCallback(
    async (loc: GeocodedLocation) => {
      const seq = ++searchSeq.current;
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

        /**
         * THE SERVER'S COPY WINS. `shared` GOES FIRST AND THAT IS WHY.
         *
         * `mergeCampsites` breaks a tie in favour of whichever group it saw
         * first, and this used to pass `prev` — so a spot the app was already
         * holding beat the same spot coming back from the server. That is
         * backwards. The device's copy is a snapshot from whenever it was
         * written; the server's carries the current review state, the position
         * as it stands now, and whether other campers have since touched it.
         * A stale local record quietly overriding all of that is how a spot
         * ends up looking unshared long after it went up.
         *
         * Nothing is lost by the flip. The merge never overwrites a recorded
         * value with an empty one — the amenities a camper filled in here, which
         * the server deliberately does not return, are still donated to the
         * winning record. And a spot that is only on this phone is not in
         * `shared` at all, so it survives untouched from `prev`.
         */
        // A newer search started while this one was in flight. Its answer is
        // the one the user is waiting on; this one is now about somewhere else.
        if (seq !== searchSeq.current) return;

        setCampsites((prev) => mergeCampsites(shared, prev, liveSites));
      } catch (err) {
        console.warn('Campsite lookup failed:', err);
      } finally {
        if (seq === searchSeq.current) setIsSearchingSites(false);
      }
    },
    [isOfflineMode, filterState.maxDistanceMiles]
  );

  /**
   * ---------------------------------------------------------------------
   * THE BLUE DOT IS ALWAYS ON THE MAP, FROM THE MOMENT THE APP OPENS.
   * ---------------------------------------------------------------------
   *
   * `userLocation` used to be set only by the locate button, so until you
   * pressed it the map had no idea where you were and drew nothing. That is
   * backwards for a driving app: knowing where you are is the baseline, and
   * the button is for bringing the CAMERA back to you — which is why nothing
   * in here ever moves the map. It only keeps the dot true.
   *
   * WHY THIS DOES NOT PROMPT ON A COLD OPEN. Calling `watchPosition`
   * unprompted throws a permission dialog at somebody who has just opened the
   * app and asked for nothing, and a prompt with no context is a prompt that
   * gets denied — after which the dot is gone for good. So the watch starts
   * only when permission has ALREADY been granted, or the moment the camper
   * grants it by pressing locate. Where the Permissions API is missing, it
   * waits for the button rather than guessing.
   */
  const watchIdRef = useRef<number | null>(null);

  const startLocationWatch = useCallback(() => {
    if (watchIdRef.current !== null) return;
    if (!('geolocation' in navigator)) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => setUserLocation([pos.coords.latitude, pos.coords.longitude]),
      (err) => {
        // Never fatal, and never a dialog. A dot that cannot be drawn is the
        // app knowing slightly less, not the app being broken.
        console.warn('Location watch unavailable:', err.message);
      },
      // High accuracy because this dot is read while driving a backroad, and
      // a fix that is two streets out is worse than none. `maximumAge` lets
      // the platform answer from a recent fix instead of waking the GPS for
      // every update, which is most of the battery cost back.
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 }
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    let permission: PermissionStatus | null = null;

    const armIfAlreadyAllowed = async () => {
      try {
        permission = await navigator.permissions?.query({
          name: 'geolocation' as PermissionName
        });
        if (!permission || cancelled) return;
        if (permission.state === 'granted') startLocationWatch();
        // Granting it in the browser's own UI, rather than through our button,
        // should light the dot up too.
        permission.onchange = () => {
          if (!cancelled && permission?.state === 'granted') startLocationWatch();
        };
      } catch {
        // No Permissions API. The locate button is the way in.
      }
    };

    void armIfAlreadyAllowed();

    return () => {
      cancelled = true;
      if (permission) permission.onchange = null;
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [startLocationWatch]);

  /**
   * ---------------------------------------------------------------------
   * WHERE THE MAP IS LOOKING, WHICH IS NOT THE SAME AS WHERE YOU SEARCHED
   * ---------------------------------------------------------------------
   *
   * Campsites were fetched in exactly one place — `handleSelectLocation` —
   * so the app only ever held the sites within `maxDistanceMiles` of the last
   * place somebody SEARCHED for. Pan the map to another region and nothing
   * loaded, and the distance filter then discarded anything that had, because
   * it measured from that same stale point.
   *
   * It went unnoticed while the table held twenty-two curated sites. Adding
   * eight hundred BC recreation sites made it obvious: they were in the
   * database, the RPC served ninety of them around Campbell River, and the
   * map showed none, because nothing had ever asked about that ground.
   *
   * So the map now reports where it settles and the sites follow the view.
   * `center` is left alone — it is the fly-to instruction App sends, and
   * writing to it from the map's own movement would fight the camera.
   */
  const [exploreCentre, setExploreCentre] = useState<[number, number] | null>(null);

  const handleExploreCentre = useCallback((lat: number, lon: number) => {
    setExploreCentre((prev) => {
      // A refetch per pan would hammer the API for an answer that barely
      // changes. A quarter of the default radius is far enough to be new
      // ground and close enough that the edge of the list stays populated.
      if (prev && distanceMiles(prev[0], prev[1], lat, lon) < 25) return prev;
      return [lat, lon];
    });
  }, []);

  /** Guards against a slower earlier view landing after a newer one. */
  const exploreSeq = useRef(0);

  useEffect(() => {
    if (!exploreCentre || isOfflineMode) return;
    const [lat, lon] = exploreCentre;
    const seq = ++exploreSeq.current;

    void (async () => {
      try {
        const [shared, live] = await Promise.all([
          fetchCampsitesNear(lat, lon, filterState.maxDistanceMiles),
          fetchOverpassCampsites(lat, lon, filterState.maxDistanceMiles)
        ]);
        if (seq !== exploreSeq.current) return;
        // Same precedence as a search: the server's copy wins, and anything
        // held only on this device survives untouched.
        setCampsites((prev) => mergeCampsites(shared, prev, live));
      } catch (err) {
        console.warn('Campsite lookup for the visible map failed:', err);
      }
    })();
  }, [exploreCentre, isOfflineMode, filterState.maxDistanceMiles]);

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
      (pos) => {
        // Permission has just been granted, or was already there. Either way
        // the dot can now stay live for the rest of the session.
        startLocationWatch();
        apply(pos.coords.latitude, pos.coords.longitude, 'My current position');
      },
      (err) => {
        // Denied, or blocked inside an iframe. Fall back home rather than
        // leaving the user staring at a spinner.
        console.warn('Geolocation unavailable:', err.message);
        apply(HOME_CENTER[0], HOME_CENTER[1], HOME_LABEL);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, [handleSelectLocation, startLocationWatch]);

  // Stable identity: MapComponent rebuilds its marker cluster whenever this
  // changes, so an inline arrow here would rebuild every pin on every render.
  const handleSelectMapCampsite = useCallback((site: Campsite) => {
    setSelectedCampsite(site);
    setSelectedReport(null);
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

  /* ------------------------------------------------------------ FACILITIES */

  /** Switch one facility layer on or off. */
  const handleToggleFacilityKind = useCallback((kind: FacilityKind) => {
    setFacilityKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    );
  }, []);

  const handleClearFacilityKinds = useCallback(() => setFacilityKinds([]), []);

  /**
   * THE FACILITY THE CAMPER WAS SENT TO, WAITING TO BE ASKED ABOUT.
   *
   * Raised when the app is looked at again after a handoff to Google Maps —
   * which is the first moment anybody can say whether the toilet was actually
   * there. `readFacilityCheck` owns the two windows: not before three minutes
   * (they have not been anywhere), not after twelve hours (nobody should be
   * asked to remember).
   *
   * The buzz is the point of the timing. The phone has been in a pocket, in a
   * cradle, or face down on a table since the handoff, so the question arrives
   * with a haptic tap rather than only as something on screen.
   */
  const [facilityCheck, setFacilityCheck] = useState<PendingFacilityCheck | null>(null);

  useEffect(() => {
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      setFacilityCheck((current) => {
        if (current) return current;
        const pending = readFacilityCheck();
        if (pending) haptic('warning');
        return pending;
      });
    };

    // Both, because a phone returning from another app fires `visibilitychange`
    // and a desktop tab returning from a new window fires `focus`.
    document.addEventListener('visibilitychange', ask);
    window.addEventListener('focus', ask);
    /* And once on mount: the app may have been killed in the background while
       Google Maps had the screen, in which case coming back is a cold start
       and neither event ever fires. */
    ask();

    return () => {
      document.removeEventListener('visibilitychange', ask);
      window.removeEventListener('focus', ask);
    };
  }, []);

  /* Dismissing is a real answer. The record is cleared either way, because an
     app that keeps asking until it gets a reply teaches people to tap whatever
     makes it go away. */
  const dismissFacilityCheck = useCallback(() => {
    clearFacilityCheck();
    setFacilityCheck(null);
  }, []);

  /** Open the facility form on a specific coordinate. */
  const handleAddFacilityAt = useCallback((latitude: number, longitude: number) => {
    setAddFacilityAt([latitude, longitude]);
    setAddFacilityFromGps(false);
    setIsAddFacilityOpen(true);
  }, []);

  /**
   * A facility landed. Redraw the layer, and switch its kind on if it is off.
   *
   * Without the second half a camper adds a toilet with no chips selected and
   * the map stays exactly as blank as it was — the pin is there, the layer
   * that would draw it is not running, and the app looks like it lost the
   * submission.
   */
  const handleFacilitySaved = useCallback((kind: FacilityKind) => {
    setFacilityKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
    setFacilityRefreshKey((key) => key + 1);
  }, []);

  /* ---------------------------------------------------------------- BEACON */

  /**
   * Whether a beacon could run at all.
   *
   * A beacon is a live search of public map data, so with no connection there
   * is nothing to search — and it is never offered on a submitted campsite,
   * because asking "what might be around here?" while standing on a known
   * campsite answers a question the camper did not ask.
   *
   * The map uses this to decide whether the button appears under a dropped
   * marker. It is the only place the beacon is offered from: an offer that
   * could only fail is worse than no offer, and a second copy across the top
   * of the screen was just noise over the map.
   */
  const canBeacon = isOnline && !destination?.campsite && !isBeaconOpen;

  /** Open the beacon on one exact point — the button under the marker. */
  const openBeaconAt = useCallback((latitude: number, longitude: number) => {
    setBeaconAt([latitude, longitude]);
    setIsBeaconOpen(true);
  }, []);

  /**
   * Sending the camper to a Beacon spot reuses the existing destination flow
   * rather than inventing a second one — same pin, same routing, same
   * conditions panel. A Beacon result is just a place on the map once you have
   * decided to drive to it.
   */
  const handleNavigateToBeaconSpot = useCallback(
    (latitude: number, longitude: number, label?: string) => {
      setIsBeaconOpen(false);
      setSelectedCampsite(null);
      setSelectedReport(null);
      setDestination({ latitude, longitude });
      setCenter([latitude, longitude]);
      setZoom((current) => Math.max(current, 14));
      // BeaconPanel passes the spot's name. It used to be dropped on the
      // floor — TypeScript allows a handler that takes fewer arguments —
      // which left the header naming wherever the camper searched last
      // while the map had already flown somewhere else.
      if (label) setCurrentLocationName(label);
    },
    []
  );

  /**
   * A spot changed — it was flagged red, or it genuinely left the map. Bump the
   * layer key so the change shows now, and close the sheet that was talking
   * about it.
   */
  const handleBeaconSpotWithdrawn = useCallback((_spotId: string) => {
    setBeaconSpot(null);
    setBeaconRefreshKey((n) => n + 1);
  }, []);

  /** A scan finished. The leads it persisted are on the map; go and get them. */
  const handleBeaconScanComplete = useCallback(() => {
    setBeaconRefreshKey((n) => n + 1);
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
   * The origin the DRIVE is measured from, which is deliberately not the live
   * one.
   *
   * `userLocation` now comes from a `watchPosition` that runs the whole time
   * the app is open, so the blue dot stays true — and a GPS fix jitters by
   * tens of metres while the phone sits still on a table. Every one of those
   * samples is a new `origin`, and the route effect below re-ran on every one:
   * it blanked the route, refetched it, and the chips that hang off it —
   * the drive time, and "1.8 km short", which is where the mapped road gives
   * out — vanished and came back every few seconds while the camper was
   * trying to read them.
   *
   * So the routing origin only moves when the camper has actually gone
   * somewhere. A quarter of a kilometre changes no answer this route provides
   * — not the drive time to a spot an hour away, not where the road stops —
   * and it is comfortably wider than any fix's wander.
   */
  const routeOriginRef = useRef<[number, number]>(origin);
  if (
    distanceKm(
      routeOriginRef.current[0], routeOriginRef.current[1], origin[0], origin[1]
    ) > ROUTE_ORIGIN_MOVE_KM
  ) {
    routeOriginRef.current = origin;
  }
  const routeOrigin = routeOriginRef.current;

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
    /*
     * THE OLD ANSWER STAYS UP UNTIL THE NEW ONE LANDS.
     *
     * This used to `setRoute(null)` first, which emptied the chip row of the
     * drive and of "1.8 km short" for however long the routing round trip
     * took. Recomputing an answer is not the same as not having one, and a
     * chip that blinks out mid-read is worse than a chip that is a few
     * seconds stale. It is still cleared outright when the destination
     * changes — see below — because then the old answer is about somewhere
     * else, which is the one case where holding it would be a lie.
     */
    calculateRoute({
      from: routeOrigin,
      to: [destination.latitude, destination.longitude],
      rig: primaryRig
    }).then((result) => {
      if (cancelled) return;
      setRoute(result);
    });

    return () => { cancelled = true; };
    // `routeOrigin` is a fresh array each render, so it is spread into
    // primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, routeOrigin[0], routeOrigin[1], primaryRig]);

  /*
   * A route belongs to the destination it was worked out for. The moment that
   * changes, the old one is about somewhere else and goes immediately, rather
   * than lingering as a plausible-looking drive to the wrong place.
   */
  useEffect(() => { setRoute(null); }, [destination]);

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
   * A camper took their own spot back down.
   *
   * The sheet has already asked the server and the server has already agreed —
   * this is the tidy-up, and it has to be thorough. The same spot can be in
   * five places at once: the map's list, the device's user-submitted list, the
   * saved list, whatever is selected, and the destination panel. Clearing four
   * of them leaves a ghost pin that reappears the moment the view changes.
   *
   * The device copy goes unconditionally. It is the one the app falls back to
   * with no server at all, so leaving it behind would put the spot straight
   * back on the map on the next reload.
   */
  const handleSpotRemoved = useCallback(async (site: Campsite) => {
    await deleteCustomCampsite(site.id);

    // A bookmark to a spot that no longer exists is a dead end in the Saved
    // tab, so it goes with it — through the same toggle the bookmark button
    // uses, never by writing the list here.
    const saved = await getSavedCampsites();
    if (saved.some((s) => s.id === site.id)) {
      await toggleSaveCampsite(site);
      setSavedSites(await getSavedCampsites());
    }

    setCampsites((prev) => prev.filter((s) => s.id !== site.id));
    setSheetSite(null);
    setSelectedCampsite((prev) => (prev?.id === site.id ? null : prev));
    setDetailModalSite((prev) => (prev?.id === site.id ? null : prev));
    setDestination((prev) => (prev?.campsite?.id === site.id ? null : prev));

    toast.success('Spot removed', 'It is off the map.');
  }, [toast]);

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
  const handleAddCustomSite = useCallback(async (
    site: Campsite,
    /**
     * Skip the toast.
     *
     * Set when this is being called as one half of a bigger submission that
     * reports its own outcome — two toasts about the same tap, one of them a
     * partial truth, is worse than one accurate one.
     */
    silent = false
  ) => {
    /**
     * DEVICE FIRST, SERVER SECOND, DEVICE COPY DROPPED LAST.
     *
     * The device write still happens before anything is attempted, because a
     * camper standing at a pullout with one bar has just typed coordinates they
     * may not be able to recover. There is no moment in this sequence where the
     * spot exists nowhere.
     *
     * But it no longer STAYS there once the server has it. A spot in browser
     * storage is invisible to every other camper and one cleared cache from
     * gone; the server copy is the real one, and the device list is now an
     * outbox for the spots that could not get there yet. See `spotSync`.
     */
    await addCustomCampsite({
      ...site, submissionState: 'local_only', submittedByMe: true
    });

    const shared = await submitCampsite(site);
    if (shared.ok) await deleteCustomCampsite(site.id);

    const stored: Campsite = {
      ...site,
      submissionState: shared.ok ? 'pending_review' : 'local_only',
      submittedByMe: true
    };

    if (!silent) {
      if (shared.ok) {
        toast.success(
          'Spot saved and sent for review',
          'Only you can see it until it is approved.'
        );
      } else {
        // "Waiting", not "saved": it is held on this phone and it is going up
        // by itself the moment it can. A camper told only that it was saved
        // has no idea anything is still outstanding.
        toast.info('Held on this device', `${shared.message} It will upload by itself once it can.`);
      }
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

  /* ------------------------------------------------------- ADDING A SPOT */

  /**
   * Put a spot on the map, from the report sheet.
   *
   * Two writes, and the order matters.
   *
   * The LOCAL write happens whatever else does. A camper adding a spot from a
   * canyon with no signal, or without an account, still gets their pin — it
   * lands in the on-device list exactly as it always did. That is the house
   * rule about the app working with no Supabase and no internet, and the
   * shiny new ladder does not get to break it.
   *
   * The SERVER write is what puts the spot on the evidence ladder for other
   * campers. It needs an account and a connection, and when it cannot happen
   * the camper is told which of the two they got rather than being left to
   * assume.
   */
  const handleSubmitNewSpot = useCallback(
    async (submission: SpotReportSubmission) => {
      // The camper's own fix wins over the pin they dropped. They are standing
      // at the place; the pin is wherever their thumb landed.
      const latitude = submission.position.coords.latitude;
      const longitude = submission.position.coords.longitude;

      const localSite: Campsite = {
        id: newUserCampsiteId(),
        name: submission.name,
        landType: 'dispersed',
        landManager: '',
        latitude,
        longitude,
        address: { nearestCity: '', stateProvince: '', country: '' },
        description: submission.report.comment?.trim() || 'Spot added from the map.',
        /**
         * Only what the camper actually answered.
         *
         * `maxRig` is a five-stop scale, not a length, so it is translated
         * rather than dropped through — and an unanswered scale stays absent
         * instead of arriving as "tent only".
         */
        amenities: {
          water: 'none',
          toilet: submission.report.hasRestroom === true ? 'vault' : 'none',
          roadAccess: ROAD_ACCESS_BY_SCALE[submission.report.roadAccess ?? -1] ?? 'gravel',
          maxRvLengthFeet: RIG_FEET_BY_SCALE[submission.report.maxRig ?? -1]
        },
        images: [],
        reviews: [],
        rating: 0,
        reviewCount: 0,
        source: 'user_submitted'
      };

      // The existing local path, silenced so this handler owns the message.
      // It saves to the device, sends to the campsite review queue, drops the
      // pin into state and flies the map to it — all of which a newly added
      // spot still wants.
      await handleAddCustomSite(localSite, true);

      const result = await createSpot(
        latitude,
        longitude,
        submission.name,
        submission.nameBasis,
        submission.position.coords.accuracy,
        submission.report,
        submission.clientFlags
      );

      setAddSpotAt(null);
      setIsAddModalOpen(false);

      if (result.ok) {
        setBeaconRefreshKey((n) => n + 1);
        return {
          ok: true,
          // A merge is not a failure, but it is not what they asked for either,
          // so it gets said rather than quietly happening.
          message: result.data?.merged
            ? 'Somebody had already pinned this pullout, so your report went onto their spot rather than adding a second pin next to it.'
            : result.message
        };
      }

      // The local pin exists. Say exactly that, rather than "failed".
      return {
        ok: true,
        message: `Saved on this device. ${result.message} Other campers will not see it until it goes through.`
      };
    },
    [handleAddCustomSite]
  );


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
    /*
     * Measured from what is on screen, falling back to the searched centre
     * before the map has reported in. Distance here decides what is listed
     * and how it sorts, so pinning it to a stale search point is what made
     * sites load and then immediately get filtered away again.
     */
    const [lat, lon] = exploreCentre ?? center;

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
  }, [campsites, center, exploreCentre, filterState]);

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

  /**
   * WHAT THE APP HAS TO SAY OVER THE MAP, handed to the map to place.
   *
   * These three are the app's, not the map's — a search running, a place off
   * the edge of coverage, a pin refused for landing in water — but they belong
   * in the same column as everything the map says about itself, in the middle
   * at the top, under the "tap to pick a spot" hint. They used to be floated
   * separately: two of them at the bottom edge, one at the top, while the map
   * kept its own notices in the top-left corner. A camper reading one had no
   * idea where the next one would appear.
   *
   * They are passed DOWN rather than drawn here because only the map knows
   * what else is in that column and how tall it is. See `topNotice`.
   */
  const mapTopNotice = (
    <>
      {outOfCoverageNotice && (
        <div className="max-w-full bg-slate-900/95 border border-slate-600 text-slate-200 px-3.5 py-2 rounded-2xl shadow-2xl backdrop-blur-md text-xs flex items-start gap-2 anim-in-down">
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
          'outside_coverage' — the tap was in the pannable rectangle but
             outside the precise coverage polygon (a sliver of northern
             Mexico is the main one; the user cannot reach anywhere else
             because of maxBounds).
        Auto-clears after 2.4s; see handlePinRefused.
      */}
      {pinRefusal && (
        <div className="max-w-full bg-slate-900/95 border border-amber-500/60 text-slate-200 px-3.5 py-2 rounded-2xl shadow-2xl backdrop-blur-md text-xs flex items-start gap-2 anim-in-down">
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
    </>
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
     *
     * ---------------------------------------------------------------------
     * THE TOP INSET IS NOT HERE. IT BELONGS TO THE HEADER.
     * ---------------------------------------------------------------------
     *
     * It used to be, and it made the installed app look like a browser. This
     * shell is slate-950 and the header is slate-900 with its own border and
     * shadow, so padding the SHELL left an empty slate-950 strip the height
     * of the status bar sitting above a visibly separate darker bar — two
     * stacked bars, the top one blank, in exactly the place Safari draws its
     * address bar. On a phone that reads as browser chrome, which is the one
     * thing an installed app must not look like.
     *
     * So the header absorbs the top inset into its own padding instead, and
     * its background runs up behind the clock and the battery. One bar, the
     * app's own, the way a native title bar looks. Anything else drawn
     * against the viewport rather than inside this box — the first-run map
     * data screen — has to do the same for itself.
     */
    <div
      className="h-[100dvh] bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-['Plus_Jakarta_Sans',sans-serif]
                 pb-[env(safe-area-inset-bottom)]
                 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      {/*
        The first-run map data choice, over everything.

        The map underneath keeps mounting and loading while this is up, so
        picking "Quick map" lands on a map that is already drawn rather than on
        a spinner.
      */}
      {askMapData && <MapDataChoiceScreen onChosen={() => setAskMapData(false)} />}

      <div className="w-full h-full flex flex-col flex-1 min-h-0">
        <Navbar
          activeView={activeView}
          setActiveView={setActiveView}
          filterState={filterState}
          setFilterState={setFilterState}
          onSelectLocation={handleSelectLocation}
          isOnline={isOnline}
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
          facilityKinds={facilityKinds}
          onToggleFacilityKind={handleToggleFacilityKind}
        />

        <main id="main" className="flex-1 relative flex flex-col overflow-hidden min-h-0">
          {/*
            "A new version is ready", as a pill just above the map's tap hint.

            In here rather than at the root so it sits inside the same box the
            map does — clear of the phone's tab bar without anybody hard-coding
            that bar's height — and on every view, because an update is not a
            map-only concern. Production only: in dev there is no service
            worker, and waiting on one that never arrives shows nothing.
          */}
          {import.meta.env.PROD && <UpdatePrompt />}
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
                    onOpenBottomSheet={setSheetSite}
                    onLocateUser={handleLocateUser}
                    isLocating={isLocating}
                    destination={destination}
                    onDropDestination={handleDropDestination}
                    onPinRefused={handlePinRefused}
                    onSelectHazardReport={setSelectedReport}
                    onSelectBeaconSpot={setBeaconSpot}
                    beaconRefreshKey={beaconRefreshKey}
                    weather={destWeather}
                    coverage={destCoverage}
                    route={route}
                    onOpenDirections={handleOpenDirections}
                    onClearDestination={handleClearDestination}
                    onAddSpotHere={handleAddSpotAt}
                    onAddFacilityHere={handleAddFacilityAt}
                    facilityKinds={facilityKinds}
                    onFacilityStateChange={setFacilityState}
                    onSelectFacility={setSelectedFacility}
                    selectedFacility={selectedFacility}
                    onCloseFacility={() => setSelectedFacility(null)}
                    isSignedIn={Boolean(user)}
                    onFacilityNoteSaved={() => setFacilityRefreshKey((key) => key + 1)}
                    isSearchingSites={isSearchingSites}
                    facilityRefreshKey={facilityRefreshKey}
                    bottomSheetPx={sheetSite ? sheetPx : 0}
                    topNotice={mapTopNotice}
                    onToggleFacilityKind={handleToggleFacilityKind}
                    onClearFacilityKinds={handleClearFacilityKinds}
                    facilityState={facilityState}
                    onExploreCentre={handleExploreCentre}
                    onSendBeaconAt={openBeaconAt}
                    canBeacon={canBeacon}
                    onOpenAuth={() => setIsAuthOpen(true)}
                  />
                </ErrorBoundary>

              </div>
            </div>
          )}

          {/* --------------------------------------------------------- LIST */}
          {activeView === 'list' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-16 md:pb-6 max-w-7xl mx-auto w-full space-y-4 scroll-soft">
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

          {/* -------------------------------------------------------- TOOLS */}
          {/*
            A page, not a panel over the map. Same frame as the list and the
            saved views, reached by the same row of tabs — see `ToolsView`.
          */}
          {activeView === 'tools' && (
            <ToolsView
              activeFilterCount={activeFilterCount}
              nearbyCount={nearbyCampers.length}
              onOpenFilterDrawer={() => setIsFilterOpen(true)}
              onOpenPresence={() => setIsPresenceOpen(true)}
              onOpenScout={() => setIsScoutOpen(true)}
              onOpenReport={() => setIsReportOpen(true)}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onOpenOfflineManager={() => setIsOfflineManagerOpen(true)}
              onOpenGuideModal={() => setIsGuideModalOpen(true)}
              onOpenAddModal={() => setIsAddHereOpen(true)}
            />
          )}

          {/* -------------------------------------------------------- SAVED */}
          {activeView === 'saved' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-16 md:pb-6 max-w-7xl mx-auto w-full space-y-4 scroll-soft">
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

        {/*
          The phone's primary navigation.

          A flex sibling of <main>, not an overlay: the map gets a shorter
          box rather than a bar parked on top of it, so the zoom buttons,
          the attribution and the boundary/backroad notices along the map's
          bottom edge keep the room they had. On a desktop it is not
          rendered at all — the header's own switcher and tool rail are
          still there and still reachable.
        */}
        <MobileTabBar
          activeView={activeView}
          setActiveView={setActiveView}
          savedCount={savedSites.length}
          activeFilterCount={activeFilterCount}
          nearbyCount={nearbyCampers.length}
          onOpenAddModal={() => setIsAddHereOpen(true)}
        />
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
        isOnline={isOnline}
      />

      {/*
        The submission form, which used to be a fourteen-field modal.

        What replaced it: the name is built from OpenStreetMap instead of
        typed, the coordinates come from the camper's own fix instead of two
        number inputs, the facility questions are only asked when the map
        cannot answer them, and everything that remains is optional. See
        SpotReportSheet for why it is one scroll and not a wizard.
      */}
      <SpotReportSheet
        isOpen={isAddModalOpen}
        onClose={() => { setIsAddModalOpen(false); setAddSpotAt(null); }}
        mode="create"
        at={addSpotAt ?? center}
        onSubmit={handleSubmitNewSpot}
      />

      {/*
        Adding a facility, and the card one opens when tapped.

        A separate sheet from SpotReportSheet on purpose: a campsite needs a
        photo, a GPS fix taken where you are standing, and eight scales; a
        toilet needs a kind and a coordinate. Folding the second into the
        first would make marking a tap as heavy as publishing a campsite, and
        nobody would do it twice.
      */}
      <AddFacilitySheet
        isOpen={isAddFacilityOpen}
        onClose={() => { setIsAddFacilityOpen(false); setAddFacilityAt(null); }}
        at={addFacilityAt}
        fromGps={addFacilityFromGps}
        isSignedIn={Boolean(user)}
        onRequireAuth={() => setIsAuthOpen(true)}
        onSaved={handleFacilitySaved}
      />

      {/*
        "DID YOU FIND IT?", ASKED ON THE WAY BACK.

        Not while the camper is looking at the pin deciding whether to go —
        nobody can answer then, and what that collects is somebody confirming
        that the pin exists. See `FacilityCheckSheet` and `utils/facilityCheck`.
      */}
      <FacilityCheckSheet
        pending={facilityCheck}
        onClose={dismissFacilityCheck}
        isSignedIn={Boolean(user)}
        onRequireAuth={() => setIsAuthOpen(true)}
        onRecorded={() => setFacilityRefreshKey((key) => key + 1)}
      />

      <AddHereConfirm
        isOpen={isAddHereOpen}
        onClose={() => setIsAddHereOpen(false)}
        userLocation={userLocation}
        isLocating={isLocating}
        onLocateUser={handleLocateUser}
        onConfirm={handleAddSpotAt}
        onAddFacility={(latitude, longitude) => {
          setIsAddHereOpen(false);
          setAddFacilityAt([latitude, longitude]);
          // The one path where the coordinate IS the phone's own fix, so the
          // sheet hedges it as such rather than as "where you tapped".
          setAddFacilityFromGps(true);
          setIsAddFacilityOpen(true);
        }}
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
        onRemoved={handleSpotRemoved}
        onHeightChange={setSheetPx}
      />

      <HazardReportCard
        record={selectedReport}
        onClose={() => setSelectedReport(null)}
        onRequireAuth={() => setIsAuthOpen(true)}
      />

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

      <BeaconPanel
        isOpen={isBeaconOpen}
        onClose={() => setIsBeaconOpen(false)}
        at={beaconAt}
        onRequireAuth={() => setIsAuthOpen(true)}
        onNavigate={handleNavigateToBeaconSpot}
        onScanComplete={handleBeaconScanComplete}
      />

      <BeaconVerifyPanel
        isOpen={beaconSpot !== null}
        onClose={() => setBeaconSpot(null)}
        spot={beaconSpot}
        onRequireAuth={() => setIsAuthOpen(true)}
        onSpotWithdrawn={handleBeaconSpotWithdrawn}
      />

      <LegalGate onOpenFullText={setLegalDoc} />
      <LegalDocumentModal kind={legalDoc} onClose={() => setLegalDoc(null)} />
    </div>
  );
}
