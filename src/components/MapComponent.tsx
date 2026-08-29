import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.vectorgrid';
import {
  AlertTriangle, Coffee, Crosshair, Eye, Info, Layers, Loader2, MapPin,
  MousePointerClick, Navigation, Search, User as UserIcon, X
} from 'lucide-react';
import { UserMenu, AccountPanelBody } from './UserMenu';
import { BuyMeACoffeeButton, SupportPanelBody } from './ui/BuyMeACoffeeButton';
import { MapPanel } from './ui/MapPanel';
import { FacilityPicker } from './FacilityPicker';
import { FacilityCard } from './FacilityCard';
import { rememberFacilityHandoff } from '../utils/facilityCheck';

import type {
  Campsite, CellCoverage, DestinationLand, FacilityKind, FacilityLookupState,
  FacilityNote,
  MapDestination, MapFacility, MapTileLayer, NearbyFacility, BeaconSpot, BackroadScan,
  CampsiteSetting
} from '../types';
import { getCachedTile } from '../services/offlineStorage';
import { pointInGeometry } from '../utils/geo';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { beaconTierStyle } from '../config/beacon';
import {
  BACKROAD_STYLES, BACKROAD_CLASS_ORDER, BACKROAD_CASING, backroadClassOf
} from '../config/backroads';
import { FACILITY, facilityKindFromDb, facilitySourceStyle } from '../config/facilities';
import { landRules } from '../config/landRules';
import { mergeFacilities, poiToMapFacility } from '../utils/mergeFacilities';
import {
  fetchHazardsNear, fetchBeaconSpotsNear, fetchPoisNear, fetchPoiNotesNear, HazardRecord
} from '../services/dataService';
import {
  fetchBoundaries, requestBoxFor, boxContains,
  BOUNDARY_GROUP_STYLES, boundaryGroupOf,
  EMPTY_BOUNDARIES, BoundaryCollection, BoundaryFeature,
  BoundaryDetail, EdgeAccuracy
} from '../services/boundaryService';
import {
  loadLandOverlay, overviewCollection, packCollection, LandOverlay
} from '../services/landOverlayService';
import {
  fetchBackroads, backroadRequestBox, backroadBoxCovers
} from '../services/backroadService';
import { tracesIn, onTracesChanged, type ScoutTrace } from '../services/scoutTraceStore';
import {
  PASS_ALPHA, SCOUT_WEIGHT, SCOUT_CASING, SCOUT_MIN_ZOOM,
  roughnessColor, ROUGHNESS_BANDS
} from '../config/scoutRoughness';
import {
  fetchActiveFires, findFiresNear, boxAround, isUnderControl, FIRE_ALERT_RADIUS_KM, ActiveFire
} from '../services/fireService';
import { fetchAdmin1, findAdmin1At, Admin1, primeAdmin1 } from '../services/admin1Service';
import { isOnLand, primeLandMask } from '../services/landService';
import {
  buildFuzzRings, ringBudget, edgeBlurPx, UNCERTAINTY_LABEL, shouldSimplify
} from '../utils/fuzzyBoundary';
import {
  AlertBadge, PointWarning, BADGE_COLOR, CLOUD_TINT, warningsForPoint, alertBadge,
  localizedPinHtml, cloudPieces,
  dissolveKey, dissolveSegments, dissolvedFill
} from '../utils/alertOverlay';
import {
  MarkerDot, amenityDots, conditionDots, facilityDots, fireDots, hazardDots,
  FACILITY_COLOR, LAND_GLYPH
} from '../utils/amenityDots';
import {
  fetchNearbyFacilities, fetchNearestDriveableRoad, findNearestDriveableRoad,
  fetchFacilitiesInView, ROAD_RADIUS_KM,
  FACILITY_GLYPH, FACILITY_LABEL, FACILITY_RADIUS_KM, FACILITY_MIN_ZOOM
} from '../services/nearbyAmenityService';
import { calculateRoute, RouteResult } from '../services/routingService';
import { directionsAppName, openDirections } from '../utils/handoff';
import {
  BoundingBox, MAP_VIEW_BBOX, COVERAGE_OUTLINE, WORLD_RING, VIEW_RING,
  BOUNDARY_MIN_ZOOM, BOUNDARY_MID_ZOOM, BOUNDARY_OVERVIEW_MIN_ZOOM, OVERVIEW_BOX,
  BACKROAD_MIN_ZOOM,
  overviewMinSpanDegrees, midMinSpanDegrees, clampToCoverage,
  COVERAGE_LABEL, isWithinCoverage, landDataGap, hasMappedCrownLand
} from '../config/coverage';
import {
  fetchAreaAlerts, alertGapNote, HazardAlert, sortAlerts,
  WeatherSnapshot
} from '../services/weatherService';
import { prefersReducedMotion, haptic } from '../utils/animation';
import { PointInfoSheet } from './PointInfoSheet';
/*
 * Tile/zoom/pan-bounds config, and pin/chip rendering, live in
 * mapViewConfig.ts and mapPinRendering.ts now — split out purely to shrink
 * this file, with no change in behavior. Neither has any React or component
 * state; MapComponent calls into them, they never call back.
 */
import {
  TRANSPARENT_PIXEL, TILE_URLS, TILE_PERFORMANCE, UNDERLAY_NATIVE_ZOOM,
  CAMPSITE_FOCUS_ZOOM, CLOUD_BLUR_PX, PAN_BOUNDS, TILE_BOUNDS,
  centreLeavingRoom, clusterView, type RenderedGeoJSONOptions
} from './mapViewConfig';
import {
  escapeHtml, outerRing, flipRow, patchChipRow, PEEK_HOLD_MS, PEEK_SLOP_PX,
  openPeek, closePeek, retractChipRow, createChipBatcher, freshChipKeys,
  setChipsLoading, CLOSE_SVG, withNavChip, NO_FACILITY_KINDS, FACILITY_IDLE,
  STACK_BUTTON, buildCampsiteIcon, buildHazardReportIcon, buildBeaconIcon,
  buildFacilityIcon, PIN_LIFT_PX, buildDestinationIcon, bboxExtent,
  featureMinDimPx, parcelFingerprint, landFromFeature, landSubtitle
} from './mapPinRendering';

/**
 * How far in a tour will go when everything it is showing sits close together.
 *
 * Not the map's own maximum. Two points forty metres apart framed at street
 * zoom fill the screen with one anonymous patch of ground — the surroundings
 * are what make a place recognisable, and past about here there are none left
 * to see. Seventeen is close enough to walk a track with and far enough out
 * that the ground still says where it is.
 */
const TOUR_MAX_ZOOM = 17;


interface MapComponentProps {
  campsites: Campsite[];
  selectedCampsite: Campsite | null;
  onSelectCampsite: (site: Campsite) => void;
  center: [number, number];
  zoom: number;
  userLocation: [number, number] | null;
  isOfflineMode: boolean;
  /**
   * Fired on a pin double-click: opens the quick-glance CampsiteBottomSheet,
   * not the full CampsiteDetailModal (that's CampsiteCard's onOpenDetail).
   * Named onOpenDetailModal until it was found to open the wrong one of the
   * app's two campsite surfaces — renamed so the mix-up can't repeat.
   */
  onOpenBottomSheet: (site: Campsite) => void;
  onLocateUser?: () => void;
  /**
   * Where the map is actually looking, after it settles.
   *
   * `center` is a fly-to instruction that App sends; this is the opposite
   * direction, and without it App had no idea the map had moved. Campsites
   * were therefore only ever loaded around the last place someone SEARCHED
   * for, so panning to a region full of them showed an empty map — see the
   * note on `handleExploreCentre` in App.tsx.
   */
  onExploreCentre?: (lat: number, lon: number) => void;
  isLocating?: boolean;

  /** The pin the user dropped, or the site they selected. Null when neither. */
  destination: MapDestination | null;
  /**
   * Conditions at that point, fetched by App and shown as chips on the pin.
   *
   * The map does not fetch these itself because the list view asks the same
   * question about the same point, and two owners means two requests.
   */
  weather: WeatherSnapshot;
  coverage: CellCoverage;
  /** The drive to that point, or null while it is being worked out. */
  route: RouteResult | null;
  /** A camper's "Metric units" preference — see `UserSettings` in `dataService.ts`. */
  useMetric: boolean;
  /** Hands the drive to Apple or Google Maps. See `src/utils/handoff.ts`. */
  onOpenDirections: () => void;
  /** Lets the open pin go, and gives the camera back. */
  onClearDestination: () => void;
  /** Starts a submission at the dropped pin. Bare ground only. */
  onAddSpotHere: (lat: number, lon: number) => void;
  /**
   * Starts a facility submission at the dropped pin.
   *
   * Separate from `onAddSpotHere` because they are separate things: one is
   * somewhere to sleep, the other is a toilet. Offered on any point, not just
   * bare ground inside public land — a dump station in a town car park is
   * worth marking and is nowhere you would camp.
   */
  onAddFacilityHere?: (lat: number, lon: number) => void;
  /** Fired when the user taps bare map. Carries the land under the tap. */
  onDropDestination: (lat: number, lon: number, land?: DestinationLand) => void;
  /**
   * Fired when a tap is rejected — pin in water, or pin in the
   * bit of the pannable box that falls outside the precise
   * coverage polygon (a sliver of northern Mexico, say). The
   * reason chooses which notice to show.
   */
  onPinRefused?: (reason: 'water' | 'outside_coverage') => void;
  /**
   * How many pixels of the map are covered by a card App is showing over it —
   * the campsite drawer, in practice. Zero when nothing is over the map.
   *
   * The map does not render that card, but it does have to get out from under
   * it: the open pin is centred in the strip of screen that is left, and the
   * view is given back when the card closes. See the effect that uses it.
   */
  bottomSheetPx?: number;
  /**
   * THE APP'S OWN NOTICES, RENDERED INSIDE THE MAP'S NOTICE COLUMN.
   *
   * A slot rather than a number. The app has passing things to say over the
   * map — a pin refused for landing in water, a search running, a place
   * outside coverage — and the map has standing ones: running offline, a
   * layer that could not be reached. They used to be laid out in two places
   * that could not see each other, so the app told the map how many pixels to
   * keep clear and the map took its word for it. Every time either side
   * changed height the two drifted apart and something ended up underneath
   * something else.
   *
   * Now there is ONE column, owned here, and the app hands its notices in.
   * They stack in the order a camper needs them: the instruction first,
   * then whatever just happened, then the standing state of the app.
   */
  topNotice?: React.ReactNode;
  /** Fired when a camper's hazard report is tapped. */
  onSelectHazardReport?: (record: HazardRecord) => void;
  /** Fired when a Beacon spot is tapped. */
  onSelectBeaconSpot?: (spot: BeaconSpot) => void;
  /**
   * Bumped to force the Beacon layer to refetch.
   *
   * Needed because a takedown has to leave the map immediately. Without it the
   * withdrawn spot would sit there until the camper panned 50 km — which is
   * exactly the pin somebody else is about to drive to.
   */
  beaconRefreshKey?: number;

  /** Opens the sign-in sheet, for the account button in the same stack. */
  onOpenAuth?: () => void;

  /**
   * Sends a Beacon from an exact point — the button under a dropped pin.
   *
   * The pin has already answered "where should it look?", so this goes
   * straight to the beacon rather than back through the question.
   */
  onSendBeaconAt?: (lat: number, lon: number) => void;
  /**
   * Whether a beacon can be sent at all. A beacon is a live search of public
   * map data, so with no connection there is nothing to search and the button
   * is not offered — an offer that fails is worse than no offer.
   */
  canBeacon?: boolean;

  /**
   * The facility layers switched on from the arc in the control stack.
   *
   * Empty means the layer is off entirely and nothing is fetched — this is
   * the common case, and Overpass is not asked a question nobody posed.
   */
  facilityKinds?: FacilityKind[];
  /** How the lookup is going. The app keeps it; the notice column says it. */
  onFacilityStateChange?: (state: FacilityLookupState) => void;
  /** The same state, handed back down so the map can say it in words. */
  facilityState?: FacilityLookupState;
  onToggleFacilityKind?: (kind: FacilityKind) => void;
  onClearFacilityKinds?: () => void;
  /** Fired when a facility pin is tapped. */
  onSelectFacility?: (facility: MapFacility) => void;
  /**
   * The tapped facility, handed back so its card can be THE SAME CARD the
   * layer menu and the facility picker open in.
   *
   * The app still owns the selection — it is the app that clears it, and the
   * app that knows who is signed in — but the card has to be rendered in here,
   * because `ui/MapPanel` is positioned inside the map's own box and takes its
   * place in the same one-card-at-a-time rule as the other two. A card floating
   * at the bottom of the WINDOW was a fourth shape in a fourth place.
   */
  selectedFacility?: MapFacility | null;
  onCloseFacility?: () => void;
  /** Whether there is somebody to attribute a note to. */
  isSignedIn?: boolean;
  /**
   * The app is looking for camping spots on public land right now.
   *
   * Said only while the public-land layer is ON, which is why this is a prop
   * rather than a pill the app floats itself: the layer's switch lives in
   * here. "Exploring public lands…" over a map with no public land drawn on it
   * is the app narrating work the camper did not ask to see, and it is the
   * common case — the layer is off by default.
   */
  isSearchingSites?: boolean;
  /** Fired after a note lands, so the layer redraws carrying it. */
  onFacilityNoteSaved?: () => void;
  /**
   * Bumped to force the facility layer to refetch.
   *
   * Same reason `beaconRefreshKey` exists: without it a camper adds a toilet,
   * watches the sheet say "added", and sees nothing appear until they pan far
   * enough to trip a reload. The pin was in the database the whole time.
   */
  facilityRefreshKey?: number;
}

/**
 * Where to centre the map so `at` sits in the middle of what a card has left.
 *
 * A card over the bottom of the screen does not make the map smaller — Leaflet
 * still thinks it owns the whole container — so the "centre" it flies to is
 * behind the card. Everything the camper opened the card to look at ends up
 * hidden by the card describing it.
 *
 * The fix is to move the centre DOWN by half of what is covered, which lifts
 * the point up by the same amount into the middle of the strip that is showing.
 * A floor keeps at least a band of map on screen, so a card dragged to full
 * height cannot shove the pin off the top.
 */
export const MapComponent: React.FC<MapComponentProps> = ({
  campsites, selectedCampsite, onSelectCampsite, center, zoom, userLocation, weather,
  coverage, route, useMetric, onOpenDirections, onClearDestination, onAddSpotHere, onAddFacilityHere,
  isOfflineMode, onOpenBottomSheet, onLocateUser,
  isLocating = false,
  destination, onDropDestination, onPinRefused, onSelectHazardReport,
  onSelectBeaconSpot, beaconRefreshKey = 0, bottomSheetPx = 0, topNotice = null,
  onOpenAuth,
  onSendBeaconAt, canBeacon = false, onExploreCentre,
  facilityKinds = NO_FACILITY_KINDS, onFacilityStateChange, onSelectFacility,
  facilityState = FACILITY_IDLE, onToggleFacilityKind, onClearFacilityKinds,
  selectedFacility = null, onCloseFacility, isSignedIn = false,
  onFacilityNoteSaved, isSearchingSites = false,
  facilityRefreshKey = 0
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  /** The HTML each marker's icon was last given, so a no-op swap is skipped. */
  const iconHtmlRef = useRef<Map<string, string>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  /** `mapRef.current` seen through `clusterView`; the cluster group's map. */
  const clusterViewRef = useRef<L.Map | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const underlayLayerRef = useRef<L.TileLayer | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const scoutLayerRef = useRef<L.LayerGroup | null>(null);
  const scoutRendererRef = useRef<L.Canvas | null>(null);
  const backroadLayerRef = useRef<L.LayerGroup | null>(null);
  const backroadRendererRef = useRef<L.Canvas | null>(null);
  /** The padded, grid-snapped box the drawn roads were fetched for. */
  const backroadBoxRef = useRef<BoundingBox | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  /** Alert badges affecting each pinned campsite, keyed by id. */
  const badgesByIdRef = useRef<Map<string, PointWarning[]>>(new Map());
  /**
   * The destination the camera has already closed in on.
   *
   * Compared by identity, so re-parking the pin as the panel is dragged
   * between snaps never re-runs the zoom.
   */
  const focusedDestRef = useRef<MapDestination | null>(null);
  /**
   * Where the camera was before it closed in on a spot.
   *
   * Tapping a pin zooms in; letting go of it puts the map back where the
   * camper had it. Without this the app kept every zoom it ever took on the
   * camper's behalf, so browsing four spots in a row left you looking at a
   * hundred metres of one clearing with no idea where it sat.
   */
  const preFocusViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null);
  /**
   * And where it was before a card slid up over the bottom of the screen.
   *
   * Separate from `preFocusViewRef` on purpose: a card can open and close
   * several times over one pin, and each of those has to give back the view it
   * borrowed without disturbing the wider one the pin borrowed first.
   */
  const preSheetViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null);
  /**
   * And where it was before a facility trip framed the pin next to a toilet.
   *
   * Tapping a POI chip fits the pin and the facility on screen together, which
   * necessarily pushes the pin off to one side. Closing that trip has to put
   * the pin back in the middle — it is still the open pin, and a camper who
   * tapped a POI is interested in exactly this spot, at exactly the zoom they
   * were just looking at it — so only the centring is undone, never the zoom
   * fitBounds chose.
   *
   * Just the pin it belongs to, not a view: moving straight to another pin
   * closes the trip too, and that pin is doing its own aiming — recentring
   * this one over the top of it is the two-restores-in-one-frame problem.
   */
  const preTripPinRef = useRef<{ lat: number; lon: number } | null>(null);
  /** Facilities near the selected spot, for the tappable chips. */
  const facilitiesRef = useRef<NearbyFacility[]>([]);
  /** Fires near the open point, read by the icon builders. */
  const nearbyFiresRef = useRef<Array<{ fire: ActiveFire; distanceKm: number }>>([]);
  /** The line and end marker drawn for the facility the camper tapped. */
  const facilityLayerRef = useRef<L.LayerGroup | null>(null);

  // What boundary data we already hold, so a pan inside it costs nothing.
  const loadedBoxRef = useRef<BoundingBox | null>(null);
  const loadedZoomRef = useRef<number>(0);
  const collectionRef = useRef<BoundaryCollection>(EMPTY_BOUNDARIES);
  const boundaryRendererRef = useRef<L.Canvas | null>(null);
  /**
   * The overview that ships with the app, parsed once.
   *
   * A ref rather than state on purpose: it is read inside the boundary effect
   * and must not be a dependency of it. Putting a few thousand parcels in
   * state would tear down and rebuild the whole Leaflet layer stack the moment
   * the file finished parsing.
   */
  const landOverlayRef = useRef<LandOverlay | null>(null);
  /**
   * THE ZOOMED-OUT MAP, HELD FOR THE WHOLE SESSION.
   *
   * One answer covering the entire coverage area, fetched once and then reused
   * at every zoom below BOUNDARY_MIN_ZOOM and at every pan. Holding it here is
   * what stops public land popping in and out while the map is moved — see the
   * long note in the boundary effect, and `OVERVIEW_BOX`.
   *
   * A ref, not state: it must not be a dependency of the boundary effect, or
   * arriving would tear down and rebuild the entire Leaflet layer stack.
   */
  const overviewCollectionRef = useRef<BoundaryCollection | null>(null);
  /**
   * The in-flight overview request, shared by every caller.
   *
   * Zooming out fires a move and a zoom event, the prefetch may already be
   * running, and all of them want the same continent. Without this they would
   * each start their own copy of a request the others are already waiting on.
   */
  const overviewInFlightRef = useRef<Promise<BoundaryCollection | null> | null>(null);
  /**
   * The slice of the bundled overview currently drawn, and what it was chosen
   * for. Rebuilt only when the view leaves the window or the zoom band changes
   * — see the overview branch of the boundary effect.
   */
  const overviewWindowRef = useRef<
    { box: BoundingBox; minSpan: number; collection: BoundaryCollection } | null
  >(null);
  /** Which tier is on screen, and at what settings — see `render`. */
  const loadedDetailRef = useRef<BoundaryDetail | null>(null);
  const renderSignatureRef = useRef<string>('');
  const renderedCollectionRef = useRef<BoundaryCollection | null>(null);
  /**
   * Content fingerprint of the parcels currently drawn.
   *
   * Separate from `renderedCollectionRef` because a refetch hands back a
   * different object holding the same land, and rebuilding the whole layer
   * for that is the redraw-on-pan the fingerprint exists to skip.
   */
  const renderedFingerprintRef = useRef<string | null>(null);
  const fillLayerRef = useRef<L.GeoJSON | null>(null);
  const haloLayerRef = useRef<L.LayerGroup | null>(null);
  const hazardLayerRef = useRef<L.LayerGroup | null>(null);
  const reportLayerRef = useRef<L.LayerGroup | null>(null);
  const beaconLayerRef = useRef<L.LayerGroup | null>(null);
  /**
   * The facility PINS from the chips under the search.
   *
   * Not to be confused with `facilityLayerRef` above, which is the single
   * route line drawn to one facility the camper tapped a chip for. Different
   * lifetimes, different panes, and conflating them would have the search
   * chips wipe the route line every time the map moved.
   */
  const facilityPinsLayerRef = useRef<L.LayerGroup | null>(null);
  /** State / province boundary lines. Cleared when `showAdmin1` is off. */
  const admin1LayerRef = useRef<L.LayerGroup | null>(null);
  /** Canvas the warning clouds are painted on. See CLOUD_BLUR_PX. */
  const warningCloudRendererRef = useRef<L.Renderer | null>(null);
  const destinationMarkerRef = useRef<L.Marker | null>(null);

  /**
   * Callbacks reached through refs, not through effect dependencies.
   *
   * The map click listener is bound once for the life of the map. If it
   * depended on the callback identity it would be torn down and rebound on
   * every render of App, and Leaflet would briefly have no click handler at
   * all in the middle of a tap.
   */
  const dropRef = useRef(onDropDestination);
  dropRef.current = onDropDestination;
  const pinRefusedRef = useRef(onPinRefused);
  pinRefusedRef.current = onPinRefused;
  const reportTapRef = useRef(onSelectHazardReport);
  reportTapRef.current = onSelectHazardReport;
  const beaconTapRef = useRef(onSelectBeaconSpot);
  beaconTapRef.current = onSelectBeaconSpot;
  const facilityTapRef = useRef(onSelectFacility);
  facilityTapRef.current = onSelectFacility;
  const facilityStateRef = useRef(onFacilityStateChange);
  facilityStateRef.current = onFacilityStateChange;
  const directionsRef = useRef(onOpenDirections);
  directionsRef.current = onOpenDirections;
  const clearDestinationRef = useRef(onClearDestination);
  clearDestinationRef.current = onClearDestination;
  const addSpotRef = useRef(onAddSpotHere);
  addSpotRef.current = onAddSpotHere;
  const addFacilityRef = useRef(onAddFacilityHere);
  addFacilityRef.current = onAddFacilityHere;
  const sendBeaconRef = useRef(onSendBeaconAt);
  sendBeaconRef.current = onSendBeaconAt;
  /* Read by the effect that grows the pin's row after it has been dropped,
     which must not be re-run just because connectivity flickered. */
  const exploreRef = useRef(onExploreCentre);
  exploreRef.current = onExploreCentre;
  const canBeaconRef = useRef(canBeacon);
  canBeaconRef.current = canBeacon;
  const bottomSheetRef = useRef(onOpenBottomSheet);
  bottomSheetRef.current = onOpenBottomSheet;
  const destinationRef = useRef(destination);
  destinationRef.current = destination;

  /** The drive to the open point, for the chips that show where it stops. */
  const routeRef = useRef(route);
  routeRef.current = route;

  /** The towers behind the signal estimate, for the chip's own tour. */
  const coverageRef = useRef(coverage);
  coverageRef.current = coverage;

  /** Weather, signal and land for the open point, as chips. */
  const conditions = React.useMemo(
    () => conditionDots(weather, coverage, destination?.land, route, useMetric),
    [weather, coverage, destination?.land, route, useMetric]
  );
  const conditionsRef = useRef(conditions);
  conditionsRef.current = conditions;

  const [activeTileLayer, setActiveTileLayer] = useState<MapTileLayer>('satellite');
  const [isMapReady, setIsMapReady] = useState(false);
  const [showCrownLand, setShowCrownLand] = useState(true);
  const [crownLandAvailable, setCrownLandAvailable] = useState(false);
  /**
   * WHICH OF THE STACK'S PANELS IS OPEN — one variable, so only one can be.
   *
   * Layers, search and the account used to be three separate pieces of state
   * opening three different shapes: a card docked at the bottom, a drawer
   * welded to the bottom edge, and a dropdown hanging off the button's own
   * corner. Two of them could be up at once, over each other, and none of
   * them looked like the others.
   *
   * They are one card in one place now (`ui/MapPanel`), and one variable
   * decides which. Opening any of them closes whatever was open, so there is
   * nothing left to overlap.
   */
  const [mapPanel, setMapPanel] = useState<'layers' | 'facilities' | 'account' | 'support' | null>(null);
  const closePanel = useCallback(() => setMapPanel(null), []);
  const togglePanel = useCallback(
    (panel: 'layers' | 'facilities' | 'account' | 'support') =>
      setMapPanel((open) => (open === panel ? null : panel)),
    []
  );

  /**
   * THE MAP NO LONGER HAS A SEARCH BOX, AND THAT IS THE POINT.
   *
   * There were two, and they were doing two different jobs under one symbol.
   * Typing a place name is a question about WHERE THE MAP SHOULD GO, and it
   * belongs in a field at the top of the app where a search field belongs —
   * which is where it now is, for phones as well as desktops, and it answers
   * for parts of the app as well as for towns. Pressing a symbol for showers
   * is a question about THE GROUND ALREADY ON SCREEN, and it never wanted a
   * keyboard at all.
   *
   * So the magnifier down here kept the second job: it opens the facility
   * symbols, named and in the colours their pins wear, in the same card the
   * layer menu and the account panel open in. See `FacilityPicker`.
   */

  /** Tile credits, off the map until asked for. See the button that sets it. */
  const [showCredits, setShowCredits] = useState(false);
  /**
   * Parcel fills and their fuzzy edges. OFF by default now.
   *
   * The polygons were the loudest thing on the map and the least precise —
   * a wash of colour across whole states, whose edges are a guess with a
   * range of hundreds of metres, standing in for a question a camper only
   * ever asks about ONE point: "can I sleep here?" That question is answered
   * properly by tapping, which names the land, its stay limit, its permit and
   * its fire ban for that spot. The data is still loaded either way — hiding
   * the layer only stops it being painted — so the answer on tap is identical
   * whether the fills are drawn or not.
   */
  const [showBoundaries, setShowBoundaries] = useState(false);
  /**
   * The backroads overlay. OFF by default.
   *
   * It is the densest thing the map can draw — a forest at zoom 13 is
   * hundreds of lines — and it is only meaningful once you are already
   * looking at somewhere in particular. Off is also the honest default for a
   * layer whose lines are volunteer-recorded rather than surveyed: it is
   * something a camper turns on knowing what it is, having just read the
   * caveat sitting under the switch.
   */
  const [showBackroads, setShowBackroads] = useState(false);

  /**
   * The roads this phone has driven. OFF by default, like the backroads.
   *
   * `scoutState` is what the layer can currently say — held so an empty map
   * can explain WHICH silence it is. "You have not driven anything here" and
   * "you are too far out to draw it" are different sentences, and neither of
   * them is "there are no roads".
   */
  const [showScout, setShowScout] = useState(false);
  const [scoutState, setScoutState] = useState<{
    tooFar: boolean; traces: number;
  }>({ tooFar: false, traces: 0 });

  /**
   * Bumped when a drive is stored or erased, so the layer redraws without
   * waiting for the camper to pan. Recording happens while the map sits
   * still — that is the whole point of Scout Mode — so "redraw on moveend"
   * alone would leave the road you just drove missing until you touched
   * the map.
   */
  const [scoutRefreshKey, setScoutRefreshKey] = useState(0);
  useEffect(() => onTracesChanged(() => setScoutRefreshKey((n) => n + 1)), []);
  /**
   * What the backroads layer is currently able to say. `scan` is the last
   * answer, `tooFar` means the map is zoomed out past where it asks at all,
   * and `loading` is a request in flight — three different silences that must
   * not all render as an empty map.
   */
  const [backroadState, setBackroadState] = useState<{
    loading: boolean; tooFar: boolean; scan: BackroadScan | null;
  }>({ loading: false, tooFar: false, scan: null });

  /**
   * THE ONE SENTENCE THE BACKROADS LAYER OWES THE CAMPER.
   *
   * Five different states all look identical on the map — an empty screen —
   * and four of them are NOT "there are no roads here":
   *
   *   zoomed out past where we ask · still asking · asked and could not
   *   reach OpenStreetMap · asked and got more than we can draw · asked and
   *   OSM genuinely has nothing recorded.
   *
   * The last one is still not "there are no roads out there". It is "nobody
   * has mapped one", which is the commonest state of all in the backcountry
   * and the single easiest thing for a map to lie about by staying quiet.
   */
  const backroadNotice = useMemo((): {
    tone: 'quiet' | 'amber' | 'violet'; text: string; spinner?: boolean;
  } | null => {
    if (!showBackroads) return null;

    if (backroadState.tooFar) {
      return { tone: 'quiet', text: 'Backroads draw once you zoom in closer.' };
    }
    // Only while there is nothing on screen yet — a pan that is refreshing
    // roads already drawn should not flash a spinner over them.
    if (backroadState.loading && !backroadState.scan) {
      return { tone: 'quiet', text: 'Looking for the little roads…', spinner: true };
    }

    const scan = backroadState.scan;
    if (!scan) return null;

    if (!scan.ok) {
      return {
        tone: 'amber',
        text: 'Couldn’t load the backroads here — which is not the same as there being none.'
      };
    }
    if (scan.truncated) {
      return {
        tone: 'violet',
        text: 'More little roads here than the map can draw — zoom in for the rest.'
      };
    }
    if (!scan.roads.length) {
      return {
        tone: 'amber',
        text: 'No backroads mapped here. Nobody has recorded one, which is not the same as there not being one.'
      };
    }
    return null;
  }, [showBackroads, backroadState]);

  /**
   * THE FACILITY LAYER, SAYING WHICH OF ITS SILENCES THIS ONE IS.
   *
   * This sentence used to sit under the row of chips. The chips are gone —
   * the symbols fan out of the magnifier now and fold away the moment one is
   * pressed — so the sentence moved to where the rest of the map's statements
   * live, and it stays on screen for as long as the layer is on.
   *
   * The load-bearing case is `count === 0`: NOBODY HAS MAPPED ONE HERE, never
   * "there are none". OpenStreetMap is volunteer-surveyed and the emptiest
   * country is the least surveyed, which is exactly where a camper is standing
   * when they need a tap. Somebody who reads "no water" and drives on with
   * empty tanks has been lied to by a phrasing choice.
   */
  const facilityNotice = useMemo((): {
    tone: 'quiet' | 'amber' | 'violet'; text: string; spinner?: boolean;
  } | null => {
    if (facilityKinds.length === 0) return null;

    // "Toilets", or "toilets and water", or "3 kinds" — named while it is
    // short enough to read, counted once it is not.
    const names = facilityKinds.map((kind) => FACILITY[kind].plural.toLowerCase());
    const subject = names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.length} kinds`;

    switch (facilityState.status) {
      case 'zoomed-out':
        return { tone: 'quiet', text: `Zoom in to look for ${subject} around here.` };
      case 'loading':
        return { tone: 'quiet', text: `Looking for ${subject}…`, spinner: true };
      case 'failed':
        return { tone: 'amber', text: `Couldn't check for ${subject} just now.` };
      case 'done':
        if (facilityState.count === 0) {
          return {
            tone: 'amber',
            text: `Nobody has mapped ${subject} in this view. That is not the same as there being none.`
          };
        }
        return facilityState.truncated
          ? {
              tone: 'violet',
              text: `${facilityState.count} on the map — there are more here than fit in one look.`
            }
          : {
              tone: 'quiet',
              text: `${facilityState.count} on the map. Tap one to see where it came from.`
            };
      default:
        return null;
    }
  }, [facilityKinds, facilityState]);
  /**
   * Weather warning overlay (merged areas + event pins). ON by default because
   * warnings are the safety feature, and a camper who has the layer off
   * still gets a heads-up on the destination sheet and campsite bottom
   * sheet (the per-pin hazard panel reads from `hazards` state, not from
   * this toggle, so a hidden layer does not silence the pin card).
   */
  const [showWarnings, setShowWarnings] = useState(true);
  /**
   * State / province boundary lines. ON by default.
   *
   * They used to start off, on the reasoning that a state line is context
   * rather than a highlight. Wrong call for this app: where you are is
   * the first question a dispersed-camping map has to answer, and camping
   * rules, permits and fire bans all change at exactly these lines. A
   * thin line the user can switch off costs far less than a map that
   * makes them guess which state they're looking at.
   */
  const [showAdmin1, setShowAdmin1] = useState(true);
  const [boundaries, setBoundaries] = useState<BoundaryCollection>(EMPTY_BOUNDARIES);
  const [zoomTooFar, setZoomTooFar] = useState(false);
  /** The map's own current zoom, kept live across gestures. The `zoom` prop
   * only changes when App flies somewhere (search, locate, pin focus), so it
   * goes stale the moment the user pans or pinches; UI that must react to the
   * real zoom reads this instead. Synced where the boundary effect reads
   * `map.getZoom()`. */
  const [liveZoom, setLiveZoom] = useState(zoom);
  /**
   * The wide view asked for boundaries and did not get an answer it could
   * trust — so the map is showing whatever it had, which may be from the zoom
   * above or from a moment ago. Silence here is what made this feel like a
   * bug: the boundaries went, nothing said why, and the honest reading of an
   * empty map is "there is no public land here".
   */
  const [wideViewFailed, setWideViewFailed] = useState(false);
  /**
   * The province under the middle of the screen is one this app cannot draw
   * the Crown land of — its name, and why, in a camper's words.
   *
   * Until now this caveat existed only on a pin's card, which means it was
   * shown to somebody who had already found a spot and never to the person
   * staring at an empty province wondering where the camping went. That is
   * backwards: Newfoundland and Labrador is about 95% Crown land and draws
   * completely blank, and a blank map with nothing written on it is the app
   * saying "there is nowhere to camp here" — the one sentence this codebase
   * is not allowed to say. Now the map says it out loud, unprompted, over
   * the ground it applies to.
   *
   * Null for a fully mapped region, which is every US state and Alberta,
   * New Brunswick and Nova Scotia.
   */
  const [centreGap, setCentreGap] = useState<{ name: string; gap: string; isoCode: string } | null>(null);
  const [hazards, setHazards] = useState<HazardAlert[]>([]);
  /** The same alerts, for the chip tours, which run outside React's render. */
  const hazardsRef = useRef<HazardAlert[]>([]);
  hazardsRef.current = hazards;
  /**
   * Which side of the border went unchecked, in words, or null when both
   * agencies answered.
   *
   * A warning layer with a hole in it looks exactly like a warning layer over
   * quiet ground, and there is no way for a camper to tell them apart by
   * looking. This is the difference, printed on the map. See `alertGapNote`.
   */
  const [alertGap, setAlertGap] = useState<string | null>(null);
  /**
   * Toilets, taps and fuel within `FACILITY_RADIUS_KM` of the selected spot.
   *
   * Only ever fetched for the pin that is open, because it is an Overpass
   * query per spot and most spots are never opened.
   */
  const [facilities, setFacilities] = useState<NearbyFacility[]>([]);
  /**
   * True for exactly as long as the open pin's facility/road lookup below is
   * in flight — drives the "more is coming" placeholder chip. See
   * `setChipsLoading` in mapPinRendering.ts.
   */
  const [facilitiesLoading, setFacilitiesLoading] = useState(false);
  /** The facility whose chip was tapped: what it is, and how you'd get there. */
  const [facilityTrip, setFacilityTrip] = useState<{
    facility: NearbyFacility;
    route: RouteResult | null;
    loading: boolean;
  } | null>(null);
  /**
   * Fires burning within `FIRE_ALERT_RADIUS_KM` of the point being read.
   *
   * Looked up per open point rather than per viewport — see the effect below
   * and the note where the map's flame layer used to be. Empty means "not
   * asked, or nothing came back", which is never rendered as "no fires".
   */
  const [nearbyFires, setNearbyFires] = useState<
    Array<{ fire: ActiveFire; distanceKm: number }>
  >([]);

  /** The card the "i" under a dropped pin opens, and how tall it currently is. */
  const [pointCardOpen, setPointCardOpen] = useState(false);
  const [pointCardPx, setPointCardPx] = useState(0);
  /**
   * How much of the map is under a card right now, whoever is rendering it.
   *
   * Never both at once in practice — bare ground gets the point card, a
   * submitted spot gets App's campsite drawer — so the larger of the two is
   * simply whichever one is open.
   */
  const overlayPx = Math.max(bottomSheetPx, pointCardPx);
  /** The same number, for the camera effects that read it outside a render. */
  /*
   * The account panel goes when its button does.
   *
   * The button steps out of the stack while a card is open over the map (see
   * the note on it below), and a panel still sitting there with no control to
   * match is the app half-forgetting what it was doing.
   */
  useEffect(() => {
    if (overlayPx > 0) setMapPanel((open) => (open === 'account' ? null : open));
  }, [overlayPx]);

  const overlayPxRef = useRef(0);
  overlayPxRef.current = overlayPx;

  /**
   * The one point the app is currently answering questions about.
   *
   * A tapped campsite and a dropped pin are the same question — "what is it
   * like here?" — so the facility and fire lookups hang off this rather than
   * off `selectedCampsite`. That is what lets a pin on bare ground carry the
   * same row of dots a submitted spot does.
   */
  const readLat = destination?.latitude ?? null;
  const readLon = destination?.longitude ?? null;
  /** The same point, for the callbacks that run outside React's render. */
  const readPointRef = useRef<{ lat: number; lon: number } | null>(null);
  readPointRef.current =
    readLat === null || readLon === null ? null : { lat: readLat, lon: readLon };
  /**
   * What the point is: public land or not, an existing pin or bare ground.
   * Read inside the facility lookup, which is keyed on the coordinates alone
   * so it does not re-run when an unrelated part of the destination changes.
   */
  const landRef = useRef(destination?.land);
  landRef.current = destination?.land;
  const hasCampsiteRef = useRef(Boolean(destination?.campsite));
  hasCampsiteRef.current = Boolean(destination?.campsite);

  /* ------------------------------------------------------------------ */
  /* Map lifecycle                                                       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center,
      zoom,
      zoomControl: false,
      attributionControl: false,
      // The user pans inside the frame and cannot drag out of it.
      // Viscosity 1.0 makes the edge hard, so a drag past it rubber-bands
      // straight back rather than sliding off into ocean the app has
      // nothing to say about.
      //
      // The minimum zoom is NOT set here. It depends on the container
      // size, which isn't trustworthy yet, so `applyMinZoom` below owns
      // it — one place, not two.
      worldCopyJump: false,
      maxBounds: PAN_BOUNDS,
      maxBoundsViscosity: 1.0,
      /**
       * Half-level zoom granularity, so the frame can be met exactly.
       *
       * The zoom-out floor computed in `applyMinZoom` is fractional —
       * whatever level makes the frame meet the edges of this particular
       * screen. Leaflet rounds a requested zoom to `zoomSnap` BEFORE
       * clamping it to the minimum, so at the default of 1 that floor is
       * only reachable when rounding happens to land below it. On a
       * phone it rounded 2.65 up to 3 and the frame overshot the screen;
       * on a desktop it rounded 4.24 down and the frame fit. Same code,
       * two different results, for no reason the user could see.
       *
       * At 0.5 the rounding lands below the floor and the clamp wins, so
       * both end up exactly at the fit. Zoom buttons step by whole
       * levels from a whole level, so ordinary zooming still sits on
       * integers where the tiles are pixel-sharp; only the fully
       * zoomed-out frame is fractional.
       */
      zoomSnap: 0.5
    });
    /**
     * NO LEAFLET CONTROLS. Zoom and attribution are React, below.
     *
     * Leaflet renders its controls inside the map container, and in navigation
     * mode that container is rotated to point the way you're driving. The
     * controls would rotate with it — a zoom button at 40° in the wrong corner,
     * attribution reading up the side of the screen. Rendering them as siblings
     * of the rotating element keeps every piece of chrome upright and where the
     * user left it.
     *
     * The attribution is still on screen at all times; Esri and OpenStreetMap
     * both require that, and the React version below is not dismissible.
     */

    /**
     * Stop zooming out once the frame fills the screen.
     *
     * THIS IS THE LINE THAT DECIDES HOW FAR OUT THE MAP GOES, and it
     * previously undid the setting above it. The old version solved for
     * the zoom at which the WHOLE WORLD filled the viewport width, which
     * on a phone works out to zoom 1 — so the map opened on the entire
     * planet, South America and all, with a `maxBounds` far too small to
     * constrain anything at that scale. Whatever minimum was passed to
     * the constructor got overwritten a few lines later.
     *
     * The right question is how far out we can go before the frame stops
     * FILLING THE SCREEN TOP TO BOTTOM. Zooming out past that only ever
     * trades land for grey — either the parts of the world this app has
     * nothing to say about, or the matte where there is no world at all.
     *
     * Recomputed on resize, so rotating a phone or dragging a window
     * narrower can't strand the user below the new minimum.
     */
    const applyMinZoom = () => {
      const size = map.getSize();
      if (!size.x || !size.y) return;

      // Frame size in projected pixels at zoom 0, so the ratio to the
      // viewport gives the scale that just fits — and log2 of a scale is
      // a zoom level.
      const nw = map.project(PAN_BOUNDS.getNorthWest(), 0);
      const se = map.project(PAN_BOUNDS.getSouthEast(), 0);
      const frameWidth = Math.abs(se.x - nw.x);
      const frameHeight = Math.abs(se.y - nw.y);
      if (!frameWidth || !frameHeight) return;

      /**
       * HEIGHT ONLY. The frame meets the TOP and BOTTOM of the screen at
       * full zoom-out, and the east and west of it run off the sides.
       *
       * Fitting BOTH dimensions is the obvious thing and it is wrong on a
       * phone. The frame is half again as wide as it is tall, a phone held
       * upright is twice as tall as it is wide, so the width won and the
       * continent landed as a thin strip across the middle of the screen
       * with a thick field of grey above it and another below — every pin,
       * coastline and coverage line too small to read, and two-thirds of
       * the screen spent on nothing.
       *
       * Solving for the height instead spends the whole screen on land.
       * Less of the continent is visible at once and the rest is reached
       * by dragging sideways, which is the trade worth making. On a wide
       * screen nothing changes: the height was already the binding
       * dimension there, so this is the same number the fit gave.
       *
       * Fractional on purpose — `getBoundsZoom` would floor it to a whole
       * level, which halves the scale and undoes the point. Computed
       * rather than asked for, too, because `getBoundsZoom` clamps its
       * answer to the minimum currently in force: once this had been set,
       * widening the window could never lower it again and the map would
       * stay stuck at the phone-sized minimum.
       */
      const next = Math.log2(size.y / frameHeight);

      map.setMinZoom(next);

      /**
       * At the floor the VERTICAL position is completely determined —
       * the frame's top and bottom are the screen's — so settle it here.
       * Leaflet gets there on its own most of the time, but not after a
       * resize: `invalidateSize` shifts the view without re-running the
       * bounds clamp, so rotating a phone or the address bar sliding away
       * could leave the continent sitting high or low with the grey
       * gathered on one side of it.
       *
       * The east-west position is NOT determined, and must not be reset.
       * The whole point of the floor above is that the frame is wider than
       * the screen, so where the camper has dragged to is real information
       * — and the address bar alone fires this several times a scroll.
       * Snapping the longitude back to the middle of the continent every
       * time would yank the map out from under them. Only the y moves;
       * Leaflet's own `maxBounds` clamp keeps the x inside the frame, and
       * centres it on a screen wide enough that it fits.
       *
       * The vertical middle is measured in PROJECTED space, not by
       * averaging the corner latitudes. Mercator stretches the north, so
       * the halfway latitude and the halfway pixel are two different
       * places — about four degrees apart over a frame this tall, which is
       * a visibly off-centre map.
       */
      if (map.getZoom() <= next + 1e-9) {
        const frameNW = map.project(PAN_BOUNDS.getNorthWest(), next);
        const frameSE = map.project(PAN_BOUNDS.getSouthEast(), next);
        const middle = map.unproject(
          L.point(map.project(map.getCenter(), next).x, (frameNW.y + frameSE.y) / 2),
          next
        );
        map.setView(middle, next, { animate: false });
      }
    };
    applyMinZoom();
    map.on('resize', applyMinZoom);

    mapRef.current = map;
    clusterViewRef.current = clusterView(map);
    setIsMapReady(true);

    /**
     * Pull the two bundled map files down now, while the user is still
     * getting their bearings, so neither ever blocks an interaction.
     * The land mask has to be resident before the first tap — the pin
     * check reads it synchronously and treats "not loaded yet" as
     * "allow the pin", so a slow download would quietly let a few
     * ocean pins through rather than making anyone wait.
     */
    primeLandMask();
    primeAdmin1();

    // The container is often still being laid out on first paint.
    const timer = setTimeout(() => {
      try {
        map.invalidateSize();
        // Size is only trustworthy after layout settles, so recompute here too.
        applyMinZoom();
      } catch { /* not attached yet */ }
    }, 200);

    /**
     * Watch the container itself, not the window.
     *
     * Leaflet caches the map's pixel size and only re-measures on a window
     * resize. On a phone the container changes size without the window ever
     * resizing — the address bar slides away, the keyboard opens, the device
     * rotates — and a Leaflet holding a stale size draws its tiles at an
     * offset from where the map actually is, which is exactly the "map is
     * sliding off the screen" symptom.
     */
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Coalesce to one measurement per frame; a resize fires in bursts.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          map.invalidateSize({ animate: false });
          applyMinZoom();
        } catch { /* detached */ }
      });
    });
    observer.observe(containerRef.current);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      map.off('resize', applyMinZoom);
      try { map.remove(); } catch { /* already gone */ }
      mapRef.current = null;
      clusterViewRef.current = null;
      markersRef.current.clear();
    };
    // Mount only: centre and zoom are driven by their own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ */
  /* Base raster layer                                                   */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (tileLayerRef.current) {
      try { map.removeLayer(tileLayerRef.current); } catch { /* already removed */ }
    }

    let layer: L.TileLayer;

    if (isOfflineMode) {
      // Serve previously downloaded tiles from IndexedDB, and render a
      // placeholder on a miss. Object URLs are revoked once the browser has
      // decoded the image — leaking one per tile fills memory on a long pan.
      const OfflineTileLayer = (L.TileLayer as any).extend({
        createTile(coords: { z: number; x: number; y: number }, done: Function) {
          const tile = document.createElement('img');
          tile.alt = '';

          const release = () => {
            if (tile.src.startsWith('blob:')) URL.revokeObjectURL(tile.src);
          };
          tile.addEventListener('load', release, { once: true });
          tile.addEventListener('error', release, { once: true });

          getCachedTile(coords.z, coords.x, coords.y)
            .then((objectUrl) => { tile.src = objectUrl ?? TRANSPARENT_PIXEL; done(null, tile); })
            .catch(() => { tile.src = TRANSPARENT_PIXEL; done(null, tile); });

          return tile;
        }
      });
      // noWrap + bounds: draw the frame exactly once, and nothing outside it.
      // See TILE_BOUNDS.
      layer = new OfflineTileLayer('', {
        ...TILE_PERFORMANCE,
        maxZoom: 19,
        noWrap: true,
        bounds: TILE_BOUNDS,
        attribution: 'Offline tile cache'
      });
    } else {
      const config = TILE_URLS[activeTileLayer];
      layer = L.tileLayer(config.url, {
        ...TILE_PERFORMANCE,
        maxZoom: 19,
        noWrap: true,
        bounds: TILE_BOUNDS,
        attribution: config.attribution
      });
    }

    layer.addTo(map);
    tileLayerRef.current = layer;

    /**
     * A permanently-loaded, low-resolution copy of the same map, underneath.
     *
     * Panning into somewhere new always means waiting on tiles, and until they
     * arrive the container's background colour shows through — the blank blue
     * at the edges of a scroll. This layer is drawn from zoom 8 and stretched,
     * so it is blurry, but a whole region is only a handful of images: they
     * arrive almost immediately, stay in the browser cache, and mean there is
     * always terrain under the sharp tiles rather than nothing.
     *
     * Skipped offline, where the point is to make missing tiles obvious rather
     * than paper over them with imagery we don't have.
     */
    if (!isOfflineMode) {
      if (!map.getPane('underlayPane')) {
        map.createPane('underlayPane');
        const pane = map.getPane('underlayPane');
        // Below Leaflet's own tile pane, which sits at 200.
        if (pane) { pane.style.zIndex = '150'; pane.style.pointerEvents = 'none'; }
      }

      const config = TILE_URLS[activeTileLayer];
      underlayLayerRef.current = L.tileLayer(config.url, {
        pane: 'underlayPane',
        // Stop requesting past this level; Leaflet upscales what it has.
        maxNativeZoom: UNDERLAY_NATIVE_ZOOM,
        maxZoom: 19,
        noWrap: true,
        bounds: TILE_BOUNDS,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 2,
        // The sharp layer above carries the attribution for both.
        attribution: ''
      }).addTo(map);
    }

    return () => {
      if (!underlayLayerRef.current) return;
      try { map.removeLayer(underlayLayerRef.current); } catch { /* detached */ }
      underlayLayerRef.current = null;
    };
  }, [activeTileLayer, isMapReady, isOfflineMode]);

  /* ------------------------------------------------------------------ */
  /* Optional Crown Land vector tiles (needs your own Mapbox token)      */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !showCrownLand) return;

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    const tileset = import.meta.env.VITE_CROWN_LAND_TILESET;
    const styleLayer = import.meta.env.VITE_CROWN_LAND_LAYER || 'on_general_use_areas';
    if (!token || !tileset) { setCrownLandAvailable(false); return; }

    if (!map.getPane('crownLandPane')) {
      map.createPane('crownLandPane');
      const pane = map.getPane('crownLandPane');
      if (pane) pane.style.zIndex = '400';
    }

    let vectorLayer: L.Layer | null = null;
    try {
      // leaflet.vectorgrid ships no types, hence the cast.
      vectorLayer = (L as any).vectorGrid.protobuf(
        `https://a.tiles.mapbox.com/v4/${tileset}/{z}/{x}/{y}.vector.pbf?access_token=${token}`,
        {
          pane: 'crownLandPane',
          interactive: false,
          vectorTileLayerStyles: {
            [styleLayer]: {
              fill: true, fillColor: '#10B981', fillOpacity: 0.25,
              color: '#059669', weight: 1
            }
          }
        }
      );
      vectorLayer?.addTo(map);
      setCrownLandAvailable(true);
    } catch {
      setCrownLandAvailable(false);
    }

    return () => {
      if (!vectorLayer) return;
      try { map.removeLayer(vectorLayer); } catch { /* already detached */ }
    };
  }, [isMapReady, showCrownLand]);

  /* ------------------------------------------------------------------ */
  /* Grey mask outside the supported coverage area                       */
  /* ------------------------------------------------------------------ */
  /**
   * Everything this app has no data for is greyed out: Mexico, the
   * oceans, and the three northern territories.
   *
   * This is not decoration, and it is not optional. It is how the map
   * tells the truth about its own limits. Without it the satellite
   * imagery runs edge to edge and northern Mexico looks exactly like
   * southern Arizona — same terrain, same detail, no pins — and an empty
   * map that looks in-bounds reads as "we checked, there's nothing
   * here". That is the one claim this app must never make by accident.
   * Greying it says "we didn't look" instead.
   *
   * Drawn once on a canvas with generous padding rather than as an SVG
   * path: the shape never changes, so rasterising it once and sliding
   * the surface around beats re-projecting a world-sized polygon on
   * every pan and zoom, and it kills the flicker along the grey edge.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    /**
     * ABOVE EVERY DATA LAYER, at 645.
     *
     * It used to sit at 450 — under the warning areas, the fire
     * perimeters, the camper reports and the pins. Anything whose shape
     * crossed the coverage line therefore carried on drawing at full
     * strength over the grey: a heat area reaching down into Mexico, a
     * fire perimeter running off into the Pacific, a storm icon out over
     * open water. The mask said "we didn't look here" and the layer on
     * top of it said "here's what's here".
     *
     * At 645 the grey covers them all, so the coverage line is the same
     * line for every layer on the map. Still below Leaflet's tooltip
     * (650) and popup (700) panes, so tapping something near the edge
     * still opens a readable card, and still pointer-events:none, so it
     * never swallows a tap.
     */
    if (!map.getPane('coveragePane')) {
      map.createPane('coveragePane');
      const pane = map.getPane('coveragePane');
      if (pane) { pane.style.zIndex = '645'; pane.style.pointerEvents = 'none'; }
    }

    const toLatLng = (ring: [number, number][]) =>
      ring.map(([lon, lat]) => [lat, lon] as [number, number]);

    const renderer = L.canvas({ pane: 'coveragePane', padding: 1 });

    /**
     * The matte: everything outside the viewing frame, solid.
     *
     * Tiles stop at the frame (see TILE_BOUNDS), so on a screen that
     * isn't the frame's shape there is a band down two sides — or
     * across the top and bottom, on a phone held upright — with no
     * imagery behind it. This fills that band with the same flat
     * colour as the map container, so it reads as a deliberate matte
     * around the map rather than tiles that failed to arrive.
     *
     * Drawn before the grey mask so the mask's 72% grey lands on top
     * of it; both are the same colour, so the result out there is flat.
     */
    const matte = L.polygon([toLatLng(WORLD_RING), toLatLng(VIEW_RING)], {
      pane: 'coveragePane', renderer, interactive: false, stroke: false,
      fillColor: '#0F172A', fillOpacity: 1
    } as L.PolylineOptions).addTo(map);

    // A world-sized polygon with the supported region punched out of it.
    const mask = L.polygon([toLatLng(WORLD_RING), toLatLng(COVERAGE_OUTLINE)], {
      pane: 'coveragePane', renderer, interactive: false, stroke: true,
      color: '#64748B', weight: 1, fillColor: '#0F172A', fillOpacity: 0.72
    } as L.PolylineOptions).addTo(map);

    return () => {
      try { map.removeLayer(mask); } catch { /* detached */ }
      try { map.removeLayer(matte); } catch { /* detached */ }
      try { map.removeLayer(renderer); } catch { /* never attached */ }
    };
  }, [isMapReady]);

  /* ------------------------------------------------------------------ */
  /* The bundled overview                                                */
  /* ------------------------------------------------------------------ */
  /**
   * Parse the shipped overview once, then nudge the boundary effect.
   *
   * The nudge is a synthetic `moveend` rather than a state change wired into
   * the boundary effect's dependencies. Adding a dependency would run that
   * effect's cleanup — which strips the boundary layer off the map — so the
   * one thing that arrives to make the map faster would have made it flash
   * empty first.
   */
  useEffect(() => {
    let cancelled = false;

    loadLandOverlay().then((overlay) => {
      if (cancelled || !overlay) return;
      landOverlayRef.current = overlay;
      const map = mapRef.current;
      if (map && isMapReady) {
        try { map.fire('moveend'); } catch { /* map torn down mid-parse */ }
      }
    });

    return () => { cancelled = true; };
  }, [isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Public land boundaries                                              */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clearLayer = () => {
      if (!boundaryLayerRef.current) return;
      try { map.removeLayer(boundaryLayerRef.current); } catch { /* detached */ }
      boundaryLayerRef.current = null;
      fillLayerRef.current = null;
      haloLayerRef.current = null;
      renderSignatureRef.current = '';
      renderedCollectionRef.current = null;
      renderedFingerprintRef.current = null;
    };

    const forget = () => {
      loadedBoxRef.current = null;
      loadedDetailRef.current = null;
      collectionRef.current = EMPTY_BOUNDARIES;
    };

    /**
     * Fetch the one wide-zoom answer, at most once.
     *
     * Every caller shares the same promise, and once it resolves with something
     * worth keeping it is held for the session — so this does real work exactly
     * once, and every later zoom-out is a ref read.
     *
     * A failed attempt is NOT held. It clears the slot so the next gesture
     * tries again, because the alternative is one bad moment on a car park
     * connection deciding there is no public land for the rest of the session.
     *
     * Deliberately given no abort signal. Every other request here is tied to a
     * viewport and is rightly cancelled when the viewport moves; this one is
     * tied to the continent, and cancelling it because somebody panned would
     * mean it never finishes on a map that is being used.
     */
    const loadOverview = (): Promise<BoundaryCollection | null> => {
      if (overviewCollectionRef.current) {
        return Promise.resolve(overviewCollectionRef.current);
      }
      if (overviewInFlightRef.current) return overviewInFlightRef.current;

      const attempt = fetchBoundaries(OVERVIEW_BOX, undefined, 'overview')
        .then((collection) => {
          overviewInFlightRef.current = null;

          // Superseded, failed, or an empty we cannot stand behind: keep
          // nothing, so the next gesture asks again.
          if (!collection) return null;
          if (collection.features.length === 0) return null;

          overviewCollectionRef.current = collection;
          return collection;
        })
        .catch(() => {
          overviewInFlightRef.current = null;
          return null;
        });

      overviewInFlightRef.current = attempt;
      return attempt;
    };

    // Offline is the only reason to stop LOADING. `showBoundaries` decides
    // whether the parcels are painted, not whether they are known: tapping a
    // point has to name the land it is in whether or not it is drawn.
    if (isOfflineMode) {
      clearLayer();
      forget();
      setBoundaries(EMPTY_BOUNDARIES);
      setZoomTooFar(false);
      setWideViewFailed(false);
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let requestId = 0;
    // The tier ('overview' | 'mid' | 'full') currently on the canvas. A change
    // in this value is a STEP on the zoom ladder, and steps get the fade.
    let lastTier: BoundaryDetail | null = null;
    // Monotonic token so a newer fade supersedes an older one mid-flight
    // (rapid tier flipping never double-blooms).
    let fadeSeq = 0;

    /**
     * Boundaries draw to a canvas, not to SVG.
     *
     * A viewport over the Rockies can hold several hundred polygons, each with
     * an uncertainty band on top. As SVG that is thousands of DOM nodes the
     * browser has to lay out and repaint; on canvas it is one element the GPU
     * moves as a unit while you pan.
     */
    const boundaryPane = (): HTMLElement | undefined => {
      if (!map.getPane('boundariesPane')) {
        map.createPane('boundariesPane');
        const created = map.getPane('boundariesPane');
        if (created) created.style.zIndex = '390';
      }
      return map.getPane('boundariesPane');
    };

    // One canvas for the life of the effect. Leaflet registers a renderer as a
    // map layer the first time a path uses it, so minting a new one per redraw
    // would stack up an orphaned canvas every time the map moved.
    const boundaryRenderer = (): L.Canvas => {
      if (!boundaryRendererRef.current) {
        boundaryPane();
        boundaryRendererRef.current = L.canvas({ pane: 'boundariesPane', padding: 0.3 });
      }
      return boundaryRendererRef.current;
    };

    /**
     * THE PARCELS NO LONGER OPEN A POPUP, AND THAT IS THE POINT.
     *
     * Tapping the map now drops a destination pin — which has to work over
     * public land above all, since public land is where the camping is. A
     * parcel that swallowed the tap to open its own popup made the feature
     * useless over exactly the ground the app exists for.
     *
     * Nothing was lost. Everything that popup said — the land's name, the stay
     * limit, the permit, the fire ban, the "approximate boundary, not
     * permission to camp" line — is now in the destination sheet, which reads
     * better, is reachable by keyboard, and sits beside the weather and signal
     * for the same point.
     *
     * `interactive: false` below is what lets the tap through to the map. The
     * canvas renderer hit-tests every interactive path it holds; with several
     * hundred parcels on screen, opting out is also measurably cheaper.
     */

    /**
     * Style for one parcel's fill and outline at a given zoom.
     *
     * Deliberately more contrast than it had. The old fill sat at 0.2 opacity
     * behind an outline drawn at half opacity, and over satellite imagery —
     * which is where this app spends its life — that was close to invisible in
     * daylight on a phone. It is now a brighter stroke over a stronger fill.
     * The edges say the same thing they always did; you can just see them.
     */
    // Below this many pixels on its short side, a parcel is a razor-thin sliver
    // and is not drawn at all. Slightly higher in the overview, where nothing
    // that small is legible anyway.
    const SLIVER_PX = 2.5;

    const parcelStyle = (feature: any, centreLat: number, currentZoom: number, overview: boolean) => {
      // Grouped by whether you can camp, not by which agency holds the title
      // or how confident the dataset is. See BOUNDARY_GROUP_STYLES.
      const style = BOUNDARY_GROUP_STYLES[boundaryGroupOf(feature?.properties)];

      if (overview) {
        // Hairline. At this zoom the band would be sub-pixel anyway, and a
        // heavy outline turns a continent into a solid mat of colour.
        return {
          color: style.color,
          fillColor: style.fillColor,
          fillOpacity: style.fillOpacity * 0.7,
          weight: 0.6,
          opacity: 0.85
        };
      }

      return {
        color: style.color,
        fillColor: style.fillColor,
        fillOpacity: style.fillOpacity,
        // No per-parcel outline, ever. The dissolved-boundary layer draws the
        // group's edge, so abutting same-category parcels read as ONE shape
        // instead of a mesh of internal lines. A visible fill also means a
        // parcel never silently vanishes when its edges are all shared.
        weight: 0,
        opacity: 0.8
      };
    };

    /* ---- Fuzzy edge rendering -----------------------------------------
     * We never draw a crisp boundary line. Each polygon gets a soft fill plus
     * a stack of translucent strokes whose total width equals the dataset's
     * real positional uncertainty, converted from metres to pixels at the
     * current zoom. A hard line would claim a precision none of these sources
     * have, and the failure mode is somebody parking on private land.
     *
     * The strokes are batched: every polygon that shares an edge accuracy and
     * a confidence tier shares the same band geometry, so they go into one
     * layer per ring instead of one layer per ring per polygon. That is the
     * difference between a couple of dozen layers and several thousand.
     */
    const buildHalo = (
      collection: BoundaryCollection,
      centreLat: number,
      currentZoom: number,
      minDim: (g: unknown) => number,
      /** How far apart two parcels may be and still merge — see `mergeSnap`. */
      snap: number
    ): { group: L.LayerGroup; widest: number } => {
      const rings = ringBudget(collection.features.length);
      const renderer = boundaryRenderer();

      // Every parcel is grouped by dissolveKey — same organisation, usage and
      // expectations — so parcels that share those AND share an edge collapse
      // into one shape. Nothing is skipped here: a group always gets a drawn
      // outline, so no parcel disappears at any zoom.
      const bands = new Map<string, { accuracy: EdgeAccuracy; color: string; features: BoundaryFeature[] }>();
      collection.features.forEach((feature) => {
        // A razor-thin sliver is narrower than a couple of pixels on its short
        // side. Drop it — outline and all — so leftover hairline splinters from
        // the source data don't draw. Real parcels are wide on both axes.
        if (minDim(feature.geometry) < SLIVER_PX) return;
        const accuracy: EdgeAccuracy = feature?.properties?._edgeAccuracy ?? 'administrative';
        const style = BOUNDARY_GROUP_STYLES[boundaryGroupOf(feature?.properties)];
        const key = dissolveKey(feature?.properties);
        const existing = bands.get(key);
        if (existing) existing.features.push(feature);
        else bands.set(key, { accuracy, color: style.color, features: [feature] });
      });

      const group = L.layerGroup([], { pane: 'boundariesPane' });
      let widest = 0;

      bands.forEach(({ accuracy, color, features }) => {
        // Drop the seams shared by two parcels in the same group, so abutting
        // Crown/BLM/PLUZ land draws as one outline instead of a web of internal
        // lines. What survives is the true outer edge of the merged shape.
        // The snap merges same-type parcels split only by a vertex mismatch:
        // rasterised vector tiles are routinely off by 30-80 m at a shared
        // edge, and the server's own generalisation adds far more than that
        // when zoomed out. It floors at ~100 m and tracks that generalisation
        // above it — see `mergeSnap`, which is where the whole "why does
        // Ontario draw as a mesh and Alberta as one shape" answer lives.
        const segments = dissolveSegments(features, snap);
        if (segments.length === 0) return;
        const line = { type: 'MultiLineString', coordinates: segments } as any;

        // Zoomed out far enough that the uncertainty band would be sub-pixel:
        // draw the dissolved boundary as ONE thin crisp line rather than a fuzzy
        // band. This is the fix for the mesh of edges — the grouping still holds
        // at every zoom, it just switches from a soft band to a hairline.
        if (shouldSimplify(accuracy, centreLat, currentZoom)) {
          group.addLayer(
            L.geoJSON(line, {
              pane: 'boundariesPane',
              renderer,
              interactive: false,
              style: {
                color, weight: 1, opacity: 0.75,
                fill: false, lineJoin: 'round', lineCap: 'round'
              }
            } as RenderedGeoJSONOptions)
          );
          return;
        }

        const ringSpecs = buildFuzzRings(accuracy, centreLat, currentZoom, rings);
        widest = Math.max(widest, ringSpecs[0]?.weight ?? 0);

        ringSpecs.forEach((ring) => {
          group.addLayer(
            L.geoJSON(line, {
              pane: 'boundariesPane',
              renderer,
              interactive: false,
              style: {
                color, weight: ring.weight, opacity: ring.opacity,
                fill: false, lineJoin: 'round', lineCap: 'round'
              }
            } as RenderedGeoJSONOptions)
          );
        });
      });

      return { group, widest };
    };

    /**
     * Draw the boundaries — and, far more often, decide not to.
     *
     * THIS IS THE FIX FOR THE JANK. Every `moveend` and `zoomend` used to tear
     * the whole layer down and rebuild it: re-parsing the GeoJSON, minting a
     * fresh Leaflet layer for every parcel and a popup binding for each one,
     * then throwing all of it away on the next gesture. With a few hundred
     * parcels on screen that is the frame drop you could feel.
     *
     * Two things changed.
     *
     * First, a render signature. If the data and the drawing parameters are
     * identical to what is already on the map, this returns immediately and
     * nothing is touched — which is now the common case, because panning
     * inside loaded data no longer changes either.
     *
     * Second, the fill and the uncertainty halo are separate layers. Only the
     * halo's width depends on zoom, so a zoom step rebuilds the halo (a
     * handful of batched layers) and leaves the expensive parcel layer, with
     * all its popups, exactly where it is.
     */
    const render = (collection: BoundaryCollection, detail: BoundaryDetail) => {
      // Loaded but not painted: everything below this line is drawing.
      if (!showBoundaries) { clearLayer(); return; }
      const pane = boundaryPane();
      // The mid tier is the overview data windowed finer, so it draws with
      // the same light styling family as the overview — hairline edges, no
      // uncertainty halo, no pixel culling (the server has already filtered).
      const light = detail !== 'full';
      const overview = detail === 'overview';
      const currentZoom = map.getZoom();
      const centreLat = map.getCenter().lat;

      if (collection.features.length === 0) {
        clearLayer();
        if (pane) pane.style.filter = '';
        return;
      }

      // The overview is deliberately zoom-independent: hairlines and a flat
      // fill look the same at zoom 3 as at zoom 6, so zooming inside the
      // overview redraws nothing at all.
      const zoomKey = overview ? 'ov' : String(Math.round(currentZoom));
      const fingerprint = parcelFingerprint(collection);
      const signature = `${detail}|${zoomKey}|${fingerprint}`;

      /**
       * Is this the same PARCEL SET that is already drawn?
       *
       * Object identity catches the cheap case — panning inside one grid cell
       * resolves to the same request URL, the cache hands back the same
       * object, and nothing is touched.
       *
       * The FINGERPRINT catches the case that was making panning feel clunky.
       * Crossing a grid cell means a new request and a new response object,
       * and that used to force a full teardown and rebuild of every parcel:
       * the dissolve pass over every polygon, a fresh Leaflet layer per
       * group, a fresh canvas repaint. But the neighbouring box almost always
       * holds the SAME parcels — public land does not change between two
       * overlapping requests — so nearly all of that work was spent redrawing
       * exactly what was already on screen. Comparing content instead of
       * identity means a rebuild happens when the land actually differs, and
       * panning across a cell boundary costs nothing.
       */
      const sameData =
        renderedCollectionRef.current === collection ||
        (renderedFingerprintRef.current !== null &&
          renderedFingerprintRef.current === fingerprint);

      if (sameData && signature === renderSignatureRef.current && boundaryLayerRef.current) {
        // Point the refs at the live object so the zoom-only path below still
        // recognises it after a refetch that returned equal data.
        renderedCollectionRef.current = collection;
        renderedFingerprintRef.current = fingerprint;
        return;
      }

      /**
       * Pre-compute the per-feature sliver test for THIS render.
       *
       * `featureMinDimPx` calls `latLngToLayerPoint`, which is fine once but
       * the fill's `filter` callback runs it for every feature in the
       * collection on every redraw, and so does `buildHalo`. That is two
       * `latLngToLayerPoint` calls per feature per render — a few hundred
       * features at every zoom step. Computing it once and reusing the
       * result cuts the work in half and lets the filter be a Map lookup
       * rather than a function call.
       */
      /**
       * HOW FAR APART TWO PARCELS MAY BE AND STILL COUNT AS TOUCHING.
       *
       * This is the number that decides whether a province reads as Alberta
       * does — one clean shape — or as a mesh of thousands of outlines.
       *
       * Merging works by cancelling the edge two abutting parcels share, which
       * requires both copies of that edge to still line up. They do at street
       * zoom. They do not when zoomed out, because the server generalises each
       * parcel INDEPENDENTLY, and two sides of one shared boundary can drift
       * apart by as much as the whole simplification tolerance — 1.4 km on a
       * province-wide view. Against that, a fixed 100 m tolerance recognises
       * nothing, every internal seam survives, and Ontario draws every parcel
       * separately while Alberta looks fine purely because the Green Area
       * arrives as a single polygon that was never split to begin with.
       *
       * So the tolerance follows the generalisation the server reports, with
       * the old 100 m as the floor for close-in views where nothing was
       * generalised much. Doubled, because the drift is up to the tolerance on
       * EACH side of the shared edge.
       */
      const mergeSnap = Math.min(
        // AND A CEILING, BECAUSE MERGING IS ALSO A CLAIM. Two parcels joined
        // across a gap say there is campable ground in that gap. At ~5 km the
        // gap is about a pixel on the widest views this tolerance is reached
        // at, so nobody can act on it and zooming in undoes it — but past that
        // the merge stops being a rendering decision and starts being an
        // assertion about land, so it stops here.
        0.05,
        Math.max(1e-3, (collection.meta?.simplifyDegrees ?? 0) * 2)
      );

      const minDimCache = new Map<unknown, number>();
      const minDim = (g: unknown): number => {
        const cached = minDimCache.get(g);
        if (cached !== undefined) return cached;
        const v = featureMinDimPx(map, g);
        minDimCache.set(g, v);
        return v;
      };
      /**
       * NO PIXEL-BASED CULLING IN THE OVERVIEW.
       *
       * This used to drop overview shapes narrower than three pixels, which is
       * a zoom-dependent test applied to a layer that is deliberately drawn
       * once and reused at every wide zoom. Whatever the zoom happened to be
       * the first time the overview was drawn would decide, permanently, which
       * areas existed — draw it at zoom 3 and the smaller ones were culled and
       * never came back when you zoomed to 6.
       *
       * The server already filters this tier by real area, in km², which is a
       * property of the land rather than of the current zoom. That is the right
       * test and it has already been applied by the time these features arrive.
       */
      const sliverCutoff = light ? 0 : SLIVER_PX;

      /* -- Zoom-only change: rebuild the halo, keep the parcels ---------- */
      if (sameData && fillLayerRef.current && boundaryLayerRef.current && !light) {
        const group = boundaryLayerRef.current;
        if (haloLayerRef.current) {
          try { group.removeLayer(haloLayerRef.current); } catch { /* gone */ }
        }
        const { group: halo, widest } = buildHalo(collection, centreLat, currentZoom, minDim, mergeSnap);
        haloLayerRef.current = halo;
        group.addLayer(halo);
        fillLayerRef.current.setStyle((f: any) => parcelStyle(f, centreLat, currentZoom, false));
        if (pane) pane.style.filter = widest > 0 ? `blur(${edgeBlurPx(widest).toFixed(1)}px)` : '';
        renderSignatureRef.current = signature;
        renderedCollectionRef.current = collection;
        renderedFingerprintRef.current = fingerprint;
        return;
      }

      /* -- Tier change: fade through to the next step -------------------- */
      const stepChanged = detail !== lastTier && !!boundaryLayerRef.current;
      lastTier = detail;

      const rebuild = () => {
      /* -- New data: full rebuild --------------------------------------- */
      const renderer = boundaryRenderer();

      // No uncertainty band in the overview. At zoom 4 a ±200 m band is a
      // fraction of a pixel, so it would draw as a slightly thicker line that
      // says nothing — while costing one extra pass over every polygon.
      const halo = light ? null : buildHalo(collection, centreLat, currentZoom, minDim, mergeSnap);

      /**
       * DISSOLVED FILL. Same-org, same-rule parcels are merged into a single
       * filled polygon, with a different group's polygons (private land, a
       * water body, a different agency) drawn on top as their own dissolved
       * fills. A 50-parcel Crown-land mass with a private inholding in the
       * middle now draws as one big Crown-land shape with the inholding
       * sitting on top in its own colour, rather than fifty-one abutting
       * outlines that look like a topological map.
       *
       * Groups are sorted by area, LARGEST first, so the larger surrounds
       * go on the BOTTOM of the layer stack and any smaller inclusions
       * (no-go zones, different agencies) paint on top. The previous
       * version sorted smallest first, which inverted the stack and
       * covered smaller groups with larger ones — the visual read as
       * "the green and yellow are merging", which was the larger group
       * painting over the smaller one.
       */
      /*
       * THE WATER IS ALREADY GONE BY THE TIME IT GETS HERE.
       *
       * This used to drop each lake in as an extra ring and let the even-odd
       * fill rule turn it into a hole, which only works for a lake sitting
       * entirely inside one polygon — so in Ontario, where the parcels are
       * fragmented and the lakes are enormous, almost every lake straddled a
       * boundary, was skipped, and stayed painted green.
       *
       * The server now does a real geometric difference before it answers, and
       * the result is cached, so a correct cut costs nothing here. See
       * `subtractLakes` in server/landGeometry.ts.
       */
      const dissolved = dissolvedFill(
        collection.features as { properties?: Record<string, any>; geometry: unknown }[],
        dissolveKey,
        mergeSnap
      );
      const dissolvedSorted = [...dissolved].sort((a, b) => {
        const ea = a.geometry as { type: string; coordinates: any };
        const eb = b.geometry as { type: string; coordinates: any };
        const ringOf = (g: { type: string; coordinates: any }): number[][] => {
          if (g.type === 'Polygon') return g.coordinates[0] as number[][];
          if (g.type === 'MultiPolygon') return (g.coordinates[0] as number[][][])[0];
          return [];
        };
        const ringA = ringOf(ea);
        const ringB = ringOf(eb);
        const bboxArea = (r: number[][]): number => {
          let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
          r.forEach(([lon, lat]) => {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          });
          return (maxLon - minLon) * (maxLat - minLat);
        };
        return bboxArea(ringB) - bboxArea(ringA);
      });

      const fill = L.geoJSON(
        { type: 'FeatureCollection', features: dissolvedSorted } as any,
        {
          pane: 'boundariesPane',
          renderer,
          // Taps pass straight through to the map, which drops the destination
          // pin and reads this parcel's rules out of the collection in memory.
          interactive: false,
          // Razor-thin slivers are filtered out here too, so the fill never draws
          // a hairline splinter the halo already refused to outline.
          filter: (feature: any) => minDim(feature.geometry) >= sliverCutoff,
          style: (feature: any) => parcelStyle(feature, centreLat, currentZoom, light)
        } as RenderedGeoJSONOptions
      );

      if (pane) {
        pane.style.filter =
          halo && halo.widest > 0 ? `blur(${edgeBlurPx(halo.widest).toFixed(1)}px)` : '';
      }

      // SWAP, don't clear-then-build. The new layer goes on the map BEFORE the
      // old one comes off, so there is never a frame with no boundaries — which
      // is what made them flash and disappear on every new fetch.
      const previous = boundaryLayerRef.current;
      const nextGroup = L.layerGroup(halo ? [halo.group, fill] : [fill]).addTo(map);
      if (previous) { try { map.removeLayer(previous); } catch { /* detached */ } }

      boundaryLayerRef.current = nextGroup;
      fillLayerRef.current = fill;
      haloLayerRef.current = halo ? halo.group : null;
      renderSignatureRef.current = signature;
      renderedCollectionRef.current = collection;
      renderedFingerprintRef.current = fingerprint;
      };

      /* -- Tier change: fade through ------------------------------------ */
      if (stepChanged && !prefersReducedMotion()) {
        const paneEl = boundaryPane();
        if (paneEl) {
          paneEl.style.transition = 'opacity 140ms ease';
          paneEl.style.opacity = '0.15';
          // The old tier is still on the pane right now. Dim it, swap in the
          // new tier at its darkest frame, then bloom back — a step, not a
          // cut. A newer fade supersedes this one (`fadeSeq`) and owns the
          // pane from then on; the older fade's cleanup must not touch the
          // transition once it does, or the pane can be left stuck at
          // partial opacity (layers look gone after a fast zoom).
          const myFade = ++fadeSeq;
          window.setTimeout(() => {
            if (myFade !== fadeSeq) return; // a newer fade owns the pane
            try {
              rebuild();
            } catch (err) {
              // Never strand the pane dimmed: bloom back even if the swap
              // failed so the previous tier stays visible.
              console.error('boundary tier swap failed', err);
            }
            paneEl.style.transition = 'opacity 320ms ease-out';
            paneEl.style.opacity = '1';
            window.setTimeout(() => {
              if (myFade === fadeSeq) paneEl.style.transition = '';
            }, 600);
          }, 150);
          return;
        }
      }
      rebuild();
    };

    const run = async () => {
      // Mid-flight through a flyTo the viewport is somewhere between where the
      // user was and where they asked to go. Fetching for it wastes a round
      // trip on a view nobody will look at, so wait for the map to land.
      if ((map as unknown as { _animatingZoom?: boolean })._animatingZoom) {
        load();
        return;
      }

      const currentZoom = map.getZoom();
      setLiveZoom(currentZoom);

      // Below the overview floor the whole hemisphere is on screen and there
      // is nothing legible to draw at any level of generalisation.
      if (currentZoom < BOUNDARY_OVERVIEW_MIN_ZOOM) {
        setZoomTooFar(true);
        setWideViewFailed(false);
        setBoundaries(EMPTY_BOUNDARIES);
        forget();
        clearLayer();
        const pane = map.getPane('boundariesPane');
        if (pane) pane.style.filter = '';
        return;
      }

      /**
       * Which tier to draw.
       *
       * Three steps on the way in, instead of one hard cutover:
       *   - below BOUNDARY_MID_ZOOM:      'overview' — the coarse blocks,
       *                                    one answer for the whole coverage
       *                                    area, held for the session.
       *   - BOUNDARY_MID_ZOOM .. MIN-1:   'mid'      — the same local data,
       *                                    windowed much finer. The step
       *                                    between "is there public land over
       *                                    there" and "where exactly".
       *   - at or above BOUNDARY_MIN_ZOOM: 'full'    — real geometry for the
       *                                    viewport, refetched as you move,
       *                                    drawn over the top.
       * Crossing any step fades through rather than snapping.
       */
      const detail: BoundaryDetail =
        currentZoom < BOUNDARY_MID_ZOOM ? 'overview'
        : currentZoom < BOUNDARY_MIN_ZOOM ? 'mid'
        : 'full';
      setZoomTooFar(false);

      const b = map.getBounds();
      const view: BoundingBox = {
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
      };

      /* -------------------------------------------------------------------
       * THE ZOOMED-OUT TIER: ASKED ONCE, THEN NEVER AGAIN.
       * -------------------------------------------------------------------
       *
       * This is the fix for public land popping in and out while you scroll.
       *
       * The overview used to be fetched for a box that followed the viewport,
       * so panning far enough crossed the box and fetched again. Each request
       * spends a per-source record cap that the government services fill with
       * whatever comes first rather than with the biggest parcels — so two
       * overlapping boxes come back holding DIFFERENT arbitrary subsets of the
       * same continent, and the map replaced everything it was drawing with the
       * new one. Areas on screen a second earlier were simply absent from the
       * next answer and vanished. Nothing had failed; the map was being handed
       * a fresh sample every few gestures and drawing each one faithfully.
       *
       * There is only one sample now. `OVERVIEW_BOX` is the entire coverage
       * area, the request is identical at every wide zoom, and the answer is
       * kept in `overviewCollectionRef` for the session. Panning does no work
       * at all — not a request, not even a redraw, because `render` sees the
       * same object and returns. Zooming 6 → 2 does no work either.
       *
       * Nothing can pop, because there is no second answer to disagree with
       * the first.
       */
      if (detail !== 'full') {
        /* -----------------------------------------------------------------
         * THE COPY ON THE DEVICE WINS, WHENEVER THERE IS ONE.
         * -----------------------------------------------------------------
         *
         * `public/map/public-land-overview.json` is built by CI from the same
         * eight sources and committed into the app, and where it exists it
         * beats the network answer on every axis that matters: about a
         * kilometre of generalisation instead of twenty-four, ten thousand
         * parcels instead of a two-hundred-record sample, National Forest
         * included even on the days the Forest Service's own server is
         * refusing requests — and no round trip, so it is there before the
         * map has finished drawing and it works with no signal at all.
         *
         * It is also complete and deterministic, which is what lets it be
         * windowed. The remote overview must be one fixed continental
         * question because its answer is a capped arbitrary sample and two
         * different questions give two different samples. Nothing here is
         * sampled: the same zoom over the same ground selects exactly the
         * same parcels every time, so panning away and back cannot change
         * what is drawn. That is what makes it safe to show the big blocks
         * when zoomed out and progressively more as you come in — which is
         * also the only way to draw ten thousand parcels without stalling.
         */
        const overlay = landOverlayRef.current;
        if (overlay) {
          const minSpan = detail === 'mid'
            ? midMinSpanDegrees(currentZoom)
            : overviewMinSpanDegrees(currentZoom);
          const held = overviewWindowRef.current;

          // Rebuild only when the view leaves the window we selected for, or
          // when the zoom band changes what this zoom is allowed to show.
          if (!held || held.minSpan !== minSpan || !boxContains(held.box, view)) {
            // A whole viewport of headroom on each side, clipped to what we
            // have data for, so an ordinary pan reuses the same selection.
            const padLat = Math.max(view.maxLat - view.minLat, 0.5);
            const padLon = Math.max(view.maxLon - view.minLon, 0.5);
            const box = clampToCoverage({
              minLat: view.minLat - padLat, maxLat: view.maxLat + padLat,
              minLon: view.minLon - padLon, maxLon: view.maxLon + padLon
            });
            overviewWindowRef.current = {
              box,
              minSpan,
              collection: overviewCollection(overlay, box, minSpan) ?? EMPTY_BOUNDARIES
            };
          }

          const local = overviewWindowRef.current!.collection;
          setWideViewFailed(false);
          loadedDetailRef.current = detail;
          collectionRef.current = local;
          setBoundaries(local);
          render(local, detail);
          return;
        }

        // No bundled file in this build. Fall back to the one continental
        // request, held for the session — see the note above.
        const held = overviewCollectionRef.current;
        if (held) {
          setWideViewFailed(false);
          loadedDetailRef.current = detail;
          collectionRef.current = held;
          setBoundaries(held);
          render(held, detail);
          return;
        }

        const fetched = await loadOverview();
        if (cancelled) return;

        if (!fetched) {
          // Superseded, or an answer we could not stand behind. Either way
          // keep what is drawn — see the note on `meta.unavailable`.
          setWideViewFailed(true);
          return;
        }

        setWideViewFailed(false);
        loadedDetailRef.current = 'overview';
        collectionRef.current = fetched;
        setBoundaries(fetched);
        render(fetched, detail);
        return;
      }

      const loaded = loadedBoxRef.current;
      const sameTier = loadedDetailRef.current === detail;

      // Everything in view is already loaded at this detail level.
      if (loaded && sameTier && boxContains(loaded, view)) {
        // Panning inside loaded data needs nothing. A zoom change inside it
        // needs the uncertainty band rewidened, which `render` does without
        // rebuilding the parcels.
        if (currentZoom > loadedZoomRef.current) {
          // Zoomed past the detail we fetched for: go and get finer geometry.
        } else {
          setWideViewFailed(false);
          render(collectionRef.current, detail);
          return;
        }
      }

      const box = requestBoxFor(view, currentZoom);
      const myId = ++requestId;
      controller?.abort();
      controller = new AbortController();

      /**
       * ---------------------------------------------------------------------
       * DRAW WHAT IS ALREADY ON THE DEVICE, THEN GO AND ASK
       * ---------------------------------------------------------------------
       *
       * Everything below this point is a network round trip: eight government
       * ArcGIS services, or Supabase, or a cache warmed by neither on a cold
       * start. Until it lands the map has nothing to show, and "nothing to
       * show" on a map of public land is a blank continent — the one thing
       * this app must never draw.
       *
       * So local data paints FIRST, synchronously, from whatever this device
       * carries: the downloaded full-detail pack if there is one, otherwise
       * the overview that shipped with the app. The remote answer replaces it
       * a moment later if it is better.
       *
       * The pack is preferred over the bundled overview because it IS the real
       * geometry — a camper who paid for the download should never be shown
       * the coarse shape while the accurate one sits on their phone unused.
       */
      const localPack = await packCollection(box);
      if (cancelled || myId !== requestId) return;

      const local = localPack ?? overviewCollection(landOverlayRef.current, box);
      if (local) render(local, localPack ? detail : 'overview');

      /*
       * With the full pack on the device there is nothing better to fetch:
       * it is the same data the server would return, already local. Stopping
       * here is what makes the pack worth downloading — no round trip, and it
       * behaves identically with no signal.
       */
      if (localPack) {
        setWideViewFailed(false);
        loadedBoxRef.current = box;
        loadedZoomRef.current = currentZoom;
        loadedDetailRef.current = detail;
        collectionRef.current = localPack;
        setBoundaries(localPack);
        return;
      }

      const collection = await fetchBoundaries(box, controller.signal, detail);
      if (cancelled || myId !== requestId) return;

      // `null` means the request was superseded. Keep what is on screen rather
      // than blanking the map between one viewport and the next.
      if (!collection) return;

      /*
       * ---------------------------------------------------------------------
       * NOTHING CAME BACK. THAT IS NOT THE SAME AS NOTHING BEING THERE.
       * ---------------------------------------------------------------------
       *
       * Eight government ArcGIS services answer this inside one serverless
       * function. When one of them is having a slow afternoon the response is a
       * well-formed, utterly empty province — and the map used to draw it,
       * wiping boundaries that had loaded perfectly a second earlier.
       *
       * `fetchBoundaries` now marks an answer it could not stand behind. Where
       * it is marked, we keep exactly what is on screen, leave the loaded box
       * alone so the next gesture retries, and say on screen that the view did
       * not load. A stale outline the camper can see is honest and useful; a
       * blank continent is neither.
       *
       * A trustworthy empty — every source answered, there is nothing here —
       * still clears the map, because that is a real answer.
       */
      if (collection.features.length === 0 && collection.meta?.unavailable) {
        setWideViewFailed(true);
        return;
      }

      // Local data says there IS public land here and the network disagrees
      // without having failed. Keep the local answer: it is drawn from a
      // dataset that shipped with the app, not from a service having a moment.
      if (local && collection.features.length === 0) return;

      setWideViewFailed(false);
      loadedBoxRef.current = box;
      loadedZoomRef.current = currentZoom;
      loadedDetailRef.current = detail;
      collectionRef.current = collection;
      setBoundaries(collection);
      render(collection, detail);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 220);
    };

    load();
    map.on('moveend zoomend', load);

    /**
     * Warm the wide view before anyone asks for it.
     *
     * The zoomed-out answer covers the whole coverage area, so it is the same
     * request no matter where the camper happens to be standing — which means
     * it can be fetched before they zoom out rather than at the moment they
     * do. Zooming out then draws instantly from memory instead of watching a
     * continent load.
     *
     * Held back a few seconds so it never competes with the boundaries and
     * campsites for the view actually on screen, and skipped entirely when the
     * device already carries the full-detail pack, which is better than this in
     * every way. Usually free regardless: the response caches on disk for seven
     * days, so most launches resolve it without touching the network.
     */
    const prefetch = setTimeout(() => {
      if (cancelled || overviewCollectionRef.current) return;
      // The bundled file is better than anything this request can return, and
      // it is already here. Asking eight government servers for a worse copy
      // of it would be pure waste.
      if (landOverlayRef.current) return;
      void loadOverview();
    }, 4000);

    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(prefetch);
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clearLayer();
      if (boundaryRendererRef.current) {
        try { map.removeLayer(boundaryRendererRef.current); } catch { /* detached */ }
        boundaryRendererRef.current = null;
      }
    };
  }, [isMapReady, showBoundaries, isOfflineMode]);

  /* -------------------------------------------------------------------- */
  /* Scout: the roads THIS PHONE has driven, and how rough they were       */
  /* -------------------------------------------------------------------- */
  /**
   * One line per recorded drive, coloured span by span.
   *
   * WHAT A COLOUR MEANS is in `config/scoutRoughness.ts`, and it is one
   * thing only: how rough the ride was. Not what the road is made of — an
   * accelerometer cannot know that, and the backroads layer above already
   * answers it from OpenStreetMap.
   *
   * ---------------------------------------------------------------------
   * THE GRADIENT IS MANY SHORT SEGMENTS, NOT ONE LINE
   * ---------------------------------------------------------------------
   *
   * Leaflet cannot paint a gradient along a polyline, and it does not need
   * to: the data is already a string of readings about a second apart, so
   * each consecutive pair is drawn as its own two-point segment in its own
   * colour. At driving speed that is a new colour every ten to twenty
   * metres, which is fine enough to fade smoothly and — the point — fine
   * enough that one bad twenty metres shows up as its own red stripe
   * instead of being averaged into the road around it. That is why there
   * are no pothole markers in this app.
   *
   * ---------------------------------------------------------------------
   * NOTHING HERE COUNTS PASSES
   * ---------------------------------------------------------------------
   *
   * Every trace is drawn at `PASS_ALPHA`, and where drives overlap the alpha
   * compounds on its own: one pass is a whisper, five is solid. A road you
   * have driven once LOOKS like a road you have driven once, which is the
   * honest rendering of a single vehicle's single opinion. GPS scatter puts
   * repeat passes a few metres apart, so they read as a braid — which is
   * what a track log has always looked like, and is a truer picture than one
   * confident line down the middle.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const clear = () => {
      if (!scoutLayerRef.current) return;
      try { map.removeLayer(scoutLayerRef.current); } catch { /* detached */ }
      scoutLayerRef.current = null;
    };

    if (!showScout) {
      clear();
      setScoutState({ tooFar: false, traces: 0 });
      return;
    }

    /**
     * Just above the backroads (410), so a road you have driven paints over
     * the generic line for the same road rather than under it. Pointer
     * events off: a tap here must still drop a destination pin.
     */
    const pane = (): void => {
      if (!map.getPane('scoutPane')) {
        map.createPane('scoutPane');
        const created = map.getPane('scoutPane');
        if (created) {
          created.style.zIndex = '412';
          created.style.pointerEvents = 'none';
        }
      }
    };

    // One canvas for the life of the effect — see the backroads note below
    // for why minting one per redraw orphans a renderer on every pan.
    const renderer = (): L.Canvas => {
      if (!scoutRendererRef.current) {
        pane();
        scoutRendererRef.current = L.canvas({ pane: 'scoutPane', padding: 0.3 });
      }
      return scoutRendererRef.current;
    };

    const draw = (traces: ScoutTrace[]) => {
      clear();
      if (traces.length === 0) return;

      const canvas = renderer();
      const group = L.layerGroup([], { pane: 'scoutPane' });

      /*
       * Casings first, then colour — the same two passes the backroads use.
       * Drawn trace by trace instead, one drive's dark outline paints over
       * the previous drive's colour wherever they cross, and a junction you
       * have driven twice comes out chewed.
       */
      for (const trace of traces) {
        group.addLayer(L.polyline(
          trace.points.map((p) => [p.lat, p.lon] as [number, number]),
          {
            renderer: canvas,
            pane: 'scoutPane',
            interactive: false,
            color: SCOUT_CASING.color,
            opacity: SCOUT_CASING.opacity,
            weight: SCOUT_WEIGHT + SCOUT_CASING.extraWeight,
            lineCap: 'round',
            lineJoin: 'round'
          }
        ));
      }

      for (const trace of traces) {
        for (let i = 1; i < trace.points.length; i += 1) {
          const from = trace.points[i - 1];
          const to = trace.points[i];

          /*
           * The WORSE of the two ends, not the mean. A span is only as good
           * as its bad half: averaging a smooth reading with the pothole
           * next to it paints the pothole half as bad as it is, which is
           * the one direction this layer must never round in.
           */
          group.addLayer(L.polyline(
            [[from.lat, from.lon], [to.lat, to.lon]] as [number, number][],
            {
              renderer: canvas,
              pane: 'scoutPane',
              interactive: false,
              color: roughnessColor(Math.max(from.r, to.r)),
              opacity: PASS_ALPHA,
              weight: SCOUT_WEIGHT,
              lineCap: 'round',
              lineJoin: 'round'
            }
          ));
        }
      }

      group.addTo(map);
      scoutLayerRef.current = group;
    };

    const run = async () => {
      if (cancelled) return;

      /*
       * Too far out. Cleared rather than left showing the last close-up's
       * strands floating over a county — and the notice says which silence
       * this is, so an empty map never reads as "you have driven nothing".
       */
      if (map.getZoom() < SCOUT_MIN_ZOOM) {
        clear();
        setScoutState({ tooFar: true, traces: 0 });
        return;
      }

      const b = map.getBounds();
      const traces = await tracesIn({
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
      });
      if (cancelled) return;

      setScoutState({ tooFar: false, traces: traces.length });
      draw(traces);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 200);
    };

    load();
    map.on('moveend zoomend', load);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clear();
      if (scoutRendererRef.current) {
        try { map.removeLayer(scoutRendererRef.current); } catch { /* detached */ }
        scoutRendererRef.current = null;
      }
    };
  }, [isMapReady, showScout, scoutRefreshKey]);

  /* ------------------------------------------------------------------ */
  /* Backroads: the little unpaved roads nothing else draws              */
  /* ------------------------------------------------------------------ */
  /**
   * WHY THE MAP NEEDED THIS.
   *
   * The default basemap is satellite imagery, which has no roads on it at
   * all. You can see a two-track scratched across a mesa; nothing tells you
   * it is a road or where it goes. The street and topo basemaps do draw
   * roads, but their cartography is built for towns — most tracks are dropped
   * entirely and the survivors are hairlines under everything else.
   *
   * So the roads that matter most for dispersed camping — the forest service
   * spur, the gravel section road, the grass line through a cutblock — were
   * the ones the map was least likely to show. This layer asks OpenStreetMap
   * for them directly and draws them over whichever basemap is on.
   *
   * WHAT A LINE MEANS is in `src/config/backroads.ts`, and it is narrow: a
   * volunteer recorded a road here. Not maintained, not ungated, not
   * passable, not legal to drive. The four line styles exist to keep the
   * three different facts apart — surface known unpaved, purpose-built
   * track, surface NOT RECORDED, and access restricted — because collapsing
   * "nobody wrote it down" into either of the others is the exact
   * overstatement this app does not make.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!backroadLayerRef.current) return;
      try { map.removeLayer(backroadLayerRef.current); } catch { /* detached */ }
      backroadLayerRef.current = null;
    };

    /**
     * Offline means the roads cannot be fetched, and there is no local copy
     * of them the way there is for boundaries — so the layer goes quiet
     * rather than pretending. Turning it off does the same.
     */
    if (!showBackroads || isOfflineMode) {
      clear();
      backroadBoxRef.current = null;
      setBackroadState({ loading: false, tooFar: false, scan: null });
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let requestId = 0;

    /**
     * Above the parcels (390) and the optional Crown Land tiles (400), below
     * the coverage mask (645), the markers and every popup. Pointer events
     * off, so a tap on a road still drops a destination pin — the same reason
     * the boundary parcels are not interactive.
     */
    const backroadPane = (): HTMLElement | undefined => {
      if (!map.getPane('backroadsPane')) {
        map.createPane('backroadsPane');
        const created = map.getPane('backroadsPane');
        if (created) {
          created.style.zIndex = '410';
          created.style.pointerEvents = 'none';
        }
      }
      return map.getPane('backroadsPane');
    };

    // One canvas for the life of the effect, for the same reason the
    // boundaries have one: Leaflet registers a renderer as a map layer the
    // first time a path uses it, so minting one per redraw orphans a canvas
    // on the map every time it moves. Canvas and not SVG because a forest at
    // zoom 13 is well over a thousand paths.
    const backroadRenderer = (): L.Canvas => {
      if (!backroadRendererRef.current) {
        backroadPane();
        backroadRendererRef.current = L.canvas({ pane: 'backroadsPane', padding: 0.3 });
      }
      return backroadRendererRef.current;
    };

    const draw = (scan: BackroadScan) => {
      clear();
      if (!scan.roads.length) return;

      const canvas = backroadRenderer();
      const group = L.layerGroup([], { pane: 'backroadsPane' });

      /**
       * Every casing first, then every line.
       *
       * Drawn road-by-road instead, a junction of two tracks would have one
       * road's dark outline painted over the other road's colour, and a
       * network of them looks chewed. Two passes costs nothing on canvas and
       * the joins come out clean.
       */
      for (const road of scan.roads) {
        const style = BACKROAD_STYLES[backroadClassOf(road)];
        group.addLayer(L.polyline(road.line, {
          renderer: canvas,
          pane: 'backroadsPane',
          interactive: false,
          color: BACKROAD_CASING.color,
          opacity: BACKROAD_CASING.opacity,
          weight: style.weight + BACKROAD_CASING.extraWeight,
          lineCap: 'round',
          lineJoin: 'round'
        }));
      }

      for (const road of scan.roads) {
        const style = BACKROAD_STYLES[backroadClassOf(road)];
        group.addLayer(L.polyline(road.line, {
          renderer: canvas,
          pane: 'backroadsPane',
          interactive: false,
          color: style.color,
          opacity: style.opacity,
          weight: style.weight,
          dashArray: style.dash,
          lineCap: 'round',
          lineJoin: 'round'
        }));
      }

      group.addTo(map);
      backroadLayerRef.current = group;
    };

    const run = async () => {
      if (cancelled) return;

      /**
       * Too far out to ask. The layer clears rather than leaving the last
       * close-up view's roads floating over a county — and says which of the
       * silences this is, so an empty map never reads as "no roads here".
       */
      if (map.getZoom() < BACKROAD_MIN_ZOOM) {
        clear();
        backroadBoxRef.current = null;
        setBackroadState({ loading: false, tooFar: true, scan: null });
        return;
      }

      const b = map.getBounds();
      const view: BoundingBox = {
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
      };

      // A pan that stays inside the padded box already on screen is free —
      // no request, no redraw.
      if (backroadBoxCovers(backroadBoxRef.current, view)) {
        setBackroadState((prev) => (prev.tooFar ? { ...prev, tooFar: false } : prev));
        return;
      }

      const box = backroadRequestBox(view);
      controller?.abort();
      controller = new AbortController();
      const myId = ++requestId;

      setBackroadState((prev) => ({ ...prev, loading: true, tooFar: false }));

      const scan = await fetchBackroads(box, controller.signal);
      if (cancelled || myId !== requestId) return;

      // `null` is the request being superseded by a newer viewport. Keep what
      // is drawn rather than blanking the layer between one pan and the next.
      if (!scan) return;

      setBackroadState({ loading: false, tooFar: false, scan });

      /**
       * A failed answer holds no box, so the next gesture asks again. Keeping
       * it would let one bad moment on a car-park connection decide there are
       * no roads out here for the rest of the pan.
       */
      if (!scan.ok) return;

      backroadBoxRef.current = box;
      draw(scan);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 260);
    };

    load();
    map.on('moveend zoomend', load);

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', load);
      clear();
      if (backroadRendererRef.current) {
        try { map.removeLayer(backroadRendererRef.current); } catch { /* detached */ }
        backroadRendererRef.current = null;
      }
    };
  }, [isMapReady, showBackroads, isOfflineMode]);

  /* ------------------------------------------------------------------ */
  /* Tap anywhere to pick a destination                                  */
  /* ------------------------------------------------------------------ */
  /**
   * A tap on bare map drops a pin there; a tap on an icon selects the icon.
   *
   * That split is Leaflet's, not ours. `_findEventTargets` only falls back to
   * the map when no interactive layer was hit, so a marker tap never reaches
   * this handler — which is why the parcels had to become non-interactive for
   * it to work over public land, and why the campsite pins did not.
   *
   * The land under the tap is read from the polygons already in memory rather
   * than fetched. It costs a point-in-polygon test against what is on screen
   * and no round trip at all.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const handleTap = (event: L.LeafletMouseEvent) => {
      const { lat, lng } = event.latlng;

      /**
       * Two ways a tap can be refused, both decided here and now.
       *
       * Outside coverage: the frame has margin around the data area, so
       * there is reachable map — northern Mexico, mostly — that we have
       * nothing to say about. Dropping a pin there would produce a card
       * full of confident blanks.
       *
       * Water: a pin in the middle of a lake or out at sea is never a
       * campsite. Both tests are synchronous, so the pin lands on the
       * same frame as the tap; the previous version awaited an HTTP
       * round trip before it would accept a tap, which on a weak
       * connection felt like the map had stopped responding.
       */
      if (!isWithinCoverage(lat, lng)) {
        pinRefusedRef.current?.('outside_coverage');
        return;
      }
      if (!isOnLand(lat, lng)) {
        pinRefusedRef.current?.('water');
        return;
      }

      /**
       * Smallest matching parcel wins.
       *
       * Parcels nest — a wilderness area sits inside a national forest — and
       * naming the forest when the user tapped the wilderness would quote the
       * wrong rules, which are usually the stricter ones. Feature order is
       * whatever the upstream service happened to return, so the tie has to be
       * broken on something. Bounding-box area is a rough stand-in for real
       * area and costs one pass over coordinates we already hold; it only has
       * to rank two shapes that both contain the same point.
       */
      let best: { feature: BoundaryFeature; extent: number } | null = null;
      for (const feature of collectionRef.current.features) {
        if (!pointInGeometry(lat, lng, feature.geometry)) continue;
        const extent = bboxExtent(feature.geometry);
        if (!best || extent < best.extent) best = { feature, extent };
      }

      dropRef.current(lat, lng, landFromFeature(best?.feature.properties as any));
    };

    map.on('click', handleTap);
    return () => { map.off('click', handleTap); };
  }, [isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Camper hazard reports                                               */
  /* ------------------------------------------------------------------ */
  /**
   * What other campers have reported: washouts, flooding, fire, enforcement.
   *
   * Refetched as the map moves, on a coarse radius so an ordinary pan reuses
   * what is already loaded. Every one of these is one person's account —
   * `reportStanding` decides how loudly to draw it, and the report's own sheet
   * says who many people have confirmed it. Without Supabase this returns an
   * empty list and the layer simply never appears.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!reportLayerRef.current) return;
      try { map.removeLayer(reportLayerRef.current); } catch { /* detached */ }
      reportLayerRef.current = null;
    };

    if (isOfflineMode) { clear(); return; }

    if (!map.getPane('reportPane')) {
      map.createPane('reportPane');
      const pane = map.getPane('reportPane');
      // Under the official alert triangles (620), over the campsite pins.
      if (pane) pane.style.zIndex = '610';
    }

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let loadedAt: [number, number] | null = null;

    const render = (records: HazardRecord[]) => {
      clear();
      if (records.length === 0) return;

      const group = L.layerGroup([], { pane: 'reportPane' });
      records.forEach((record) => {
        if (typeof record.latitude !== 'number' || typeof record.longitude !== 'number') return;
        // Same rule as the alerts and the fires: no icon on the grey.
        if (!isWithinCoverage(record.latitude, record.longitude)) return;
        const style = hazardReportStyle(record.kind);
        const marker = L.marker([record.latitude, record.longitude], {
          pane: 'reportPane',
          icon: buildHazardReportIcon(record),
          title: `${style.label} — reported by a camper`,
          riseOnHover: true
        });
        marker.on('click', () => reportTapRef.current?.(record));
        group.addLayer(marker);
      });

      reportLayerRef.current = group.addTo(map);
    };

    const run = async () => {
      const centre = map.getCenter();
      // Loaded within ~50 km of here already: the 150 km fetch still covers
      // the view, so don't spend a request on it.
      if (loadedAt && map.distance(centre, L.latLng(loadedAt)) < 50_000) return;

      const records = await fetchHazardsNear(centre.lat, centre.lng, 150);
      if (cancelled) return;

      loadedAt = [centre.lat, centre.lng];
      render(records);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 700);
    };

    load();
    map.on('moveend', load);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend', load);
      clear();
    };
  }, [isMapReady, isOfflineMode]);

  /**
   * Beacon spots.
   *
   * Same shape as the hazard-report layer above — own pane, debounced on
   * `moveend`, cleared at the start of the effect AND in the cleanup, because
   * Leaflet layers stack up invisibly otherwise.
   *
   * Two differences worth knowing. It refetches on `beaconRefreshKey` as well
   * as on movement, and spots that are genuinely gone never arrive here at all
   * — `beacon_spots_near` filters them in SQL — so there is no way for a client
   * bug to leave one drawn. Flagged spots deliberately DO arrive, and are drawn
   * red.
   *
   * `beaconRefreshKey` is not a nicety. Without it the layer only reloaded when
   * the map moved more than 10 km, which meant a camper could send a beacon,
   * watch it find three spots, and see nothing appear on the map underneath —
   * the leads were in the database the whole time and the layer had simply not
   * been told to look again. Anything that writes a spot must bump the key.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!beaconLayerRef.current) return;
      try { map.removeLayer(beaconLayerRef.current); } catch { /* detached */ }
      beaconLayerRef.current = null;
    };

    if (isOfflineMode) { clear(); return; }

    if (!map.getPane('beaconPane')) {
      map.createPane('beaconPane');
      const pane = map.getPane('beaconPane');
      // Below the camper hazard reports (610) — a lead is the least urgent
      // thing on the map and must never cover a washout warning.
      if (pane) pane.style.zIndex = '600';
    }

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let loadedAt: [number, number] | null = null;
    /** The radius the held spots were fetched at, so a zoom-out re-asks. */
    let loadedRadiusKm: number | null = null;

    const render = (spots: BeaconSpot[]) => {
      clear();
      if (spots.length === 0) return;

      const group = L.layerGroup([], { pane: 'beaconPane' });
      spots.forEach((spot) => {
        if (typeof spot.latitude !== 'number' || typeof spot.longitude !== 'number') return;
        // Same rule as the alerts, fires and reports: no icon on the grey.
        if (!isWithinCoverage(spot.latitude, spot.longitude)) return;

        const style = beaconTierStyle(spot.tier);
        const marker = L.marker([spot.latitude, spot.longitude], {
          pane: 'beaconPane',
          icon: buildBeaconIcon(spot),
          // The tooltip carries the tier's MEANING, not its name, so hovering
          // a grey ring says "nobody has been here" rather than "Lead". On a
          // flagged spot the camper's own words come first — that warning is
          // the reason the pin is still here at all.
          title: spot.knock?.comment
            ? `${spot.label} — knock reported: “${spot.knock.comment}”`
            : `${spot.label} — ${style.meaning}`,
          riseOnHover: true
        });
        marker.on('click', () => beaconTapRef.current?.(spot));
        group.addLayer(marker);
      });

      beaconLayerRef.current = group.addTo(map);
    };

    const run = async () => {
      const centre = map.getCenter();

      /**
       * ASK FOR WHAT IS ON SCREEN, NOT FOR A FIXED 25 km.
       *
       * The radius was hard-coded at 25 km round the map centre, which is
       * fine at close zoom and invisible at any other. A camper who scanned a
       * forest road and then went back to looking at their home town had
       * leads sitting in the database a hundred-odd kilometres away, on a map
       * showing that whole region, with nothing drawn and nothing said. The
       * feature looked broken because the query was smaller than the view.
       *
       * Reaching the corner of the viewport means the layer answers for
       * exactly the ground being looked at. Floored at 25 km so a close zoom
       * still picks up spots just off-screen, and capped at 200 because that
       * is where `beacon_spots_near` clamps anyway.
       */
      const radiusKm = Math.min(
        200,
        Math.max(25, map.distance(centre, map.getBounds().getNorthEast()) / 1000)
      );

      /*
       * The "already loaded" guard has to scale with that radius. At 25 km a
       * 10 km move was a sixth of the loaded area; against a 200 km fetch it
       * was refetching the same rows on every small pan.
       */
      const reuseWithinM = Math.max(10_000, radiusKm * 1000 * 0.4);
      /*
       * And the guard has to know what radius the held data was fetched AT.
       * Zooming out without panning leaves the centre where it was, so a
       * distance-only test would keep serving the small answer forever and
       * the new ground would stay empty. Only a LARGER ask invalidates.
       */
      const staleRadius = loadedRadiusKm !== null && radiusKm > loadedRadiusKm * 1.25;
      if (
        loadedAt && !staleRadius &&
        map.distance(centre, L.latLng(loadedAt)) < reuseWithinM
      ) return;

      const spots = await fetchBeaconSpotsNear(centre.lat, centre.lng, radiusKm);
      if (cancelled) return;

      loadedAt = [centre.lat, centre.lng];
      loadedRadiusKm = radiusKm;
      render(spots);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 700);
    };

    load();
    map.on('moveend', load);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend', load);
      clear();
    };
  }, [isMapReady, isOfflineMode, beaconRefreshKey]);

  /* ------------------------------------------------------------------ */
  /* Facilities in view — the chips under the search                     */
  /* ------------------------------------------------------------------ */
  /**
   * Every toilet / tap / dump station on screen, from BOTH sources.
   *
   * Same shape as the Beacon layer above — own pane, debounced on `moveend`,
   * cleared at the start of the effect AND in the cleanup, because Leaflet
   * layers stack up invisibly otherwise. Three things differ.
   *
   * ONE: IT IS OFF BY DEFAULT AND ASKS NOTHING WHEN IT IS OFF. No chip on,
   * no Overpass query. This is the only layer on the map the camper switches
   * on deliberately, so it must cost nothing when they have not.
   *
   * TWO: A ZOOM FLOOR. Overpass will not answer a continent-sized box, and a
   * toilet drawn at country zoom is a dot in the wrong state anyway. Below
   * `FACILITY_MIN_ZOOM` the layer clears and reports `zoomed-out`, so the
   * chip row says "zoom in to look for toilets" — the one thing it must never
   * do is come back empty and let that read as "there are none".
   *
   * THREE: NO "ALREADY LOADED NEARBY" SHORT-CIRCUIT. The Beacon layer skips a
   * refetch while the centre has moved under 10 km, which it can afford
   * because it asks about a radius round that centre. The query here IS the
   * viewport box, so a zoom change with the centre unmoved is a completely
   * different question — and Leaflet fires `moveend` after a zoom, so the
   * reload happens without a second listener.
   *
   * Every outcome is reported upward — loading, failed, empty, capped — and
   * the wording lives in `facilityNotice`. An empty result is an absence of
   * survey, never an absence of facilities.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!facilityPinsLayerRef.current) return;
      try { map.removeLayer(facilityPinsLayerRef.current); } catch { /* detached */ }
      facilityPinsLayerRef.current = null;
    };

    // Nothing switched on, or no map to draw on: spend nothing.
    if (facilityKinds.length === 0 || isOfflineMode) {
      clear();
      facilityStateRef.current?.({ status: 'idle' });
      return;
    }

    if (!map.getPane('facilityPane')) {
      map.createPane('facilityPane');
      const pane = map.getPane('facilityPane');
      // Below the Beacon spots (600) and the hazard reports (610). A toilet
      // is the least urgent thing on this map and must never cover a washout.
      if (pane) pane.style.zIndex = '580';
    }

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const render = (facilities: MapFacility[]) => {
      clear();
      if (facilities.length === 0) return;

      const group = L.layerGroup([], { pane: 'facilityPane' });
      facilities.forEach((facility) => {
        // Same rule as the alerts, fires, reports and beacons: no icon on the
        // grey outside the supported region.
        if (!isWithinCoverage(facility.latitude, facility.longitude)) return;

        const { meaning } = facilitySourceStyle(facility.fromOsm, facility.confirmations);
        const marker = L.marker([facility.latitude, facility.longitude], {
          pane: 'facilityPane',
          icon: buildFacilityIcon(facility),
          // The tooltip carries where it came from, not just what it is —
          // hovering an unconfirmed pin says so before the camper drives to it.
          title: `${facility.name ?? FACILITY_LABEL[facility.kind]} — ${meaning}`,
          riseOnHover: true
        });
        marker.on('click', () => {
          /* One card at a time: tapping a pin puts away whatever control was
             open, because the card that is about to appear takes the same
             place on the screen. */
          setMapPanel(null);
          facilityTapRef.current?.(facility);
        });
        group.addLayer(marker);
      });

      facilityPinsLayerRef.current = group.addTo(map);
    };

    const run = async () => {
      if (map.getZoom() < FACILITY_MIN_ZOOM) {
        clear();
        facilityStateRef.current?.({ status: 'zoomed-out' });
        return;
      }

      facilityStateRef.current?.({ status: 'loading' });

      const bounds = map.getBounds();
      const centre = map.getCenter();
      /* The radius that covers the corners of the box, so the camper-added
         layer answers for everything the OpenStreetMap box does. Capped,
         because at low zoom the corner distance grows faster than usefulness. */
      const radiusKm = Math.min(
        map.distance(centre, bounds.getNorthEast()) / 1000,
        200
      );

      const [osm, pois, notes] = await Promise.all([
        fetchFacilitiesInView(
          {
            south: bounds.getSouth(), west: bounds.getWest(),
            north: bounds.getNorth(), east: bounds.getEast()
          },
          facilityKinds
        ),
        fetchPoisNear(centre.lat, centre.lng, Math.max(radiusKm, 1)),
        /* Notes ride along with the same viewport question rather than being
           fetched when a pin is tapped: a card that opens and THEN grows a
           paragraph is a card that moves under the thumb, and the whole read
           is one indexed query over the same box. */
        fetchPoiNotesNear(centre.lat, centre.lng, Math.max(radiusKm, 1))
      ]);
      if (cancelled) return;

      /* Camper rows arrive as every kind at once — the RPC does not filter by
         kind, because a camper toggling a second chip should not pay for a
         second round trip. Narrowing happens here. */
      const wanted = new Set(facilityKinds);
      const camperAdded = pois
        .map((row) => {
          const kind = facilityKindFromDb(row.kind);
          return kind && wanted.has(kind) ? poiToMapFacility(row, kind) : null;
        })
        .filter((f): f is MapFacility => f !== null)
        .filter((f) => bounds.contains(L.latLng(f.latitude, f.longitude)));

      const merged = mergeFacilities(camperAdded, osm.facilities);

      /* Attach each camper's note to the pin it is about. A note keyed to an
         OSM node and a note keyed to our own row can both land on the same
         merged pin, which is correct — they are notes about one tap. */
      if (notes.length > 0) {
        const byTarget = new Map<string, FacilityNote[]>();
        for (const row of notes) {
          const key = row.poi_id ? `poi:${row.poi_id}` : `osm:${row.osm_id}`;
          const list = byTarget.get(key);
          const note: FacilityNote = {
            id: row.id,
            body: row.body,
            authorName: row.author_name,
            createdAt: row.created_at
          };
          if (list) list.push(note);
          else byTarget.set(key, [note]);
        }

        for (const facility of merged) {
          const mine = [
            ...(facility.poiId ? byTarget.get(`poi:${facility.poiId}`) ?? [] : []),
            ...byTarget.get(`osm:${facility.id}`) ?? []
          ];
          if (mine.length > 0) facility.notes = mine;
        }
      }

      render(merged);

      /* `ok: false` means every Overpass mirror failed. Camper-added pins may
         still have arrived, and they are still drawn — but the row must say
         "couldn't check" rather than counting them as the whole answer. */
      facilityStateRef.current?.(
        osm.ok
          ? { status: 'done', count: merged.length, truncated: osm.truncated }
          : { status: 'failed' }
      );
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 700);
    };

    load();
    map.on('moveend', load);

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend', load);
      clear();
    };
    // `facilityKinds` is an array from a parent render. App memoises it, so
    // this depends on the identity rather than on a join of the contents.
  }, [isMapReady, isOfflineMode, facilityKinds, facilityRefreshKey]);

  /* ------------------------------------------------------------------ */
  /* The dropped destination pin                                         */
  /* ------------------------------------------------------------------ */
  /**
   * One pin at a time, and it stays until the user picks somewhere else.
   *
   * Nothing is drawn when the destination is an existing campsite — that pin
   * is already on the map and is highlighted instead, so a teardrop on top of
   * it would just be two markers claiming one spot.
   */
  const destinationHtmlRef = useRef('');
  /** The dropped pin's own memory of which chips it has popped in. */
  const destinationChipKeysRef = useRef<Set<string>>(new Set());
  /** Its answers, gathered so they arrive as one wave. See `createChipBatcher`. */
  const destinationBatchRef = useRef(createChipBatcher());
  const destinationDots = useMemo(() => {
    if (!destination || destination.campsite) return [];
    return withNavChip([
      ...hazardDots(warningsForPoint(destination.latitude, destination.longitude, hazards)),
      ...fireDots(nearbyFires),
      ...conditions,
      ...facilityDots(facilities)
    ]);
  }, [destination, hazards, nearbyFires, conditions, facilities]);
  const destinationDotsRef = useRef(destinationDots);
  destinationDotsRef.current = destinationDots;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      destinationBatchRef.current.cancel();
      if (!destinationMarkerRef.current) return;
      try { map.removeLayer(destinationMarkerRef.current); } catch { /* detached */ }
      destinationMarkerRef.current = null;
      destinationHtmlRef.current = '';
      destinationChipKeysRef.current = new Set();
    };

    clear();
    if (!destination || destination.campsite) return;

    destinationMarkerRef.current = L.marker(
      [destination.latitude, destination.longitude],
      {
        icon: buildDestinationIcon(
          destinationDotsRef.current,
          'Submit this spot as a place to camp',
          freshChipKeys(destinationChipKeysRef.current, destinationDotsRef.current),
          canBeacon
        ),
        title: 'Your chosen spot',
        zIndexOffset: 900
      }
    ).addTo(map);

    return clear;
    // Deliberately NOT keyed on the dots: the marker is created once per
    // dropped pin, and the row it carries is grown by the effect below as
    // each lookup lands. Rebuilding the marker instead would drop the pin
    // again, from the top, three times over. `canBeacon` IS in here — losing
    // the connection while a pin is open has to take the beacon button with
    // it, and that changes about as often as the pin does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, isMapReady, canBeacon]);

  /**
   * Grow the dropped pin's row as the lookups land, without redrawing it.
   *
   * Same rule as `refreshIcon` for submitted pins: if the row would come out
   * identical, the DOM is left alone, and the entrance animation belongs to
   * the drop rather than to every arrival after it.
   */
  useEffect(() => {
    if (!destinationMarkerRef.current) return;

    /*
     * Held back until the answers stop coming, so they arrive as one wave.
     *
     * A dropped pin on bare ground starts with NOTHING — every chip it will
     * ever wear (the warnings over it, the fires, the weather, the drive, the
     * track up the road) is a separate request. Applied as they landed, that
     * was five separate arrivals over a couple of seconds. The batcher gives
     * them a beat to catch up with each other and then plays the whole stack
     * in one go, which is what the press-and-hold peek has always looked like.
     */
    destinationBatchRef.current.schedule(() => {
      const marker = destinationMarkerRef.current;
      if (!marker) return;
      const dots = destinationDotsRef.current;
      const fresh = freshChipKeys(destinationChipKeysRef.current, dots);
      // Patched in place for the same reason a submitted pin is: rebuilding
      // the icon would drop the teardrop again and cut the chips off mid-pop.
      if (patchChipRow(marker.getElement(), dots, fresh)) return;
      const icon = buildDestinationIcon(
        dots, 'Submit this spot as a place to camp', fresh, canBeaconRef.current
      );
      const html = (icon.options.html as string) ?? '';
      if (html === destinationHtmlRef.current) return;
      destinationHtmlRef.current = html;
      marker.setIcon(icon);
    });
  }, [destinationDots]);

  /**
   * The open pin sits dead centre — or in the middle of whatever a card leaves.
   *
   * Dead centre is the ordinary case: nothing is over the map, so the pin gets
   * the middle of the screen, which is where a camper looks. When a card IS up
   * — the point card, or a spot's drawer — the pin is centred in the strip
   * above it instead, so the thing being described is never behind the thing
   * describing it. See `centreLeavingRoom`.
   *
   * Tapping a submitted spot also moves the camera IN, once per selection, so
   * the chips that just unfolded have room and the roads into the spot are
   * drawn. Only ever in, never out: the zoom you chose to browse at is yours.
   * The view being borrowed is remembered here and flown back to when the pin
   * is closed — see the effect below.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !destination) return;

    // A beat, so the chips are laid out and Leaflet has the marker on screen
    // before the camera measures anything.
    const timer = setTimeout(() => {
      try {
        const first = focusedDestRef.current !== destination;
        focusedDestRef.current = destination;
        const zoomTo = first && destination.campsite
          ? Math.max(map.getZoom(), CAMPSITE_FOCUS_ZOOM)
          : map.getZoom();

        const centre = centreLeavingRoom(
          map,
          L.latLng(destination.latitude, destination.longitude),
          overlayPxRef.current,
          zoomTo
        );

        // Already close enough that moving would just look twitchy.
        const shift = map
          .latLngToContainerPoint(centre)
          .distanceTo(map.getSize().divideBy(2));
        if (shift < 8 && zoomTo === map.getZoom()) return;

        // Remember where we were, but only for the zoom-in "borrow" a campsite
        // does — an ordinary POI pan just nudges the pin into view and should
        // recenter on the pin when it closes, not rewind to the old view.
        if (first && zoomTo !== map.getZoom() && !preFocusViewRef.current) {
          preFocusViewRef.current = { center: map.getCenter(), zoom: map.getZoom() };
        }

        if (prefersReducedMotion()) {
          map.setView(centre, zoomTo, { animate: false });
        } else if (zoomTo !== map.getZoom()) {
          map.flyTo(centre, zoomTo, { duration: 0.7 });
        } else {
          map.panTo(centre, { animate: true, duration: 0.45 });
        }
      } catch { /* map torn down mid-timeout */ }
    }, 70);

    return () => clearTimeout(timer);
  }, [destination, isMapReady]);

  /**
   * A card slides up, the map slides the pin out from under it — and back.
   *
   * Opening a card takes half the screen away, and the half it takes is the
   * half the pin was sitting in. So the map lifts the pin into the strip that
   * is left, and when the card closes it gives that borrowed view straight
   * back. Dragging the card between its snap points re-aims without saving
   * anything new, so however many times it is resized, closing it still returns
   * to the one view it interrupted.
   *
   * It does NOT give the view back when the pin itself has gone. Closing a pin
   * already restores the wider view the camper was browsing in, and two
   * restores racing each other on one frame is how you land somewhere neither
   * of them meant.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (overlayPx > 0) {
      if (readLat === null || readLon === null) return;
      if (!preSheetViewRef.current) {
        preSheetViewRef.current = { center: map.getCenter(), zoom: map.getZoom() };
      }
      // A beat, so the card has finished growing before the pin is aimed at
      // the gap above it.
      const timer = setTimeout(() => {
        try {
          const zoomNow = map.getZoom();
          const centre = centreLeavingRoom(
            map, L.latLng(readLat, readLon), overlayPx, zoomNow
          );
          const shift = map
            .latLngToContainerPoint(centre)
            .distanceTo(map.getSize().divideBy(2));
          if (shift < 8) return;
          if (prefersReducedMotion()) map.setView(centre, zoomNow, { animate: false });
          else map.panTo(centre, { animate: true, duration: 0.45 });
        } catch { /* map torn down mid-timeout */ }
      }, 120);
      return () => clearTimeout(timer);
    }

    const previous = preSheetViewRef.current;
    preSheetViewRef.current = null;
    if (!previous || readLat === null || readLon === null) return;

    try {
      if (prefersReducedMotion()) {
        map.setView(previous.center, previous.zoom, { animate: false });
      } else {
        map.panTo(previous.center, { animate: true, duration: 0.45 });
      }
    } catch { /* map torn down */ }
  }, [overlayPx, readLat, readLon, isMapReady]);

  /**
   * The point card belongs to the pin that opened it.
   *
   * Picking somewhere else, or letting the pin go, takes the card with it —
   * otherwise it sits there describing a point that is no longer on screen.
   */
  useEffect(() => { setPointCardOpen(false); }, [destination]);

  /**
   * Closing the card gives the camera back.
   *
   * The tap that opened a spot borrowed the view: it flew in to
   * `CAMPSITE_FOCUS_ZOOM` so the pin's chips had room. Tapping the X, or
   * going back, undoes exactly that — the map returns to the centre and zoom
   * it was at before, which is the wide view the camper was browsing in
   * rather than some fixed "zoomed out" level we picked for them.
   *
   * That is only possible when there IS a borrowed view to hand back —
   * `preFocusViewRef` is set once, the first time a CAMPSITE pin flies in.
   * Everything else that closes a pin — a dropped pin that never zoomed
   * anything, a facility, a second tap on a spot already focused — used to
   * leave the camera exactly where it was, which reads as the tap having
   * done nothing at all. So when there is nothing to restore, the camera
   * instead steps back a touch from wherever the pin just was: not the
   * precise old view, just enough motion to say "that closed".
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || destination) return;

    const previous = preFocusViewRef.current;
    const lastPoint = focusedDestRef.current;
    preFocusViewRef.current = null;
    focusedDestRef.current = null;

    try {
      if (previous) {
        if (prefersReducedMotion()) {
          map.setView(previous.center, previous.zoom, { animate: false });
        } else {
          map.flyTo(previous.center, previous.zoom, { duration: 0.7 });
        }
        return;
      }

      if (!lastPoint) return;
      const centre = L.latLng(lastPoint.latitude, lastPoint.longitude);
      const zoomOut = Math.max(map.getMinZoom(), map.getZoom() - 1);
      if (prefersReducedMotion()) {
        map.setView(centre, zoomOut, { animate: false });
      } else {
        map.flyTo(centre, zoomOut, { duration: 0.6 });
      }
    } catch { /* map torn down */ }
  }, [destination, isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Weather alerts — one soft area per warned region                     */
  /* ------------------------------------------------------------------ */
  /**
   * Active alerts, every one of them drawn as a cloud over the ground the
   * agency named. Fire, flood, smoke, rain, storm, heat, cold and wind differ
   * only in colour.
   *
   * Only alerts the feed gave a geometry for can be drawn. NWS sends
   * `geometry: null` for its zone-based products, and those are counted and
   * reported rather than dropped silently or, worse, shaded over a guessed
   * area — a fire warning shown over the wrong valley is actively dangerous.
   * The count of undrawable alerts is surfaced in the status chip.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!hazardLayerRef.current) return;
      try { map.removeLayer(hazardLayerRef.current); } catch { /* detached */ }
      hazardLayerRef.current = null;
    };

    if (isOfflineMode) {
      clear();
      setHazards([]);
      // Offline is its own notice, top-left. A second one naming an agency
      // that was never going to be asked would just be noise.
      setAlertGap(null);
      return;
    }

    // Layer off: clear the existing overlays and skip the fetch. The
    // hazard state is intentionally NOT cleared — the per-pin
    // destination sheet and campsite bottom sheet read from `hazards`
    // directly, so a hidden layer does not silence the pin card. A
    // camper who has the layer off still sees "Heat advisory nearby"
    // on the pin they're considering — which is the point of having
    // the layer toggleable without losing safety context.
    if (!showWarnings) {
      clear();
      return;
    }

    // ONE pane, because there is now one thing to draw.
    //
    //   warningCloudPane — every warned area, whatever the family. Blurred as a
    //                      whole (see CLOUD_BLUR_PX), which is what turns a
    //                      shape with an edge into a cloud without one.
    //
    // There used to be two more: a sharp pane for the outline of a fire or
    // flood polygon, and an icon pane for the teardrop pins that sat on top of
    // them. Both went when those families started clouding like everything
    // else — see alertOverlay.ts.
    //
    // pointer-events:none, so a tap on a cloud falls straight through to the
    // map, which drops a spot and shows the warning in that spot's sheet. That
    // is deliberately the only way to read a warning: the sheet knows the
    // alert covers the point under your thumb, which an icon floating in the
    // middle of a forecast region never did.
    if (!map.getPane('warningCloudPane')) {
      map.createPane('warningCloudPane');
      const cpane = map.getPane('warningCloudPane');
      if (cpane) {
        cpane.style.zIndex = '455';
        cpane.style.pointerEvents = 'none';
        /**
         * THE CLOUD'S SOFT EDGE, IN ONE LINE.
         *
         * A compositor blur over the whole pane, exactly how the boundary
         * layer draws its uncertainty band. The alternative — feathering each
         * shape with a stack of translucent strokes — costs a path per ring
         * per step, and an SVG filter per shape was what made the old cloud
         * layer re-rasterise the map on every frame of a pan. This is one
         * GPU-composited blur for every warning on screen.
         *
         * Screen-space on purpose: the softness is a statement about how well
         * the edge is known, which does not sharpen up because you zoomed in.
         */
        cpane.style.filter = `blur(${CLOUD_BLUR_PX}px)`;
      }
    }
    // Canvas for the clouds: they are big, they are blurred, and a canvas is
    // what the pane-level blur is cheap on — the GPU blurs one bitmap rather
    // than re-rasterising a tree of paths.
    if (!warningCloudRendererRef.current) {
      warningCloudRendererRef.current = L.canvas({ pane: 'warningCloudPane', padding: 0.3 });
    }
    // Non-null: just created above if missing.
    const cloudRenderer = warningCloudRendererRef.current!;

    /**
     * WHAT USED TO BE HERE, AND WHY IT IS GONE. TWICE.
     *
     * FIRST VERSION. Every area event was a "cloud" built three ways at once:
     * a per-polygon radial gradient hand-written into the renderer's <defs>, a
     * per-path CSS blur, and the family's glyph TILED across the whole shape.
     * All of it re-measured on every zoom, because the gradients lived in
     * projected screen space. The tiling is what put a dozen lightning bolts
     * across one valley for a single storm warning.
     *
     * SECOND VERSION. A flat fill with a crisp 2px outer stroke on the merged
     * forecast zones. Cheap and legible, and wrong in the one way this app
     * cannot be wrong: it drew the SURVEYED EDGES of administrative regions as
     * the edge of the weather. Smoke does not stop at a township line. The
     * outline also had to be reconstructed from cancelled segments, and when
     * that reconstruction could not close a chain it drew a straight line
     * across the shape and left the rest over as a second phantom polygon.
     *
     * NOW. The zones are grouped into contiguous areas, simplified, rounded
     * off, and drawn on a canvas in a pane with one compositor blur over it.
     * No gradients, no defs, no tiling, no reconstructed outline, and no edge
     * anywhere that claims to be where the hazard stops.
     */

    let cancelled = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // The area the current warnings were fetched for. A pan or zoom whose new
    // view still sits inside this padded box reuses what is already drawn
    // instead of refetching and rebuilding — which is what made the overlays
    // blink out and back on every gesture. Warnings do not depend on zoom, so
    // only leaving the loaded area triggers a refetch.
    let loadedAlertBox: L.LatLngBounds | null = null;
    // The latest fetch's request id. A slow older fetch that returns after
    // a newer one must NOT overwrite the newer data — without this guard,
    // a storm in Ontario can flicker when a slow refetch from a Calgary
    // pan lands after a fast Ontario refetch. The boundary effect uses the
    // same pattern; doing it here too is what stops the "shows up then
    // disappears" flicker on the warning layer.
    let requestId = 0;
    /**
     * Backoff for a lookup that could not complete.
     *
     * A camper who reopens the app on a waking radio gets one failed request
     * and then, with the box-loaded guard suppressing `moveend` refetches,
     * nothing at all until they pan. So a failure schedules its own retry —
     * doubling from 4 seconds up to a minute, reset the moment one succeeds.
     *
     * Capped rather than infinite-backoff-forever because the common case here
     * is a phone that will be back on signal within a minute, and the whole
     * point is that the warnings return without the camper doing anything.
     */
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 4000;
    const RETRY_MAX = 60_000;

    /**
     * A FLOOR ON HOW OFTEN THE AGENCIES GET ASKED, WHATEVER THE MAP DOES.
     *
     * The coverage guard above is about whether we NEED to ask; this is about
     * how often we are willing to, and the two are not the same thing. Zoomed
     * out past the server's clamp the covered area is always smaller than the
     * view, so the guard can never hold and a camper dragging the map across a
     * province would otherwise fire a National Weather Service and an
     * Environment Canada query every time their thumb settled.
     *
     * Fifteen seconds, with the suppressed attempt scheduled rather than
     * dropped — a warning must never be missed because a request was throttled,
     * only delayed. Both government feeds are free, unfunded and shared by
     * everybody; this is the difference between using them and leaning on them.
     */
    const MIN_FETCH_GAP_MS = 15_000;
    let lastFetchStartedAt = 0;
    let pendingRunTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAlertRetry = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
        void run();
      }, retryDelay);
    };

    /**
     * Draw the active warnings. Every family draws the same way: one soft area
     * per contiguous warned region, in that family's colour, no icons.
     *
     * Fire and flood used to be the exception, drawn as teardrop pins on the
     * alert's centroid. They are not any more, and alertOverlay.ts carries the
     * reasoning — the short version is that a red flag warning and a flash
     * flood warning are issued over a polygon like everything else, so the
     * centroid was the middle of an administrative shape and a pin on it
     * claimed somebody had stood there.
     *
     * THE MERGE IS THE POINT. Environment Canada and the NWS issue these
     * products once per forecast zone, so a single rainfall warning arrives as
     * eleven adjacent blocks. Drawn as they come, that is a honeycomb of
     * internal lines — which is what the map looked like before, and it read
     * as eleven separate warnings. `cloudPieces` groups the blocks that touch
     * into ONE area and softens their surveyed edges away.
     *
     * Alerts the feed gave no geometry for are counted, never pinned to a guess.
     *
     * NOTHING IS CLAIMED OUTSIDE THE COVERAGE AREA. The weather feeds are wider
     * than this app is: a viewport near the border pulls back marine zones out
     * in the Atlantic, Mexican border counties, whole territories north of 60°.
     * The grey coverage mask sits above every layer on the map (pane 645), so
     * anything reaching past the line is greyed out with the ground it covers.
     */
    const render = (alerts: HazardAlert[]) => {
      const group = L.layerGroup([]);
      /** Alerts gathered by family, so each family clouds as one. */
      const areas = new Map<AlertBadge, HazardAlert[]>();

      alerts.forEach((alert) => {
        if (!alert.geometry) return;
        const badge = alertBadge(alert);
        if (!badge) return;

        /**
         * NO CENTROID TEST HERE, and that is the fix for the smoke area that
         * blinked in and out over BC.
         *
         * An area is drawn from its geometry, so it never needed the alert's
         * single centroid — but it was being filtered on it, and that centroid
         * is the average of the biggest region in the alert. For a coastal BC
         * region it lands in the Pacific, outside coverage, and the whole
         * warning was dropped. Worse, Environment Canada publishes one row per
         * region and the server merges the rows it can see, so panning changed
         * which regions were merged, which moved the centroid, which flipped
         * the test — the area appeared and vanished as you dragged.
         *
         * The centroid is not used to DRAW anything any more either. Fire and
         * flood used to be pinned on it; see the note at the top of the
         * "EVERY OFFICIAL WARNING IS AN AREA" section in alertOverlay.ts.
         */
        const bucket = areas.get(badge);
        if (bucket) bucket.push(alert);
        else areas.set(badge, [alert]);
      });

      areas.forEach((familyAlerts, badge) => {
        const pieces = cloudPieces(familyAlerts.map((a) => a.geometry));
        if (pieces.length === 0) return;
        // The wash is the light tint; anything that names this family keeps the
        // saturated colour. See CLOUD_TINT for why they differ.
        const color = CLOUD_TINT[badge] ?? BADGE_COLOR[badge];

        pieces.forEach((piece) => {
          /**
           * ONE PATH PER AREA, and the softening is already in the geometry.
           *
           * `fillRule: 'nonzero'` is what makes two overlapping warnings of the
           * same family read as one mass instead of punching a hole where they
           * cross — Leaflet's default is `evenodd`, which does exactly that
           * hole. The stroke is wide, dim and the same colour as the fill: once
           * the pane blur lands on it, it is a slightly denser rim rather than
           * a line, which is what stops the cloud from looking like a spill.
           */
          group.addLayer(
            L.geoJSON(piece.shape, {
              pane: 'warningCloudPane',
              renderer: cloudRenderer,
              interactive: false,
              style: {
                color,
                // The rim: wide, soft, and denser than the middle. Blurred it
                // stops being a line and becomes the edge of a bank of weather,
                // which is what gives the cloud a shape you can see at a glance
                // without ever drawing an edge you could point at.
                weight: 14,
                opacity: 0.45,
                fill: true,
                // Dense enough to see over bright green farmland and dark
                // forest alike, light enough to read the ground through. A
                // warning you cannot see is the same as no warning.
                fillOpacity: 0.3,
                fillRule: 'nonzero',
                lineJoin: 'round',
                lineCap: 'round'
              }
            } as RenderedGeoJSONOptions)
          );

          /**
           * NO BADGE ON A WARNED AREA. There used to be one per area.
           *
           * A cloud covers ground the camper is not asking about. Pinning an
           * icon in the middle of it put a tappable thing on the map at a
           * point that means nothing — the centre of a smoke area is not
           * where the smoke is, it is just the middle of some forecast
           * regions — and it competed for the thumb with the campsite pins,
           * which are what the map is actually for.
           *
           * These warnings are read where they matter instead: as a chip on
           * the pin you are standing on, whether that is a submitted spot or
           * a pin you dropped on bare ground. That chip knows the warning
           * covers THAT point, which the badge never did, and tapping it runs
           * the tour that goes and shows you the area. See `runAlertTour`.
           */
        });
      });

      // Swap: the fresh layer goes on the map before the old one comes off, so
      // there is no blank frame between one render and the next.
      const previous = hazardLayerRef.current;
      hazardLayerRef.current = group.addTo(map);
      if (previous) { try { map.removeLayer(previous); } catch { /* detached */ } }
    };

    const run = async () => {
      const b = map.getBounds();
      // Still inside the area we last fetched for: the warnings already cover
      // the view, so leave them exactly as they are. This is the guard that stops
      // the constant refetch-and-rebuild on every small pan or zoom.
      if (loadedAlertBox && loadedAlertBox.contains(b)) return;

      // Asked too recently. Not dropped — re-armed for the moment the floor
      // lifts, so a genuinely new view still gets its warnings.
      const since = Date.now() - lastFetchStartedAt;
      if (since < MIN_FETCH_GAP_MS) {
        if (!pendingRunTimer) {
          pendingRunTimer = setTimeout(() => {
            pendingRunTimer = null;
            void run();
          }, MIN_FETCH_GAP_MS - since);
        }
        return;
      }
      lastFetchStartedAt = Date.now();

      controller?.abort();
      const myId = ++requestId;
      controller = new AbortController();

      // Fetch a generously padded box — three times the viewport in each
      // dimension — so a zoom-out from a centred view still sits inside
      // the loaded area and reuses the data. The 0.4 pad (a 1.4x box) was
      // tight enough that zooming out a level invalidated the loaded box
      // and triggered a refetch that, in the worst case, returned the
      // same alert with `centroid: null` for a moment and the warning
      // disappeared mid-pan. 1.0 is the floor that keeps a multi-zoom-out
      // gesture from churning the layer.
      const padded = b.pad(1.0);
      const result = await fetchAreaAlerts(
        {
          minLat: padded.getSouth(), minLon: padded.getWest(),
          maxLat: padded.getNorth(), maxLon: padded.getEast()
        },
        controller.signal
      );
      // A newer fetch has started, OR the effect is unmounted. Either
      // way, do not write over fresher data.
      if (cancelled || myId !== requestId) return;

      /**
       * A LOOKUP THAT FAILED LEAVES THE WARNINGS EXACTLY WHERE THEY ARE.
       *
       * This is the "I came back to the app and the clouds were gone" bug, and
       * it had two halves that made each other worse.
       *
       * Backgrounding a phone browser kills in-flight requests and drops the
       * radio. Coming back fires a resize, which fires `moveend`, which ran
       * this — against a network that had not woken up yet. The fetch failed,
       * failure was indistinguishable from an empty sky, and `render([])` wiped
       * every cloud off the map.
       *
       * Then the second half: `loadedAlertBox` was set REGARDLESS of the
       * outcome, so the "we already have this area" guard at the top of `run`
       * suppressed every retry. The warnings did not come back when the signal
       * did — they stayed gone until the camper panned clean out of the box.
       *
       * So: on a failure, keep the layer, do not record the box, and let the
       * next `moveend` — or the retry below — have another go. Drawing nothing
       * is a claim that there is nothing, and that is the one claim this app
       * must never make about a weather warning.
       */
      if (!result.ok) {
        if (!result.aborted) {
          scheduleAlertRetry();
          /*
           * The clouds already drawn stay, and now they carry a date stamp of
           * sorts: a line saying the check did not go through. Warnings left on
           * screen with nothing said about them are the stale-and-silent case
           * this whole path exists to avoid.
           */
          setAlertGap(
            'Warnings could not be checked just now. Anything shaded below is ' +
            'from the last successful check, and may have changed.'
          );
        }
        return;
      }

      /**
       * A HALF-ANSWER IS DRAWN, AND THEN SAID OUT LOUD.
       *
       * `partial` means one agency answered and the other did not; `clipped`
       * means the server narrowed the query because the view was too wide to
       * ask about (see MAX_SPAN_LAT in server/weatherRoutes.ts). Either way the
       * warnings that came back are real and get drawn — but the area is NOT
       * recorded as loaded, so the guard at the top of `run` cannot suppress
       * the next attempt, and the retry keeps going until the gap closes.
       *
       * This is the other half of the fix for the map that shaded the American
       * side of the border and left Canada blank. The server used to throw a
       * half-answer away entirely, which did not make the map honest — it just
       * left the previous answer on screen with nothing saying it was stale.
       */
      /*
       * ---------------------------------------------------------------
       * WHAT COUNTS AS LOADED, AND WHY IT IS NEVER "NOTHING"
       * ---------------------------------------------------------------
       *
       * This used to set `loadedAlertBox = null` for any answer that was not
       * perfect, which meant the guard at the top of `run` could not suppress
       * anything and EVERY pan re-asked the agencies. Two situations made that
       * permanent rather than temporary, and both are the common case:
       *
       *   CLIPPED is not a failure. The server deliberately narrows a very
       *   wide viewport (MAX_SPAN_LAT) and tells us how much it really
       *   covered. Zoomed out far enough, every answer is clipped forever —
       *   so the map re-queried the National Weather Service and Environment
       *   Canada on every single pan, indefinitely, by design.
       *
       *   PARTIAL means one agency did not answer. Refetching on every pan is
       *   the worst possible response to an agency that is already
       *   struggling: it is a retry storm aimed at the thing that is down,
       *   and it makes the outage that produced it worse.
       *
       * So the area actually covered is always recorded, and recovery is the
       * TIMED retry's job — which already exists, already backs off, and
       * already resets on success. The camper's thumb is not a retry policy.
       */
      const covered = result.area
        ? L.latLngBounds(
            [result.area.minLat, result.area.minLon],
            [result.area.maxLat, result.area.maxLon]
          )
        : padded;

      loadedAlertBox = covered;

      if (result.partial) {
        // Still incomplete, so keep asking — on a clock, not on every gesture.
        scheduleAlertRetry();
      } else {
        retryDelay = 4000;
      }

      setAlertGap(alertGapNote(result));

      const sorted = sortAlerts(result.alerts);
      setHazards(sorted);
      render(sorted);
    };

    const load = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 600);
    };

    load();
    // Nothing to re-measure on zoom any more: the fill, the stroke and the
    // badge are all plain geometry Leaflet re-projects itself.
    map.on('moveend zoomend', load);

    /**
     * Coming back to the app re-checks the warnings.
     *
     * A phone that has been in a pocket for two hours is showing warnings from
     * two hours ago, and a warning that has since been cancelled — or a new one
     * that has since been issued — is exactly the thing a camper reopens the
     * app to find out about. `moveend` does not reliably fire on return, and
     * when it does the box-loaded guard swallows it, so ask explicitly.
     *
     * `loadedAlertBox` is dropped first so the guard cannot suppress this one.
     */
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      loadedAlertBox = null;
      load();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);

    return () => {
      cancelled = true;
      controller?.abort();
      if (debounce) clearTimeout(debounce);
      if (retryTimer) clearTimeout(retryTimer);
      if (pendingRunTimer) clearTimeout(pendingRunTimer);
      map.off('moveend zoomend', load);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      clear();
      // Drop the renderer too, so a remount does not stack a second one.
      if (warningCloudRendererRef.current) {
        try { map.removeLayer(warningCloudRendererRef.current); } catch { /* detached */ }
        warningCloudRendererRef.current = null;
      }
    };
  }, [isMapReady, isOfflineMode, showWarnings]);

  /* ------------------------------------------------------------------ */
  /* Active fires near the point being read                              */
  /* ------------------------------------------------------------------ */
  /**
   * Ask "is anything burning near HERE" once, for the one point that is open.
   *
   * This replaces the viewport-wide fire layer. That version fetched every
   * incident on screen and drew a flame on each; this one fetches a padded box
   * around the open pin and turns the answer into a single dot above it. It
   * costs one request per selection instead of one per pan, and nothing is
   * drawn on ground the camper has not asked about.
   *
   * Debounced and aborted on the way out, like the facility lookup, so walking
   * down a line of pins does not leave the previous pin's fires over the new
   * one. Offline it stays empty — and empty means "not asked", never "clear".
   */
  useEffect(() => {
    setNearbyFires([]);
    if (readLat === null || readLon === null || isOfflineMode) return;

    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(async () => {
      const box = boxAround(readLat, readLon, FIRE_ALERT_RADIUS_KM);
      const data = await fetchActiveFires(box, controller.signal);
      if (cancelled) return;
      setNearbyFires(
        findFiresNear(
          data.features.map((f) => f.properties),
          readLat, readLon, FIRE_ALERT_RADIUS_KM
        )
      );
    }, 300);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [readLat, readLon, isOfflineMode]);

  /* ------------------------------------------------------------------ */
  /* State / province boundary lines (Natural Earth admin-1)           */
  /* ------------------------------------------------------------------ */
  /**
   * Draw the admin-1 lines.
   *
   *   - Outline-only: no fill. The lines are a context, not a
   *     highlight — filling would compete with the campsite pins,
   *     the boundary fills, the warnings, and the fire markers.
   *   - Light slate, 1 px at most zoom levels; 1.4 px above zoom 8
   *     so a state line at city zoom doesn't get antialiased to
   *     nothing.
   *   - Above the boundary fills (which is at boundariesPane, z 440),
   *     below the campsite pins and the warning layers, so it
   *     doesn't sit on top of anything that already does the job
   *     of "draw my attention here".
   *   - Same fetch/render pattern as the warnings and fires:
   *     250 ms debounce, requestId guard, padded bbox, clear-on-off.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = (): void => {
      if (!admin1LayerRef.current) return;
      try { map.removeLayer(admin1LayerRef.current); } catch { /* detached */ }
      admin1LayerRef.current = null;
    };

    if (isOfflineMode) {
      clear();
      return;
    }

    if (!showAdmin1) {
      clear();
      return;
    }

    if (!map.getPane('admin1Pane')) {
      map.createPane('admin1Pane');
      const pane = map.getPane('admin1Pane');
      if (pane) {
        // Above boundariesPane (440), below warnings (460) and fires
        // (560). The line is a context, so it sits visually behind the
        // safety layers — and, like all of them, under the grey
        // coverage mask at 645.
        pane.style.zIndex = '450';
      }
    }

    const padded = (): BoundingBox => requestBoxFor({
      minLat: map.getBounds().getSouth(),
      minLon: map.getBounds().getWest(),
      maxLat: map.getBounds().getNorth(),
      maxLon: map.getBounds().getEast()
    }, map.getZoom());

    let requestId = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    /** Which regions are currently drawn, so an identical set is a no-op. */
    let drawnKey = '';

    const renderAdmin1 = (features: Array<{ type: 'Feature'; geometry: GeoJSON.Geometry; properties: Admin1 }>): void => {
      const z = map.getZoom();
      /**
       * Canvas, not SVG. Fifty states and thirteen provinces are tens of
       * thousands of vertices, and as SVG that is tens of thousands of
       * DOM nodes for the browser to re-project on every pan — which is
       * precisely the kind of thing that makes this map stutter. On a
       * canvas it is one element and a draw call.
       */
      const renderer = L.canvas({ pane: 'admin1Pane', padding: 0.5 });

      const layer = L.geoJSON(
        { type: 'FeatureCollection', features } as unknown as GeoJSON.FeatureCollection,
        // `renderer` is forwarded to each Path Leaflet builds, but it is
        // missing from the GeoJSON options type, hence the assertion.
        {
          pane: 'admin1Pane',
          renderer,
          interactive: false,
          style: {
            // Slate-500 at 60% — visible on satellite, visible on
            // street, doesn't shout. The "under it" line of
            // cartography, not the "look at me" line.
            color: 'rgb(100 116 139)',
            opacity: 0.6,
            // A hair thicker close in, so a state line at city zoom
            // doesn't get antialiased down to nothing.
            weight: z >= 8 ? 1.4 : 1.0,
            fill: false,
            lineJoin: 'round'
          }
        } as L.GeoJSONOptions
      );

      const previous = admin1LayerRef.current;
      admin1LayerRef.current = layer.addTo(map);
      if (previous) {
        try { map.removeLayer(previous); } catch { /* detached */ }
      }
    };

    const run = async (): Promise<void> => {
      const myId = ++requestId;
      const data = await fetchAdmin1(padded());
      if (cancelled || myId !== requestId) return;

      /**
       * Redraw only when the set of visible regions actually changes.
       *
       * The lookup is local now, so re-filtering on every pan is free —
       * but rebuilding the layer is not, and panning across Wyoming
       * would otherwise throw away and re-create the same geometry
       * dozens of times. Comparing the region list is the cheap way to
       * tell a real change from a nudge.
       *
       * The previous version cached the loaded BOX instead, and skipped
       * any view inside it. That kept every polygon it had ever seen:
       * zoom out once to the whole continent and all sixty-four regions
       * stayed loaded and drawn for the rest of the session, no matter
       * how far back in you went.
       */
      // The zoom tier is part of the key because it decides line weight;
      // without it, crossing zoom 8 inside one state never restyles.
      const key = `${map.getZoom() >= 8 ? 'near' : 'far'}:` +
        data.features.map((f) => f.properties.isoCode).sort().join('|');
      if (key === drawnKey && admin1LayerRef.current) return;
      drawnKey = key;
      renderAdmin1(data.features);
    };

    const schedule = (): void => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { run().catch(() => undefined); }, 250);
    };

    map.on('moveend zoomend', schedule);
    schedule();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', schedule);
      clear();
    };
  }, [isMapReady, isOfflineMode, showAdmin1]);

  /**
   * WHICH PROVINCE AM I LOOKING AT, AND DO WE KNOW ANYTHING ABOUT IT.
   *
   * A point-in-polygon test against the bundled outlines — no request, no key,
   * works offline — run on the centre of the viewport and debounced like every
   * other pan handler here.
   *
   * The centre rather than the whole viewport on purpose. A box straddling the
   * Quebec–Ontario line would otherwise have to choose between two answers or
   * show both, and a chip that flickers between provinces as you drag is worse
   * than no chip. What you are looking at is what is in the middle.
   *
   * Runs regardless of `showBoundaries` — the state is cheap and the chip that
   * reads it does the gating — and independently of the boundary fetch, so a
   * province with no source still gets its say. That independence is the whole
   * point: the sources that answer are exactly the ones this is not about.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let requestId = 0;

    const run = async (): Promise<void> => {
      const myId = ++requestId;
      const centre = map.getCenter();
      const hit = await findAdmin1At(centre.lat, centre.lng);
      if (cancelled || myId !== requestId) return;

      const gap = landDataGap(hit?.isoCode);
      // No region under the centre is not the same as a region with no gap,
      // but both end the same way here: nothing to say, so say nothing.
      setCentreGap(hit && gap ? { name: hit.name, gap, isoCode: hit.isoCode } : null);
    };

    const schedule = (): void => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { run().catch(() => undefined); }, 250);
    };

    map.on('moveend zoomend', schedule);
    schedule();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      map.off('moveend zoomend', schedule);
    };
  }, [isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Markers                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Which sources are real enough to earn a pin.
   *
   * The original rule was `user_submitted` only, and the reasoning was sound
   * for the sources that existed then: a marker asserts "there is a place
   * here", while a curated row or an OpenStreetMap node inferred from tagging
   * asserts "a database says there is public land around here" — which the
   * boundary polygons already say, more honestly, at their true resolution.
   *
   * `agency_dataset` breaks that symmetry and has to be pinned. These are not
   * inferences about land: they are named campgrounds that a government
   * operates and publishes, with a defined number of sites. Marble River is
   * not "public land near Port McNeill", it is a campground with 35 pitches
   * run by Recreation Sites and Trails BC. Withholding a pin from that is not
   * caution, it is hiding a campsite from somebody looking for one — 832 of
   * them went into the database and none appeared on the map.
   *
   * The curated rows and OpenStreetMap nodes stay unpinned, for exactly the
   * original reason. They still fill the list, are searchable, and are still
   * what the filters filter.
   */
  const PINNED_SOURCES = new Set(['user_submitted', 'agency_dataset']);
  const pinnedCampsites = React.useMemo(
    () => campsites.filter((site) => PINNED_SOURCES.has(site.source)),
    [campsites]
  );

  /**
   * The dots for each pinned site, worked out once per list change.
   *
   * Held in a ref as well so `iconForId` can stay a stable callback — it is a
   * dependency of the cluster effect, and giving it a new identity on every
   * render would tear down and rebuild every marker on the map.
   */
  const amenityDotsById = React.useMemo(() => {
    const byId = new Map<string, MarkerDot[]>();
    for (const site of pinnedCampsites) byId.set(site.id, amenityDots(site.amenities));
    return byId;
  }, [pinnedCampsites]);
  const amenityDotsRef = useRef(amenityDotsById);
  amenityDotsRef.current = amenityDotsById;

  /**
   * Which chips the OPEN pin has already popped in.
   *
   * One set, not one per pin, because only one pin is ever open: it is
   * emptied on every tap, so the stack always plays from nothing, and a
   * lookup landing afterwards only animates the chip it brought.
   */
  const shownChipKeysRef = useRef<Set<string>>(new Set());
  /** The open pin's answers, gathered so they arrive together as one wave. */
  const openBatchRef = useRef(createChipBatcher());

  /**
   * The press-and-hold peek.
   *
   * `peekSwallowClickRef` is read by the marker's own click handler, which
   * Leaflet fires on release — a hold that showed the stack must not also
   * select the spot.
   */
  const peekRef = useRef<{
    wrap: Element;
    timer: number | null;
    startX: number;
    startY: number;
    open: boolean;
  } | null>(null);
  const peekSwallowClickRef = useRef(false);

  /**
   * Icon for a pinned site: hollow or filled, with its dot row.
   *
   * Hazards lead the row. A heat warning or smoke over the spot changes
   * whether to go at all, which outranks anything about the spot itself.
   */
  const dotsForId = useCallback((id: string): MarkerDot[] => {
    const isSelected = selectedIdRef.current === id;
    const dots = [
      ...hazardDots(badgesByIdRef.current.get(id) ?? []),
      // A fire burning up the valley, for the open pin only — it is one
      // request per selection, and it is where the map's flame layer went.
      ...(isSelected ? fireDots(nearbyFiresRef.current) : []),
      // Weather, signal and the land under it: also the open pin only,
      // because App fetches them for the point that is open.
      ...(isSelected ? conditionsRef.current : []),
      ...(amenityDotsRef.current.get(id) ?? []),
      // Facilities up the road belong to the open pin only — they are the
      // one part of the row you can tap through to, and they are only
      // looked up for the spot being read.
      ...(isSelected ? facilityDots(facilitiesRef.current) : [])
    ];
    // Only the open pin gets the car chip: a resting pin's ring of dots is
    // facts about the spot, and "you could drive here" is not one of them.
    return isSelected ? withNavChip(dots) : dots;
  }, []);

  /**
   * Which pins are a government's campground rather than a camper's spot.
   *
   * Held as a set of ids because `iconForId` has to stay a stable callback —
   * it is a dependency of the cluster effect, and a new identity there tears
   * down and rebuilds every marker on the map.
   */
  const officialIdsRef = useRef<Set<string>>(new Set());
  officialIdsRef.current = useMemo(
    () => new Set(
      campsites.filter((s) => s.source === 'agency_dataset').map((s) => s.id)
    ),
    [campsites]
  );

  /** The glyph axis: what kind of place each pin is, where anybody has said. */
  const settingByIdRef = useRef<Map<string, CampsiteSetting>>(new Map());
  settingByIdRef.current = useMemo(() => {
    const map = new Map<string, CampsiteSetting>();
    campsites.forEach((s) => { if (s.setting) map.set(s.id, s.setting); });
    return map;
  }, [campsites]);

  const iconForId = useCallback((id: string, animate = false) => {
    const isSelected = selectedIdRef.current === id;
    // A fresh tap forgets what the last one showed, so the stack replays.
    if (animate) shownChipKeysRef.current = new Set();
    const dots = dotsForId(id);
    return buildCampsiteIcon(
      isSelected,
      dots,
      isSelected ? freshChipKeys(shownChipKeysRef.current, dots) : undefined,
      id,
      officialIdsRef.current.has(id) ? 'official' : 'camper',
      settingByIdRef.current.get(id) ?? null
    );
  }, [dotsForId]);

  /**
   * Bring a marker up to date with the least DOM possible.
   *
   * A pin's row grows in stages — the tap, then the fires, then the weather,
   * then whatever OpenStreetMap has up the road. Rebuilding the icon for each
   * stage is what made the pin blink and cut chips off mid-pop, so an open
   * pin that is already on screen has the new chips PATCHED into the row it
   * already has (`patchChipRow`) and is never redrawn.
   *
   * The full rebuild is kept for the two cases that really do change the
   * marker: the tap itself, which fills the ring and grows the buttons under
   * it, and a marker that is not currently rendered.
   */
  const refreshIcon = useCallback((id: string, animate = false) => {
    const marker = markersRef.current.get(id);
    if (!marker) return;
    const isSelected = selectedIdRef.current === id;
    const open = marker.getElement()?.firstElementChild?.classList.contains('wl-pin-wrap-on');

    if (isSelected && !animate && open) {
      /*
       * Collected, not applied on the spot. The lookups behind an open pin
       * finish at different times, and patching each one in as it lands is
       * what turned one stack into four dribbles. See `createChipBatcher`.
       */
      openBatchRef.current.schedule(() => {
        const live = markersRef.current.get(id);
        if (!live || selectedIdRef.current !== id) return;
        const dots = dotsForId(id);
        if (patchChipRow(
          live.getElement(),
          dots,
          freshChipKeys(shownChipKeysRef.current, dots)
        )) {
          // The cached HTML no longer describes the DOM, so the next full
          // rebuild must not be skipped as a no-op.
          iconHtmlRef.current.delete(id);
          return;
        }
        // Clustered away or not yet on screen: fall back to a full rebuild.
        const rebuilt = iconForId(id);
        iconHtmlRef.current.set(id, (rebuilt.options.html as string) ?? '');
        live.setIcon(rebuilt);
      });
      return;
    }

    const icon = iconForId(id, animate);
    const html = (icon.options.html as string) ?? '';
    if (!animate && iconHtmlRef.current.get(id) === html) return;
    iconHtmlRef.current.set(id, html);
    marker.setIcon(icon);
  }, [iconForId, dotsForId]);

  // Rebuilt only when the campsite list changes. Selection is handled
  // separately below — previously changing the selection tore down and rebuilt
  // every marker on the map, which stuttered badly with a few hundred pins.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (clusterRef.current) {
      try { map.removeLayer(clusterRef.current); } catch { /* detached */ }
    }
    markersRef.current.clear();
    iconHtmlRef.current.clear();

    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      /**
       * How close two pins must be, in screen pixels, before they merge.
       *
       * This was 40 — barely more than the 32px width of a pin — so pins only
       * grouped once they were already overlapping, and zooming out produced a
       * pile of tangled markers instead of a count. 80 is the plugin's own
       * default and groups while there is still space between them.
       */
      maxClusterRadius: 80,
      // Build the cluster tree in chunks across frames rather than in one
      // blocking pass, so a big result set can't freeze the map while it loads.
      chunkedLoading: true,
      removeOutsideVisibleBounds: true,
      // Tapping a cluster that can't split any further fans its pins out.
      spiderfyOnMaxZoom: true,
      iconCreateFunction: (c) => {
        // Bigger groups get a bigger badge, so density reads at a glance
        // instead of having to compare numbers.
        const count = c.getChildCount();
        const size = count < 10 ? 34 : count < 100 ? 42 : 50;
        const text = count < 100 ? 'text-xs' : 'text-xs';

        return L.divIcon({
          html:
            `<div class="rounded-full bg-slate-900/95 border-2 border-emerald-400 flex items-center justify-center text-white font-bold ${text} shadow-xl" ` +
            `style="width:${size}px;height:${size}px">${count}</div>`,
          className: 'custom-cluster-icon',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
      }
    });

    const markers = pinnedCampsites.map((site) => {
      const marker = L.marker([site.latitude, site.longitude], {
        icon: iconForId(site.id),
        /*
         * The title has to match the source. Every pin used to say "added by
         * a camper" because every pin was, and saying it over a government
         * campground would be the app inventing a witness who does not exist.
         */
        title: site.source === 'agency_dataset'
          ? `${site.name} — published by ${site.landManager || 'a government agency'}, not yet visited by anyone here`
          : `${site.name} — added by a camper`
      });
      marker.on('click', () => {
        // A hold that showed the peek must not also open the spot. Without
        // this, letting go fires the click and the pin you only wanted to
        // glance at takes over the screen.
        if (peekSwallowClickRef.current) return;
        onSelectCampsite(site);
      });
      marker.on('dblclick', () => onOpenBottomSheet(site));
      markersRef.current.set(site.id, marker);
      return marker;
    });

    // One bulk insert. Adding markers one at a time re-clusters the whole
    // group on every single one.
    cluster.addLayers(markers);

    (clusterViewRef.current ?? map).addLayer(cluster);
    clusterRef.current = cluster;
  }, [pinnedCampsites, isMapReady, onSelectCampsite, onOpenBottomSheet, iconForId]);

  /**
   * Press and hold a pin to peek at its chips.
   *
   * ONE DELEGATED LISTENER ON THE MAP, not a listener per marker. The cluster
   * plugin creates and destroys marker elements constantly as you pan and
   * zoom, so per-marker handlers would need reattaching on every one of those
   * — and would leak the ones it missed. The pin carries `data-site-id` and
   * this finds it with `closest`.
   *
   * The gesture has to lose gracefully to the map itself: a finger that moves
   * more than a few pixels is panning, not holding, and the peek must get out
   * of the way rather than fighting the drag. Hence the slop check, and the
   * cancel on any map movement at all.
   */
  useEffect(() => {
    const map = mapRef.current;
    const container = map?.getContainer();
    if (!map || !isMapReady || !container) return;

    const cancelTimer = () => {
      const peek = peekRef.current;
      if (peek?.timer != null) window.clearTimeout(peek.timer);
    };

    /** Put everything back. `swallow` when a peek actually opened. */
    const endPeek = (swallow: boolean) => {
      const peek = peekRef.current;
      if (!peek) return;
      cancelTimer();

      if (peek.open) {
        closePeek(peek.wrap);
        if (swallow) {
          peekSwallowClickRef.current = true;
          // Cleared on a timer rather than in the click handler: a hold that
          // ends off the marker produces no click at all, and a flag nobody
          // clears would swallow the NEXT genuine tap instead.
          window.setTimeout(() => { peekSwallowClickRef.current = false; }, 350);
        }
      }
      peekRef.current = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Secondary buttons and pinch-zoom second fingers are not holds.
      if (e.button != null && e.button > 0) return;
      if (peekRef.current) return;

      const target = e.target as Element | null;
      const wrap = target?.closest?.('.wl-pin-wrap[data-site-id]');
      if (!wrap) return;

      // An open pin already shows its chips — and a real one, with the
      // lookups behind it. Peeking it would replace a better answer.
      if (wrap.classList.contains('wl-pin-wrap-on')) return;

      const id = wrap.getAttribute('data-site-id');
      if (!id) return;

      const timer = window.setTimeout(() => {
        const peek = peekRef.current;
        if (!peek) return;
        if (openPeek(peek.wrap, dotsForId(id))) {
          peek.open = true;
          haptic('tap');
        }
      }, PEEK_HOLD_MS);

      peekRef.current = {
        wrap, timer, open: false, startX: e.clientX, startY: e.clientY
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const peek = peekRef.current;
      if (!peek || peek.open) return;

      const moved = Math.hypot(e.clientX - peek.startX, e.clientY - peek.startY);
      // Still inside the slop: the finger is resting, not travelling.
      if (moved <= PEEK_SLOP_PX) return;
      endPeek(false);
    };

    const onPointerUp = () => endPeek(true);
    const onPointerCancel = () => endPeek(false);
    // Any camera movement while holding means the map won the gesture.
    const onMapMove = () => endPeek(false);

    container.addEventListener('pointerdown', onPointerDown);
    // On window, not the container: a finger released off the edge of a pin,
    // or off the map entirely, still has to put the stack away.
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    map.on('movestart', onMapMove);
    map.on('zoomstart', onMapMove);

    return () => {
      cancelTimer();
      // Drop the row outright rather than animating on the way out — the
      // component is going away and there is nothing left to animate onto.
      peekRef.current?.wrap.querySelector(':scope > .wl-chips-peek')?.remove();
      peekRef.current = null;

      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      map.off('movestart', onMapMove);
      map.off('zoomstart', onMapMove);
    };
  }, [isMapReady, dotsForId]);

  // Swap only the two icons that changed.
  useEffect(() => {
    const previousId = selectedIdRef.current;
    const nextId = selectedCampsite?.id ?? null;
    if (previousId === nextId) return;
    // Update the ref first: iconForId reads it, and both pins need the new state.
    selectedIdRef.current = nextId;
    // The last spot's facilities are not this spot's. Cleared before either
    // icon is rebuilt, so a toilet 4 km from the previous pin cannot appear
    // over the new one for the moment before the fetch lands.
    facilitiesRef.current = [];
    // Anything the old pin was still waiting to show belongs to the old pin.
    openBatchRef.current.cancel();
    if (previousId) {
      /*
       * The stack winds itself down before the pin closes, top chip first —
       * the same exit a held pin plays when the finger comes off it. Closing
       * used to swap the icon on the spot, so a column of answers a camper was
       * halfway through reading vanished between two frames.
       */
      const closing = markersRef.current.get(previousId);
      retractChipRow(closing?.getElement(), () => {
        refreshIcon(previousId);
        markersRef.current.get(previousId)?.setZIndexOffset(0);
      });
    }
    if (nextId) {
      const marker = markersRef.current.get(nextId);
      refreshIcon(nextId, true);
      // Leaflet stacks markers by latitude, so a selected pin's expanded
      // chips would otherwise slide under any pin north of it.
      marker?.setZIndexOffset(800);
    }
  }, [selectedCampsite, refreshIcon]);

  /**
   * Keep each pinned campsite's alert badges current.
   *
   * Kept out of the cluster effect on purpose: alerts refresh on every pan, and
   * rebuilding the whole marker cluster that often would stutter. This only
   * swaps the icon on markers that already exist — the same trick the selection
   * effect above uses.
   *
   * Updated to diff against the previous badge set. The previous version called
   * `setIcon` on every marker whenever `hazards` changed, and the cluster
   * plugin treats any change to a child's icon as a reason to recompute that
   * cluster's wrapper — so a few hundred pins across a few dozen clusters
   * became a few hundred DOM mutations and a few dozen cluster icon rebuilds
   * every time the alert view changed, which is what the panning jank was
   * actually composed of. We now walk the diff and only touch the markers
   * whose badge list actually changed; the cluster wrapper is left alone
   * because the cluster badge never depended on the child icon.
   */
  useEffect(() => {
    const next = new Map<string, PointWarning[]>();
    for (const site of pinnedCampsites) {
      const found = hazards.length
        ? warningsForPoint(site.latitude, site.longitude, hazards)
        : [];
      if (found.length) next.set(site.id, found);
    }
    const prev = badgesByIdRef.current;
    badgesByIdRef.current = next;
    if (!isMapReady) return;

    /**
     * A marker has changed only if its warnings have.
     *
     * The LABEL is compared as well as the family, not just the family it used
     * to be. The chip now carries the agency's product name, so a flood watch
     * upgrading to a flash flood warning is the same badge with different
     * words — and comparing families alone would leave the old wording sitting
     * on the pin through the one change a camper most needs to see.
     */
    const sameBadges = (a: PointWarning[] | undefined, b: PointWarning[]): boolean => {
      if (!a) return b.length === 0;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].badge !== b[i].badge) return false;
        if (a[i].label !== b[i].label) return false;
        if (a[i].count !== b[i].count) return false;
      }
      return true;
    };

    // Markers that USED to have a badge but no longer do.
    prev.forEach((badges, id) => {
      if (!next.has(id)) refreshIcon(id);
    });
    // Markers whose badge set changed.
    next.forEach((badges, id) => {
      if (!sameBadges(prev.get(id), badges)) refreshIcon(id);
    });
  }, [hazards, pinnedCampsites, isMapReady, refreshIcon]);

  /* ------------------------------------------------------------------ */
  /* Facilities near the open spot                                       */
  /* ------------------------------------------------------------------ */
  /**
   * Look up what is within a few kilometres of the spot being read.
   *
   * Debounced, because tapping down a line of pins would otherwise fire an
   * Overpass query per pin, and aborted on the way out so the answer for a
   * spot the camper has already left never lands on the one they are on.
   *
   * Finding nothing sets an empty list and draws no dots, which is the
   * honest outcome: OpenStreetMap is volunteer-surveyed and the emptiest
   * country is the least surveyed. Nowhere does the app turn that into "no
   * toilet within 5 km".
   */
  useEffect(() => {
    setFacilityTrip(null);
    if (readLat === null || readLon === null || isOfflineMode) {
      setFacilities([]);
      setFacilitiesLoading(false);
      return;
    }

    setFacilitiesLoading(true);
    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(async () => {
      /**
       * The road question is only asked of bare ground inside public land.
       *
       * On an existing pin it is noise — somebody has already camped there,
       * so of course they drove in — and off public land it is nobody's
       * business how close the nearest track is. This is the whole of what
       * replaced the painted parcels: instead of colouring half a state to
       * hint that a vehicle might get in somewhere, the point you tapped
       * says whether there is a road near IT.
       */
      const wantsRoad = Boolean(landRef.current) && !hasCampsiteRef.current;

      const [result, road] = await Promise.all([
        fetchNearbyFacilities(readLat, readLon, FACILITY_RADIUS_KM, controller.signal),
        wantsRoad
          ? fetchNearestDriveableRoad(readLat, readLon, ROAD_RADIUS_KM, controller.signal)
          : Promise.resolve(null)
      ]);
      if (cancelled) return;

      // Road first: the chip row is capped, and "can I get a vehicle in" beats
      // a bin two kilometres away for somebody looking at empty land.
      setFacilities(road ? [road, ...result.facilities] : result.facilities);
      setFacilitiesLoading(false);
    }, 300);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      setFacilities([]);
      setFacilitiesLoading(false);
    };
  }, [readLat, readLon, isOfflineMode]);

  // Grow the open pin's chip row once the facilities land.
  useEffect(() => {
    facilitiesRef.current = facilities;
    const id = selectedIdRef.current;
    if (!id) return;
    refreshIcon(id);
  }, [facilities, refreshIcon]);

  // Same again for the fires: the lookup lands after the pin is already open.
  useEffect(() => {
    nearbyFiresRef.current = nearbyFires;
    const id = selectedIdRef.current;
    if (!id) return;
    refreshIcon(id);
  }, [nearbyFires, refreshIcon]);

  // And for the conditions, which arrive from App a moment after the tap.
  useEffect(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    refreshIcon(id);
  }, [conditions, refreshIcon]);

  /**
   * "More is coming" — a tiny placeholder at the top of whichever pin is
   * open, for as long as its facility lookup is still in flight.
   *
   * A freshly tapped pin usually has NOTHING in its chip row yet — the
   * facility answer is the slowest of the lookups that fill it, an Overpass
   * query with real network latency — and with no signal that anything is
   * still coming, that empty beat reads as the tap having done nothing.
   */
  useEffect(() => {
    const marker =
      destinationMarkerRef.current ??
      (selectedIdRef.current ? markersRef.current.get(selectedIdRef.current) ?? null : null);
    setChipsLoading(marker?.getElement() as HTMLElement | undefined, facilitiesLoading);
  }, [facilitiesLoading]);

  /**
   * Tapping the fire chip: go and look, then come back.
   *
   * The chip says "3 active fires, nearest 21 km away", and the next question
   * is always the same one — WHERE, and are they out? So the camera pulls out
   * far enough to hold the spot and the fires in one frame, then names them
   * one at a time, each label popping in over its own flame so it is obvious
   * which fire is being talked about. Then it puts the camera back exactly
   * where it found it.
   *
   * The labels quote the agency's own reading and nothing more: "reported
   * under control" is never shortened to "out", and a fire with no status
   * from the feed says so rather than being assumed to be running.
   */
  const tourRunningRef = useRef(false);
  const tourLayerRef = useRef<L.LayerGroup | null>(null);
  /**
   * Stop the tour that is on screen, right now.
   *
   * A tour used to be something you started and then sat through. That was
   * fine at two seconds and is not fine at ten: the land label is meant to be
   * read, so it stays up long enough to read, which means there has to be a
   * way to say "done". Two things call this — the little × on the label
   * itself, and the × under the pin, which a camper reasonably expects to put
   * away everything the pin has put on the map, not just the pin.
   *
   * Null when nothing is running.
   */
  const endTourRef = useRef<(() => void) | null>(null);
  const endTour = useCallback(() => { endTourRef.current?.(); }, []);

  /**
   * THE SHAPE OF EVERY "GO AND LOOK" ON THIS MAP.
   *
   * The fire chip has always done this: pull the camera out far enough to hold
   * the spot and the thing being asked about in one frame, draw the thing,
   * name it, wait long enough to read it, then put the camera back exactly
   * where it was found. Tapping a chip is a question about something you
   * cannot currently see, and the map itself is the answer — briefly, rather
   * than as a paragraph.
   *
   * Every chip that has somewhere to take you now runs through here, so they
   * all behave identically: one tour at a time, nothing in a tour is tappable,
   * and the borrowed view is always given back, including when the middle of
   * the tour throws.
   */
  const runTour = useCallback(async (
    steps: (ctx: {
      map: L.Map;
      layer: L.LayerGroup;
      /** Scaled down under prefers-reduced-motion, never to zero. */
      wait: (ms: number) => Promise<void>;
      reduced: boolean;
      /**
       * Frame these bounds, never closer than `maxZoom` and never further out
       * than `minZoom`. The floor is the important half — see the note on the
       * implementation. `anchor` is what stays centred when the floor means
       * the bounds cannot all fit.
       */
      frame: (
        bounds: L.LatLngBounds, maxZoom?: number, minZoom?: number, anchor?: L.LatLng
      ) => void;
      /** A named marker pinned on the map, in a colour. */
      label: (at: L.LatLngExpression, opts: {
        title: string;
        /** A quieter line straight under the title — what kind of thing it is. */
        sub?: string;
        /**
         * The facts, one bullet each. Kept apart from `detail` so a rule you
         * can act on ("14 nights in any 28-day period") never reads at the
         * same weight as the hedge underneath it.
         */
        lines?: string[];
        /** The caveat, in the smaller, quieter type under everything else. */
        detail?: string;
        glyph: string;
        color: string;
        /**
         * This label lands on the dropped pin rather than somewhere else.
         *
         * Two things follow, and they are the same thought twice. The bubble
         * climbs clear of the teardrop, which is 40px tall and otherwise
         * covers the bottom two lines of the thing the label is explaining.
         * And the glyph is dropped: the pin IS the mark for this point, so a
         * second one drawn on top of it marks nothing and hides the first.
         */
        atPin?: boolean;
        /** Give the camper an × to stop the tour early. Long labels only. */
        closable?: boolean;
      }) => void;
      /** False once this tour has been torn down — check it after every await. */
      alive: () => boolean;
    }) => Promise<void>
  ) => {
    const map = mapRef.current;
    if (!map || tourRunningRef.current) return;

    tourRunningRef.current = true;
    const reduced = prefersReducedMotion();
    const home = { center: map.getCenter(), zoom: map.getZoom() };

    const layer = L.layerGroup().addTo(map);
    tourLayerRef.current = layer;

    /*
     * EVERY WAIT IS INTERRUPTIBLE.
     *
     * A tour is a chain of sleeps, so "stop" has to mean the sleep the tour is
     * currently in ends now — otherwise the camper taps the × and the shape,
     * the label and the borrowed camera all sit there until the timer that was
     * already running happens to expire. Each pending wait keeps its resolver
     * here; `cancel` fires all of them, and `alive()` has already gone false by
     * then, so the step function bails at its next check instead of drawing the
     * next thing onto a torn-down layer.
     */
    let cancelled = false;
    const pending = new Set<() => void>();
    const wait = (ms: number) => new Promise<void>((resolve) => {
      if (cancelled) { resolve(); return; }
      const done = () => {
        pending.delete(done);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, reduced ? ms / 3 : ms);
      pending.add(done);
    });

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      // alive() reads this, so it must go first.
      if (tourLayerRef.current === layer) tourLayerRef.current = null;
      // Off the screen in this frame rather than whenever the chain unwinds.
      try { layer.clearLayers(); } catch { /* already gone */ }
      Array.from(pending).forEach((done) => done());
    };
    endTourRef.current = cancel;
    /**
     * The pin's own row of chips steps aside while the tour is on screen.
     *
     * The row is a stack of labels sitting exactly where the camera is about
     * to pull out to, so it would otherwise be reading the weather over the
     * top of the thing it sent you to look at. A class on the map container
     * fades every chip row out together; the CSS transition brings them back
     * on its own the moment it is removed in `finally`.
     */
    const container = map.getContainer();
    container.classList.add('wl-touring');

    try {
      await steps({
        map,
        layer,
        wait,
        reduced,
        alive: () => tourLayerRef.current === layer,
        /**
         * PULL OUT ONLY AS FAR AS THE ANSWER NEEDS.
         *
         * This was a plain `fitBounds`, and Leaflet's `fitBounds` takes a
         * maximum zoom and no minimum — so a warning issued for half a
         * province threw the camera out to the continent, and the answer to
         * "where is this smoke?" became a map of the west coast with the pin
         * lost somewhere in it. Nobody can see anything at that scale.
         *
         * So the fit is worked out first and then FLOORED, which means an area
         * bigger than the floor allows is deliberately shown part-framed: a
         * recognisable piece of ground with the shading over it beats the whole
         * shape at a zoom where neither the shape nor the ground reads.
         *
         * When the floor does bite, the `anchor` — the pin the camper is asking
         * from — is what stays in the middle. Centring on the middle of an area
         * that does not fit can leave the pin off the screen entirely, which is
         * the one thing a tour must never do: it is answering a question about
         * that pin.
         *
         * The centring is otherwise Leaflet's own `fitBounds` maths, lifted
         * here because `fitBounds` takes no minimum and would drop the floor.
         *
         * ---------------------------------------------------------------
         * AND THE CEILING GOES UP, TOO — IT WAS ZOOMING OUT ON PURPOSE.
         * ---------------------------------------------------------------
         *
         * The ceiling used to be 11, 12, 14 or 15 depending on the tour, and
         * that only ever bites when the answer is CLOSE: a mast half a
         * kilometre away, a track 200 m off the pin. In exactly those cases
         * the camera pulled OUT to a zoom where the two things it was
         * comparing sat on top of each other — the tour answered "how far is
         * it?" by making it look like no distance at all.
         *
         * So the fit is used whichever way it points. Close things zoom in
         * until they nearly touch the edges of the screen; far things pull
         * out as they always did. The ceiling that remains is only there to
         * stop two points a few metres apart filling the screen with one
         * featureless patch of ground, where the surroundings are the thing
         * that makes a location readable at all.
         */
        frame: (bounds, maxZoom = TOUR_MAX_ZOOM, minZoom, anchor) => {
          try {
            /*
             * A SMALL BUFFER, NOT A MARGIN.
             *
             * This was 60px each side on a phone that is 390px wide — nearly
             * a third of the screen given away — so two things 400 m apart
             * were framed as though they were 4 km apart. The sides are a
             * thin border now. The top and bottom keep more because a tour's
             * label bubble hangs off the marker at the edge of these bounds,
             * and a clipped answer is worse than a loose frame.
             */
            const padTL = L.point(26, 84);
            const padBR = L.point(26, 76);
            const fit = map.getBoundsZoom(bounds, false, padTL.add(padBR));
            let z = Math.min(fit, maxZoom);
            const floored = minZoom != null && z < minZoom;
            if (floored) z = minZoom as number;
            z = Math.max(z, map.getMinZoom());

            const offset = padBR.subtract(padTL).divideBy(2);
            const sw = map.project(bounds.getSouthWest(), z);
            const ne = map.project(bounds.getNorthEast(), z);
            const centre = floored && anchor
              ? anchor
              : map.unproject(sw.add(ne).divideBy(2).add(offset), z);

            if (reduced) map.setView(centre, z, { animate: false });
            else map.flyTo(centre, z, { duration: 0.8 });
          } catch { /* degenerate bounds */ }
        },
        label: (at, {
          title, sub, lines = [], detail, glyph, color, atPin = false, closable = false
        }) => {
          const facts = lines.filter(Boolean);
          L.marker(at, {
            icon: L.divIcon({
              className: 'wl-tour-stop',
              html:
                `<div class="wl-tour-stop-wrap" ` +
                `style="--wl-tour-color:${color};` +
                `--wl-tour-lift:${atPin ? PIN_LIFT_PX : 0}px">` +
                // A stack of facts reads as a little card, left-aligned;
                // a single line stays centred over its glyph as before.
                `<span class="wl-tour-stop-label` +
                `${facts.length ? ' wl-tour-stop-label-card' : ''}` +
                `${closable ? ' wl-tour-stop-label-closable' : ''}">` +
                `<b>${escapeHtml(title)}</b>` +
                (sub ? `<small>${escapeHtml(sub)}</small>` : '') +
                facts.map((l) => `<i>${escapeHtml(l)}</i>`).join('') +
                `${detail ? `<em>${escapeHtml(detail)}</em>` : ''}` +
                (closable
                  ? `<span class="wl-tour-stop-close" data-action="tour-close" ` +
                    `role="button" tabindex="0" aria-label="Close" title="Close">` +
                    `${CLOSE_SVG}</span>`
                  : '') +
                `</span>` +
                // Nothing under the bubble when it is standing on the pin —
                // see `atPin`.
                (atPin
                  ? ''
                  : `<span class="wl-tour-stop-glyph" aria-hidden="true">${glyph}</span>`) +
                `</div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15]
            }),
            /*
             * The MARKER stays non-interactive — nothing in a tour is a target
             * — and the × opts itself back in with `pointer-events: auto`, the
             * same way a chip does. It is caught by the map container's
             * delegated handler on `data-action`.
             */
            interactive: false,
            zIndexOffset: 800
          }).addTo(layer);
        }
      });
    } finally {
      layer.remove();
      tourLayerRef.current = null;
      if (endTourRef.current === cancel) endTourRef.current = null;
      container.classList.remove('wl-touring');
      try {
        // The camera is given back whether the tour finished or was stopped:
        // it was always borrowed.
        if (reduced) map.setView(home.center, home.zoom, { animate: false });
        else map.flyTo(home.center, home.zoom, { duration: 0.8 });
      } catch { /* map torn down */ }
      tourRunningRef.current = false;
    }
  }, []);

  /**
   * Mark a tour's own shape with the pulsing edge glow — the warning polygon
   * in `runAlertTour`, the parcel in `runLandTour`. Never anything else on
   * the map: `group` is always the shape a tour drew into its own `t.layer`
   * for exactly this tap, so the pulse can only ever land on the one thing
   * being answered about. See `.wl-tour-shape-glow` in index.css.
   */
  const glowShape = (group: L.GeoJSON, color: string): void => {
    group.eachLayer((layer) => {
      const el = (layer as L.Path).getElement() as SVGElement | undefined;
      if (!el) return;
      el.style.setProperty('--wl-glow-color', color);
      el.classList.add('wl-tour-shape-glow');
    });
  };

  /**
   * Tapping the fire chip: go and look, then come back.
   *
   * The chip says "3 active fires, nearest 21 km away", and the next question
   * is always the same one — WHERE, and are they out? Each fire is named in
   * turn, its label popping in over its own flame so it is obvious which one
   * is being talked about.
   *
   * The labels quote the agency's own reading and nothing more: "reported
   * under control" is never shortened to "out", and a fire the feed gives no
   * status for says that rather than being assumed to be running.
   */
  const runFireTour = useCallback(() => runTour(async (t) => {
    const point = readPointRef.current;
    // Five is as many labels as fit on a phone before they stack on top of
    // each other; the rest are still counted on the chip.
    const shown = nearbyFiresRef.current.slice(0, 5);
    if (!point || !shown.length) return;

    const bounds = L.latLngBounds(
      [point.lat, point.lon] as L.LatLngExpression,
      [point.lat, point.lon] as L.LatLngExpression
    );
    shown.forEach((n) => bounds.extend([n.fire.centroid.lat, n.fire.centroid.lon]));
    t.frame(bounds);
    await t.wait(750);

    for (const { fire, distanceKm } of shown) {
      if (!t.alive()) return;
      const held = isUnderControl(fire);
      t.label([fire.centroid.lat, fire.centroid.lon], {
        title: fire.status?.trim()
          ? fire.status
          : held ? 'Reported under control' : 'Not reported under control',
        detail: `${fire.name} · ${distanceKm.toFixed(1)} km away`,
        glyph: '\u{1F525}',
        color: held ? '#F97316' : '#EF4444'
      });
      await t.wait(850);
    }

    await t.wait(900);
  }), [runTour]);

  /**
   * Tapping the signal chip: where is the estimate actually coming from?
   *
   * "Weak signal" is a distance to a mast with the terrain ignored — the chip
   * already says so once it unfurls, but a distance is easier to trust once
   * you have seen the thing it is a distance FROM. `coverage.towers` is
   * sorted nearest first, so the head of the list is the one the estimate is
   * keyed to.
   *
   * Unlike the facility trip, this never asks for a route — a transmitter is
   * not a place to drive to, it is just where the signal a phone would catch
   * is coming from. The ping is decoration earning its keep: three rings
   * expanding out from the mast read as a transmitter even to someone who has
   * never seen a cell tower icon before.
   *
   * The label's own icon is lucide's `radio-tower` glyph, drawn as an inline
   * SVG rather than an emoji — the same line weight and stroke language as
   * every other icon in this app, instead of whatever a phone's own emoji
   * font happens to render a satellite dish as.
   */
  const runSignalTour = useCallback(() => runTour(async (t) => {
    const SIGNAL_COLOR = '#22D3EE';
    const point = readPointRef.current;
    const tower = coverageRef.current.towers?.[0];
    if (!point || !tower) return;

    const bounds = L.latLngBounds(
      [point.lat, point.lon] as L.LatLngExpression,
      [tower.latitude, tower.longitude] as L.LatLngExpression
    );
    t.frame(bounds);
    await t.wait(700);
    if (!t.alive()) return;

    L.marker([tower.latitude, tower.longitude], {
      interactive: false,
      zIndexOffset: -100,
      icon: L.divIcon({
        className: 'wl-tower-ping',
        html:
          `<div class="wl-tower-ping-wrap" style="--wl-signal-color:${SIGNAL_COLOR}">` +
          '<span class="wl-radio-ping"></span>' +
          '<span class="wl-radio-ping wl-radio-ping-2"></span>' +
          '<span class="wl-radio-ping wl-radio-ping-3"></span>' +
          '<span class="wl-radio-dot"></span>' +
          '</div>',
        iconSize: [46, 46],
        iconAnchor: [23, 23]
      })
    }).addTo(t.layer);

    /*
     * NO LABEL ON THE MAST. The ping IS the answer.
     *
     * The question this tour is asked is "where is the signal coming from",
     * and a radiating dot on a piece of ground answers it completely, in the
     * time it takes to look. The bubble that used to sit over it repeated the
     * distance the chip had just been tapped to say, and covered the ground
     * between the mast and the pin — which is the one part of the picture
     * worth seeing, because that distance is the whole estimate.
     *
     * Nothing honest is lost with it: the coverage chip carries the distance,
     * the operator and the "terrain ignored" caveat in its own text, and that
     * chip is what the camper pressed to get here.
     */
    await t.wait(2600);
  }), [runTour]);

  /**
   * Tapping a warning chip: where does this actually apply?
   *
   * The chip says "Heatwave" and the honest follow-up is "over what?" — a
   * warning is a shape an agency drew, and the shape is the answer. Every
   * alert of that family covering this point is drawn at once, because a
   * camper standing under two overlapping heat products is standing under one
   * heat problem.
   *
   * A zone-based product says so on its label. Its outline is the edge of the
   * FORECAST REGION the warning was issued for, not the edge of the weather,
   * and that is exactly the sort of thing this app must not let a shape imply
   * on its own.
   */
  const runAlertTour = useCallback((badge: AlertBadge) => runTour(async (t) => {
    const point = readPointRef.current;
    if (!point) return;

    const covering = hazardsRef.current.filter(
      (a) =>
        a.geometry &&
        alertBadge(a) === badge &&
        pointInGeometry(point.lat, point.lon, a.geometry)
    );
    if (!covering.length) return;

    const color = BADGE_COLOR[badge];

    /**
     * The SAME cloud that is on the map, lifted a little.
     *
     * This used to draw the raw alert geometry with a crisp 2.5px stroke —
     * the surveyed parcel edges, hard, directly on top of the soft cloud
     * already drawn for the same warning. Two different shapes for one
     * warning, and the sharper of the two was the one this app is least
     * entitled to draw. `cloudPieces` gives back exactly the shape the cloud
     * layer uses, so the tour highlights the thing you are looking at instead
     * of contradicting it.
     */
    const pieces = cloudPieces(covering.map((a) => a.geometry));
    if (!pieces.length) return;

    const shapes = L.geoJSON(
      {
        type: 'FeatureCollection',
        features: pieces.map((p) => p.shape)
      } as any,
      {
        style: {
          color,
          weight: 10,
          opacity: 0.35,
          fillColor: color,
          fillOpacity: 0.26,
          fillRule: 'nonzero',
          lineJoin: 'round',
          lineCap: 'round'
        }
      } as RenderedGeoJSONOptions
    ).addTo(t.layer);

    /**
     * FRAME THE PIECE THE CAMPER IS STANDING IN, NOT EVERY PIECE THERE IS.
     *
     * `covering` is the whole family — one air quality statement can arrive as
     * a dozen disjoint regions strung along a mountain range, and framing all
     * of them together is what used to throw the camera out to a map of the
     * west coast. The camper asked about the one over their head. The rest
     * stay drawn, because they are the same warning, and the camera simply
     * does not try to hold them.
     */
    const here =
      pieces.find((p) => pointInGeometry(point.lat, point.lon, p.shape.geometry)) ?? pieces[0];
    const edge = outerRing(here.shape);
    const bounds = (edge.length ? L.latLngBounds(edge) : shapes.getBounds())
      .extend([point.lat, point.lon]);

    /**
     * THE WHOLE SHAPE, NOT A WINDOW ONTO PART OF IT.
     *
     * This used to floor the zoom seven levels out from wherever the camper
     * already was — a warning bigger than that floor allowed was shown
     * part-framed, on the reasoning that the shape should read against
     * recognisable ground rather than shrink to a smear at continental
     * zoom. In practice a tap meant to answer "where is this" instead
     * pulled the camera IN on a warning bigger than the floor, which is
     * backwards from what the tour is for. So the fit is unclamped: whatever
     * zoom shows the entire shape is the one the tour goes to.
     */
    t.frame(bounds);
    // Longer than the other tours wait: the camera is flying, and the glow
    // has to start once it has actually arrived.
    await t.wait(1000);
    if (!t.alive()) return;

    /*
     * THE SHAPE GLOWS AT ITS OWN EDGE, INSTEAD OF A DOT LAPPING IT.
     *
     * There used to be a small tracker running one lap around the outline.
     * A moving dot reads as pointing at a shape; the shape itself glowing at
     * its own boundary reads as being the answer, and it does that without
     * a label sitting on top of the thing it is naming — see the note that
     * used to be here about the removed caveat bubble, which still holds:
     * both the name and the caveat live on the chip and in the "i" card.
     * `glowShape` is the shared helper both this tour and the land tour use
     * — see its own comment and `.wl-tour-shape-glow` in index.css.
     */
    glowShape(shapes, color);
    await t.wait(2400);
    await t.wait(500);
  }), [runTour]);

  /**
   * Tapping the land chip: which shape said that, and what are the rules on it?
   *
   * The chip names a forest or a district; this draws the parcel the name came
   * from AND spells out what the name means for tonight — how many days, what
   * you have to buy first, whether there is a fire ban. A camper tapping the
   * name of a national forest is not asking to be told the name back.
   *
   * Those edges are approximate to within hundreds of metres — which is why the
   * fills are off by default — so the caveat rides underneath the rules, on
   * screen, attached to the thing it is about.
   */
  const runLandTour = useCallback(() => runTour(async (t) => {
    const point = readPointRef.current;
    if (!point) return;

    // Smallest matching parcel wins, exactly as it does when a pin is dropped:
    // a wilderness area inside a national forest carries the stricter rules.
    let best: { feature: BoundaryFeature; extent: number } | null = null;
    for (const feature of collectionRef.current.features) {
      if (!pointInGeometry(point.lat, point.lon, feature.geometry)) continue;
      const extent = bboxExtent(feature.geometry);
      if (!best || extent < best.extent) best = { feature, extent };
    }
    if (!best) return;

    const LAND_COLOR = '#A78BFA';
    const shape = L.geoJSON(best.feature as any, {
      style: {
        color: LAND_COLOR, weight: 2.5, opacity: 0.95,
        fillColor: LAND_COLOR, fillOpacity: 0.2
      }
    }).addTo(t.layer);

    t.frame(shape.getBounds());
    await t.wait(700);
    if (!t.alive()) return;

    /**
     * THE PARCEL GLOWS, THE SAME WAY A WARNING DOES.
     *
     * A named forest or district is one shape, same as a warning is, and
     * "which one is this" deserves the same answer: the parcel itself
     * pulsing at its own edge, not a separate mark drawn near it. Only this
     * one shape ever carries it — `best.feature` is already the single
     * smallest matching parcel, exactly as it is when a pin is dropped.
     */
    glowShape(shape, LAND_COLOR);

    /*
     * MAKE ROOM ABOVE THE PIN FOR A CARD THIS TALL.
     *
     * The camera was framed on the PARCEL, which says nothing about where in
     * the viewport the pin ends up — on a tall thin forest it lands near the
     * top, and a bubble carrying four rules and a hedge then opens off the top
     * of the screen. So if the pin is sitting too high to hang the card above
     * it, the view slides up and the pin comes down into the lower half first.
     */
    const HEADROOM_PX = 250;
    try {
      const seat = t.map.latLngToContainerPoint([point.lat, point.lon]);
      if (seat.y < HEADROOM_PX) {
        t.map.panBy([0, seat.y - HEADROOM_PX], { animate: !t.reduced, duration: 0.4 });
        await t.wait(500);
        if (!t.alive()) return;
      }
    } catch { /* map torn down mid-tour */ }

    const land = landFromFeature(best.feature.properties as any);
    const card = land ? landRules(land) : null;

    t.label([point.lat, point.lon], {
      title: land?.name ?? 'Public land',
      sub: land ? landSubtitle(land) : undefined,
      lines: card?.rules ?? [],
      /*
       * Two hedges, and both have to be here. Where the rules are the agency's
       * general ones rather than this parcel's record, saying so is the whole
       * condition on showing them at all — see `src/config/landRules.ts`. The
       * boundary caveat is the house rule and never comes off.
       */
      detail: (card?.basis ? `${card.basis}. ` : '') +
        'Boundary approximate — the edge can be hundreds of metres out',
      glyph: LAND_GLYPH,
      color: LAND_COLOR,
      // The dropped pin is standing on this exact point: climb over it, and
      // don't draw a second mark on top of it.
      atPin: true,
      closable: true
    });

    /*
     * TEN SECONDS, AND AN × FOR THE IMPATIENT.
     *
     * This is the one tour label that is a piece of reading rather than a
     * caption: a name, a stay limit, a permit, a hedge. Two seconds was enough
     * for the name alone and the rest may as well not have been there. Ten is
     * a proper read with time to go back over a line — and because ten seconds
     * is a long time to be made to wait, the label carries its own way out.
     */
    await t.wait(10000);

    /**
     * READING THE CARD IS THE WHOLE ERRAND — SO FINISHING IT PUTS THE PIN AWAY TOO.
     *
     * Every other chip's tour borrows the camera for a couple of seconds and
     * hands it straight back, leaving the pin exactly as open as it was. This
     * one is different: the × and the ten-second timeout are both ways of
     * saying "I'm done reading", and this parcel card was the reason the pin
     * was open in the first place. Leaving it selected after either exit made
     * the answer outlive the question. `t.wait` above resolves on both paths
     * — a real ten seconds, or `cancel()` waking it early — so one call here
     * covers both.
     */
    clearDestinationRef.current();
  }), [runTour]);

  /**
   * Tapping a road chip: show me the track.
   *
   * A road is a LINE, and it used to be treated as a destination — a dot on
   * the single nearest vertex, and a router asked how to drive to a road you
   * are already standing beside. Now the way itself is drawn.
   *
   * Two chips land here. The facility chip already carries its line, so it
   * draws instantly. The spot's own "gravel road" chip is a camper's rating
   * with no geometry behind it at all, so the track is looked up on the spot,
   * and the label keeps the two apart: the rating describes the drive in, the
   * line is only whatever OpenStreetMap has near the pin.
   */
  const runRoadTour = useCallback((facility: NearbyFacility | null) => runTour(async (t) => {
    const point = readPointRef.current;
    if (!point) return;

    let road = facility;
    /**
     * `checked` is the difference between two sentences that look alike and
     * mean opposite things: "nobody has mapped a track here" and "we could not
     * find out". The chip already carries its own line when the facility lookup
     * found one, so that path never has to ask.
     */
    let checked = true;
    if (!road?.line?.length) {
      t.label([point.lat, point.lon], {
        title: 'Looking for the track…', glyph: '\u{1F6E3}️', color: '#FDE047',
        atPin: true
      });
      const found = await findNearestDriveableRoad(point.lat, point.lon, ROAD_RADIUS_KM);
      if (!t.alive()) return;
      road = found.road;
      checked = found.ok;
      t.layer.clearLayers();
    }

    if (!road?.line?.length) {
      t.label([point.lat, point.lon], checked
        ? {
            title: 'No mapped track within 2 km',
            detail: 'OpenStreetMap has nothing here, which is not the same as nothing being here',
            glyph: '\u{1F6E3}️',
            color: '#FDE047',
            atPin: true
          }
        : {
            title: 'Could not check for a track',
            detail: 'OpenStreetMap did not answer. That is not a report that there is no road',
            glyph: '\u{1F6E3}️',
            color: '#FDE047',
            atPin: true
          });
      await t.wait(2600);
      return;
    }

    // A dark under-stroke first, so a yellow line stays legible over pale
    // desert and bright sand.
    L.polyline(road.line, { color: '#0F172A', weight: 9, opacity: 0.45 }).addTo(t.layer);
    const line = L.polyline(road.line, {
      color: '#FDE047', weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round'
    }).addTo(t.layer);

    t.frame(line.getBounds().extend([point.lat, point.lon]));
    await t.wait(700);
    if (!t.alive()) return;

    const away = road.distanceKm < 1
      ? `${Math.round(road.distanceKm * 1000)} m`
      : `${road.distanceKm.toFixed(1)} km`;
    t.label([road.latitude, road.longitude], {
      title: road.name ?? 'Nearest mapped track',
      detail: `${away} away — it may be gated, seasonal or impassable`,
      glyph: '\u{1F6E3}️',
      color: '#FDE047'
    });

    /**
     * LONG ENOUGH TO ACTUALLY LOOK AT THE ROAD.
     *
     * The line was on screen for about three seconds all in, and most of that
     * went on the camera still settling and the label arriving. By the time you
     * had found the yellow line against the imagery it was being taken away —
     * so the answer to "where is the track" was one you had to ask for twice.
     * Five seconds is a glance, a second glance, and time to see where it goes.
     */
    await t.wait(4500);
  }), [runTour]);

  /**
   * Tapping the gap chip: where does the road actually stop, and what is there?
   *
   * The chip says "1.8 km short" and the only useful version of that is on the
   * map. It used to be one dashed line into nowhere and a label saying the
   * road ends here, which reads as the app not knowing about roads that are
   * plainly drawn on the basemap underneath it.
   *
   * It knows. So the tour now shows the road too, in one of two shapes:
   *
   *   THE ROUTE ENDS ON A ROAD — the road is drawn in yellow, named, and the
   *   dashed stretch runs from it to the pin. That is "you drive this, then
   *   you're on your own for 400 m".
   *
   *   A CLOSER ROAD EXISTS THAT NOTHING WOULD ROUTE ONTO — it is drawn too, in
   *   a dimmer, dashed yellow to keep it visibly different from the drive, and
   *   labelled as what it is: mapped, close, and not reachable by any engine
   *   we asked. That is the honest answer to "why is it ignoring that road",
   *   and it is one the camper can act on with satellite imagery.
   *
   * The dashed stretch is still never called a route. Nobody has said there is
   * anything to drive, walk or push a rig along in that gap.
   */
  const runGapTour = useCallback(() => runTour(async (t) => {
    const point = readPointRef.current;
    const route = routeRef.current;
    const line = route?.geometry ?? [];
    const end = line[line.length - 1];
    if (!point || !end) return;

    const gap = route?.gapToDestinationKm ?? 0;
    const approach = route?.approach ?? null;
    const nearest = route?.nearestRoad ?? null;

    // A road we could not route onto is only worth showing when it is
    // meaningfully closer than where the drive gave up.
    const stranded =
      !approach && nearest && nearest.distanceKm < gap - 0.15 ? nearest : null;
    const shown = approach ?? stranded;

    const bounds = L.latLngBounds(end, [point.lat, point.lon]);

    if (shown?.line?.length) {
      // Dark under-stroke first, so yellow survives pale rock and bright sand.
      L.polyline(shown.line, { color: '#0F172A', weight: 9, opacity: 0.45 }).addTo(t.layer);
      L.polyline(shown.line, {
        color: '#FDE047',
        weight: 5,
        opacity: stranded ? 0.75 : 0.95,
        // Dashed when nothing can route onto it: the line is a fact about the
        // map, not a way in, and it must not look like the drive.
        dashArray: stranded ? '10 8' : undefined,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(t.layer);
      bounds.extend(L.latLngBounds(shown.line));
    }

    L.polyline([end, [point.lat, point.lon]], {
      color: '#F59E0B', weight: 4, opacity: 0.95, dashArray: '2 9', lineCap: 'round'
    }).addTo(t.layer);
    L.circleMarker(end, {
      radius: 6, color: '#F59E0B', weight: 3, fillColor: '#0F172A', fillOpacity: 1
    }).addTo(t.layer);

    t.frame(bounds);
    await t.wait(700);
    if (!t.alive()) return;

    const named = (road: NonNullable<typeof shown>): string =>
      road.name ?? `an unnamed ${road.kind.replace(/_/g, ' ')}`;
    const away = (km: number): string =>
      km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

    t.label(end, {
      title: approach
        ? `The drive ends on ${named(approach)}`
        : 'The mapped road ends here',
      detail: approach
        ? `${away(gap)} left on foot or an unmapped track` +
          (approach.gated ? ' — OpenStreetMap records a gate on this road' : '')
        : `${away(gap)} left — an unmapped track, or nothing at all`,
      glyph: '\u{1F6A7}',
      color: '#F59E0B'
    });

    // The second label only exists when there is a second thing to say.
    if (stranded) {
      await t.wait(2000);
      if (!t.alive()) return;

      t.label([stranded.lat, stranded.lon], {
        title: `${named(stranded)} — ${away(stranded.distanceKm)} away`,
        detail: 'Mapped, but no router could find a way onto it. Check satellite ' +
          'imagery before counting on it',
        glyph: '\u{1F6E3}️',
        color: '#FDE047'
      });
    }

    await t.wait(2400);
  }), [runTour]);

  // A tour still running when the map goes away would keep adding flames to a
  // layer nobody can see, and then fly a torn-down camera home.
  useEffect(() => () => { tourLayerRef.current?.remove(); tourLayerRef.current = null; }, []);

  /**
   * A chip that has no journey in it still answers when tapped.
   *
   * It unfurls into its own full sentence — the hedged one, with the caveats —
   * for a few seconds, and then goes back to being short. That sentence has
   * always existed; it lived in the `title` attribute, which is a hover
   * tooltip, which on the phone this app is used on is nowhere at all. So
   * "Strong signal" could never tell anybody it means a distance to a mast
   * with the terrain ignored.
   *
   * The rest of the stack slides to make room rather than jumping, and the
   * chip puts itself away on a timer — a tap is a glance, not a state to have
   * to get back out of.
   */
  const unfurlTimersRef = useRef(new Map<HTMLElement, number>());

  const unfurlChip = useCallback((chip: HTMLElement) => {
    const text = chip.querySelector<HTMLElement>(':scope > .wl-chip-text');
    const row = chip.parentElement;
    if (!text || !row) return;

    const timers = unfurlTimersRef.current;
    const running = timers.get(chip);
    if (running) window.clearTimeout(running);

    const short = chip.getAttribute('data-label') ?? text.textContent ?? '';
    const full = chip.getAttribute('data-full') ?? short;

    // Already open: tapping again puts it away rather than doing nothing.
    if (chip.classList.contains('wl-chip-open')) {
      timers.delete(chip);
      flipRow(row, () => {
        chip.classList.remove('wl-chip-open');
        text.textContent = short;
      });
      return;
    }

    flipRow(row, () => {
      chip.classList.add('wl-chip-open');
      text.textContent = full;
    });
    haptic('tap');

    timers.set(chip, window.setTimeout(() => {
      timers.delete(chip);
      if (!chip.isConnected) return;
      const home = chip.parentElement;
      const close = () => {
        chip.classList.remove('wl-chip-open');
        text.textContent = short;
      };
      if (home) flipRow(home, close);
      else close();
    }, 5200));
  }, []);

  useEffect(() => () => {
    unfurlTimersRef.current.forEach((id) => window.clearTimeout(id));
    unfurlTimersRef.current.clear();
  }, []);

  /**
   * A tap on anything the open pin offers.
   *
   * EVERY CHIP GOES THROUGH HERE NOW, not just the two that used to be
   * tappable. A chip that stands for something on the map takes the camera to
   * it and brings it back; the car chip hands off to the phone's maps app; and
   * a chip that is purely a fact unfurls into its full wording. Nothing on the
   * pin is inert any more, which is what makes the arrows worth trusting.
   *
   * Delegated from the map container in the CAPTURE phase, which is the only
   * place it works: these live inside a marker's icon, so Leaflet's own marker
   * handler would otherwise see the tap first and re-select the pin. Bound
   * once for the life of the map and reads everything through refs, so it
   * never needs rebinding.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const container = map.getContainer();

    const onTap = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const hit = target?.closest?.(
        '.wl-chip,[data-facility],[data-action]'
      ) as HTMLElement | null;
      if (!hit) return;
      // A peeked stack is a look, not a menu — see the CSS note on .wl-chips-peek.
      if (hit.closest('.wl-chips-peek')) return;

      const action = hit.getAttribute('data-action');
      const facilityId = hit.getAttribute('data-facility');
      const facility = facilityId
        ? facilitiesRef.current.find((f) => f.id === facilityId)
        : undefined;
      const isChip = hit.classList.contains('wl-chip');
      if (!action && !facility && !isChip) return;

      event.preventDefault();
      event.stopPropagation();

      switch (action) {
        case 'fires': void runFireTour(); return;
        case 'alert': {
          const badge = hit.getAttribute('data-badge') as AlertBadge | null;
          if (badge) void runAlertTour(badge);
          return;
        }
        case 'land': void runLandTour(); return;
        case 'gap': void runGapTour(); return;
        case 'road': void runRoadTour(facility ?? null); return;
        case 'directions': directionsRef.current(); return;
        case 'signal': void runSignalTour(); return;
        // The × on a tour label. This dispatcher only ever stops the tour —
        // for most chips that's the whole story, and the pin stays open. The
        // land tour is the one exception: it deselects the pin itself too,
        // as a follow-on inside runLandTour once the wait this cancels
        // resolves. See the comment there.
        case 'tour-close': endTour(); return;
        /*
         * The × under the pin means "put all of this away".
         *
         * It used to mean "put the pin away", which left whatever the pin had
         * drawn on the map — a parcel outlined in violet, a label spelling out
         * its rules, a camera parked somewhere the camper never chose to be —
         * sitting there with nothing left to explain it and no way to dismiss
         * it. The tour goes first so the camera lands back home before the pin
         * it belonged to disappears.
         */
        case 'close':
          endTour();
          clearDestinationRef.current();
          return;
        case 'details':
          if (destinationRef.current?.campsite) bottomSheetRef.current(destinationRef.current.campsite);
          return;
        // The "i" under a dropped pin. It used to unfurl every chip in place,
        // above a pin that might be anywhere on the screen; now it opens the
        // card at the bottom, which reads the same at any zoom. See
        // `PointInfoSheet`.
        case 'point': setPointCardOpen(true); return;
        case 'add': {
          const at = readPointRef.current;
          if (at) addSpotRef.current(at.lat, at.lon);
          return;
        }
        case 'add-facility': {
          const at = readPointRef.current;
          if (at) addFacilityRef.current?.(at.lat, at.lon);
          return;
        }
        /*
         * The beacon, from the pin it is about.
         *
         * Straight to the search, not to the "from where?" question — the pin
         * IS the answer to that question, and asking it again about a place
         * somebody has just pointed at is the app not listening.
         */
        case 'beacon': {
          const at = readPointRef.current;
          if (at) sendBeaconRef.current?.(at.lat, at.lon);
          return;
        }
        default: break;
      }

      // A facility with no action of its own: frame it with the spot and ask
      // for a route, which is the old behaviour and still the right one.
      if (facility) { setFacilityTrip({ facility, route: null, loading: true }); return; }
      if (isChip) unfurlChip(hit);
    };

    container.addEventListener('click', onTap, true);
    return () => container.removeEventListener('click', onTap, true);
  }, [
    isMapReady, runFireTour, runAlertTour, runLandTour, runGapTour, runRoadTour,
    runSignalTour, unfurlChip, endTour
  ]);

  /**
   * The pin going away takes its tour with it, however it went.
   *
   * The × under the pin is not the only way to close one — a new pin, a search
   * result, the Escape key and the bottom sheet all clear the destination too,
   * and a tour outliving the pin it was launched from is the same orphaned
   * overlay every time. One place to say it, rather than five.
   */
  useEffect(() => {
    if (!destination) endTour();
  }, [destination, endTour]);

  /**
   * "Show me on the map", from a line in the point card.
   *
   * The card is the long-form version of the pin's chips, so its rows run the
   * same tours those chips do. The card gets out of the way first: a tour
   * borrows the camera, and it cannot borrow a screen that is half covered.
   */
  const showDotOnMap = useCallback((dot: MarkerDot) => {
    setPointCardOpen(false);
    // A beat, so the map has its full height back before a tour measures it.
    window.setTimeout(() => {
      switch (dot.action) {
        case 'fires': void runFireTour(); return;
        case 'alert': if (dot.badge) void runAlertTour(dot.badge); return;
        case 'land': void runLandTour(); return;
        case 'gap': void runGapTour(); return;
        case 'road': void runRoadTour(dot.facility ?? null); return;
        case 'directions': directionsRef.current(); return;
        case 'signal': void runSignalTour(); return;
        default:
          if (dot.facility) {
            setFacilityTrip({ facility: dot.facility, route: null, loading: true });
          }
      }
    }, 380);
  }, [runFireTour, runAlertTour, runLandTour, runGapTour, runRoadTour, runSignalTour]);

  /**
   * Frame the spot and the facility together, then ask for a route.
   *
   * Pulling the camera OUT here is the point — the answer to "where is the
   * toilet" is the two places in one view, not a closer look at either. The
   * bottom padding is whatever the card over the map is covering, so the
   * facility does not land underneath it.
   */
  const tripFacility = facilityTrip?.facility ?? null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    /*
     * The trip closed — put the pin back in the middle of the screen.
     *
     * Framing the pin with a facility necessarily pushes the pin off to one
     * side, so closing the trip has to undo that: the pin is still open, and
     * leaving it parked in a corner reads as the X having done nothing. Only
     * the centring is undone, at whatever zoom fitBounds landed on — a camper
     * who tapped a POI is interested in exactly this spot, not being pulled
     * back out. Zooming back out is what the pin's OWN close does, not this.
     *
     * Nothing to do once the pin itself has gone: closing a pin runs its own
     * restore, and two of those on one frame land somewhere neither meant.
     */
    if (!tripFacility) {
      const previous = preTripPinRef.current;
      preTripPinRef.current = null;
      if (!previous || readLat === null || readLon === null) return;
      // A different pin now: that one is aiming the camera itself.
      if (previous.lat !== readLat || previous.lon !== readLon) return;
      try {
        const zoomNow = map.getZoom();
        const centre = centreLeavingRoom(
          map, L.latLng(readLat, readLon), overlayPxRef.current, zoomNow
        );
        if (prefersReducedMotion()) {
          map.setView(centre, zoomNow, { animate: false });
        } else {
          map.panTo(centre, { animate: true, duration: 0.45 });
        }
      } catch { /* map torn down */ }
      return;
    }

    if (readLat === null || readLon === null) return;

    // Which pin the trip is about, kept once so that hopping from one
    // facility straight to another still recentres on the same pin.
    if (!preTripPinRef.current) {
      preTripPinRef.current = { lat: readLat, lon: readLon };
    }

    const bounds = L.latLngBounds(
      [readLat, readLon],
      [tripFacility.latitude, tripFacility.longitude]
    );
    try {
      map.fitBounds(bounds, {
        paddingTopLeft: L.point(48, 80),
        // Room at the bottom for the trip card, which sits over the map.
        paddingBottomRight: L.point(48, 180),
        maxZoom: 15,
        animate: !prefersReducedMotion()
      });
    } catch { /* map torn down */ }

    const controller = new AbortController();
    let cancelled = false;

    calculateRoute(
      {
        from: [readLat, readLon],
        to: [tripFacility.latitude, tripFacility.longitude]
      },
      controller.signal
    ).then((route) => {
      if (cancelled) return;
      setFacilityTrip((current) =>
        current && current.facility.id === tripFacility.id
          ? { ...current, route, loading: false }
          : current
      );
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Deliberately keyed on the facility, not on the trip: the route landing
    // must not re-frame the map or ask for the route again.
  }, [tripFacility, readLat, readLon, isMapReady]);

  /**
   * The line to the facility, and a dot on the facility itself.
   *
   * Dashed until a route comes back, and dashed for good if none does — a
   * straight line between two points is a bearing, not a way through, and
   * drawing it solid would claim a road that may not exist.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const clear = () => {
      if (!facilityLayerRef.current) return;
      try { map.removeLayer(facilityLayerRef.current); } catch { /* detached */ }
      facilityLayerRef.current = null;
    };
    clear();

    const trip = facilityTrip;
    if (!trip || readLat === null || readLon === null) return;

    const colour = FACILITY_COLOR[trip.facility.kind];
    const routed = trip.route?.ok && trip.route.geometry.length > 1;
    const line: [number, number][] = routed
      ? trip.route!.geometry
      : [
          [readLat, readLon],
          [trip.facility.latitude, trip.facility.longitude]
        ];

    const layer = L.layerGroup([
      L.polyline(line, {
        color: colour,
        weight: routed ? 4 : 3,
        opacity: 0.95,
        dashArray: routed ? undefined : '6 7',
        lineCap: 'round'
      }),
      L.marker([trip.facility.latitude, trip.facility.longitude], {
        interactive: false,
        icon: L.divIcon({
          className: 'facility-target-marker',
          html:
            `<div class="wl-facility-dot" style="--wl-facility-color:${colour}">` +
            `<span aria-hidden="true">${FACILITY_GLYPH[trip.facility.kind]}</span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        })
      })
    ]);

    layer.addTo(map);
    facilityLayerRef.current = layer;

    return clear;
  }, [facilityTrip, readLat, readLon, isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Alert patterns over affected parcels — REMOVED                      */
  /* ------------------------------------------------------------------ */
  /**
   * This used to stamp a warning pattern onto the boundary PARCELS an alert
   * intersected. It is gone: warnings now cover the AREA the agency actually
   * warned about (the alert's own geometry), animated, in the effect above —
   * so the pattern no longer rides on parcel edges and the parcels are left to
   * speak for themselves.
   */

  /* ------------------------------------------------------------------ */
  /* User location                                                       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    if (userMarkerRef.current) {
      try { map.removeLayer(userMarkerRef.current); } catch { /* detached */ }
      userMarkerRef.current = null;
    }
    if (!userLocation) return;

    const icon = L.divIcon({
      className: 'user-location-marker',
      html: `
        <div class="relative flex items-center justify-center">
          <div class="absolute w-12 h-12 bg-blue-500/25 rounded-full wl-me-ping"></div>
          <div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-lg relative z-10"></div>
        </div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });

    /**
     * The one thing the grey mask is not allowed to dim.
     *
     * Every data layer sits under the coverage mask (645), which is the
     * point — nothing claims to know about the grey. "You are here" is
     * not a claim about the land, though, it's the user's own position,
     * and it has to stay legible when they're standing outside the
     * coverage area. Its own pane, above the mask, below popups.
     */
    if (!map.getPane('mePane')) {
      map.createPane('mePane');
      const pane = map.getPane('mePane');
      if (pane) { pane.style.zIndex = '660'; pane.style.pointerEvents = 'none'; }
    }

    userMarkerRef.current = L.marker(userLocation, { icon, pane: 'mePane' }).addTo(map);
  }, [userLocation, isMapReady]);

  /**
   * Tell App where the map settled, so campsites can load for the ground
   * being looked at rather than for the last place somebody searched.
   *
   * Every other data layer on this map already refetches on `moveend` —
   * boundaries, Beacon spots, hazards, facilities, backroads. Campsites were
   * the exception, and the exception was invisible: they loaded once, around
   * the searched location, and panning anywhere else showed nothing. Eight
   * hundred BC recreation sites went into the database and not one of them
   * appeared, because nothing ever asked for that ground.
   *
   * Debounced on the same 700 ms the other layers use, and fired once on
   * ready so the opening view is loaded too.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const c = map.getCenter();
      exploreRef.current?.(c.lat, c.lng);
    };
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(report, 700);
    };

    report();
    map.on('moveend', schedule);
    return () => {
      if (debounce) clearTimeout(debounce);
      map.off('moveend', schedule);
    };
  }, [isMapReady]);

  /* ------------------------------------------------------------------ */
  /* Recentre                                                            */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    // No-op if we are already at the requested view. Without this guard the
    // effect runs on every render where `center` or `zoom` identity changes,
    // including the round trip App does after the user pans: App updates its
    // own `center` state from a `moveend` handler, which re-fires this effect,
    // which fires another `flyTo` (which is a no-op visually but schedules an
    // animated pan that emits its own `moveend`, which can queue more work in
    // the debounced loaders). Skipping when already at the view breaks the
    // loop.
    const current = map.getCenter();
    const currentZoom = map.getZoom();
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (
      close(current.lat, center[0]) &&
      close(current.lng, center[1]) &&
      close(currentZoom, zoom)
    ) {
      return;
    }

    // Leaflet clamps to minZoom and maxBounds internally, so a request to fly
    // somewhere outside the world simply lands at the nearest valid view.
    try {
      map.flyTo(center, zoom, { duration: 1.2 });
    } catch {
      try { map.setView(center, zoom); } catch { /* not ready */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, zoom, isMapReady]);

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden">
      {/*
        The stage Leaflet lives in.

        It used to rotate — in navigation mode it turned so the direction of
        travel pointed up the screen, which meant it also had to be oversized to
        √2 of the viewport so the corners never showed bare background, and
        every marker icon needed a counter-rotation in CSS to stay upright.
        Navigation is gone and so is all of that. North is up, the stage is
        exactly the viewport, and the tile budget is a third of what it was.

        It stays a wrapper rather than collapsing into the container below
        because everything else on this screen is deliberately its SIBLING —
        that is what keeps the chrome out of Leaflet's transform.
      */}
      <div className="map-stage absolute inset-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
      {/*
        WHAT USED TO SIT IN THIS CORNER.

        A stack of standing notices: a parcel-count chip with an expandable
        source legend, an amber "Storm in view" panel, and a camper-report
        count. All three described things already visible on the map — the
        shaded warning areas, the coloured dots on the pins, the report
        markers — and between them they covered the top third of a phone
        screen with text you could not dismiss. A permanent caption over the
        map is not information; it is something to look past.

        The caveats they carried did not go with them. Boundary edges are
        drawn as a fade rather than a line and the accuracy note now lives in
        the layer menu beside the toggle that draws them; warnings are read by
        tapping the spot they cover; camper reports are read by tapping the
        report.

        What is left here is state you cannot see any other way: that the app
        is running on saved data, and that you have panned outside the region
        it covers at all.
      */}
      {/*
        z-index sits above every Leaflet pane, not level with them.

        Leaflet's own panes top out at 400 and its controls at 800. These
        overlays used to be 400 too, which was a tie that DOM order settled in
        the map's favour. That was survivable while the boundary layer was SVG,
        because Leaflet marks its SVG overlay `pointer-events: none` — but a
        canvas renderer listens for clicks across the whole map surface to do
        its own hit-testing, so once boundaries moved to canvas it swallowed
        every tap meant for these buttons.
      */}
      {/*
        ONE COLUMN, AT THE TOP, IN THE MIDDLE.

        Everything the map has to say about itself now says it here, one under
        the other, in the middle of the screen where a camper is already
        looking. It used to be scattered: the instruction sat at the bottom
        edge, the offline and backroad notices were pinned to the top LEFT
        under a pill the app floated in the top centre, and the "there's more
        here" chip had a corner of its own. Four messages, four places, and no
        way for any of them to know how tall the others were.

        Reading order is the order they matter in: what to do next, then what
        just happened, then the standing state of the app.

        `pointer-events-none` on the whole column. None of this is a control —
        it is the map talking — and an invisible box across the top of the
        screen eating taps meant for the ground under it is exactly the bug
        this app has fixed twice already.
      */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[998] w-[min(22rem,calc(100%-1.5rem))] flex flex-col items-center gap-1.5 pointer-events-none">
        {/*
          THE ONE INSTRUCTION ON THE MAP.

          Shown only until the user has picked somewhere. A tap target that
          covers the entire screen is invisible until somebody tells you it's
          there — but once you know, the hint is clutter, so it removes itself.

          Five words, on one line, deliberately. "Tap anywhere to pick a spot"
          wrapped to two lines on a narrow phone and the pill grew into a
          paragraph sitting over the map. The tap target is still the whole
          screen; the sentence does not have to say so to prove it.
        */}
        {!destination && !pointCardOpen && (
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-slate-900/85 backdrop-blur-md border border-slate-700/70 shadow-xl anim-in-down">
            <MousePointerClick className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-200 whitespace-nowrap">
              Tap to pick a spot
            </span>
          </div>
        )}

        {/*
          Looking for spots — and only while the layer that draws the land they
          sit on is switched on. See `isSearchingSites`.
        */}
        {isSearchingSites && showBoundaries && (
          <div className="max-w-full bg-slate-900/95 border border-emerald-500/50 text-emerald-300 px-4 py-2 rounded-full shadow-2xl backdrop-blur-md text-xs font-semibold flex items-center gap-2.5 anim-in-down">
            <Search className="w-4 h-4 text-emerald-400 animate-[bounce_0.6s_infinite]" />
            <span>Exploring public lands…</span>
          </div>
        )}

        {/* The app's own passing notices — see `topNotice`. */}
        {topNotice}

        {isOfflineMode && (
          <div className="bg-amber-500 text-slate-950 px-3 py-1.5 rounded-xl font-bold text-xs shadow-xl flex items-center gap-2 border border-amber-300">
            <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />
            Offline — saved maps and spots
          </div>
        )}

        {!isWithinCoverage(center[0], center[1]) && (
          <div className="bg-slate-800/95 backdrop-blur-md border border-slate-600 text-slate-300 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-start gap-2 anim-in-up">
            <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
            <span>Outside coverage. Wandrlust supports {COVERAGE_LABEL}.</span>
          </div>
        )}

        {/*
          A HOLE IN THE WARNING LAYER, NAMED.

          The shading over one country and nothing over the next looks
          identical whether the second country is quiet or simply was not
          asked. Amber rather than red: nothing is known to be wrong, and
          dressing "we could not check" as a hazard would be its own kind of
          overstatement. It clears itself the moment both feeds answer.
        */}
        {showWarnings && alertGap && (
          <div className="bg-amber-950/90 backdrop-blur-md border border-amber-700/70 text-amber-100 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-start gap-2 anim-in-up">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span className="leading-snug">{alertGap}</span>
          </div>
        )}

        {/*
          The backroads layer saying which of its silences this one is. It
          joins the same stack as the offline and coverage chips rather than
          taking a corner of its own, so the map never ends up with notes in
          three places at once. Quiet slate for "still working on it", amber
          for a missing answer, violet for a good answer with more behind it —
          the same three tones the boundary layer uses for the same three
          kinds of statement.
        */}
        {backroadNotice && (
          <div
            className={`backdrop-blur-md px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-start gap-2 anim-in-up ${
              backroadNotice.tone === 'amber'
                ? 'bg-amber-950/90 border border-amber-700/70 text-amber-100'
                : backroadNotice.tone === 'violet'
                  ? 'bg-slate-900/90 border border-violet-800/70 text-violet-200'
                  : 'bg-slate-800/95 border border-slate-600 text-slate-300'
            }`}
          >
            {backroadNotice.spinner
              ? <Loader2 className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5 animate-spin" />
              : (
                <span
                  className={`w-1.5 h-1.5 mt-1.5 rounded-full shrink-0 ${
                    backroadNotice.tone === 'amber'
                      ? 'bg-amber-400'
                      : backroadNotice.tone === 'violet' ? 'bg-violet-400' : 'bg-slate-400'
                  }`}
                  aria-hidden="true"
                />
              )}
            <span className="leading-snug">{backroadNotice.text}</span>
          </div>
        )}

        {/* The facility layer's own sentence — see `facilityNotice`. Same
            three tones as the backroads above, saying the same three kinds of
            thing: working on it, a missing answer, a good answer with more
            behind it. */}
        {facilityNotice && (
          <div
            className={`backdrop-blur-md px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xl flex items-start gap-2 anim-in-down ${
              facilityNotice.tone === 'amber'
                ? 'bg-amber-950/90 border border-amber-700/70 text-amber-100'
                : facilityNotice.tone === 'violet'
                  ? 'bg-slate-900/90 border border-violet-800/70 text-violet-200'
                  : 'bg-slate-800/95 border border-slate-600 text-slate-300'
            }`}
          >
            {facilityNotice.spinner
              ? <Loader2 className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5 animate-spin" />
              : (
                <span
                  className={`w-1.5 h-1.5 mt-1.5 rounded-full shrink-0 ${
                    facilityNotice.tone === 'amber'
                      ? 'bg-amber-400'
                      : facilityNotice.tone === 'violet' ? 'bg-violet-400' : 'bg-slate-400'
                  }`}
                  aria-hidden="true"
                />
              )}
            <span className="leading-snug">{facilityNotice.text}</span>
          </div>
        )}

        {/*
          A ZOOMED-OUT MAP IS A SAMPLE, AND IT HAS TO SAY SO.

          At these zooms the map shows the biggest parcels a source will hand
          over, not all of them — and a camper reading a sparsely-painted Ontario
          concludes there is little Crown land in Ontario, then zooms in and
          watches it fill. That is the same forbidden sentence the app refuses to
          say in words, said instead by a rendering budget. It is only ever true
          that MORE exists than is drawn, never less, so the map says which way
          it is wrong.

          Only when a source actually withheld something: a view whose parcels
          all fit is a complete answer and does not need apologising for. Said at
          any zoom, not just the overview — the detailed tier has a cap of its
          own, and a sample is a sample wherever it happens.

          IT NO LONGER SAYS "LARGEST AREAS ONLY". That was true when the overview
          kept the big parcels and deleted the small ones; it now welds abutting
          parcels into blocks BEFORE judging what is too small to draw, so what is
          missing here is whatever a source withheld at its record cap, which has
          nothing to do with size. Saying "largest only" would send a camper
          looking for the small parcels that are, in fact, already on the screen
          inside the block.
        */}
        {showBoundaries && boundaries.meta?.truncated && !wideViewFailed && !zoomTooFar && !centreGap && (
          <div className="max-w-full anim-in-down">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-slate-900/85 backdrop-blur-md border border-violet-800/70 shadow-xl">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-semibold text-violet-200">
                There's more here — zoom in to see it all
              </span>
            </div>
          </div>
        )}
        {/*
          THE MAP SAYS WHEN IT DOESN'T KNOW, RATHER THAN GOING QUIET.

          Two different silences used to look identical, and both looked like
          "there is no public land out here":

            - zoomed past the point where any boundary is legible at all, and
            - the wide view asked and got an answer it could not stand behind,
              which happens when one of eight government servers is slow.

          The second is the one that stings, because the boundaries were there a
          second ago at the zoom above. So the map keeps drawing what it had and
          this says why, in words a camper can act on. Amber rather than violet:
          the truncation chip above is a caveat about a good answer, this is a
          missing answer, and they must not read the same.

          Over a province the map has NO data for, both excuses are the same
          lie the gap chip below exists to stop: telling a camper to zoom in
          when there is nothing to find. A mapped province carrying a caveat
          (Ontario's Far North) is different — zooming in there does reveal
          real land, so it keeps the request-level message. When the province
          under the crosshair has no mapped data at all, this chip says that
          instead — the standing fact beats the request-level excuse, and the
          two amber chips are never on screen together.
        */}
        {showBoundaries && (wideViewFailed || zoomTooFar) && (
          <div className="max-w-full anim-in-down">
            <div className="inline-flex items-start gap-1.5 px-2.5 py-1.5 rounded-2xl bg-slate-900/85 backdrop-blur-md border border-amber-700/70 shadow-xl">
              <span className="w-1.5 h-1.5 mt-1 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-semibold text-amber-200 leading-snug">
                {centreGap && !hasMappedCrownLand(centreGap.isoCode)
                  ? `${centreGap.name} — ${centreGap.gap}. A blank map here means we have no data, never that the land isn’t there.`
                  : zoomTooFar
                    ? 'Too far out to draw public land — zoom in to see it'
                    : 'Couldn’t load public land for this wide view. What’s drawn may be incomplete — zoom in for the real picture.'}
              </span>
            </div>
          </div>
        )}
        {/*
          THE PROVINCE ITSELF IS THE MISSING ANSWER.

          The two chips above are about this request: too far out to draw, or a
          government server that did not answer in time. This one is about the
          ground. Most of Canada's provinces now draw real Crown land — Quebec's
          multi-use zones and Newfoundland and Labrador's province-minus-titles
          are the newest — but a mapped province is not mapped to the last acre
          (QC draws only its multi-use zones; NL's edges are cadastral-derived),
          and a few provinces and the territories still have no layer at all.
          Partial and absent are different truths and both deserve a word on the
          map. Without this, the app renders its most confident possible lie —
          an empty province — with nothing to read it against.

          Shown only at detail zoom: below BOUNDARY_MIN_ZOOM the overview weld
          is what is on screen, and a province-specific caveat under one
          crosshair position would be noise against it.

          Same amber as the two above, because it is the same kind of statement:
          a missing answer, not a caveat about a good one. Ranked below them
          because they are about the map failing right now and this is a
          standing fact about the province, and only one of them is ever on
          screen at a time.
        */}
        {showBoundaries && !wideViewFailed && !zoomTooFar && liveZoom >= BOUNDARY_MIN_ZOOM && centreGap && (
          <div className="max-w-full anim-in-down">
            <div className="inline-flex items-start gap-1.5 px-2.5 py-1.5 rounded-2xl bg-slate-900/85 backdrop-blur-md border border-amber-700/70 shadow-xl">
              <span className="w-1.5 h-1.5 mt-1 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-semibold text-amber-200 leading-snug">
                {hasMappedCrownLand(centreGap.isoCode)
                  ? `${centreGap.name} — ${centreGap.gap}.`
                  : `${centreGap.name} — ${centreGap.gap}. A blank map here means we have no data, never that the land isn’t there.`}
              </span>
            </div>
          </div>
        )}
      </div>

      {/*
        THE HOP TO A FACILITY.

        Sits just above whatever card is over the map, because the two things
        it is about — the spot and the facility — are both in the strip of map
        left above it, joined by the line this card describes.

        What it will not say: how long the walk takes, or that the place is
        open. The time is a driving estimate from the same engine as every
        other route in the app, and the existence of the facility is one
        volunteer's note in OpenStreetMap, which is said on the card rather
        than left for the camper to discover at the trailhead.
      */}
      {facilityTrip && readLat !== null && readLon !== null && (
        <div className="absolute bottom-11 md:bottom-3 left-1/2 -translate-x-1/2 z-[1400] w-[min(23rem,calc(100%-1.5rem))] anim-in-up">
          <div
            className="rounded-2xl bg-slate-900/96 backdrop-blur-md border shadow-2xl px-3 py-2.5"
            style={{ borderColor: FACILITY_COLOR[facilityTrip.facility.kind] }}
          >
            <div className="flex items-start gap-2">
              <span className="text-base leading-none mt-0.5" aria-hidden="true">
                {FACILITY_GLYPH[facilityTrip.facility.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-100 truncate">
                  {facilityTrip.facility.name ?? FACILITY_LABEL[facilityTrip.facility.kind]}
                </p>
                <p className="text-[12px] text-slate-400">
                  {FACILITY_LABEL[facilityTrip.facility.kind]} ·{' '}
                  {facilityTrip.facility.distanceKm} km from this spot
                  {facilityTrip.facility.fee === true && ' · charges a fee'}
                </p>
                <p className="text-[12px] text-slate-300 mt-0.5">
                  {facilityTrip.loading ? (
                    <span className="flex items-center gap-1.5 text-slate-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Working out the drive…
                    </span>
                  ) : facilityTrip.route?.ok ? (
                    <>
                      <span className="font-bold text-slate-100">
                        ~{Math.max(1, facilityTrip.route.durationMin)} min
                      </span>{' '}
                      by road, {facilityTrip.route.distanceKm} km
                    </>
                  ) : (
                    <span className="text-amber-300">
                      No road route found — the dashed line is the direction, not a way through.
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFacilityTrip(null)}
                className="p-1.5 tap-safe rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-100 shrink-0"
                aria-label="Hide this facility"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-[11px] text-slate-500 leading-tight mt-1.5">
              Mapped by an OpenStreetMap volunteer. Nobody has checked whether it
              is open, maintained or still there.
            </p>

            <button
              type="button"
              onClick={() => {
                /* The other way to be handed to Google Maps for a facility.
                   Both remember, or the app asks "did you find it?" after one
                   route to a toilet and not the other. */
                rememberFacilityHandoff(facilityTrip.facility);
                openDirections(
                  facilityTrip.facility.latitude,
                  facilityTrip.facility.longitude,
                  [readLat, readLon]
                );
              }}
              className="mt-2 w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2"
            >
              <Navigation className="w-3.5 h-3.5" />
              Take me there in {directionsAppName()}
            </button>
          </div>
        </div>
      )}

      {/*
        THE MAP CONTROLS, ALL IN ONE CORNER A THUMB CAN REACH.

        Layers and locate used to live at the top right. On a desktop that
        is fine; on a phone it is the one part of the screen the hand
        holding it cannot get to without shifting its grip, and the two
        controls a camper reaches for while moving were both up there. They
        sit with the zoom buttons now, in the bottom third of the screen.

        SEARCH AND THE ACCOUNT BUTTON JOINED THEM, on phones only. Both were
        in the header, which is the same unreachable strip for the same
        reason, and search is the control used at every single stop. The
        magnifier opens the field, the suggestions, "use my location" and the
        facility layers, all sitting on top of the keyboard — and it opens
        them in the SAME card layers and the account open, so the three
        buttons in this stack behave like one set of controls instead of
        three habits. Only one card at a time; see `mapPanel`.

        Ordered by how often a hand goes to them, most-used lowest: zoom,
        locate, search, layers, account. The shapes carry the grouping:
        round for the buttons that each do one thing, one pill for the pair
        that share an axis. Same glass, same border, same size — one set of
        chrome rather than five floating oddments.

        The stack rides above whatever card is open (`overlayPx`) instead of
        being buried by it. A control you can see under a sheet and cannot
        press is worse than one that moved out of the way.
      */}
      {/*
        EVERY CONTROL IN THE STACK OPENS THE SAME CARD, IN THE SAME PLACE.

        The layer menu was the first thing to be a card docked at the bottom
        of the map rather than a dropdown hanging off its own button, and for
        a while it was the only one: search opened a full-width drawer welded
        to the bottom edge, and the account opened a narrow dropdown up in the
        corner. Three buttons in one row of chrome, opening three different
        shapes in three different places, two of which could be up at once and
        overlapping.

        Now they are one shape (`ui/MapPanel`) driven by one variable, so
        opening any of them closes the last and there is nothing to overlap.
        Each is centred and docked low, held clear of the control stack, and
        rides above whatever card is already open over the map.
      */}
      <MapPanel
        isOpen={mapPanel === 'layers'}
        onClose={closePanel}
        title="Map layers"
        icon={Layers}
        overlayPx={overlayPx}
      >
        <div className="p-2.5">
          {/*
            Base map as one segmented control rather than three stacked
            rows. Three words fit across the menu, and the choice reads as
            a choice instead of as a list you have to get to the bottom of.
          */}
          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold pb-1.5">Base map</p>
          <div className="flex p-0.5 rounded-xl bg-slate-950/80 border border-slate-800">
            {(Object.keys(TILE_URLS) as MapTileLayer[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTileLayer(id)}
                aria-pressed={activeTileLayer === id}
                className={`flex-1 px-1 py-1.5 rounded-lg text-[11px] font-bold ${
                  activeTileLayer === id ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {TILE_URLS[id].label}
              </button>
            ))}
          </div>

          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-bold pt-2.5 pb-0.5">Overlays</p>
          <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
            <span>Public land</span>
            <input
              type="checkbox"
              checked={showBoundaries}
              onChange={(e) => setShowBoundaries(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 shrink-0"
            />
          </label>
          {/*
            THE CAVEAT, CUT TO THE BONE BUT NOT CUT.

            This used to be four lines of prose, and the menu it sat in ran
            off the screen — so the thing that must always be said was, in
            practice, scrolled past. Every claim it made is still here: the
            edges are a guess, with a range; drawing one is not permission;
            and an empty map is missing DATA, never missing public land. It
            just stopped taking a paragraph to say so.
          */}
          {showBoundaries ? (
            <p className="px-1 pb-1 text-[11px] text-slate-500 leading-snug">
              Fuzzy edges, {UNCERTAINTY_LABEL.cadastral_derived}–{UNCERTAINTY_LABEL.generalised}.
              Not permission to camp. Blank means no data, not private land.
            </p>
          ) : (
            /* Said when the layer is OFF, because "off" reads as "the app
               has stopped knowing". It hasn't — only the paint is gone. */
            <p className="px-1 pb-1 text-[11px] text-slate-500 leading-snug">
              Off — a tap still names the land, its limits and its fire ban.
            </p>
          )}

          {/* ------------------------------------------------------- */}
          {/* Roads this phone has driven                              */}
          {/* ------------------------------------------------------- */}
          <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
            <span>Roads I&apos;ve driven</span>
            <input
              type="checkbox"
              checked={showScout}
              onChange={(e) => setShowScout(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 shrink-0"
            />
          </label>
          {showScout ? (
            <div className="px-1 pb-1 space-y-1.5">
              {/*
                THE RAMP, AND THE FOUR WORDS FOR IT.

                The line itself is continuous — these names exist so the bar
                can be read, not because the drawing is bucketed. They are
                phrased as decisions rather than textures: "washboard" is a
                description, "slow down" is what to do about it.
              */}
              <div
                className="h-2 rounded-full mt-1"
                style={{
                  background: `linear-gradient(90deg, ${ROUGHNESS_BANDS
                    .map((_, i) => roughnessColor(i / (ROUGHNESS_BANDS.length - 1)))
                    .join(', ')})`
                }}
                aria-hidden="true"
              />
              <div className="flex justify-between gap-1">
                {ROUGHNESS_BANDS.map((band) => (
                  <span key={band.label} className="text-[11px] text-slate-400 leading-tight">
                    {band.label}
                  </span>
                ))}
              </div>

              {/*
                WHICH SILENCE THIS IS.

                An empty layer has three meanings and only one of them is
                "this road is fine". Saying nothing would let the other two
                be read as the first.
              */}
              <p className="text-[11px] text-slate-500 leading-snug">
                {scoutState.tooFar
                  ? 'Zoom in to draw your recorded drives.'
                  : scoutState.traces === 0
                    ? 'Nothing recorded in this view. That means you haven’t driven it with Scout Mode on — not that the roads here are good.'
                    : 'Faint means you drove it once. It firms up as you drive it again. Roughness only — the surface itself is the backroads layer.'}
              </p>
            </div>
          ) : (
            <p className="px-1 pb-1 text-[11px] text-slate-500 leading-snug">
              Off — your drives are still recorded and kept on this phone.
            </p>
          )}

          <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
            <span>Backroads &amp; tracks</span>
            <input
              type="checkbox"
              checked={showBackroads}
              onChange={(e) => setShowBackroads(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 shrink-0"
            />
          </label>
          {showBackroads && (
            <div className="px-1 pb-1">
              {/*
                ONE COLUMN, AND THE LABELS NEVER TRUNCATE.

                Two columns fitted, and turned "Two-track / forest road"
                into "Two-track / fores…" and "Surface not recorded" into
                "Surface not reco…". The legend is the one part of this
                menu that cannot be compressed: each line style is making a
                DIFFERENT claim, and the dotted one — nobody wrote the
                surface down — is the claim most easily misread as one of
                the others. Prose gave way instead.
              */}
              <ul className="space-y-1 pt-1">
                {BACKROAD_CLASS_ORDER.map((id) => {
                  const style = BACKROAD_STYLES[id];
                  return (
                    <li key={id} className="flex items-center gap-2 min-w-0">
                      <svg
                        width="18" height="6" viewBox="0 0 18 6"
                        aria-hidden="true" className="shrink-0 overflow-visible"
                      >
                        <line
                          x1="0" y1="3" x2="18" y2="3"
                          stroke={style.color}
                          strokeWidth={Math.max(2, style.weight)}
                          strokeDasharray={style.dash}
                          strokeLinecap="round"
                          opacity={style.opacity}
                        />
                      </svg>
                      <span className="text-[11px] text-slate-400 leading-tight">
                        {style.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-slate-500 leading-snug pt-1.5">
                Volunteer-mapped, drawn zoomed in. A recorded road — not a
                maintained, ungated, passable or legal one.
              </p>
            </div>
          )}

          {/* Only listed when the optional vector tileset is actually
              configured. A toggle that explains why it can't work is a
              developer's note sitting in a camper's map menu. */}
          {crownLandAvailable && (
            <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
              <span>Crown land tiles</span>
              <input
                type="checkbox"
                checked={showCrownLand}
                onChange={(e) => setShowCrownLand(e.target.checked)}
                className="accent-emerald-500 w-4 h-4 shrink-0"
              />
            </label>
          )}
          <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
            <span>Weather warnings</span>
            <input
              type="checkbox"
              checked={showWarnings}
              onChange={(e) => setShowWarnings(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 shrink-0"
            />
          </label>
          {/*
            No "Active fires" toggle here any more: there is no fire layer
            to switch off. Fires are reported on the pin you tap, which is
            a safety answer and not a layer.
          */}
          <label className="flex items-center justify-between gap-2 px-1 py-1.5 rounded-lg text-xs font-semibold text-slate-200 hover:bg-slate-800 cursor-pointer">
            <span>State / province lines</span>
            <input
              type="checkbox"
              checked={showAdmin1}
              onChange={(e) => setShowAdmin1(e.target.checked)}
              className="accent-emerald-500 w-4 h-4 shrink-0"
            />
          </label>
        </div>
      </MapPanel>

      {/*
        The facility layers, as the same card — because a fourth shape opening
        in a fourth place is exactly what `ui/MapPanel` was made to stop. Same
        size, same spot above the control stack, same header; only the tiles
        inside are allowed their own colour, and only because it is the colour
        of the pins they switch on. See `FacilityPicker`.
      */}
      {onToggleFacilityKind && (
        <MapPanel
          isOpen={mapPanel === 'facilities'}
          onClose={closePanel}
          title="Facilities"
          icon={Search}
          overlayPx={overlayPx}
          headerAction={
            /* One word, and it does not change with the count. "Turn it off"
               and "turn them all off" are the same button doing the same
               thing, and a label that rewrites itself under the thumb reads
               as a control that might do something different this time. */
            facilityKinds.length > 0 ? (
              <button
                type="button"
                onClick={() => { haptic('tap'); onClearFacilityKinds?.(); }}
                className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-950/80 text-[11px] font-bold text-slate-300 hover:text-slate-100 hover:border-slate-500"
              >
                Turn off
              </button>
            ) : null
          }
        >
          <FacilityPicker
            active={facilityKinds}
            onToggle={onToggleFacilityKind}
          />
        </MapPanel>
      )}

      {/*
        A TAPPED FACILITY, IN THE SAME CARD AS EVERYTHING ELSE ON THIS MAP.

        It used to be its own shape welded to the bottom of the window: wider
        than the layer menu, in a different place, over the tab bar. Same box
        now — same width, same dock, same header — so the map has one card and
        one place it appears, whatever opened it.

        Its own `isOpen` rather than a fourth value in `mapPanel`, because this
        one is a SELECTION and not a control: tapping a pin closes whichever
        control was open (see the tap handler), and closing the card leaves you
        where you were rather than reopening a menu.
      */}
      {selectedFacility && (
        <MapPanel
          isOpen
          onClose={() => onCloseFacility?.()}
          title={selectedFacility.name ?? FACILITY[selectedFacility.kind].label}
          icon={MapPin}
          overlayPx={overlayPx}
        >
          <FacilityCard
            facility={selectedFacility}
            isSignedIn={isSignedIn}
            onRequireAuth={() => onOpenAuth?.()}
            onSaved={() => onFacilityNoteSaved?.()}
          />
        </MapPanel>
      )}

      {/*
        The account, as the same card — the trophy, the ladder and the way out
        at a size you can read, instead of a 288px dropdown squeezed against
        the right-hand edge of a phone.
      */}
      <MapPanel
        isOpen={mapPanel === 'account'}
        onClose={closePanel}
        title="Your account"
        icon={UserIcon}
        overlayPx={overlayPx}
      >
        <AccountPanelBody onDone={closePanel} />
      </MapPanel>

      {/* Buy Me a Coffee, as the same card: the pitch, and one yellow button
          that actually leaves the app. It is a thank-you, not a pop-up —
          closed by default, opened from the yellow cup just above the layer
          menu, and closed by the same tap that opened it. */}
      <MapPanel
        isOpen={mapPanel === 'support'}
        onClose={closePanel}
        title="Support Wandrlust"
        icon={Coffee}
        overlayPx={overlayPx}
      >
        <SupportPanelBody />
      </MapPanel>

      {/*
        The column is full-height and bottom-aligned. The buttons sit at the
        bottom of it; the space above them is empty and stays that way — the
        layer menu used to live up there and is now a card of its own, docked
        at the bottom centre (just above).

        `pointer-events-none` on the column with `pointer-events-auto` on each
        control is what keeps that empty space honest: a full-height invisible
        box down the right-hand side would otherwise swallow every tap meant
        for the map.
      */}
      <div
        className="absolute right-3 top-3 z-[1000] flex flex-col items-end justify-end gap-2 pointer-events-none transition-[bottom] duration-200"
        style={{ bottom: `calc(1.5rem + ${overlayPx}px)` }}
      >
        {/*
          The account button, top of the stack.

          Highest because it is the one thing here you touch least, and it
          steps aside entirely while a card is open over the map: the stack
          rides up on top of that card, and five controls plus the zoom pill
          is taller than the strip of screen left above a tall sheet. The
          one that goes is the one that is not about the map.

          Signed out it goes straight to the sign-in sheet — there is no
          account to show a panel about. Signed in it opens the same docked
          card layers and search open, which is `onOpenPanel`.
        */}
        {onOpenAuth && overlayPx === 0 && (
          <div className="pointer-events-auto shrink-0 md:hidden">
            <UserMenu
              onOpenAuth={onOpenAuth}
              variant="fab"
              placement="up"
              onOpenPanel={() => { haptic('tap'); togglePanel('account'); }}
              panelOpen={mapPanel === 'account'}
            />
          </div>
        )}

        {/* Buy Me a Coffee — the round yellow cup just above the layer menu.
            One tap opens the support card; it never sails straight off to a
            website. A supporter shouldn't have to hunt for the way to keep
            the project alive, but the ask stays polite — see
            `SupportPanelBody`. */}
        <BuyMeACoffeeButton
          onClick={() => { haptic('tap'); togglePanel('support'); }}
          open={mapPanel === 'support'}
        />

        <button
          type="button"
          onClick={() => { haptic('tap'); togglePanel('layers'); }}
          className={`${STACK_BUTTON} ${
            mapPanel === 'layers' ? 'text-white ring-2 ring-emerald-400/70' : ''
          }`}
          aria-label="Map layers"
          aria-expanded={mapPanel === 'layers'}
        >
          <Layers className="w-[18px] h-[18px]" />
        </button>

        {/*
          THE FACILITY SYMBOLS LIVE IN THIS BUTTON.

          It carries a count when layers are on, because a switched-on layer is
          otherwise invisible as a SETTING: a camper looking at a map with no
          toilet pins on it has to be able to tell "the layer is off" from
          "nobody has mapped one round here", and those are the same empty
          screen.
        */}
        {onToggleFacilityKind && (
          <button
            type="button"
            onClick={() => { haptic('tap'); togglePanel('facilities'); }}
            className={`${STACK_BUTTON} relative ${
              mapPanel === 'facilities' ? 'text-white ring-2 ring-emerald-400/70' : ''
            }`}
            aria-label="Show toilets, water and other facilities on this map"
            aria-expanded={mapPanel === 'facilities'}
          >
            <Search className="w-[18px] h-[18px]" />
            {facilityKinds.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[11px] font-extrabold flex items-center justify-center border border-slate-900">
                {facilityKinds.length}
              </span>
            )}
          </button>
        )}

        {/*
          LOCATE — THE RING PULSES, THE BUTTON DOES NOT FADE.

          It used to go half-transparent while the GPS was thinking, which is
          the same thing every disabled control in the app does: it read as
          "this button is unavailable", at the exact moment it was busy doing
          the thing you asked for. A fix that is working should not look like
          a thing that is broken.

          So it wears the SAME green ring the layers button wears while its
          panel is open — the stack's one signal for "this control is the
          live one" — and the ring pulses while the fix is being taken. It
          still cannot be pressed twice; it just no longer says so by fading
          out. `anim-pulse-ring` collapses to a steady ring under
          `prefers-reduced-motion`, so the state is still legible without the
          motion.
        */}
        {onLocateUser && (
          <button
            type="button"
            onClick={onLocateUser}
            disabled={isLocating}
            className={`${STACK_BUTTON} ${
              isLocating ? 'text-white anim-pulse-ring' : ''
            }`}
            aria-label="Centre on my location"
            aria-busy={isLocating}
          >
            <Crosshair
              className={`w-[18px] h-[18px] ${isLocating ? 'text-emerald-300' : ''}`}
            />
          </button>
        )}

        {/*
          Zoom, in React rather than Leaflet.

          Leaflet's own control would live inside the stage element and
          inherit anything ever done to it; these sit outside as siblings of
          the map, with the rest of the chrome. One pill rather than two
          separate circles, because they are one control with two ends.
        */}
        <div className="pointer-events-auto shrink-0 flex flex-col rounded-full overflow-hidden border border-slate-700/80 shadow-xl">
          <button
            type="button"
            onClick={() => mapRef.current?.zoomIn()}
            className="tap-safe w-11 h-11 bg-slate-900/90 backdrop-blur-md text-slate-200 hover:text-white hover:bg-slate-800 text-lg font-bold leading-none"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => mapRef.current?.zoomOut()}
            className="tap-safe w-11 h-11 bg-slate-900/90 backdrop-blur-md text-slate-200 hover:text-white hover:bg-slate-800 text-lg font-bold leading-none border-t border-slate-700/80"
            aria-label="Zoom out"
          >
            −
          </button>
        </div>
      </div>

      {/*
        Map credits, behind a button instead of printed across the map.

        WHY IT IS STILL HERE AT ALL. Nobody plans a trip around who made the
        tiles, and a permanent line of vendor names along the bottom edge is
        clutter on the one screen that should be all map. But Esri and
        OpenStreetMap both require attribution as a condition of use, so the
        answer is to move it, not to delete it: one unobtrusive control, always
        present, one tap from the full credit.

        `dangerouslySetInnerHTML` is safe here in the strict sense that these
        strings are constants defined at the top of this file; no user or API
        content reaches it.
      */}
      <div className="absolute bottom-1 left-1 z-[1000] flex items-end gap-1.5">
        <button
          type="button"
          onClick={() => setShowCredits((open) => !open)}
          className="tap-safe w-5 h-5 rounded-full bg-slate-950/60 backdrop-blur-sm border border-slate-700/50 text-slate-400 hover:text-slate-100 hover:bg-slate-900/80 flex items-center justify-center shrink-0"
          aria-label={showCredits ? 'Hide map credits' : 'Show map credits'}
          aria-expanded={showCredits}
        >
          <Info className="w-3 h-3" />
        </button>

        {showCredits && (
          <div
            className="px-2 py-1 rounded-md bg-slate-950/90 backdrop-blur-sm border border-slate-700/60 text-[11px] text-slate-300 max-w-[70vw] anim-in-up"
            dangerouslySetInnerHTML={{
              __html: isOfflineMode
                ? 'Offline tile cache'
                : TILE_URLS[activeTileLayer].attribution
            }}
          />
        )}
      </div>

      {/*
        Everything known about a dropped pin, as a card rather than as a stack
        of pills unfurling over the map. Rendered here rather than in App
        because the map already holds the answers this card lists — they are
        the same dots the pin is wearing — and because the map has to know how
        much screen the card is taking to keep the pin above it.
      */}
      {readLat !== null && readLon !== null && (
        <PointInfoSheet
          isOpen={pointCardOpen}
          dots={destinationDots}
          latitude={readLat}
          longitude={readLon}
          land={destination?.land}
          onClose={() => setPointCardOpen(false)}
          onShowOnMap={showDotOnMap}
          onHeightChange={setPointCardPx}
        />
      )}
    </div>
  );
};
