import React, { useState, useEffect, useMemo } from 'react';
import { Campsite, FilterState, GeocodedLocation, CamperReview, RoadAccess } from './types';
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
import { ErrorBoundary } from './components/ui/Feedback';
import { isWithinCoverage, COVERAGE_LABEL } from './config/coverage';
import { updateAlertLocation } from './services/pushService';
import type { NearbyCamper } from './services/dataService';

import {
  Compass,
  MapPin,
  List,
  Sparkles,
  Bookmark,
  WifiOff,
  Search,
  SlidersHorizontal,
  RefreshCw,
  PlusCircle,
  Tent
} from 'lucide-react';

export default function App() {
  // Navigation & View States
  const [activeView, setActiveView] = useState<'map' | 'list' | 'saved'>('map');
  const [isMobileFrame, setIsMobileFrame] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);

  // Map & Location States (Default: Calgary, AB)
  const [center, setCenter] = useState<[number, number]>([51.0447, -114.0719]);
  const [zoom, setZoom] = useState(10);
  const [currentLocationName, setCurrentLocationName] = useState('Calgary, AB');
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  // Data States
  const [campsites, setCampsites] = useState<Campsite[]>(CURATED_CAMPSITES);
  const [savedSites, setSavedSites] = useState<Campsite[]>([]);
  const [selectedCampsite, setSelectedCampsite] = useState<Campsite | null>(null);
  const [detailModalSite, setDetailModalSite] = useState<Campsite | null>(null);
  const [isSearchingAi, setIsSearchingAi] = useState(false);
  const [outOfCoverageNotice, setOutOfCoverageNotice] = useState<string | null>(null);
  const [visibleMapCampsites, setVisibleMapCampsites] = useState<Campsite[]>([]);

  // Modal Visibility States
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isPresenceOpen, setIsPresenceOpen] = useState(false);
  const [isScoutOpen, setIsScoutOpen] = useState(false);
  const [isHostOpen, setIsHostOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [sheetSite, setSheetSite] = useState<Campsite | null>(null);
  const [nearbyCampers, setNearbyCampers] = useState<NearbyCamper[]>([]);
  const [legalDoc, setLegalDoc] = useState<
    'privacy_policy' | 'terms_of_service' | 'safety_disclaimer' | null
  >(null);
  const [isOfflineManagerOpen, setIsOfflineManagerOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isGuideModalOpen, setIsGuideModalOpen] = useState(false);

  // Filter State
  const [filterState, setFilterState] = useState<FilterState>({
    searchQuery: 'Calgary, AB',
    landTypes: ['blm', 'usfs', 'state_forest', 'dispersed', 'crown_land'],
    waterOnly: false,
    toiletOnly: false,
    cellSignalOnly: false,
    petFriendlyOnly: false,
    rigLengthMinFt: 0,
    roadAccessMax: 'all',
    maxDistanceMiles: 500,
    sortBy: 'distance'
  });

  // Load Saved & Custom Campsites on Mount
  useEffect(() => {
    const loadStoredData = async () => {
      const saved = await getSavedCampsites();
      setSavedSites(saved);

      const custom = await getCustomCampsites();
      if (custom.length > 0) {
        setCampsites((prev) => {
          const ids = new Set(prev.map((s) => s.id));
          const newCustom = custom.filter((c) => !ids.has(c.id));
          return [...prev, ...newCustom];
        });
      }
    };
    loadStoredData();
  }, []);

  // Distance helper (Haversine formula in miles)
  const calculateDistanceMiles = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number => {
    const R = 3958.8; // Radius of earth in miles
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Handle Location Selection
  const handleSelectLocation = async (loc: GeocodedLocation) => {
    const newCenter: [number, number] = [loc.lat, loc.lon];
    setCenter(newCenter);
    setZoom(11);
    setCurrentLocationName(loc.displayName.split(',')[0]);

    // Outside the supported region we still move the map (so the user can see
    // where they searched) but we skip every data query.
    if (!isWithinCoverage(loc.lat, loc.lon)) {
      setOutOfCoverageNotice(loc.displayName.split(',')[0]);
      return;
    }
    setOutOfCoverageNotice(null);

    // Keep the push matcher's idea of where we are roughly current.
    updateAlertLocation(loc.lat, loc.lon);

    // Skip network queries if offline mode is active
    if (isOfflineMode) return;

    // Fetch live OSM Overpass campsites around this location
    setIsSearchingAi(true);
    try {
      const liveOsmSites = await fetchOverpassCampsites(loc.lat, loc.lon, filterState.maxDistanceMiles);

      // Attempt AI search via backend Gemini API proxy if server is active
      let aiSpots: Campsite[] = [];
      try {
        const aiRes = await fetch('/api/camping-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locationName: loc.displayName.split(',')[0],
            lat: loc.lat,
            lon: loc.lon
          })
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          if (aiData.spots && Array.isArray(aiData.spots)) {
            aiSpots = aiData.spots;
          }
        }
      } catch (e) {
        console.warn('AI camping endpoint unavailable:', e);
      }

      // Merge new sites with existing curated list
      setCampsites((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const filteredLive = liveOsmSites.filter((s) => !existingIds.has(s.id));
        const filteredAi = aiSpots.filter((s) => !existingIds.has(s.id));
        return [...prev, ...filteredLive, ...filteredAi];
      });
    } catch (err) {
      console.warn('Location query error:', err);
    } finally {
      setIsSearchingAi(false);
    }
  };

  // Locate User via Browser Geolocation with Calgary AB default fallback
  const handleLocateUser = () => {
    setIsLocating(true);

    const applyCoords = (lat: number, lon: number, locationLabel: string) => {
      const coords: [number, number] = [lat, lon];
      setUserLocation(coords);
      setCenter(coords);
      setZoom(12);
      setCurrentLocationName(locationLabel);
      setIsLocating(false);

      handleSelectLocation({
        displayName: locationLabel,
        city: locationLabel.split(',')[0],
        stateProvince: '',
        country: '',
        lat,
        lon
      });
    };

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          applyCoords(pos.coords.latitude, pos.coords.longitude, 'My Current Position');
        },
        async (err) => {
          console.warn('Geolocation direct lookup failed or denied:', err);
          // Fallback to Calgary, AB default when iframe/browser geolocation fails
          applyCoords(51.0447, -114.0719, 'Calgary, AB');
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      applyCoords(51.0447, -114.0719, 'Calgary, AB');
    }
  };

  // Toggle Save Campsite
  const handleToggleSave = async (site: Campsite, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    await toggleSaveCampsite(site);
    const updatedSaved = await getSavedCampsites();
    setSavedSites(updatedSaved);
  };

  // Add Custom Campsite
  const handleAddCustomSite = async (site: Campsite) => {
    await addCustomCampsite(site);
    setCampsites((prev) => [site, ...prev]);
    setSelectedCampsite(site);
    setCenter([site.latitude, site.longitude]);
  };

  // Add Review
  const handleAddReview = (siteId: string, review: CamperReview) => {
    setCampsites((prev) =>
      prev.map((site) => {
        if (site.id === siteId) {
          const updatedReviews = [review, ...site.reviews];
          const newAvgRating = parseFloat(
            (
              updatedReviews.reduce((acc, r) => acc + r.rating, 0) / updatedReviews.length
            ).toFixed(1)
          );
          return {
            ...site,
            reviews: updatedReviews,
            rating: newAvgRating,
            reviewCount: updatedReviews.length
          };
        }
        return site;
      })
    );
    if (detailModalSite && detailModalSite.id === siteId) {
      setDetailModalSite((prev) =>
        prev
          ? {
              ...prev,
              reviews: [review, ...prev.reviews],
              reviewCount: prev.reviewCount + 1
            }
          : null
      );
    }
  };

  // Apply every active filter, then sort.
  const filteredCampsites = useMemo(() => {
    // Ordered loosest -> strictest so we can compare against the user's ceiling.
    const roadAccessRank: Record<RoadAccess, number> = {
      paved: 0, gravel: 1, high_clearance: 2, '4x4_only': 3
    };

    const matches = campsites.filter((site) => {
      const distance = calculateDistanceMiles(center[0], center[1], site.latitude, site.longitude);
      if (distance > filterState.maxDistanceMiles) return false;

      if (filterState.landTypes.length > 0 && !filterState.landTypes.includes(site.landType)) {
        return false;
      }

      const { amenities } = site;

      if (filterState.waterOnly && amenities.water === 'none') return false;
      if (filterState.toiletOnly && amenities.toilet === 'none') return false;
      if (filterState.petFriendlyOnly && !amenities.petFriendly) return false;

      if (filterState.cellSignalOnly) {
        const bestSignal = Math.max(
          amenities.cellSignal.verizon, amenities.cellSignal.att, amenities.cellSignal.tmobile
        );
        if (bestSignal < 2) return false;
      }

      if (filterState.rigLengthMinFt > 0 &&
          (amenities.maxRvLengthFeet ?? 0) < filterState.rigLengthMinFt) {
        return false;
      }

      if (filterState.roadAccessMax !== 'all') {
        const ceiling = roadAccessRank[filterState.roadAccessMax];
        if (roadAccessRank[amenities.roadAccess] > ceiling) return false;
      }

      return true;
    });

    return matches.sort((a, b) => {
      switch (filterState.sortBy) {
        case 'rating': return b.rating - a.rating;
        case 'name': return a.name.localeCompare(b.name);
        case 'stay_limit': return b.amenities.stayLimitDays - a.amenities.stayLimitDays;
        case 'distance':
        default: {
          const distA = calculateDistanceMiles(center[0], center[1], a.latitude, a.longitude);
          const distB = calculateDistanceMiles(center[0], center[1], b.latitude, b.longitude);
          return distA - distB;
        }
      }
    });
  }, [campsites, center, filterState]);

  // Number of filters deviating from defaults, shown as a badge.
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterState.landTypes.length < 5) count += 1;
    if (filterState.waterOnly) count += 1;
    if (filterState.toiletOnly) count += 1;
    if (filterState.cellSignalOnly) count += 1;
    if (filterState.petFriendlyOnly) count += 1;
    if (filterState.rigLengthMinFt > 0) count += 1;
    if (filterState.roadAccessMax !== 'all') count += 1;
    if (filterState.maxDistanceMiles !== 500) count += 1;
    return count;
  }, [filterState]);

  const resetFilters = () =>
    setFilterState((prev) => ({
      ...prev,
      landTypes: ['blm', 'usfs', 'state_forest', 'dispersed', 'crown_land'],
      waterOnly: false, toiletOnly: false, cellSignalOnly: false, petFriendlyOnly: false,
      rigLengthMinFt: 0, roadAccessMax: 'all', maxDistanceMiles: 500, sortBy: 'distance'
    }));

  const savedIdsSet = useMemo(() => new Set(savedSites.map((s) => s.id)), [savedSites]);

  return (
    <div className={`${isMobileFrame ? 'min-h-screen' : 'h-screen'} bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-['Plus_Jakarta_Sans',sans-serif]`}>
      {/* React Native Frame Wrapper (provides optional mobile app UI frame) */}
      <ReactNativeFrame
        isMobileFrame={isMobileFrame}
        activeTab={activeView}
        onTabChange={(view) => setActiveView(view)}
        savedCount={savedSites.length}
      >
        {/* Navigation Bar */}
        <Navbar
          activeView={activeView}
          setActiveView={setActiveView}
          filterState={filterState}
          setFilterState={setFilterState}
          currentLocationName={currentLocationName}
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

        {/* Main Content View Switcher */}
        <main id="main" className="flex-1 relative flex flex-col overflow-hidden">
          {/* View 1: MAP VIEW */}
          {activeView === 'map' && (
            <div className="relative w-full h-full flex flex-col overflow-hidden">
              {/* Map Canvas */}
              <div className="flex-1 relative min-h-[300px]">
                <ErrorBoundary fallbackLabel="The map failed to load">
                <MapComponent
                  campsites={filteredCampsites}
                  selectedCampsite={selectedCampsite}
                  onSelectCampsite={(site) => {
                    setSelectedCampsite(site);
                    setCenter([site.latitude, site.longitude]);
                  }}
                  center={center}
                  zoom={zoom}
                  userLocation={userLocation}
                  isOfflineMode={isOfflineMode}
                  onOpenDetailModal={(site) => setSheetSite(site)}
                  onVisibleCampsitesChange={setVisibleMapCampsites}
                  onLocateUser={handleLocateUser}
                  isLocating={isLocating}
                />
                </ErrorBoundary>

                {/* AI & Live Data Loading Banner with Darting Looking Glass */}
                {isSearchingAi && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/95 border border-emerald-500/50 text-emerald-300 px-4 py-2 rounded-full shadow-2xl backdrop-blur-md text-xs font-semibold flex items-center gap-2.5">
                    <Search className="w-4 h-4 text-emerald-400 animate-[bounce_0.6s_infinite]" />
                    <span>Exploring public lands...</span>
                  </div>
                )}
              </div>

              {/* Bottom Cards Slider for Map Mode */}
              <div className="bg-slate-900/95 border-t border-slate-800 p-3 z-30 backdrop-blur-md">
                <div className="max-w-7xl mx-auto flex items-center justify-between mb-2 px-1">
                  <div className="text-xs text-slate-300 font-semibold flex items-center gap-2">
                    <Tent className="w-4 h-4 text-emerald-400" />
                    <span>
                      Showing {visibleMapCampsites.length} location{visibleMapCampsites.length === 1 ? '' : 's'} on active map
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveView('list')}
                    className="text-xs text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1"
                  >
                    Switch to Full List ({filteredCampsites.length})
                  </button>
                </div>

                {/* Horizontal Scrollable Cards */}
                <div className="flex gap-3 overflow-x-auto pb-2 pt-1 no-scrollbar">
                  {visibleMapCampsites.length === 0 ? (
                    <div className="text-xs text-slate-400 py-3 px-2 italic">
                      No campsites visible in this current map area. Pan or zoom out to discover locations.
                    </div>
                  ) : (
                    visibleMapCampsites.map((site, i) => {
                      const dist = calculateDistanceMiles(center[0], center[1], site.latitude, site.longitude);
                      return (
                        <div key={site.id} className="w-72 shrink-0">
                          <CampsiteCard
                            campsite={site}
                            isSelected={selectedCampsite?.id === site.id}
                            isSaved={savedIdsSet.has(site.id)}
                            onSelect={(s) => {
                              setSelectedCampsite(s);
                              setCenter([s.latitude, s.longitude]);
                            }}
                            onToggleSave={handleToggleSave}
                            onOpenDetail={(s) => setSheetSite(s)}
                            distanceMiles={dist}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* View 2: LIST VIEW */}
          {activeView === 'list' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="font-['Outfit'] font-bold text-xl text-slate-100">
                    Dispersed Campsites near {currentLocationName}
                  </h2>
                  <p className="text-xs text-slate-400">
                    Showing {filteredCampsites.length} BLM, USFS, and Public Land locations within {filterState.maxDistanceMiles} miles
                  </p>
                </div>
              </div>

              {filteredCampsites.length === 0 ? (
                <div className="py-16 text-center space-y-3 bg-slate-900/60 rounded-3xl border border-slate-800 p-8">
                  <WifiOff className="w-12 h-12 text-slate-600 mx-auto" />
                  <h3 className="font-bold text-lg text-slate-200">No Campsites Match Your Filters</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Try expanding your search radius, selecting more land types, or clearing amenity constraints.
                  </p>
                  <button
                    onClick={() =>
                      setFilterState((prev) => ({
                        ...prev,
                        maxDistanceMiles: 100,
                        landTypes: ['blm', 'usfs', 'state_forest', 'dispersed', 'crown_land'],
                        waterOnly: false,
                        toiletOnly: false
                      }))
                    }
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
                  >
                    Expand Search to 100 Miles
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredCampsites.map((site, i) => {
                    const dist = calculateDistanceMiles(center[0], center[1], site.latitude, site.longitude);
                    return (
                      <CampsiteCard
                        key={site.id}
                        campsite={site}
                        isSelected={selectedCampsite?.id === site.id}
                        isSaved={savedIdsSet.has(site.id)}
                        onSelect={(s) => setSelectedCampsite(s)}
                        onToggleSave={handleToggleSave}
                        onOpenDetail={(s) => setSheetSite(s)}
                        distanceMiles={dist}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* View 3: SAVED OFFLINE VIEW */}
          {activeView === 'saved' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="font-['Outfit'] font-bold text-xl text-slate-100 flex items-center gap-2">
                    <Bookmark className="w-5 h-5 text-amber-400" />
                    Saved Offline Campsites ({savedSites.length})
                  </h2>
                  <p className="text-xs text-slate-400">
                    Locations stored locally for offline wilderness navigation without cell service
                  </p>
                </div>
                <button
                  onClick={() => setIsOfflineManagerOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-teal-600/30 text-teal-300 border border-teal-500/40 text-xs font-semibold"
                >
                  Manage Map Packages
                </button>
              </div>

              {savedSites.length === 0 ? (
                <div className="py-16 text-center space-y-3 bg-slate-900/60 rounded-3xl border border-slate-800 p-8">
                  <Bookmark className="w-12 h-12 text-slate-600 mx-auto" />
                  <h3 className="font-bold text-lg text-slate-200">No Saved Campsites Yet</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Click the bookmark icon on any campsite card to save full details, coordinates, and images to your device for offline trip access.
                  </p>
                  <button
                    onClick={() => setActiveView('map')}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs"
                  >
                    Explore Free Campsites Map
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {savedSites.map((site, i) => (
                    <CampsiteCard
                      key={site.id}
                      campsite={site}
                      isSelected={selectedCampsite?.id === site.id}
                      isSaved={true}
                      onSelect={(s) => setSelectedCampsite(s)}
                      onToggleSave={handleToggleSave}
                      onOpenDetail={(s) => setSheetSite(s)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </ReactNativeFrame>

      {/* Modals & Slide-overs */}
      {detailModalSite && (
        <CampsiteDetailModal
          campsite={detailModalSite}
          isSaved={savedIdsSet.has(detailModalSite.id)}
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
        campsitesInView={filteredCampsites}
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
        totalResultsCount={filteredCampsites.length}
      />

      <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} />

      <CampsiteBottomSheet
        campsite={sheetSite}
        isSaved={sheetSite ? savedIdsSet.has(sheetSite.id) : false}
        onClose={() => setSheetSite(null)}
        onToggleSave={(site) => handleToggleSave(site)}
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


