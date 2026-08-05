import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { Campsite, FilterState, GeocodedLocation, CamperReview, AppView, LegalDocKind } from './types';
import { CURATED_CAMPSITES } from './data/curatedCampsites';
import { fetchOverpassCampsites } from './services/overpass';
import {
  getSavedCampsites,
  toggleSaveCampsite,
  getCustomCampsites,
  addCustomCampsite
} from './services/offlineStorage';
import { Navbar } from './components/Navbar';
import { MapComponent } from './components/MapComponent';
import { CampsiteCard } from './components/CampsiteCard';
import { CampsiteDetailModal } from './components/CampsiteDetailModal';
import { OfflineManagerModal } from './components/OfflineManagerModal';
import { AddCampsiteModal } from './components/AddCampsiteModal';
import { CampingGuideModal } from './components/CampingGuideModal';
import { ReactNativeFrame } from './components/ReactNativeFrame';
import { FilterDrawer } from './components/FilterDrawer';
import { AuthModal } from './components/AuthModal';
import { CampsiteBottomSheet } from './components/CampsiteBottomSheet';
import { PresencePanel } from './components/PresencePanel';
import { ScoutModePanel } from './components/ScoutModePanel';
import { HostPanel } from './components/HostPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ReportPanel } from './components/ReportPanel';
import { LegalGate, LegalDocumentModal } from './components/LegalGate';
import { ErrorBoundary, EmptyState } from './components/ui/Feedback';
import { isWithinCoverage, COVERAGE_LABEL } from './config/coverage';
import {
  createDefaultFilters, DEFAULT_FILTERS, ALL_LAND_TYPES,
  ROAD_ACCESS_RANK, countActiveFilters
} from './config/filters';
import { distanceMiles } from './utils/geo';
import { updateAlertLocation } from './services/pushService';
import type { NearbyCamper } from './services/dataService';
import { Search, Bookmark, Tent, MapPinOff, SlidersHorizontal } from 'lucide-react';

/** Calgary, AB — the app's home coordinates. */
const HOME_CENTER: [number, number] = [51.0447, -114.0719];
const HOME_LABEL = 'Calgary, AB';

export default function App() {
  // Navigation & view
  const [activeView, setActiveView] = useState<AppView>('map');
  const [isMobileFrame, setIsMobileFrame] = useState(false);
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
  const [selectedCampsite, setSelectedCampsite] = useState<Campsite | null>(null);
  const [detailModalSite, setDetailModalSite] = useState<Campsite | null>(null);
  const [sheetSite, setSheetSite] = useState<Campsite | null>(null);
  const [isSearchingSites, setIsSearchingSites] = useState(false);
  const [outOfCoverageNotice, setOutOfCoverageNotice] = useState<string | null>(null);
  const [visibleMapCampsites, setVisibleMapCampsites] = useState<Campsite[]>([]);
  const [nearbyCampers, setNearbyCampers] = useState<NearbyCamper[]>([]);

  // Panels & modals
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isPresenceOpen, setIsPresenceOpen] = useState(false);
  const [isScoutOpen, setIsScoutOpen] = useState(false);
  const [isHostOpen, setIsHostOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isOfflineManagerOpen, setIsOfflineManagerOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
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
        const liveSites = await fetchOverpassCampsites(
          loc.lat, loc.lon, filterState.maxDistanceMiles
        );
        setCampsites((prev) => {
          const existing = new Set(prev.map((s) => s.id));
          const fresh = liveSites.filter((s) => !existing.has(s.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
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
    setCenter([site.latitude, site.longitude]);
  }, []);

  const handleToggleSave = useCallback(async (site: Campsite, e?: React.MouseEvent) => {
    e?.stopPropagation();
    await toggleSaveCampsite(site);
    setSavedSites(await getSavedCampsites());
  }, []);

  const handleAddCustomSite = useCallback(async (site: Campsite) => {
    await addCustomCampsite(site);
    setCampsites((prev) => [site, ...prev]);
    setSelectedCampsite(site);
    setCenter([site.latitude, site.longitude]);
  }, []);

  const handleAddReview = useCallback((siteId: string, review: CamperReview) => {
    const applyReview = (site: Campsite): Campsite => {
      const reviews = [review, ...site.reviews];
      const average = reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;
      return {
        ...site,
        reviews,
        rating: Number(average.toFixed(1)),
        reviewCount: reviews.length
      };
    };

    setCampsites((prev) => prev.map((s) => (s.id === siteId ? applyReview(s) : s)));
    setDetailModalSite((prev) => (prev && prev.id === siteId ? applyReview(prev) : prev));
  }, []);

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

      const { amenities } = site;
      if (filterState.waterOnly && amenities.water === 'none') return false;
      if (filterState.toiletOnly && amenities.toilet === 'none') return false;
      if (filterState.petFriendlyOnly && !amenities.petFriendly) return false;

      if (filterState.cellSignalOnly) {
        const best = Math.max(
          amenities.cellSignal.verizon, amenities.cellSignal.att, amenities.cellSignal.tmobile
        );
        if (best < 2) return false;
      }

      if (
        filterState.rigLengthMinFt > 0 &&
        (amenities.maxRvLengthFeet ?? 0) < filterState.rigLengthMinFt
      ) {
        return false;
      }

      if (filterState.roadAccessMax !== 'all') {
        if (ROAD_ACCESS_RANK[amenities.roadAccess] > ROAD_ACCESS_RANK[filterState.roadAccessMax]) {
          return false;
        }
      }

      return true;
    });

    matches.sort((a, b) => {
      switch (filterState.sortBy) {
        case 'rating': return b.site.rating - a.site.rating;
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
    <div
      className={`${isMobileFrame ? 'min-h-screen' : 'h-screen'} bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-['Plus_Jakarta_Sans',sans-serif]`}
    >
      <ReactNativeFrame
        isMobileFrame={isMobileFrame}
        activeTab={activeView}
        onTabChange={setActiveView}
        savedCount={savedSites.length}
      >
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
          onOpenAddModal={() => setIsAddModalOpen(true)}
          onOpenGuideModal={() => setIsGuideModalOpen(true)}
          onOpenFilterDrawer={() => setIsFilterOpen(true)}
          onOpenAuth={() => setIsAuthOpen(true)}
          onOpenPresence={() => setIsPresenceOpen(true)}
          onOpenScout={() => setIsScoutOpen(true)}
          onOpenHost={() => setIsHostOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenReport={() => setIsReportOpen(true)}
          nearbyCount={nearbyCampers.length}
          activeFilterCount={activeFilterCount}
          isMobileFrame={isMobileFrame}
          setIsMobileFrame={setIsMobileFrame}
          savedCount={savedSites.length}
        />

        <main id="main" className="flex-1 relative flex flex-col overflow-hidden">
          {/* ---------------------------------------------------------- MAP */}
          {activeView === 'map' && (
            <div className="relative w-full h-full flex flex-col overflow-hidden">
              <div className="flex-1 relative min-h-[300px]">
                <ErrorBoundary fallbackLabel="The map failed to load">
                  <MapComponent
                    campsites={visibleSites}
                    selectedCampsite={selectedCampsite}
                    onSelectCampsite={handleSelectMapCampsite}
                    center={center}
                    zoom={zoom}
                    userLocation={userLocation}
                    isOfflineMode={isOfflineMode}
                    onOpenDetailModal={setSheetSite}
                    onVisibleCampsitesChange={setVisibleMapCampsites}
                    onLocateUser={handleLocateUser}
                    isLocating={isLocating}
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
              </div>

              {/* Horizontal card strip for whatever is on screen right now */}
              <div className="bg-slate-900/95 border-t border-slate-800 p-3 z-30 backdrop-blur-md">
                <div className="max-w-7xl mx-auto flex items-center justify-between mb-2 px-1">
                  <div className="text-xs text-slate-300 font-semibold flex items-center gap-2">
                    <Tent className="w-4 h-4 text-emerald-400" />
                    <span>
                      {visibleMapCampsites.length} location
                      {visibleMapCampsites.length === 1 ? '' : 's'} in view
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveView('list')}
                    className="text-xs text-emerald-400 hover:text-emerald-300 font-bold"
                  >
                    See all {visibleSites.length}
                  </button>
                </div>

                <div className="flex gap-3 overflow-x-auto pb-2 pt-1 scroll-soft">
                  {visibleMapCampsites.length === 0 ? (
                    <p className="text-xs text-slate-400 py-3 px-2 italic">
                      No campsites in this part of the map. Pan or zoom out to find some.
                    </p>
                  ) : (
                    visibleMapCampsites.map((site) => (
                      <div key={site.id} className="w-72 shrink-0">
                        {renderCard(site)}
                      </div>
                    ))
                  )}
                </div>
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
                    Stored on this device, so they work with no cell service
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
      </ReactNativeFrame>

      {/* ------------------------------------------------ Modals & panels */}
      {detailModalSite && (
        <CampsiteDetailModal
          campsite={detailModalSite}
          isSaved={savedIds.has(detailModalSite.id)}
          onClose={() => setDetailModalSite(null)}
          onToggleSave={handleToggleSave}
          onAddReview={handleAddReview}
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
        onClose={() => setIsAddModalOpen(false)}
        onAdd={handleAddCustomSite}
        defaultCenter={center}
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

      <HostPanel
        isOpen={isHostOpen}
        onClose={() => setIsHostOpen(false)}
        defaultCenter={center}
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
